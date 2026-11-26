import { z } from 'zod';
import { route } from '../http/router.js';
import * as domains from '../services/domains.js';
import * as enrichment from '../services/enrichment.js';
import { enqueue, QUEUES } from '../core/queues.js';
import { db } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import * as firstParty from '../services/first-party-verification.js';
import { config } from '../core/config.js';
import { redis } from '../core/redis.js';
import { queue } from '../core/queues.js';
import { diagnoseSmtpConnectivity } from '../../../integrations/src/email-verification-smtp.js';
import * as verificationDatasets from '../services/email-verification-datasets.js';
import * as verificationCsv from '../services/verification-csv.js';
import multer from 'multer';
import { putTracked, deleteTracked } from '../services/storage-accounting.js';
import { audit } from '../core/audit.js';
import { readSettings } from '../services/workspace.js';
import { getSecret } from '../services/integrations.js';

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => cb(null, file.originalname.toLowerCase().endsWith('.csv')) }).single('file');
const parseCsvUpload = (ctx: import('../http/router.js').Ctx<any, any>) => new Promise<void>((resolve, reject) => csvUpload(ctx.req, ctx.res, (e) => e ? reject(e) : resolve()));

route({ method: 'get', path: '/w/:workspaceId/provider-registry', tag: 'Deliverability', summary: 'Registrar / DNS / mailbox-provider capability registry (what is automated vs manual)', auth: 'workspace', role: 'VIEWER', handler: async () => domains.providerRegistry() });
route({ method: 'post', path: '/w/:workspaceId/domains/:id/verification', tag: 'Deliverability', summary: 'Start ownership verification (returns the TXT record to add)', auth: 'workspace', role: 'ADMIN', status: 200, handler: (c) => domains.startVerification(c.workspaceId, c.params.id, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/domains/:id/verification/check', tag: 'Deliverability', summary: 'Check the ownership TXT record', auth: 'workspace', role: 'ADMIN', status: 200, rateLimit: { limit: 30, windowSec: 600, key: 'workspace' }, handler: (c) => domains.checkOwnership(c.workspaceId, c.params.id, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/domains/:id/propagation', tag: 'Deliverability', summary: 'Compare SPF/DMARC/verification across Cloudflare, Google and Quad9 resolvers', auth: 'workspace', role: 'MEMBER', status: 200, rateLimit: { limit: 30, windowSec: 600, key: 'workspace' }, handler: (c) => domains.checkPropagation(c.workspaceId, c.params.id) });
route({ method: 'get', path: '/w/:workspaceId/domains/:id/recommended-records', tag: 'Deliverability', summary: 'DNS guidance for the mailbox providers on this domain', auth: 'workspace', role: 'VIEWER', handler: (c) => domains.recommendedRecords(c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/domains/:id/dns-records', tag: 'Deliverability', summary: 'Create one DNS record via the connected DNS provider (Cloudflare) — explicit action only', auth: 'workspace', role: 'ADMIN', body: domains.ApplyRecordSchema, handler: (c) => domains.applyRecord(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/domains/:id/zone-records', tag: 'Deliverability', summary: 'Live DNS records of the domain from the connected DNS provider', auth: 'workspace', role: 'ADMIN', handler: (c) => domains.listZoneRecords(c.workspaceId, c.params.id) });
route({ method: 'put', path: '/w/:workspaceId/domains/:id/zone-records/:recordId', tag: 'Deliverability', summary: 'Change one record’s value (refused if it changed since you loaded it; NS/SOA protected); audited', auth: 'workspace', role: 'ADMIN', rateLimit: { limit: 30, windowSec: 600, key: 'workspace' },
  body: domains.EditRecordSchema, handler: (c) => domains.editZoneRecord(c.workspaceId, c.params.id, c.params.recordId, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/domains/:id/zone-records/:recordId', tag: 'Deliverability', summary: 'Delete one record after typing its name (NS/SOA protected); audited', auth: 'workspace', role: 'ADMIN', status: 200, rateLimit: { limit: 30, windowSec: 600, key: 'workspace' },
  body: domains.DeleteRecordSchema, handler: (c) => domains.deleteZoneRecord(c.workspaceId, c.params.id, c.params.recordId, c.body, c.actor) });
route({ method: 'patch', path: '/w/:workspaceId/domains/:id/renewal', tag: 'Deliverability', summary: 'Registrar, expiry date and auto-renew (for renewal reminders)', auth: 'workspace', role: 'ADMIN', body: domains.RenewalSchema, handler: (c) => domains.updateRenewal(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/mailbox-health', tag: 'Mailboxes', summary: 'Connection, auth, sync, send/receive, errors, bounces, complaints and DNS per mailbox', auth: 'workspace', role: 'VIEWER', handler: (c) => domains.mailboxHealth(c.workspaceId) });

route({ method: 'post', path: '/w/:workspaceId/leads/:id/verify-waterfall', tag: 'Enrichment', summary: 'Verify one lead using the workspace-selected custom or external mode', auth: 'workspace', role: 'MEMBER', status: 200, rateLimit: { limit: 300, windowSec: 3600, key: 'workspace' }, body: z.object({ force: z.boolean().default(false) }), handler: (c) => enrichment.verifyConfigured(c.workspaceId, c.params.id, { force: c.body.force }) });
route({ method: 'post', path: '/w/:workspaceId/enrichment/verify-bulk', tag: 'Enrichment', summary: 'Queue lead verification using the workspace-selected custom or external mode', auth: 'workspace', role: 'MEMBER', status: 202, body: z.object({ leadIds: z.array(z.string().uuid()).min(1).max(5000), force: z.boolean().default(false) }),
  handler: async (c) => {
    const [leads, ws] = await Promise.all([
      db().lead.findMany({ where: { workspaceId: c.workspaceId, id: { in: c.body.leadIds } }, select: { id: true, emailNormalized: true } }),
      db().workspace.findUniqueOrThrow({ where: { id: c.workspaceId }, select: { settings: true } }),
    ]);
    if (leads.length !== new Set(c.body.leadIds).size) throw NotFound('Lead');
    const settings = readSettings(ws.settings);
    let queued = 0;
    if (settings.emailVerificationMode === 'external') {
      const providers = [...new Set([...settings.verifierOrder, ...(settings.verifierProvider === 'none' ? [] : [settings.verifierProvider])])];
      let configured = false;
      for (const provider of providers) if (await getSecret(c.workspaceId, provider)) { configured = true; break; }
      if (!configured) throw new AppError('PROVIDER_NOT_CONFIGURED', 'External mode is selected, but no verifier API key is configured. Add one under Settings → Integrations, or switch to Custom Verification.', 400);
      queued = leads.length;
      for (const l of leads) await enqueue(QUEUES.verify, 'verify.lead', { workspaceId: c.workspaceId, leadId: l.id, force: c.body.force, freshDays: settings.verificationFreshnessDays }, { jobId: `verify-${l.id}-${c.body.force ? 'retry' : 'normal'}-${Math.floor(Date.now() / 600_000)}`, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } });
    } else {
      for (let i = 0; i < leads.length; i += 20) {
        await Promise.all(leads.slice(i, i + 20).map(async (l) => {
          const v = await firstParty.createVerification(c.workspaceId, l.emailNormalized, { leadId: l.id, force: c.body.force });
          if (!v.cached) {
            await enqueue(QUEUES.verify, 'verify.address', { workspaceId: c.workspaceId, verificationId: v.id }, { jobId: `fpv-${v.id}`, attempts: 4, backoff: { type: 'emnVerify' } });
            queued++;
          }
        }));
      }
    }
    return { queued, mode: settings.emailVerificationMode === 'external' ? 'external' : 'custom' };
  } });
route({ method: 'post', path: '/w/:workspaceId/enrichment/find-email', tag: 'Enrichment', summary: 'Email discovery waterfall (name + company domain)', auth: 'workspace', role: 'MEMBER', status: 200, rateLimit: { limit: 300, windowSec: 3600, key: 'workspace' }, body: enrichment.FindSchema, handler: (c) => enrichment.findEmail(c.workspaceId, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/enrichment/stats', tag: 'Enrichment', summary: 'Provider comparison: checks, definitive rate, credits', auth: 'workspace', role: 'VIEWER', query: z.object({ days: z.coerce.number().int().min(1).max(365).default(90) }), handler: (c) => enrichment.enrichmentStats(c.workspaceId, c.query.days) });
route({ method: 'get', path: '/w/:workspaceId/leads/:id/verifications', tag: 'Enrichment', summary: 'Verification / enrichment history for a lead', auth: 'workspace', role: 'VIEWER', handler: (c) => enrichment.verificationHistory(c.workspaceId, c.params.id) });

route({ method: 'post', path: '/w/:workspaceId/email-verification/verify', tag: 'Enrichment', summary: 'Queue first-party syntax, disposable, role, free-provider and DNS checks; optional SMTP RCPT probing when enabled (never sends email)', auth: 'workspace', role: 'MEMBER', status: 202, rateLimit: { limit: 60, windowSec: 3600, key: 'workspace' }, body: z.object({ email: z.string().trim().min(3).max(254), leadId: z.string().uuid().optional() }), handler: async (c) => {
  if (c.body.leadId && !await db().lead.findFirst({ where: { id: c.body.leadId, workspaceId: c.workspaceId }, select: { id: true } })) throw NotFound('Lead');
  const v = await firstParty.createVerification(c.workspaceId, c.body.email, { leadId: c.body.leadId });
  if (!v.cached) await enqueue(QUEUES.verify, 'verify.address', { workspaceId: c.workspaceId, verificationId: v.id }, { jobId: `fpv-${v.id}`, attempts: 4, backoff: { type: 'emnVerify' } });
  if (!v.cached) await audit(c.workspaceId, c.actor, 'email_verification.queued', { type: 'verification', id: v.id }, { source: 'individual', linkedLead: !!c.body.leadId });
  return v;
} });

route({ method: 'post', path: '/w/:workspaceId/email-verification/bulk', tag: 'Enrichment', summary: 'Queue deduplicated first-party verification for an email list; optional SMTP RCPT probing when enabled (never sends email)', auth: 'workspace', role: 'MEMBER', status: 202, rateLimit: { limit: 10, windowSec: 3600, key: 'workspace' }, body: z.object({ emails: z.array(z.string().trim().min(3).max(254)).min(1).max(1000) }), handler: async (c) => {
  const emails = [...new Map(c.body.emails.map((email) => [email.trim().normalize('NFC').toLowerCase(), email.trim().normalize('NFC')])).values()];
  const batch = await db().emailVerificationBatch.create({ data: { workspaceId: c.workspaceId, createdBy: c.userId, total: emails.length } });
  const rows: Awaited<ReturnType<typeof firstParty.createVerification>>[] = [];
  // Bound concurrent Prisma work for large (up to 1,000 row) JSON batches.
  for (let i = 0; i < emails.length; i += 20) {
    rows.push(...await Promise.all(emails.slice(i, i + 20).map((email) => firstParty.createVerification(c.workspaceId, email, { batchId: batch.id }))));
  }
  const cachedCount = rows.filter((v) => v.cached).length;
  await db().emailVerificationBatch.update({ where: { id: batch.id }, data: { processed: cachedCount, status: cachedCount === emails.length ? 'COMPLETED' : 'PROCESSING', ...(cachedCount === emails.length ? { completedAt: new Date() } : {}) } });
  for (const v of rows) if (!v.cached) await enqueue(QUEUES.verify, 'verify.address', { workspaceId: c.workspaceId, verificationId: v.id }, { jobId: `fpv-${v.id}`, attempts: 4, backoff: { type: 'emnVerify' } });
  await audit(c.workspaceId, c.actor, 'email_verification.batch_queued', { type: 'verification_batch', id: batch.id }, { total: emails.length, queued: emails.length - cachedCount, cached: cachedCount });
  return { batchId: batch.id, total: emails.length, queued: emails.length - cachedCount, cached: cachedCount };
} });

route({ method: 'post', path: '/w/:workspaceId/email-verification/bulk.csv', tag: 'Enrichment', summary: 'Upload a bounded CSV for streaming background verification; maximum 10 MB', auth: 'workspace', role: 'MANAGER', status: 202, rateLimit: { limit: 5, windowSec: 3600, key: 'workspace' }, body: z.object({ emailColumn: z.string().trim().max(100).optional(), hasHeader: z.enum(['true','false']).default('true') }), prepare: parseCsvUpload, handler: async (c) => {
  const file = c.req.file;
  if (!file || !file.originalname.toLowerCase().endsWith('.csv')) throw new AppError('VALIDATION_FAILED', 'Upload one .csv file', 400);
  const fields = c.body;
  const safeName = file.originalname.replace(/[\\/\r\n\t]/g, '_').slice(0, 120) || 'verification.csv';
  const batch = await db().emailVerificationBatch.create({ data: { workspaceId: c.workspaceId, createdBy: c.userId, status: 'INGESTING', fileName: safeName, fileSizeBytes: BigInt(file.size), emailColumn: fields.emailColumn ?? null, hasHeader: fields.hasHeader === 'true' } });
  let storageKey: string | undefined;
  try {
    storageKey = await putTracked(c.workspaceId, 'email-verification', file.buffer, 'csv', { enforce: true });
    await db().emailVerificationBatch.update({ where: { id: batch.id }, data: { storageKey } });
    const job = await enqueue(QUEUES.verify, 'verify.csv-import', { workspaceId: c.workspaceId, batchId: batch.id }, { jobId: `fpv-import-${batch.id}`, attempts: 3, backoff: { type: 'exponential', delay: 10_000 } });
    await audit(c.workspaceId, c.actor, 'email_verification.csv_uploaded', { type: 'verification_batch', id: batch.id }, { bytes: file.size, hasHeader: fields.hasHeader === 'true' });
    return { batchId: batch.id, fileName: safeName, bytes: file.size, status: 'INGESTING', jobId: job.id };
  } catch (e) {
    if (storageKey) await deleteTracked(storageKey).catch(() => undefined);
    await db().emailVerificationBatch.update({ where: { id: batch.id }, data: { status: 'FAILED_IMPORT', error: (e as Error).message.slice(0, 200), completedAt: new Date() } });
    throw e;
  }
} });

route({ method: 'get', path: '/w/:workspaceId/email-verification/batches', tag: 'Enrichment', summary: 'List first-party verification batches', auth: 'workspace', role: 'VIEWER', query: z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }), handler: async (c) => {
  const [data, total] = await Promise.all([db().emailVerificationBatch.findMany({ where: { workspaceId: c.workspaceId }, orderBy: { createdAt: 'desc' }, skip: (c.query.page - 1) * c.query.pageSize, take: c.query.pageSize }), db().emailVerificationBatch.count({ where: { workspaceId: c.workspaceId } })]);
  return { data: data.map(({ storageKey: _storageKey, fileSizeBytes, ...row }) => ({ ...row, fileSizeBytes: fileSizeBytes == null ? null : Number(fileSizeBytes) })), total, page: c.query.page, pageSize: c.query.pageSize };
} });

route({ method: 'get', path: '/w/:workspaceId/email-verification/batches/:id', tag: 'Enrichment', summary: 'Get tenant-scoped paginated verification batch results', auth: 'workspace', role: 'VIEWER', query: z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(100) }), handler: async (c) => {
  const batch = await db().emailVerificationBatch.findFirst({ where: { id: c.params.id, workspaceId: c.workspaceId }, select: { id: true, workspaceId: true, createdBy: true, status: true, total: true, processed: true, createdAt: true, completedAt: true, fileName: true, fileSizeBytes: true, emailColumn: true, hasHeader: true, csvHeaders: true, error: true } });
  if (!batch) throw NotFound('Verification batch');
  const [verifications, total] = await Promise.all([db().emailVerification.findMany({ where: { batchId: batch.id, workspaceId: c.workspaceId }, orderBy: { email: 'asc' }, skip: (c.query.page - 1) * c.query.pageSize, take: c.query.pageSize }), db().emailVerification.count({ where: { batchId: batch.id, workspaceId: c.workspaceId } })]);
  return { ...batch, fileSizeBytes: batch.fileSizeBytes == null ? null : Number(batch.fileSizeBytes), verifications, resultCount: total, page: c.query.page, pageSize: c.query.pageSize };
} });

route({ method: 'get', path: '/w/:workspaceId/email-verification/batches/:id/export.csv', tag: 'Enrichment', summary: 'Stream a tenant-scoped CSV export with verification columns and spreadsheet formula protection', auth: 'workspace', role: 'VIEWER', raw: true, handler: async (c) => verificationCsv.streamVerificationBatchCsv(c.workspaceId, c.params.id, c.res) });

route({ method: 'post', path: '/w/:workspaceId/email-verification/batches/:id/pause', tag: 'Enrichment', summary: 'Pause a processing batch; active checks may finish', auth: 'workspace', role: 'MANAGER', handler: async (c) => {
  const batch = await db().emailVerificationBatch.findFirst({ where: { id: c.params.id, workspaceId: c.workspaceId } });
  if (!batch) throw NotFound('Verification batch');
  if (batch.status !== 'PROCESSING') throw new AppError('CAMPAIGN_STATE', `Cannot pause batch from ${batch.status}`, 409);
  await db().emailVerificationBatch.update({ where: { id: batch.id }, data: { status: 'PAUSED' } });
  await audit(c.workspaceId, c.actor, 'email_verification.batch_paused', { type: 'verification_batch', id: batch.id }, {});
  return { status: 'PAUSED' };
} });

route({ method: 'post', path: '/w/:workspaceId/email-verification/batches/:id/resume', tag: 'Enrichment', summary: 'Resume queued rows of a paused verification batch', auth: 'workspace', role: 'MANAGER', status: 202, handler: async (c) => {
  const batch = await db().emailVerificationBatch.findFirst({ where: { id: c.params.id, workspaceId: c.workspaceId } });
  if (!batch) throw NotFound('Verification batch');
  if (batch.status !== 'PAUSED') throw new AppError('CAMPAIGN_STATE', `Cannot resume batch from ${batch.status}`, 409);
  const actionId = String(Date.now());
  await db().emailVerificationBatch.update({ where: { id: batch.id }, data: { status: 'PROCESSING', completedAt: null } });
  await enqueue(QUEUES.verify, 'verify.batch-resume', { workspaceId: c.workspaceId, batchId: batch.id, actionId }, { jobId: `fpv-resume-${batch.id}-${actionId}`, attempts: 3, backoff: { type: 'exponential', delay: 10_000 } });
  await audit(c.workspaceId, c.actor, 'email_verification.batch_resumed', { type: 'verification_batch', id: batch.id }, {});
  return { status: 'PROCESSING', batchId: batch.id };
} });

route({ method: 'post', path: '/w/:workspaceId/email-verification/batches/:id/retry', tag: 'Enrichment', summary: 'Retry failed rows in a verification batch', auth: 'workspace', role: 'MANAGER', status: 202, handler: async (c) => {
  const batch = await db().emailVerificationBatch.findFirst({ where: { id: c.params.id, workspaceId: c.workspaceId } });
  if (!batch) throw NotFound('Verification batch');
  const failed = await db().emailVerification.count({ where: { batchId: batch.id, workspaceId: c.workspaceId, provider: 'first-party-dns', rawResult: 'failed' } });
  if (!failed) return { batchId: batch.id, retried: 0 };
  await db().$transaction(async (tx) => {
    // Keep the uploaded CSV row (originalRow/sourceRow) so the export still lines up after a retry.
    await tx.$executeRaw`UPDATE "EmailVerification" SET "rawResult" = 'queued', "result" = 'UNKNOWN', "step" = 1,
      "details" = jsonb_build_object('state', 'QUEUED', 'manualRetry', true) || jsonb_strip_nulls(jsonb_build_object('originalRow', "details"->'originalRow', 'sourceRow', "details"->'sourceRow'))
      WHERE "batchId" = ${batch.id}::uuid AND "workspaceId" = ${c.workspaceId}::uuid AND "provider" = 'first-party-dns' AND "rawResult" = 'failed'`;
    await tx.emailVerificationBatch.update({ where: { id: batch.id }, data: { processed: Math.max(0, batch.processed - failed), status: 'PROCESSING', completedAt: null, error: null } });
  });
  const actionId = String(Date.now());
  await enqueue(QUEUES.verify, 'verify.batch-resume', { workspaceId: c.workspaceId, batchId: batch.id, actionId }, { jobId: `fpv-retry-${batch.id}-${actionId}`, attempts: 3, backoff: { type: 'exponential', delay: 10_000 } });
  await audit(c.workspaceId, c.actor, 'email_verification.batch_retried', { type: 'verification_batch', id: batch.id }, { retried: failed });
  return { batchId: batch.id, retried: failed };
} });

route({ method: 'post', path: '/w/:workspaceId/email-verification/batches/:id/cancel', tag: 'Enrichment', summary: 'Cancel pending rows in a verification batch', auth: 'workspace', role: 'MANAGER', handler: async (c) => {
  const batch = await db().emailVerificationBatch.findFirst({ where: { id: c.params.id, workspaceId: c.workspaceId } });
  if (!batch) throw NotFound('Verification batch');
  if (['COMPLETED','COMPLETED_WITH_ERRORS','CANCELLED'].includes(batch.status)) throw new AppError('CAMPAIGN_STATE', `Cannot cancel batch from ${batch.status}`, 409);
  await db().$transaction(async (tx) => {
    await tx.emailVerification.updateMany({ where: { batchId: batch.id, workspaceId: c.workspaceId, rawResult: { in: ['queued','failed'] } }, data: { rawResult: 'cancelled' } });
    await tx.emailVerificationBatch.update({ where: { id: batch.id }, data: { status: 'CANCELLED', processed: batch.total, completedAt: new Date() } });
  });
  await audit(c.workspaceId, c.actor, 'email_verification.batch_cancelled', { type: 'verification_batch', id: batch.id }, {});
  return { status: 'CANCELLED', note: 'Active SMTP checks may finish before worker shutdown.' };
} });

route({ method: 'get', path: '/w/:workspaceId/email-verification/datasets', tag: 'Enrichment', summary: 'List shared disposable dataset metadata and workspace overrides', auth: 'workspace', role: 'VIEWER', handler: (c) => verificationDatasets.listVerificationDatasets(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/email-verification/datasets/refresh', tag: 'Enrichment', summary: 'Queue refresh from the pinned public disposable-domain source', auth: 'workspace', role: 'ADMIN', status: 202, rateLimit: { limit: 1, windowSec: 3600, key: 'workspace' }, handler: async (c) => { const j = await enqueue(QUEUES.maintenance, 'emailVerification.datasets.refresh', { workspaceId: c.workspaceId }, { jobId: `verification-dataset-refresh-${Math.floor(Date.now() / 3600_000)}`, attempts: 3, backoff: { type: 'exponential', delay: 60_000 } }); return { queued: true, jobId: j.id }; } });
route({ method: 'post', path: '/w/:workspaceId/email-verification/domain-overrides', tag: 'Enrichment', summary: 'Add or exclude a domain from this workspace disposable-domain classification', auth: 'workspace', role: 'ADMIN', body: z.object({ domain: z.string().min(1).max(253), disposable: z.boolean() }), handler: (c) => verificationDatasets.setDomainOverride(c.workspaceId, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/email-verification/domain-overrides/:id', tag: 'Enrichment', summary: 'Remove a workspace disposable-domain override', auth: 'workspace', role: 'ADMIN', handler: (c) => verificationDatasets.removeDomainOverride(c.workspaceId, c.params.id, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/email-verification/role-patterns', tag: 'Enrichment', summary: 'Add or disable a workspace role-based local-part pattern', auth: 'workspace', role: 'ADMIN', body: z.object({ localPart: z.string().min(1).max(64), enabled: z.boolean().default(true) }), handler: (c) => verificationDatasets.setRolePattern(c.workspaceId, c.body, c.actor) });

route({ method: 'get', path: '/w/:workspaceId/email-verification/history', tag: 'Enrichment', summary: 'Search tenant-scoped first-party verification history', auth: 'workspace', role: 'VIEWER', query: z.object({ email: z.string().max(254).optional(), status: z.enum(['UNVERIFIED','VALID','INVALID','RISKY','CATCH_ALL','UNKNOWN']).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }), handler: async (c) => {
  const where = { workspaceId: c.workspaceId, provider: 'first-party-dns', ...(c.query.email ? { email: { contains: c.query.email.trim().toLowerCase() } } : {}), ...(c.query.status ? { result: c.query.status } : {}) };
  const [data,total] = await Promise.all([db().emailVerification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (c.query.page-1)*c.query.pageSize, take: c.query.pageSize }), db().emailVerification.count({ where })]);
  return { data,total,page:c.query.page,pageSize:c.query.pageSize };
} });

route({ method: 'get', path: '/w/:workspaceId/email-verification/:id', tag: 'Enrichment', summary: 'Get tenant-scoped first-party verification result', auth: 'workspace', role: 'VIEWER', handler: async (c) => {
  const result = await db().emailVerification.findFirst({ where: { id: c.params.id, workspaceId: c.workspaceId, provider: 'first-party-dns' } });
  if (!result) throw NotFound('Verification');
  return result;
} });

route({ method: 'post', path: '/w/:workspaceId/email-verification/diagnostics', tag: 'Enrichment', summary: 'Admin-only outbound SMTP port 25 diagnostic to the configured verification sender domain MX; sends no recipient commands or email', auth: 'workspace', role: 'ADMIN', status: 200, rateLimit: { limit: 1, windowSec: 3600, key: 'workspace' }, handler: async (c) => {
  const env = config();
  const workspace = await db().workspace.findFirst({ where: { id: c.workspaceId }, select: { settings: true } });
  const mailFrom = readSettings(workspace?.settings).verificationSmtpMailFrom || env.EMAIL_VERIFY_MAIL_FROM;
  const [smtp, redisStatus, verificationQueue] = await Promise.all([
    diagnoseSmtpConnectivity(mailFrom, { enabled: env.EMAIL_VERIFY_SMTP_ENABLED, timeoutMs: env.EMAIL_VERIFY_SMTP_TIMEOUT_MS }),
    redis().ping().then(() => 'CONNECTED').catch(() => 'UNAVAILABLE'),
    queue(QUEUES.verify).getJobCounts('waiting','active','delayed','failed','completed').catch(() => null),
  ]);
  return { smtpEnabled: env.EMAIL_VERIFY_SMTP_ENABLED, catchAllProbeEnabled: env.EMAIL_VERIFY_CATCH_ALL_ENABLED, mailFromConfigured: !!mailFrom, smtp, redis: redisStatus, verificationQueue };
} });
