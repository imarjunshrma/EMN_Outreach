import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from './core/logger.js';
import { db } from './core/db.js';
import { newRedis, redis, rateLimit } from './core/redis.js';
import { AppError } from './core/errors.js';
import { authenticate, errorHandler, requestId, securityHeaders } from './http/middleware.js';
import { mountRoutes, routes } from './http/router.js';
import { buildOpenApi } from './http/openapi.js';
import * as accounts from './services/accounts.js';
import * as compliance from './services/compliance.js';
import * as ops from './services/ops.js';
import './routes/core.js';
import './routes/leads.js';
import './routes/intelligence.js';
import './routes/outreach.js';
import './routes/ai-studio.js';
import './routes/assist.js';
import './routes/domains-enrichment.js';
import './routes/workflows-billing.js';
import './routes/insights.js';
import './routes/saas.js';
import * as billing from './services/billing.js';
import * as workflows from './services/workflows.js';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === 'false' ? false : 1);
  app.use(requestId);
  app.use(securityHeaders);
  if (process.env.NODE_ENV !== 'test') app.use(pinoHttp({ logger, customProps: (_req, res) => ({ requestId: res.locals.requestId }), autoLogging: { ignore: (req) => req.url === '/healthz' } }));

  // ---------------- health
  app.get('/healthz', (_req, res) => { res.json({ ok: true }); });
  app.get('/readyz', async (_req, res) => {
    const checks: Record<string, string> = {};
    // Details go to the log, never to the (public) response.
    try { await db().$queryRaw`SELECT 1`; checks.database = 'ok'; } catch (e) { checks.database = 'error'; logger.error({ err: (e as Error).message }, 'readyz: database'); }
    try { await redis().ping(); checks.redis = 'ok'; } catch (e) { checks.redis = 'error'; logger.error({ err: (e as Error).message }, 'readyz: redis'); }
    const ok = Object.values(checks).every((v) => v === 'ok');
    res.status(ok ? 200 : 503).json({ ok, checks });
  });
  // Prometheus metrics for monitoring/alerting. Disabled (404) unless METRICS_TOKEN is set; scrapers send it as a bearer token.
  app.get('/metrics', async (req, res, next) => {
    try {
      const token = process.env.METRICS_TOKEN;
      const given = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!token || given.length !== token.length || !(await import('node:crypto')).timingSafeEqual(Buffer.from(given), Buffer.from(token))) { res.status(404).end(); return; }
      res.type('text/plain; version=0.0.4').send(await (await import('./core/metrics.js')).prometheusText());
    } catch (e) { next(e); }
  });

  // ---------------- raw-body public endpoints (registered before the JSON parser)
  app.post('/api/v1/hooks/booking/:workspaceId', express.text({ type: '*/*', limit: '256kb' }), async (req, res, next) => {
    try {
      const r = await rateLimit(`booking:${req.ip}`, 120, 60);
      if (!r.allowed) throw new AppError('RATE_LIMITED', 'Too many requests', 429);
      const sig = (req.headers['x-emn-signature'] ?? req.headers['x-cal-signature-256'] ?? req.headers['calendly-webhook-signature']) as string | undefined;
      res.json(await ops.handleBookingWebhook(String(req.params.workspaceId), typeof req.body === 'string' ? req.body : '', sig));
    } catch (e) { next(e); }
  });

  // Payment provider webhooks: signature is verified over the exact raw body.
  app.post('/api/v1/webhooks/billing/:provider', express.text({ type: '*/*', limit: '512kb' }), async (req, res, next) => {
    try {
      const provider = req.params.provider === 'stripe' || req.params.provider === 'razorpay' ? req.params.provider : null;
      if (!provider) throw new AppError('NOT_FOUND', 'Unknown provider', 404);
      const r = await rateLimit(`billing-hook:${req.ip}`, 600, 60);
      if (!r.allowed) throw new AppError('RATE_LIMITED', 'Too many requests', 429);
      res.json(await billing.handleWebhook(provider, typeof req.body === 'string' ? req.body : '', req.headers as Record<string, string | undefined>));
    } catch (e) { next(e); }
  });

  // Inbound workflow trigger (token per workflow, shown once when rotated).
  app.post('/api/v1/hooks/workflow/:id', express.json({ limit: '256kb' }), async (req, res, next) => {
    try {
      const r = await rateLimit(`wf-hook:${req.params.id}`, 300, 60);
      if (!r.allowed) throw new AppError('RATE_LIMITED', 'Too many requests', 429);
      if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) throw new AppError('NOT_FOUND', 'Workflow not found', 404);
      res.status(202).json(await workflows.receiveWebhook(String(req.params.id), req.headers['x-emn-workflow-token'] as string | undefined, req.body));
    } catch (e) { next(e); }
  });

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(authenticate(process.env.APP_URL ?? 'http://localhost:3000'));

  // ---------------- OAuth callbacks (browser redirects)
  app.get('/api/v1/oauth/callback/:provider', async (req, res) => {
    const provider = req.params.provider === 'google' ? 'GMAIL' : req.params.provider === 'microsoft' ? 'MICROSOFT' : null;
    const base = process.env.APP_URL ?? '';
    try {
      if (!provider) throw new AppError('NOT_FOUND', 'Unknown provider', 404);
      if (req.query.error) throw new AppError('OAUTH_DENIED', String(req.query.error_description ?? req.query.error), 400);
      const r = await accounts.oauthCallback(provider, String(req.query.code ?? ''), String(req.query.state ?? ''));
      res.redirect(`${base}/w/${r.workspaceId}/email-accounts?connected=${encodeURIComponent(r.email)}`);
    } catch (e) {
      logger.warn({ err: e }, 'oauth callback failed');
      res.redirect(`${base}/oauth-error?message=${encodeURIComponent((e as Error).message.slice(0, 300))}`);
    }
  });

  // ---------------- Microsoft Graph change notifications
  app.post('/api/v1/webhooks/graph', async (req, res) => {
    if (typeof req.query.validationToken === 'string') { res.type('text/plain').send(req.query.validationToken); return; }
    res.status(202).end(); // respond quickly; work is queued
    accounts.handleGraphNotifications(req.body ?? {}).catch((e) => logger.error({ err: e }, 'graph notification handling failed'));
  });

  // ---------------- Public unsubscribe (RFC 8058 one-click POST + link-based confirmation)
  app.post('/api/v1/public/unsubscribe/:token', async (req, res, next) => {
    try {
      const r = await rateLimit(`unsub:${req.ip}`, 60, 60);
      if (!r.allowed) throw new AppError('RATE_LIMITED', 'Too many requests', 429);
      const out = await compliance.processUnsubscribe(String(req.params.token), process.env.SESSION_SECRET ?? '');
      res.json({ ok: true, sender: out.workspaceName });
    } catch (e) { next(e); }
  });

  // ---------------- Optional tracking endpoints (only record when the campaign enabled tracking)
  app.get('/api/v1/public/t/o/:id.gif', async (req, res) => {
    await ops.recordOpen(String(req.params.id)).catch(() => undefined);
    res.setHeader('cache-control', 'no-store, private');
    res.type('image/gif').send(ops.PIXEL);
  });
  app.get('/api/v1/public/t/c/:token', async (req, res) => {
    const url = await ops.recordClick(String(req.params.token)).catch(() => null);
    if (!url || !/^https?:\/\//.test(url)) { res.status(404).send('Link not found'); return; }
    res.redirect(302, url);
  });

  // ---------------- Realtime (SSE)
  app.get('/api/v1/w/:workspaceId/events', async (req, res, next) => {
    try {
      const resolve = res.locals.resolveMembership as ((id: string) => Promise<unknown>) | undefined;
      const m = resolve ? await resolve(String(req.params.workspaceId)) as { orgStatus?: string } | null : null;
      if (!m) throw new AppError('NOT_FOUND', 'Workspace not found', 404);
      // Organizations being deleted (or deleted) get no live stream, like every other workspace route.
      if (m.orgStatus === 'DELETION_PENDING' || m.orgStatus === 'DELETED') throw new AppError('TENANT_INACTIVE', 'This organization is closed', 403);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': connected\n\n');
      const sub = newRedis();
      await sub.subscribe(`events:${req.params.workspaceId}`);
      sub.on('message', (_ch, msg) => res.write(`data: ${msg}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); void sub.quit(); });
    } catch (e) { next(e); }
  });

  app.get('/api/v1/openapi.json', (_req, res) => { res.json(buildOpenApi(routes)); });

  mountRoutes(app);
  app.use('/api', (_req, res) => { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }); });
  app.use(errorHandler);
  return app;
}

