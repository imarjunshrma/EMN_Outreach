import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { db, Prisma } from '../core/db.js';
import { adapters } from '../core/container.js';
import { pkcePair, randomToken, sha256 } from '../core/crypto.js';
import { AppError, NotFound } from '../core/errors.js';
import { acquireLock, redis } from '../core/redis.js';
import { audit, notifyWorkspace, publish, type Actor } from '../core/audit.js';
import { enqueue, QUEUES } from '../core/queues.js';
import { logger } from '../core/logger.js';
import { ProviderError } from '../../../integrations/src/http.js';
import type { AuthHandle, ConnectionCheck, SmtpImapConfig } from '../../../integrations/src/email/types.js';
import { decryptSecret, encryptSecret, readSettings } from './workspace.js';
import { SendingWindowSchema, startOfDayIn } from '../../../shared/src/schedule.js';

type OAuthProvider = 'GMAIL' | 'MICROSOFT';

export const AccountWindowSchema = SendingWindowSchema.extend({ enabled: z.boolean().default(false), timezone: z.string().default('UTC') });

// connectionConfig contains SMTP/IMAP usernames and host details. Keep it inside
// the service boundary; API callers receive only the mailbox's public metadata.
function publicAccount<T extends { connectionConfig: unknown }>(account: T) {
  const { connectionConfig: _privateConfig, ...safe } = account;
  const config = _privateConfig as { connectionHealth?: unknown; readiness?: unknown } | null;
  const connectionHealth = config?.connectionHealth ?? null;
  const readiness = config?.readiness ?? null;
  return { ...safe, connectionHealth, readiness };
}

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

/**
 * `currentUserId` is whoever is signed in on the browser that returned from the provider. It must be the person who
 * started the connection: otherwise someone could start a connection in their own workspace and trick another user
 * into approving it, attaching that user's mailbox to the wrong workspace (OAuth login CSRF).
 */
export async function oauthCallback(provider: OAuthProvider, code: string, state: string, currentUserId: string | null) {
  const raw = await redis().getdel(`oauth:state:${state}`);
  if (!raw) throw new AppError('OAUTH_STATE_INVALID', 'OAuth session expired or invalid. Start the connection again.', 400);
  const st = JSON.parse(raw) as { workspaceId: string; provider: OAuthProvider; verifier: string; userId: string | null };
  if (st.provider !== provider) throw new AppError('OAUTH_STATE_INVALID', 'Provider mismatch', 400);
  if (!currentUserId || !st.userId || currentUserId !== st.userId) throw new AppError('OAUTH_STATE_INVALID', 'Finish the connection in the same browser and account that started it. Start the connection again.', 400);
  const member = await db().workspaceMember.findFirst({ where: { workspaceId: st.workspaceId, userId: st.userId }, select: { role: true } });
  const orgAccess = member ? null : await db().workspace.findFirst({ where: { id: st.workspaceId, organization: { members: { some: { userId: st.userId, role: { in: ['OWNER', 'ADMIN'] } } } } }, select: { id: true } });
  if (!member && !orgAccess) throw new AppError('OAUTH_STATE_INVALID', 'You no longer have access to that workspace.', 400);
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
  password: z.string().min(1).max(500).optional(),
  smtpPassword: z.string().min(1).max(500).optional(),
  imapPassword: z.string().min(1).max(500).optional(),
  smtpHost: z.string().min(1), smtpPort: z.number().int().min(1).max(65535), smtpSecure: z.boolean(),
  imapHost: z.string().min(1), imapPort: z.number().int().min(1).max(65535), imapSecure: z.boolean(),
  username: z.string().min(1).optional(),
  smtpUsername: z.string().min(1).optional(),
  imapUsername: z.string().min(1).optional(),
  sentFolder: z.string().default('Sent'),
  appendToSent: z.boolean().default(false),
}).refine((v) => (v.smtpUsername || v.username) && (v.imapUsername || v.username) && (v.smtpPassword || v.password) && (v.imapPassword || v.password), { message: 'SMTP and IMAP each require a username and password (or provide shared credentials)' });

export async function connectSmtp(workspaceId: string, input: z.infer<typeof SmtpConnectSchema>, actor: Actor) {
  await (await import('./billing.js')).assertEntitled(workspaceId, 'mailboxes');
  const email = input.emailAddress.toLowerCase();
  const smtpUsername = input.smtpUsername ?? input.username!;
  const imapUsername = input.imapUsername ?? input.username!;
  const smtpPassword = input.smtpPassword ?? input.password!;
  const imapPassword = input.imapPassword ?? input.password!;
  const config: SmtpImapConfig = { smtpHost: input.smtpHost, smtpPort: input.smtpPort, smtpSecure: input.smtpSecure, imapHost: input.imapHost, imapPort: input.imapPort, imapSecure: input.imapSecure, username: smtpUsername, smtpUsername, imapUsername, sentFolder: input.sentFolder, appendToSent: input.appendToSent };
  // The username is a credential too. Encrypt it in the existing JSON column so
  // this connection does not require a schema migration.
  let connectionCheck: ConnectionCheck | null = null;
  try {
    const provider = adapters().email.SMTP_IMAP;
    const auth: AuthHandle = { kind: 'password', email, password: smtpPassword, smtpPassword, imapPassword, config };
    if (provider.testConnectionDetailed) {
      connectionCheck = await provider.testConnectionDetailed(auth);
      if (!connectionCheck.smtp.ok || !connectionCheck.imap.ok) {
        const failures = [!connectionCheck.smtp.ok && connectionCheck.smtp.error, !connectionCheck.imap.ok && connectionCheck.imap.error].filter(Boolean).join('; ');
        throw new ProviderError('smtp-imap', failures || 'Connection verification failed', 400, false);
      }
    } else await provider.testConnection(auth);
  } catch (e) {
    const safeMessage = e instanceof ProviderError ? e.message : 'SMTP/IMAP connection verification failed. Check host, port, TLS settings, and provider status.';
    const existing = await db().emailAccount.findFirst({ where: { workspaceId, emailAddress: email, provider: 'SMTP_IMAP' } });
    if (existing) {
      const oldConfig = existing.connectionConfig as Record<string, unknown>;
      const failedHealth = connectionCheck ?? { smtp: { ok: false, error: safeMessage }, imap: { ok: false, error: safeMessage } };
      await db().emailAccount.update({ where: { id: existing.id }, data: { status: 'ERROR', statusReason: safeMessage, lastError: safeMessage, lastErrorAt: new Date(), connectionConfig: { ...oldConfig, connectionHealth: { ...failedHealth, checkedAt: new Date().toISOString() } } as Prisma.InputJsonValue } });
    }
    await audit(workspaceId, actor, 'email_account.connection_failed', { type: 'email_account', id: existing?.id ?? email }, { provider: 'SMTP_IMAP', reason: safeMessage });
    throw new AppError('PROVIDER_ERROR', safeMessage, 400, connectionCheck ? { connection: connectionCheck } : undefined);
  }
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const priorAccount = await db().emailAccount.findUnique({ where: { workspaceId_emailAddress: { workspaceId, emailAddress: email } }, select: { id: true, status: true, statusReason: true, connectionConfig: true } });
  const verifiedHealth = connectionCheck ?? { smtp: { ok: true, error: null }, imap: { ok: true, error: null } };
  const priorReadiness = (priorAccount?.connectionConfig as { readiness?: unknown } | null)?.readiness;
  const persistedConfig = { ...config, username: encryptSecret(smtpUsername), smtpUsername: encryptSecret(smtpUsername), imapUsername: encryptSecret(imapUsername), usernameEncrypted: true, smtpUsernameEncrypted: true, imapUsernameEncrypted: true, smtpPasswordEncrypted: encryptSecret(smtpPassword), imapPasswordEncrypted: encryptSecret(imapPassword), connectionHealth: { ...verifiedHealth, checkedAt: new Date().toISOString() }, ...(priorReadiness ? { readiness: priorReadiness } : {}) } as unknown as Prisma.InputJsonValue;
  const domainName = email.split('@')[1];
  const domain = await db().domain.upsert({ where: { workspaceId_name: { workspaceId, name: domainName } }, update: {}, create: { workspaceId, name: domainName } });
  const account = await db().emailAccount.upsert({
    where: { workspaceId_emailAddress: { workspaceId, emailAddress: email } },
    update: { provider: 'SMTP_IMAP', status: priorAccount?.status === 'PAUSED' ? 'PAUSED' : 'CONNECTED', statusReason: priorAccount?.status === 'PAUSED' ? priorAccount.statusReason : null, lastError: null, lastErrorAt: null, connectionConfig: persistedConfig, displayName: input.displayName },
    create: { workspaceId, provider: 'SMTP_IMAP', emailAddress: email, displayName: input.displayName, domainId: domain.id, connectionConfig: persistedConfig, sendingWindow: { enabled: false, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', timezone: ws.timezone } },
  });
  await db().providerCredential.upsert({ where: { emailAccountId: account.id }, update: { encryptedPassword: encryptSecret(input.password ?? smtpPassword) }, create: { workspaceId, emailAccountId: account.id, encryptedPassword: encryptSecret(input.password ?? smtpPassword), scopes: [] } });
  await audit(workspaceId, actor, 'email_account.connected', { type: 'email_account', id: account.id }, { provider: 'SMTP_IMAP', email });
  await enqueue(QUEUES.sync, 'sync.account', { workspaceId, accountId: account.id });
  return publicAccount(account);
}

/** Decrypt credentials, refreshing OAuth tokens under a lock when they expire within 5 minutes. */
export async function getAuth(accountId: string): Promise<AuthHandle> {
  const account = await db().emailAccount.findUnique({ where: { id: accountId }, include: { credential: true } });
  if (!account?.credential) throw new AppError('ACCOUNT_NOT_CONNECTED', 'Mailbox credentials missing', 400);
  if (account.provider === 'SMTP_IMAP') {
    let stored = account.connectionConfig as unknown as SmtpImapConfig & { usernameEncrypted?: boolean; smtpUsernameEncrypted?: boolean; imapUsernameEncrypted?: boolean; smtpPasswordEncrypted?: string; imapPasswordEncrypted?: string };
    if (!stored.usernameEncrypted) {
      // Upgrade mailboxes created before usernames were encrypted, without a
      // migration or downtime. The version flag keeps this operation idempotent.
      stored = { ...stored, username: encryptSecret(stored.username), usernameEncrypted: true };
      await db().emailAccount.update({ where: { id: accountId }, data: { connectionConfig: stored as unknown as Prisma.InputJsonValue } });
    }
    const sharedPassword = decryptSecret(account.credential.encryptedPassword!);
    const config = {
      ...stored,
      username: stored.usernameEncrypted ? decryptSecret(stored.username) : stored.username,
      smtpUsername: stored.smtpUsername ? (stored.smtpUsernameEncrypted ? decryptSecret(stored.smtpUsername) : stored.smtpUsername) : undefined,
      imapUsername: stored.imapUsername ? (stored.imapUsernameEncrypted ? decryptSecret(stored.imapUsername) : stored.imapUsername) : undefined,
    };
    return {
      kind: 'password', email: account.emailAddress, password: sharedPassword,
      smtpPassword: stored.smtpPasswordEncrypted ? decryptSecret(stored.smtpPasswordEncrypted) : sharedPassword,
      imapPassword: stored.imapPasswordEncrypted ? decryptSecret(stored.imapPasswordEncrypted) : sharedPassword,
      config,
    };
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
    return { ...publicAccount(a), sentToday: sent.find((x) => x.emailAccountId === a.id)?._count._all ?? 0, sent30d: s30, bounces30d: b30, bounceRate30d: s30 ? b30 / s30 : null };
  });
}

export const AccountUpdateSchema = z.object({
  displayName: z.string().max(100).nullable().optional(),
  replyTo: z.string().email().nullable().optional(),
  signatureText: z.string().max(2000).nullable().optional(),
  dailySendLimit: z.number().int().min(1).max(2000).optional(),
  minSecondsBetweenSends: z.number().int().min(30).max(3600).optional(),
  sendingWindow: AccountWindowSchema.optional(),
  readiness: z.object({ enabled: z.boolean(), initialDailyCap: z.number().int().min(1).max(500).default(5), dailyIncrease: z.number().int().min(1).max(500).default(5), reviewIntervalDays: z.number().int().min(3).max(30).default(7) }).optional(),
});

export async function updateAccount(workspaceId: string, id: string, input: z.infer<typeof AccountUpdateSchema>, actor: Actor) {
  const a = await db().emailAccount.findFirst({ where: { id, workspaceId } });
  if (!a) throw NotFound('Email account');
  // Hard ceilings from provider published limits; workspace limits should be far lower.
  const ceiling = a.provider === 'GMAIL' ? 2000 : a.provider === 'MICROSOFT' ? 10000 : 2000;
  if (input.dailySendLimit && input.dailySendLimit > ceiling) throw new AppError('VALIDATION_FAILED', `Daily limit cannot exceed the provider maximum (${ceiling})`, 400);
  const { readiness, ...fields } = input;
  const config = (a.connectionConfig ?? {}) as Record<string, unknown>;
  let connectionConfig: Prisma.InputJsonValue | undefined;
  if (readiness) {
    const previous = config.readiness as { enabled?: boolean; currentDailyCap?: number; startedAt?: string; lastProgressAt?: string | null; lastReviewedAt?: string | null } | undefined;
    const enabling = readiness.enabled && !previous?.enabled;
    config.readiness = {
      enabled: readiness.enabled,
      initialDailyCap: readiness.initialDailyCap,
      currentDailyCap: readiness.enabled ? Math.min(previous?.currentDailyCap ?? readiness.initialDailyCap, fields.dailySendLimit ?? a.dailySendLimit) : null,
      dailyIncrease: readiness.dailyIncrease,
      reviewIntervalDays: readiness.reviewIntervalDays,
      startedAt: readiness.enabled ? (enabling ? new Date().toISOString() : previous?.startedAt ?? new Date().toISOString()) : null,
      lastProgressAt: readiness.enabled ? (enabling ? new Date().toISOString() : previous?.lastProgressAt ?? null) : null,
      lastReviewedAt: readiness.enabled ? (enabling ? new Date().toISOString() : previous?.lastReviewedAt ?? null) : null,
      status: readiness.enabled ? 'OBSERVING' : 'DISABLED',
      holdReason: readiness.enabled ? null : null,
    };
    connectionConfig = config as Prisma.InputJsonValue;
  }
  const updated = await db().emailAccount.update({ where: { id }, data: { ...fields, sendingWindow: fields.sendingWindow as Prisma.InputJsonValue | undefined, ...(connectionConfig ? { connectionConfig } : {}) } });
  await audit(workspaceId, actor, 'email_account.updated', { type: 'email_account', id }, { fields: Object.keys(input) });
  return publicAccount(updated);
}

/** Increase actual-send capacity only after a stable observation period with real volume and healthy signals. */
export async function advanceMailboxReadiness() {
  const workspaces = await db().workspace.findMany({ select: { id: true, settings: true } });
  const now = new Date();
  for (const workspace of workspaces) {
    const settings = readSettings(workspace.settings);
    if (!settings.mailboxReadinessManagement) continue;
    const accounts = await db().emailAccount.findMany({ where: { workspaceId: workspace.id }, include: { domain: { select: { healthStatus: true } } } });
    for (const account of accounts) {
      const release = await acquireLock(`mailbox-readiness:${account.id}`, 10_000);
      if (!release) continue;
      try {
        const config = account.connectionConfig as { readiness?: Record<string, unknown> } | null;
        const state = config?.readiness;
        if (!state || state.enabled !== true || account.status !== 'CONNECTED') continue;
        const cap = Number(state.currentDailyCap ?? state.initialDailyCap ?? 5);
        const intervalDays = Number(state.reviewIntervalDays ?? 7);
        const lastProgress = new Date(String(state.lastProgressAt ?? state.startedAt ?? now.toISOString()));
        if (!Number.isFinite(lastProgress.getTime()) || now.getTime() - lastProgress.getTime() < intervalDays * 86_400_000) continue;
        const events = await db().emailEvent.findMany({ where: { workspaceId: workspace.id, emailAccountId: account.id, occurredAt: { gte: lastProgress }, type: { in: ['SENT', 'BOUNCED_HARD', 'BOUNCED_SOFT', 'COMPLAINED'] } }, select: { type: true, occurredAt: true }, take: 5000 });
        const sent = events.filter((event) => event.type === 'SENT');
        const hard = events.filter((event) => event.type === 'BOUNCED_HARD').length;
        const soft = events.filter((event) => event.type === 'BOUNCED_SOFT').length;
        const complaints = events.filter((event) => event.type === 'COMPLAINED').length;
        const sentDays = new Set(sent.map((event) => event.occurredAt.toISOString().slice(0, 10))).size;
        const hardRate = sent.length ? 100 * hard / sent.length : 0;
        const abnormalDomain = !account.domain || !/healthy|configured|verified|ok/i.test(account.domain.healthStatus ?? '');
        const holdReason = abnormalDomain ? 'Domain authentication needs attention or has not been checked'
          : complaints > 0 ? 'Complaint signal observed; manual review required'
          : sentDays < Math.min(5, intervalDays) ? 'Not enough days with real sends to evaluate progression'
          : sent.length < Math.max(5, cap * 3) ? 'Not enough actual sends at the current cap to evaluate progression'
          : hardRate > (settings.mailboxAutoPauseBounceRatePct ?? 5) ? 'Hard-bounce rate exceeds the workspace threshold'
          : sent.length > 0 && settings.mailboxReadinessSoftBounceRatePct !== null && 100 * soft / sent.length > settings.mailboxReadinessSoftBounceRatePct ? `Soft-bounce rate exceeds the ${settings.mailboxReadinessSoftBounceRatePct}% readiness threshold`
          : null;
        const nextState = holdReason
          ? { ...state, status: 'HOLD', holdReason, lastReviewedAt: now.toISOString() }
          : { ...state, currentDailyCap: Math.min(account.dailySendLimit, cap + Number(state.dailyIncrease ?? 5)), status: cap + Number(state.dailyIncrease ?? 5) >= account.dailySendLimit ? 'AT_CONFIGURED_LIMIT' : 'PROGRESSED', holdReason: null, lastProgressAt: now.toISOString(), lastReviewedAt: now.toISOString() };
        await db().emailAccount.update({ where: { id: account.id }, data: { connectionConfig: { ...config, readiness: nextState } as Prisma.InputJsonValue } });
        if (!holdReason && nextState.status === 'PROGRESSED') {
          const effectiveCap = Number((nextState as Record<string, unknown>).currentDailyCap ?? cap);
          await audit(workspace.id, { type: 'WORKER', userId: null }, 'email_account.readiness_increased', { type: 'email_account', id: account.id }, { previousDailyCap: cap, currentDailyCap: effectiveCap, sentInPeriod: sent.length, hardBounceRatePct: +hardRate.toFixed(2) });
          await notifyWorkspace(workspace.id, 'ADMIN', { type: 'account.readiness_increased', title: 'Mailbox sending cap increased', body: `${account.emailAddress} passed its readiness review using actual sending and health history.`, link: '/mailbox-health' });
        } else if (holdReason && (state.holdReason !== holdReason)) {
          await notifyWorkspace(workspace.id, 'ADMIN', { type: 'account.readiness_hold', title: 'Mailbox readiness progression paused', body: `${account.emailAddress}: ${holdReason}. Review Mailbox Health before increasing volume.`, link: '/mailbox-health' });
        }
      } catch (e) {
        logger.warn({ err: e, workspaceId: workspace.id, emailAccountId: account.id }, 'mailbox readiness review failed');
      } finally { await release(); }
    }
  }
}

export async function setPaused(workspaceId: string, id: string, paused: boolean, actor: Actor) {
  const a = await db().emailAccount.findFirst({ where: { id, workspaceId } });
  if (!a) throw NotFound('Email account');
  if (!paused && a.status !== 'PAUSED') throw new AppError('CONFLICT', `Account is ${a.status}; reconnect it instead`, 409);
  const updated = await db().emailAccount.update({ where: { id }, data: { status: paused ? 'PAUSED' : 'CONNECTED', statusReason: paused ? 'Paused by user' : null } });
  await audit(workspaceId, actor, paused ? 'email_account.paused' : 'email_account.resumed', { type: 'email_account', id });
  return publicAccount(updated);
}

export async function testAccount(workspaceId: string, id: string) {
  const a = await db().emailAccount.findFirst({ where: { id, workspaceId } });
  if (!a) throw NotFound('Email account');
  try {
    const provider = adapters().email[a.provider];
    const auth = await getAuth(id);
    const details = provider.testConnectionDetailed ? await provider.testConnectionDetailed(auth) : null;
    if (details && (!details.smtp.ok || !details.imap.ok)) {
      const safeError = [!details.smtp.ok && details.smtp.error, !details.imap.ok && details.imap.error].filter(Boolean).join('; ');
      const oldConfig = a.connectionConfig as Record<string, unknown>;
      await db().emailAccount.update({ where: { id }, data: { status: a.status === 'PAUSED' ? 'PAUSED' : 'ERROR', statusReason: a.status === 'PAUSED' ? a.statusReason : safeError, lastError: safeError, lastErrorAt: new Date(), connectionConfig: { ...oldConfig, connectionHealth: { ...details, checkedAt: new Date().toISOString() } } as Prisma.InputJsonValue } });
      return { ok: false, provider: a.provider, emailAddress: a.emailAddress, error: safeError, connection: details };
    }
    if (!details) await provider.testConnection(auth);
    const oldConfig = a.connectionConfig as Record<string, unknown>;
    const connection = details ?? { smtp: { ok: true, error: null }, imap: { ok: true, error: null } };
    await db().emailAccount.update({ where: { id }, data: { status: a.status === 'PAUSED' ? 'PAUSED' : 'CONNECTED', statusReason: a.status === 'PAUSED' ? a.statusReason : null, lastError: null, lastErrorAt: null, connectionConfig: { ...oldConfig, connectionHealth: { ...connection, checkedAt: new Date().toISOString() } } as Prisma.InputJsonValue } });
    return { ok: true, provider: a.provider, emailAddress: a.emailAddress, connection };
  } catch (e) {
    const safeError = e instanceof ProviderError && e.status === 401 ? 'Mailbox authentication failed. Recheck credentials and provider access.' : 'Mailbox connection verification failed. Check provider settings and try again.';
    if (a.provider !== 'SMTP_IMAP' && e instanceof ProviderError && (e.status === 401 || e.status === 403)) {
      await markNeedsReauth(workspaceId, id, safeError);
    } else {
      await db().emailAccount.update({ where: { id }, data: { status: a.status === 'PAUSED' ? 'PAUSED' : 'ERROR', statusReason: a.status === 'PAUSED' ? a.statusReason : safeError, lastError: safeError, lastErrorAt: new Date() } });
    }
    return { ok: false, provider: a.provider, emailAddress: a.emailAddress, error: safeError };
  }
}

/** One explicit, clearly labeled delivery diagnostic addressed only to the same authorized mailbox. */
export async function sendMailboxDiagnostic(workspaceId: string, id: string, actor: Actor) {
  const account = await db().emailAccount.findFirst({ where: { id, workspaceId } });
  if (!account) throw NotFound('Email account');
  if (account.status !== 'CONNECTED') throw new AppError('CONFLICT', `Mailbox is ${account.status}; reconnect or resume it before testing`, 409);
  const messageId = `<${randomUUID()}@${account.emailAddress.split('@')[1]}>`;
  const now = new Date();
  let result;
  try {
    result = await adapters().email[account.provider].send(await getAuth(id), {
      from: { address: account.emailAddress, name: account.displayName ?? undefined },
      to: account.emailAddress,
      replyTo: account.replyTo ?? undefined,
      subject: '[EMN mailbox diagnostic] Explicit self-test',
      text: `This is an automated mailbox delivery diagnostic requested by an administrator in EMN Outreach OS at ${now.toISOString()}. It was sent from this mailbox to itself to verify provider submission and mailbox synchronization. It is not a prospect message. No reply or engagement action is requested.`,
      messageId,
      headers: { 'X-EMN-Mailbox-Diagnostic': '1' },
    });
  } catch (e) {
    await db().emailAccount.update({ where: { id }, data: { lastError: (e as Error).message.slice(0, 500), lastErrorAt: now } });
    throw e;
  }
  await audit(workspaceId, actor, 'email_account.delivery_diagnostic_sent', { type: 'email_account', id }, { provider: account.provider, recipient: account.emailAddress, providerMessageId: result.providerMessageId, internetMessageId: result.internetMessageId });
  return { acceptedByProvider: true, providerMessageId: result.providerMessageId, internetMessageId: result.internetMessageId, sentAt: now.toISOString(), recipient: account.emailAddress, note: 'Provider accepted the explicit self-test. Run mailbox sync to check whether a copy appears; this does not measure inbox placement.' };
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
  const releaseSyncLock = await acquireLock(`mailbox-sync:${accountId}`, 10 * 60_000);
  if (!releaseSyncLock) return { skipped: true, reason: 'sync already running' };
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
    const authFailure = e instanceof ProviderError && (e.status === 401 || e.status === 403);
    const safeMessage = authFailure ? 'Mailbox authentication failed during synchronization. Reconnect this mailbox.' : e instanceof AppError ? e.message : 'Mailbox synchronization failed. The worker will retry; check provider settings if this persists.';
    const failedAt = new Date();
    await db().emailAccount.update({ where: { id: accountId }, data: { lastError: safeMessage.slice(0, 500), lastErrorAt: failedAt } });
    if (authFailure) {
      if (a.status !== 'NEEDS_REAUTH') await markNeedsReauth(a.workspaceId, accountId, safeMessage);
    } else if (!a.lastErrorAt || failedAt.getTime() - a.lastErrorAt.getTime() >= 6 * 3600_000) {
      await notifyWorkspace(a.workspaceId, 'ADMIN', { type: 'account.sync_error', title: 'Mailbox synchronization is failing', body: 'EMN could not complete mailbox synchronization. Check Mailbox Health and the provider connection settings.', link: '/mailbox-health' });
    }
    throw new ProviderError('mailbox-sync', safeMessage, authFailure ? 401 : 503, !authFailure);
  } finally {
    await releaseSyncLock();
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
