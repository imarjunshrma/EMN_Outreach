import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { db } from '../core/db.js';
import { redis } from '../core/redis.js';
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { Keyring } from '../core/crypto.js';
import { platformAudit } from '../core/tenant.js';
import { ClaudeSubscriptionRunner, looksLikeClaudeOAuthToken } from '../../../integrations/src/ai/subscription/claude-agent.js';
import { CodexSubscriptionRunner, codexCli, type CodexCli, type DeviceLoginUpdate } from '../../../integrations/src/ai/subscription/codex.js';
import { SubscriptionError, scrubSecrets, type SubscriptionRunner } from '../../../integrations/src/ai/subscription/types.js';
import type { SubscriptionProviderName } from '../../../shared/src/ai-workflows.js';

// Personal AI subscriptions. Strictly owner-only: every entry point is gated by isAiSubscriptionOwner(),
// enforced on the server (routes answer 404 to anyone else). Nothing here ever returns a credential.

// ------------------------------------------------------------------ owner gate

export function ownerEmails(): Set<string> {
  return new Set((process.env.AI_SUBSCRIPTION_OWNER_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** The owner is a listed, active SUPER_ADMIN with two-factor sign-in (2FA may be relaxed only outside production). */
export async function isAiSubscriptionOwner(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const emails = ownerEmails();
  if (!emails.size) return false;
  const u = await db().user.findUnique({ where: { id: userId }, select: { email: true, status: true, platformRole: true, mfaEnabled: true } });
  if (!u || u.status !== 'ACTIVE' || u.platformRole !== 'SUPER_ADMIN') return false;
  if (!emails.has(u.email.toLowerCase())) return false;
  const mfaOptional = process.env.PLATFORM_MFA_REQUIRED === 'false' && process.env.NODE_ENV !== 'production';
  return u.mfaEnabled || mfaOptional;
}

export async function assertOwner(userId: string | null | undefined) {
  if (!(await isAiSubscriptionOwner(userId))) throw new AppError('NOT_FOUND', 'Not found', 404);
}

// ------------------------------------------------------------------ dedicated encryption + paths

let ring: Keyring | null = null;
function subscriptionKeyring(): Keyring {
  const key = process.env.AI_SUBSCRIPTION_ENCRYPTION_KEY?.trim();
  if (!key) throw new AppError('CONFIG_MISSING', 'AI_SUBSCRIPTION_ENCRYPTION_KEY is not set on the server. Generate one with `openssl rand -base64 32`, add it to .env and restart.', 503);
  if (!ring) {
    try { ring = new Keyring(`1:${key}`, 1); } catch { throw new AppError('CONFIG_INVALID', 'AI_SUBSCRIPTION_ENCRYPTION_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32).', 503); }
  }
  return ring;
}
export function resetSubscriptionKeyringForTests() { ring = null; }

export function subscriptionHome(): string {
  const root = resolve(process.env.AI_SUBSCRIPTION_HOME ?? './.ai-subscriptions');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
const claudeHome = (userId: string) => join(subscriptionHome(), userId, 'claude');
export const codexHome = (userId: string) => join(subscriptionHome(), userId, 'codex', '.codex');

// ------------------------------------------------------------------ runner factories (replaced in tests)

interface Deps {
  claudeRunner: (token: string, userId: string) => SubscriptionRunner;
  codexRunner: (userId: string) => SubscriptionRunner;
  codexCli: (userId: string) => CodexCli;
}
const defaultDeps: Deps = {
  claudeRunner: (token, userId) => new ClaudeSubscriptionRunner({ token, homeDir: claudeHome(userId), executablePath: process.env.CLAUDE_CODE_PATH || null }),
  codexRunner: (userId) => new CodexSubscriptionRunner({ codexHome: codexHome(userId), binary: process.env.CODEX_PATH || null }),
  codexCli: (userId) => codexCli(codexHome(userId), { binary: process.env.CODEX_PATH || null }),
};
let deps: Deps = defaultDeps;
export function setSubscriptionDeps(partial: Partial<Deps>) { deps = { ...defaultDeps, ...partial }; }
export function resetSubscriptionDeps() { deps = defaultDeps; }

// ------------------------------------------------------------------ connections

const SAFE_FIELDS = { id: true, provider: true, status: true, credentialHint: true, accountLabel: true, model: true, concurrency: true, delayMs: true, paused: true, connectedAt: true, expiresAt: true, lastTestedAt: true, lastTestOk: true, lastError: true, limitResetsAt: true, limitType: true, utilization: true, lastUsedAt: true, updatedAt: true } as const;

async function upsertConnection(ownerUserId: string, provider: SubscriptionProviderName, data: Record<string, unknown>) {
  return db().aiSubscriptionConnection.upsert({
    where: { ownerUserId_provider: { ownerUserId, provider } },
    update: data, create: { ownerUserId, provider, ...data },
    select: SAFE_FIELDS,
  });
}

export async function listConnections(ownerUserId: string) {
  const rows = await db().aiSubscriptionConnection.findMany({ where: { ownerUserId }, select: SAFE_FIELDS });
  const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r]));
  const now = Date.now();
  return (['CLAUDE_SUBSCRIPTION', 'CODEX_SUBSCRIPTION'] as const).map((p) => {
    const r = byProvider[p];
    // Owner-only: where Codex keeps its sign-in on the server, for signing in from the server shell.
    const extra = p === 'CODEX_SUBSCRIPTION' ? { serverCodexHome: codexHome(ownerUserId) } : {};
    if (!r) return { provider: p, status: 'DISCONNECTED' as const, configured: false, ...extra };
    const expiringSoon = r.expiresAt ? r.expiresAt.getTime() - now < 30 * 86_400_000 : false;
    return { ...r, configured: true, expiringSoon, ...extra };
  });
}

export async function loadConnection(ownerUserId: string, provider: SubscriptionProviderName) {
  return db().aiSubscriptionConnection.findUnique({ where: { ownerUserId_provider: { ownerUserId, provider } } });
}

/** Runner for a provider, or a SubscriptionError explaining why it cannot run (never a fallback). */
export async function runnerFor(ownerUserId: string, provider: SubscriptionProviderName): Promise<SubscriptionRunner> {
  const c = await loadConnection(ownerUserId, provider);
  const label = provider === 'CLAUDE_SUBSCRIPTION' ? 'Claude' : 'Codex';
  if (!c || c.status === 'DISCONNECTED' || c.status === 'CONNECTING') throw new SubscriptionError('UNAVAILABLE', `${label} is not connected`);
  if (c.status === 'EXPIRED') throw new SubscriptionError('AUTH', `${label} sign-in expired — reconnect ${label}`);
  if (c.status === 'USAGE_LIMITED' && c.limitResetsAt && c.limitResetsAt.getTime() > Date.now()) throw new SubscriptionError('USAGE_LIMIT', `${label} usage limit reached`, c.limitResetsAt, c.limitType);
  if (c.paused) throw new SubscriptionError('UNAVAILABLE', `${label} is paused in AI settings`);
  if (provider === 'CLAUDE_SUBSCRIPTION') {
    if (!c.encryptedCredential) throw new SubscriptionError('UNAVAILABLE', 'Claude is not connected');
    return deps.claudeRunner(subscriptionKeyring().decrypt(c.encryptedCredential), ownerUserId);
  }
  return deps.codexRunner(ownerUserId);
}

/** Record the outcome of a real call on the connection (expiry / limit / healthy). */
export async function recordProviderOutcome(ownerUserId: string, provider: SubscriptionProviderName, outcome: { ok: true; rateLimit?: { status: string; resetsAt: Date | null; type: string | null; utilization: number | null } | null } | { ok: false; error: SubscriptionError }) {
  if (outcome.ok) {
    const rl = outcome.rateLimit;
    await db().aiSubscriptionConnection.updateMany({ where: { ownerUserId, provider }, data: { status: 'CONNECTED', lastUsedAt: new Date(), lastError: null, ...(rl ? { utilization: rl.utilization, limitType: rl.type, limitResetsAt: rl.status === 'allowed' ? null : rl.resetsAt } : {}) } });
    return;
  }
  const e = outcome.error;
  if (e.kind === 'AUTH') await db().aiSubscriptionConnection.updateMany({ where: { ownerUserId, provider }, data: { status: 'EXPIRED', lastError: scrubSecrets(e.message) } });
  else if (e.kind === 'USAGE_LIMIT') await db().aiSubscriptionConnection.updateMany({ where: { ownerUserId, provider }, data: { status: 'USAGE_LIMITED', limitResetsAt: e.resetsAt, limitType: e.limitType, lastError: e.message } });
  else await db().aiSubscriptionConnection.updateMany({ where: { ownerUserId, provider }, data: { lastError: scrubSecrets(e.message) } });
}

const TEST_SCHEMA = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] };

async function probe(ownerUserId: string, provider: SubscriptionProviderName, runner: SubscriptionRunner) {
  try {
    const r = await runner.run({ system: 'You are a connection test. Answer with JSON only.', prompt: 'Return {"ok": true}.', jsonSchema: TEST_SCHEMA, allowWeb: false, timeoutMs: 90_000 }); // stays under the API request timeout
    const ok = (r.data as { ok?: unknown })?.ok === true;
    await db().aiSubscriptionConnection.updateMany({ where: { ownerUserId, provider }, data: { lastTestedAt: new Date(), lastTestOk: ok, lastError: ok ? null : 'Unexpected test answer', ...(ok ? { status: 'CONNECTED' } : {}) } });
    if (ok) await recordProviderOutcome(ownerUserId, provider, { ok: true, rateLimit: r.rateLimit });
    return ok ? { ok: true as const, model: r.model } : { ok: false as const, error: 'The provider answered, but not with the expected test result' };
  } catch (e) {
    const err = e instanceof SubscriptionError ? e : new SubscriptionError('FAILED', scrubSecrets((e as Error).message));
    await db().aiSubscriptionConnection.updateMany({ where: { ownerUserId, provider }, data: { lastTestedAt: new Date(), lastTestOk: false, lastError: scrubSecrets(err.message), ...(err.kind === 'FAILED' || err.kind === 'UNAVAILABLE' || err.kind === 'TIMEOUT' ? { status: 'ERROR' } : {}) } });
    await recordProviderOutcome(ownerUserId, provider, { ok: false, error: err });
    return { ok: false as const, error: err.message, kind: err.kind };
  }
}

export const ClaudeConnectSchema = z.object({ token: z.string().trim().min(20).max(500) });

/** Store the `claude setup-token` token (encrypted), then verify it with a real minimal request. */
export async function connectClaude(ownerUserId: string, token: string, ip: string | null) {
  const t = token.trim();
  if (!looksLikeClaudeOAuthToken(t)) throw new AppError('VALIDATION_FAILED', 'That does not look like a token from `claude setup-token` (it starts with sk-ant-oat). API keys (sk-ant-api…) are not accepted here.', 400);
  const encrypted = subscriptionKeyring().encrypt(t);
  const now = new Date();
  await upsertConnection(ownerUserId, 'CLAUDE_SUBSCRIPTION', {
    encryptedCredential: encrypted, credentialHint: `…${t.slice(-4)}`, status: 'CONNECTING', connectedAt: now,
    // Anthropic documents setup-token tokens as valid for one year; the real expiry is detected on use.
    expiresAt: new Date(now.getTime() + 365 * 86_400_000), lastError: null, limitResetsAt: null, accountLabel: 'Claude subscription (setup-token)',
  });
  await platformAudit({ actorUserId: ownerUserId, action: 'ai_subscription.connected', targetType: 'ai_subscription', targetId: 'CLAUDE_SUBSCRIPTION', ip });
  const runner = deps.claudeRunner(t, ownerUserId);
  const test = await probe(ownerUserId, 'CLAUDE_SUBSCRIPTION', runner);
  return { connection: (await listConnections(ownerUserId)).find((c) => c.provider === 'CLAUDE_SUBSCRIPTION'), test };
}

export async function testConnection(ownerUserId: string, provider: SubscriptionProviderName) {
  const c = await loadConnection(ownerUserId, provider);
  if (!c || c.status === 'DISCONNECTED') throw new AppError('NOT_CONNECTED', 'Connect this provider first', 400);
  if (provider === 'CODEX_SUBSCRIPTION') {
    const st = await deps.codexCli(ownerUserId).status();
    if (!st.loggedIn || st.method !== 'ChatGPT') {
      await db().aiSubscriptionConnection.update({ where: { id: c.id }, data: { status: st.loggedIn ? 'ERROR' : 'EXPIRED', lastTestedAt: new Date(), lastTestOk: false, lastError: st.loggedIn ? `Signed in with ${st.method}, not ChatGPT` : 'Codex is not signed in' } });
      return { ok: false as const, error: st.loggedIn ? `Codex is signed in with ${st.method}, not ChatGPT` : 'Codex is not signed in — reconnect', kind: 'AUTH' };
    }
  }
  const runner = provider === 'CLAUDE_SUBSCRIPTION'
    ? deps.claudeRunner(subscriptionKeyring().decrypt(c.encryptedCredential ?? ''), ownerUserId)
    : deps.codexRunner(ownerUserId);
  return probe(ownerUserId, provider, runner);
}

export async function disconnect(ownerUserId: string, provider: SubscriptionProviderName, ip: string | null) {
  if (provider === 'CODEX_SUBSCRIPTION') {
    cancelLocalLogin(ownerUserId);
    await deps.codexCli(ownerUserId).logout().catch((e) => logger.warn({ err: scrubSecrets(String(e)) }, 'codex logout failed'));
    await redis().del(loginKey(ownerUserId));
  }
  await db().aiSubscriptionConnection.updateMany({ where: { ownerUserId, provider }, data: { status: 'DISCONNECTED', encryptedCredential: null, credentialHint: null, connectedAt: null, expiresAt: null, lastTestOk: null, lastError: null, limitResetsAt: null, accountLabel: null } });
  await platformAudit({ actorUserId: ownerUserId, action: 'ai_subscription.disconnected', targetType: 'ai_subscription', targetId: provider, ip });
  return { ok: true };
}

export const ConnectionSettingsSchema = z.object({
  model: z.string().trim().max(120).nullable().optional(),
  concurrency: z.number().int().min(1).max(4).optional(),
  delayMs: z.number().int().min(0).max(600_000).optional(),
  paused: z.boolean().optional(),
});
export async function updateSettings(ownerUserId: string, provider: SubscriptionProviderName, input: z.infer<typeof ConnectionSettingsSchema>) {
  const data = { ...(input.model !== undefined ? { model: input.model || null } : {}), ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}), ...(input.delayMs !== undefined ? { delayMs: input.delayMs } : {}), ...(input.paused !== undefined ? { paused: input.paused } : {}) };
  const r = await upsertConnection(ownerUserId, provider, data);
  if (input.paused === false) await (await import('./ai-workflow-runs.js')).resumeRunsForProvider(ownerUserId, provider, 'provider resumed');
  return r;
}

/** Clear expired usage-limit flags and resume runs that asked to continue automatically. Scheduled. */
export async function refreshLimits() {
  const due = await db().aiSubscriptionConnection.findMany({ where: { status: 'USAGE_LIMITED', limitResetsAt: { lte: new Date() } } });
  for (const c of due) {
    await db().aiSubscriptionConnection.update({ where: { id: c.id }, data: { status: 'CONNECTED', limitResetsAt: null } });
    await (await import('./ai-workflow-runs.js')).resumeRunsForProvider(c.ownerUserId, c.provider, 'usage limit reset', true);
  }
  return { cleared: due.length };
}

// ------------------------------------------------------------------ Codex device-code sign-in

const loginKey = (userId: string) => `aisub:codex-login:${userId}`;
const localLogins = new Map<string, { cancel: () => void }>();
function cancelLocalLogin(userId: string) { localLogins.get(userId)?.cancel(); localLogins.delete(userId); }

export async function startCodexLogin(ownerUserId: string, ip: string | null) {
  cancelLocalLogin(ownerUserId);
  await upsertConnection(ownerUserId, 'CODEX_SUBSCRIPTION', { status: 'CONNECTING', lastError: null });
  await redis().set(loginKey(ownerUserId), JSON.stringify({ state: 'STARTING' }), 'EX', 20 * 60);
  const first = new Promise<DeviceLoginUpdate>((resolveFirst) => {
    const handle = deps.codexCli(ownerUserId).startDeviceLogin(async (u) => {
      resolveFirst(u);
      try {
        await redis().set(loginKey(ownerUserId), JSON.stringify(u), 'EX', 20 * 60);
        if (u.state === 'SUCCEEDED') {
          localLogins.delete(ownerUserId);
          const st = await deps.codexCli(ownerUserId).status();
          const isChatGpt = st.loggedIn && st.method === 'ChatGPT';
          await upsertConnection(ownerUserId, 'CODEX_SUBSCRIPTION', isChatGpt
            ? { status: 'CONNECTED', connectedAt: new Date(), accountLabel: 'ChatGPT sign-in (Codex CLI)', lastError: null, limitResetsAt: null, expiresAt: null }
            : { status: 'ERROR', lastError: st.loggedIn ? `Signed in with ${st.method}, not ChatGPT` : 'Codex reported no sign-in after the device flow' });
          await platformAudit({ actorUserId: ownerUserId, action: isChatGpt ? 'ai_subscription.connected' : 'ai_subscription.connect_failed', targetType: 'ai_subscription', targetId: 'CODEX_SUBSCRIPTION', ip });
        } else if (u.state === 'FAILED') {
          localLogins.delete(ownerUserId);
          await upsertConnection(ownerUserId, 'CODEX_SUBSCRIPTION', { status: 'DISCONNECTED', lastError: u.error });
        }
      } catch (e) { logger.warn({ err: scrubSecrets(String(e)) }, 'codex login bookkeeping failed'); }
    });
    localLogins.set(ownerUserId, handle);
    setTimeout(() => resolveFirst({ state: 'FAILED', error: 'Codex did not start the sign-in within 30 seconds' }), 30_000);
  });
  const u = await first;
  if (u.state === 'FAILED') throw new AppError('CODEX_LOGIN_FAILED', u.error, 502);
  return codexLoginStatus(ownerUserId);
}

export async function codexLoginStatus(ownerUserId: string) {
  const raw = await redis().get(loginKey(ownerUserId));
  const s = raw ? JSON.parse(raw) as DeviceLoginUpdate | { state: 'STARTING' } : null;
  const conn = (await listConnections(ownerUserId)).find((c) => c.provider === 'CODEX_SUBSCRIPTION');
  return { login: s, connection: conn };
}

export async function cancelCodexLogin(ownerUserId: string) {
  cancelLocalLogin(ownerUserId);
  await redis().set(loginKey(ownerUserId), JSON.stringify({ state: 'FAILED', error: 'Sign-in cancelled' }), 'EX', 600);
  await db().aiSubscriptionConnection.updateMany({ where: { ownerUserId, provider: 'CODEX_SUBSCRIPTION', status: 'CONNECTING' }, data: { status: 'DISCONNECTED' } });
  return { ok: true };
}

/** For the queue dashboard and graceful shutdown: kill any in-flight device login on this process. */
export function shutdownSubscriptionLogins() { for (const k of [...localLogins.keys()]) cancelLocalLogin(k); }
