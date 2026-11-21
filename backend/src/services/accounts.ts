import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { adapters } from '../core/container.js';
import { pkcePair, randomToken, sha256 } from '../core/crypto.js';
import { AppError, NotFound } from '../core/errors.js';
import { acquireLock, redis } from '../core/redis.js';
import { audit, notifyWorkspace, publish, type Actor } from '../core/audit.js';
import { enqueue, QUEUES } from '../core/queues.js';
import { logger } from '../core/logger.js';
import { ProviderError } from '../../../integrations/src/http.js';
import type { AuthHandle, SmtpImapConfig } from '../../../integrations/src/email/types.js';
import { decryptSecret, encryptSecret } from './workspace.js';
import { SendingWindowSchema, startOfDayIn } from '../../../shared/src/schedule.js';

type OAuthProvider = 'GMAIL' | 'MICROSOFT';

export const AccountWindowSchema = SendingWindowSchema.extend({ enabled: z.boolean().default(false), timezone: z.string().default('UTC') });

function redirectUri(provider: OAuthProvider) {
  return `${process.env.APP_URL}/api/v1/oauth/callback/${provider === 'GMAIL' ? 'google' : 'microsoft'}`;
}

export async function oauthStart(workspaceId: string, provider: OAuthProvider, actor: Actor, loginHint?: string) {
  await (await import('./billing.js')).assertEntitled(workspaceId, 'mailboxes');
  const client = adapters().oauth[provider];
  if (!client) throw new AppError('PROVIDER_NOT_CONFIGURED', `${provider === 'GMAIL' ? 'Google' : 'Microsoft'} OAuth app is not configured on this server (set ${provider === 'GMAIL' ? 'GOOGLE_CLIENT_ID/SECRET' : 'MICROSOFT_CLIENT_ID/SECRET'} in .env). See INSTALLATION.md.`, 400);
  const state = randomToken(24);
  const { verifier, challenge } = pkcePair();
  await redis().set(`oauth:state:${state}`, JSON.stringify({ workspaceId, provider, verifier, userId: actor.userId }), 'EX', 600);
  return { url: client.buildAuthUrl({ state, codeChallenge: challenge, redirectUri: redirectUri(provider), loginHint }) };
}

export async function oauthCallback(provider: OAuthProvider, code: string, state: string) {
  const raw = await redis().getdel(`oauth:state:${state}`);
  if (!raw) throw new AppError('OAUTH_STATE_INVALID', 'OAuth session expired or invalid. Start the connection again.', 400);
  const st = JSON.parse(raw) as { workspaceId: string; provider: OAuthProvider; verifier: string; userId: string | null };
  if (st.provider !== provider) throw new AppError('OAUTH_STATE_INVALID', 'Provider mismatch', 400);
  const client = adapters().oauth[provider]!;
  const t = await client.exchangeCode({ code, codeVerifier: st.verifier, redirectUri: redirectUri(provider) });
  if (!t.refreshToken) throw new AppError('OAUTH_NO_REFRESH', 'The provider did not return a refresh token. Remove the app from your account permissions and connect again.', 400);
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: st.workspaceId } });
  const email = t.profile.email;
  const domainName = email.split('@')[1];
  const domain = await db().domain.upsert({ where: { workspaceId_name: { workspaceId: ws.id, name: domainName } }, update: {}, create: { workspaceId: ws.id, name: domainName } });
  const account = await db().emailAccount.upsert({
    where: { workspaceId_emailAddress: { workspaceId: ws.id, emailAddress: email } },
    update: { provider, status: 'CONNECTED', statusReason: null, providerAccountId: t.profile.providerAccountId, displayName: t.profile.displayName, lastError: null },
    create: { workspaceId: ws.id, provider, emailAddress: email, displayName: t.profile.displayName, providerAccountId: t.profile.providerAccountId, domainId: domain.id, sendingWindow: { enabled: false, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', timezone: ws.timezone } },
  });
  const cred = { encryptedAccessToken: encryptSecret(t.accessToken), encryptedRefreshToken: encryptSecret(t.refreshToken), accessTokenExpiresAt: t.expiresAt, scopes: t.scopes };
  await db().providerCredential.upsert({ where: { emailAccountId: account.id }, update: cred, create: { workspaceId: ws.id, emailAccountId: account.id, ...cred } });
  await audit(ws.id, { type: 'USER', userId: st.userId }, 'email_account.connected', { type: 'email_account', id: account.id }, { provider, email });
  await enqueue(QUEUES.sync, 'sync.account', { workspaceId: ws.id, accountId: account.id }, { jobId: `sync-initial-${account.id}-${Date.now()}` });
  await enqueue(QUEUES.domain, 'domain.check', { workspaceId: ws.id, domainId: domain.id });
  if (provider === 'MICROSOFT' && process.env.GRAPH_WEBHOOKS_ENABLED === 'true') await ensureGraphSubscription(account.id).catch((e) => logger.warn({ err: e }, 'graph subscription failed'));
  return { workspaceId: ws.id, accountId: account.id, email };
}

export const SmtpConnectSchema = z.object({
  emailAddress: z.string().email(),
  displayName: z.string().max(100).optional(),
  password: z.string().min(1).max(500),
  smtpHost: z.string().min(1), smtpPort: z.number().int().min(1).max(65535), smtpSecure: z.boolean(),
  imapHost: z.string().min(1), imapPort: z.number().int().min(1).max(65535), imapSecure: z.boolean(),
  username: z.string().min(1),
  sentFolder: z.string().default('Sent'),
  appendToSent: z.boolean().default(false),
});

export async function connectSmtp(workspaceId: string, input: z.infer<typeof SmtpConnectSchema>, actor: Actor) {
  await (await import('./billing.js')).assertEntitled(workspaceId, 'mailboxes');
  const email = input.emailAddress.toLowerCase();
  const config: SmtpImapConfig = { smtpHost: input.smtpHost, smtpPort: input.smtpPort, smtpSecure: input.smtpSecure, imapHost: input.imapHost, imapPort: input.imapPort, imapSecure: input.imapSecure, username: input.username, sentFolder: input.sentFolder, appendToSent: input.appendToSent };
  try {
    await adapters().email.SMTP_IMAP.testConnection({ kind: 'password', email, password: input.password, config });
  } catch (e) {
    throw new AppError('PROVIDER_ERROR', `Connection test failed: ${(e as Error).message}`, 400);
  }
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const domainName = email.split('@')[1];
  const domain = await db().domain.upsert({ where: { workspaceId_name: { workspaceId, name: domainName } }, update: {}, create: { workspaceId, name: domainName } });
  const account = await db().emailAccount.upsert({
    where: { workspaceId_emailAddress: { workspaceId, emailAddress: email } },
    update: { provider: 'SMTP_IMAP', status: 'CONNECTED', connectionConfig: config as unknown as Prisma.InputJsonValue, displayName: input.displayName },
    create: { workspaceId, provider: 'SMTP_IMAP', emailAddress: email, displayName: input.displayName, domainId: domain.id, connectionConfig: config as unknown as Prisma.InputJsonValue, sendingWindow: { enabled: false, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', timezone: ws.timezone } },
  });
  await db().providerCredential.upsert({ where: { emailAccountId: account.id }, update: { encryptedPassword: encryptSecret(input.password) }, create: { workspaceId, emailAccountId: account.id, encryptedPassword: encryptSecret(input.password), scopes: [] } });
  await audit(workspaceId, actor, 'email_account.connected', { type: 'email_account', id: account.id }, { provider: 'SMTP_IMAP', email });
  await enqueue(QUEUES.sync, 'sync.account', { workspaceId, accountId: account.id });
  return account;
}

/** Decrypt credentials, refreshing OAuth tokens under a lock when they expire within 5 minutes. */
export async function getAuth(accountId: string): Promise<AuthHandle> {
  const account = await db().emailAccount.findUnique({ where: { id: accountId }, include: { credential: true } });
  if (!account?.credential) throw new AppError('ACCOUNT_NOT_CONNECTED', 'Mailbox credentials missing', 400);
  if (account.provider === 'SMTP_IMAP') {
    return { kind: 'password', email: account.emailAddress, password: decryptSecret(account.credential.encryptedPassword!), config: account.connectionConfig as unknown as SmtpImapConfig };
  }
  const cred = account.credential;
  const fresh = cred.accessTokenExpiresAt && cred.accessTokenExpiresAt.getTime() > Date.now() + 5 * 60_000;
  if (fresh && cred.encryptedAccessToken) return { kind: 'oauth', accessToken: decryptSecret(cred.encryptedAccessToken), email: account.emailAddress };

  const release = await acquireLock(`token:${accountId}`, 30_000);
  if (!release) {
    await new Promise((r) => setTimeout(r, 1500));
    return getAuth(accountId); // another worker is refreshing
  }
  try {
    const again = await db().providerCredential.findUnique({ where: { emailAccountId: accountId } });
    if (again?.accessTokenExpiresAt && again.accessTokenExpiresAt.getTime() > Date.now() + 5 * 60_000 && again.encryptedAccessToken) {
      return { kind: 'oauth', accessToken: decryptSecret(again.encryptedAccessToken), email: account.emailAddress };
    }
    const client = adapters().oauth[account.provider as OAuthProvider];
    if (!client) throw new AppError('PROVIDER_NOT_CONFIGURED', 'OAuth app not configured', 400);
    try {
      const t = await client.refresh(decryptSecret(cred.encryptedRefreshToken!));
      await db().providerCredential.update({ where: { emailAccountId: accountId }, data: { encryptedAccessToken: encryptSecret(t.accessToken), encryptedRefreshToken: t.refreshToken ? encryptSecret(t.refreshToken) : undefined, accessTokenExpiresAt: t.expiresAt } });
      return { kind: 'oauth', accessToken: t.accessToken, email: account.emailAddress };
    } catch (e) {
      const msg = (e as Error).message;
      if (/invalid_grant|AADSTS700082|AADSTS50173|revoked|expired/i.test(msg) || (e instanceof ProviderError && e.status === 400)) {
        await markNeedsReauth(account.workspaceId, accountId, `Token refresh failed: ${msg.slice(0, 200)}`);
      }
      throw e;
    }
  } finally {
    await release();
  }
}

export async function markNeedsReauth(workspaceId: string, accountId: string, reason: string) {
  const a = await db().emailAccount.update({ where: { id: accountId }, data: { status: 'NEEDS_REAUTH', statusReason: reason, lastError: reason, lastErrorAt: new Date() } });
  await notifyWorkspace(workspaceId, 'ADMIN', { type: 'account.needs_reauth', title: `Reconnect ${a.emailAddress}`, body: reason, link: '/email-accounts' });
  await audit(workspaceId, { type: 'WORKER' }, 'email_account.needs_reauth', { type: 'email_account', id: accountId }, { reason });
}

export async function listAccounts(workspaceId: string) {
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const accounts = await db().emailAccount.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' }, include: { domain: { select: { name: true, healthStatus: true } } } });
  const today = startOfDayIn(ws.timezone);
  const sent = await db().outboundEmail.groupBy({ by: ['emailAccountId'], where: { workspaceId, status: 'SENT', sentAt: { gte: today } }, _count: { _all: true } });
  const bounces = await db().emailEvent.groupBy({ by: ['emailAccountId'], where: { workspaceId, type: 'BOUNCED_HARD', occurredAt: { gte: new Date(Date.now() - 30 * 86400_000) } }, _count: { _all: true } });
  const sent30 = await db().emailEvent.groupBy({ by: ['emailAccountId'], where: { workspaceId, type: 'SENT', occurredAt: { gte: new Date(Date.now() - 30 * 86400_000) } }, _count: { _all: true } });
  return accounts.map((a) => {
    const s30 = sent30.find((x) => x.emailAccountId === a.id)?._count._all ?? 0;
    const b30 = bounces.find((x) => x.emailAccountId === a.id)?._count._all ?? 0;
    return { ...a, sentToday: sent.find((x) => x.emailAccountId === a.id)?._count._all ?? 0, sent30d: s30, bounces30d: b30, bounceRate30d: s30 ? b30 / s30 : null };
  });
}

export const AccountUpdateSchema = z.object({
  displayName: z.string().max(100).nullable().optional(),
  replyTo: z.string().email().nullable().optional(),
  signatureText: z.string().max(2000).nullable().optional(),
  dailySendLimit: z.number().int().min(1).max(2000).optional(),
  minSecondsBetweenSends: z.number().int().min(30).max(3600).optional(),
  sendingWindow: AccountWindowSchema.optional(),
});

export async function updateAccount(workspaceId: string, id: string, input: z.infer<typeof AccountUpdateSchema>, actor: Actor) {
  const a = await db().emailAccount.findFirst({ where: { id, workspaceId } });
  if (!a) throw NotFound('Email account');
  // Hard ceilings from provider published limits; workspace limits should be far lower.
  const ceiling = a.provider === 'GMAIL' ? 2000 : a.provider === 'MICROSOFT' ? 10000 : 2000;
  if (input.dailySendLimit && input.dailySendLimit > ceiling) throw new AppError('VALIDATION_FAILED', `Daily limit cannot exceed the provider maximum (${ceiling})`, 400);
  const updated = await db().emailAccount.update({ where: { id }, data: { ...input, sendingWindow: input.sendingWindow as Prisma.InputJsonValue | undefined } });
  await audit(workspaceId, actor, 'email_account.updated', { type: 'email_account', id }, { fields: Object.keys(input) });
  return updated;
}

export async function setPaused(workspaceId: string, id: string, paused: boolean, actor: Actor) {
  const a = await db().emailAccount.findFirst({ where: { id, workspaceId } });
  if (!a) throw NotFound('Email account');
  if (!paused && a.status !== 'PAUSED') throw new AppError('CONFLICT', `Account is ${a.status}; reconnect it instead`, 409);
  const updated = await db().emailAccount.update({ where: { id }, data: { status: paused ? 'PAUSED' : 'CONNECTED', statusReason: paused ? 'Paused by user' : null } });
  await audit(workspaceId, actor, paused ? 'email_account.paused' : 'email_account.resumed', { type: 'email_account', id });
  return updated;
}

export async function testAccount(workspaceId: string, id: string) {
  const a = await db().emailAccount.findFirst({ where: { id, workspaceId } });
  if (!a) throw NotFound('Email account');
  try {
    const profile = await adapters().email[a.provider].testConnection(await getAuth(id));
    if (a.status === 'ERROR' || a.status === 'NEEDS_REAUTH') await db().emailAccount.update({ where: { id }, data: { status: 'CONNECTED', statusReason: null, lastError: null } });
    return { ok: true, profile };
  } catch (e) {
    await db().emailAccount.update({ where: { id }, data: { lastError: (e as Error).message.slice(0, 500), lastErrorAt: new Date() } });
    return { ok: false, error: (e as Error).message };
  }
}

export async function disconnectAccount(workspaceId: string, id: string, actor: Actor) {
  const a = await db().emailAccount.findFirst({ where: { id, workspaceId }, include: { credential: true } });
  if (!a) throw NotFound('Email account');
  try {
    if (a.provider === 'MICROSOFT' && a.subscriptionId) await adapters().graphSubscriptions?.unsubscribe(await getAuth(id), a.subscriptionId);
    if (a.provider === 'GMAIL' && a.credential?.encryptedRefreshToken) await adapters().oauth.GMAIL?.revoke(decryptSecret(a.credential.encryptedRefreshToken));
  } catch (e) { logger.warn({ err: e }, 'revoke during disconnect failed'); }
  await db().$transaction([
    db().providerCredential.deleteMany({ where: { emailAccountId: id } }),
    db().emailAccount.update({ where: { id }, data: { status: 'DISCONNECTED', statusReason: 'Disconnected by user', subscriptionId: null, syncCursor: null } }),
    db().sequenceEnrollment.updateMany({ where: { emailAccountId: id, status: 'ACTIVE' }, data: { status: 'PAUSED', stopReason: 'sending mailbox disconnected' } }),
  ]);
  await audit(workspaceId, actor, 'email_account.disconnected', { type: 'email_account', id });
}

export async function resync(workspaceId: string, id: string, actor: Actor) {
  const a = await db().emailAccount.findFirst({ where: { id, workspaceId } });
  if (!a) throw NotFound('Email account');
  await db().emailAccount.update({ where: { id }, data: { syncCursor: null } });
  await enqueue(QUEUES.sync, 'sync.account', { workspaceId, accountId: id }, { jobId: `sync-full-${id}-${Date.now()}` });
  await audit(workspaceId, actor, 'email_account.resync', { type: 'email_account', id });
  return { queued: true };
}

/** Worker: incremental sync for one mailbox, then ingest. */
export async function syncAccount(accountId: string) {
  const a = await db().emailAccount.findUnique({ where: { id: accountId } });
  if (!a || !['CONNECTED', 'PAUSED'].includes(a.status)) return { skipped: true };
  const provider = adapters().email[a.provider];
  try {
    const auth = await getAuth(accountId);
    const since = new Date(Date.now() - 14 * 86400_000);
    let result = await provider.sync(auth, a.syncCursor, since);
    if (result.fullResyncRequired) result = await provider.sync(auth, null, a.lastSyncedAt ? new Date(a.lastSyncedAt.getTime() - 86400_000) : since);
    const { ingestMessages } = await import('./inbox.js');
    const stats = await ingestMessages(a.workspaceId, accountId, result.messages);
    await db().emailAccount.update({ where: { id: accountId }, data: { syncCursor: result.nextCursor || null, lastSyncedAt: new Date(), lastError: null } });
    if (stats.inbound) await publish(a.workspaceId, 'inbox.updated', { accountId, ...stats });
    return stats;
  } catch (e) {
    await db().emailAccount.update({ where: { id: accountId }, data: { lastError: (e as Error).message.slice(0, 500), lastErrorAt: new Date() } });
    if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) await markNeedsReauth(a.workspaceId, accountId, e.message);
    throw e;
  }
}

export async function ensureGraphSubscription(accountId: string) {
  const a = await db().emailAccount.findUniqueOrThrow({ where: { id: accountId } });
  const subs = adapters().graphSubscriptions;
  if (!subs || a.provider !== 'MICROSOFT') return;
  const auth = await getAuth(accountId);
  if (a.subscriptionId && a.watchExpiresAt && a.watchExpiresAt.getTime() > Date.now() + 12 * 3600_000) return;
  if (a.subscriptionId) {
    try {
      const r = await subs.renew(auth, a.subscriptionId);
      await db().emailAccount.update({ where: { id: accountId }, data: { watchExpiresAt: r.expiresAt } });
      return;
    } catch { /* recreate below */ }
  }
  const clientState = randomToken(24);
  const r = await subs.subscribe(auth, `${process.env.APP_URL}/api/v1/webhooks/graph`, clientState);
  await db().emailAccount.update({ where: { id: accountId }, data: { subscriptionId: r.id, subscriptionSecretHash: sha256(clientState), watchExpiresAt: r.expiresAt } });
}

/** Handle a Graph change notification batch: verify clientState, queue a sync per account. */
export async function handleGraphNotifications(body: { value?: Array<{ subscriptionId: string; clientState?: string; lifecycleEvent?: string }> }) {
  for (const n of body.value ?? []) {
    const a = await db().emailAccount.findFirst({ where: { subscriptionId: n.subscriptionId } });
    if (!a || !n.clientState || a.subscriptionSecretHash !== sha256(n.clientState)) continue;
    if (n.lifecycleEvent === 'reauthorizationRequired' || n.lifecycleEvent === 'subscriptionRemoved') await ensureGraphSubscription(a.id).catch(() => undefined);
    await enqueue(QUEUES.sync, 'sync.account', { workspaceId: a.workspaceId, accountId: a.id }, { jobId: `sync-${a.id}-${Math.floor(Date.now() / 15000)}` });
  }
}
