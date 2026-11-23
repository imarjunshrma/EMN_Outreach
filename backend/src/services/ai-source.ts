import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { db, Prisma } from '../core/db.js';
import { AppError } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { SubscriptionError } from '../../../integrations/src/ai/subscription/types.js';

/**
 * Where a workspace's AI work runs: API keys (Settings → AI providers) or a personal Claude / Codex subscription.
 * One setting, read by runAi(), so every AI feature (Copilot, research, personalization, replies, fact-checks,
 * AI Studio) follows it. A campaign can override it for its own personalization.
 *
 * Subscriptions are personal logins, so a subscription source always names the person whose login is used, and is
 * only available where that person may use subscriptions on this install (private installs; never while public
 * sign-up is open). There is no silent fallback to paid API calls unless an admin ticks "fall back to API keys".
 */
export const AI_SOURCE_MODES = ['api', 'claude_subscription', 'codex_subscription'] as const;
export type AiSourceMode = (typeof AI_SOURCE_MODES)[number];
export type CampaignAiSource = 'workspace' | AiSourceMode;

const StoredSchema = z.object({
  mode: z.enum(AI_SOURCE_MODES).default('api'),
  ownerUserId: z.string().uuid().nullable().default(null),
  fallbackToApi: z.boolean().default(false),
  updatedAt: z.string().nullable().default(null),
});
type Stored = z.infer<typeof StoredSchema>;

export const SetAiSourceSchema = z.object({ mode: z.enum(AI_SOURCE_MODES), fallbackToApi: z.boolean().default(false) });

const PROVIDER: Record<Exclude<AiSourceMode, 'api'>, 'CLAUDE_SUBSCRIPTION' | 'CODEX_SUBSCRIPTION'> = { claude_subscription: 'CLAUDE_SUBSCRIPTION', codex_subscription: 'CODEX_SUBSCRIPTION' };
export const AI_SOURCE_LABEL: Record<AiSourceMode, string> = { api: 'API keys', claude_subscription: 'Claude subscription', codex_subscription: 'Codex subscription' };

async function readStored(workspaceId: string): Promise<Stored> {
  const ws = await db().workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
  return StoredSchema.parse(((ws?.settings ?? {}) as { aiSource?: unknown }).aiSource ?? {});
}

/** Whether `userId` may run AI on their `mode` subscription right now, and why not. */
async function subscriptionUsable(userId: string | null, mode: Exclude<AiSourceMode, 'api'>): Promise<{ ok: boolean; reason: string | null }> {
  const label = AI_SOURCE_LABEL[mode];
  if (!userId) return { ok: false, reason: `Nobody's ${label} is selected` };
  const subs = await import('./ai-subscriptions.js');
  if (!(await subs.isAiSubscriptionOwner(userId))) return { ok: false, reason: `${label} is not available for this account on this install` };
  const c = await subs.loadConnection(userId, PROVIDER[mode]);
  if (!c || ['DISCONNECTED', 'CONNECTING'].includes(c.status)) return { ok: false, reason: `${label} is not connected. Connect it under AI → Subscriptions.` };
  if (c.status === 'EXPIRED') return { ok: false, reason: `${label} sign-in expired. Reconnect it under AI → Subscriptions.` };
  if (c.paused) return { ok: false, reason: `${label} is paused in AI → Subscriptions` };
  return { ok: true, reason: null };
}

/** What the AI settings card shows: current source, who it belongs to, and which options this person can pick. */
export async function getAiSource(workspaceId: string, viewerUserId: string | null) {
  const s = await readStored(workspaceId);
  const owner = s.ownerUserId ? await db().user.findUnique({ where: { id: s.ownerUserId }, select: { name: true, email: true } }) : null;
  const apiProviders = await db().aiProvider.count({ where: { workspaceId, isEnabled: true } });
  const current = s.mode === 'api' ? { ok: apiProviders > 0, reason: apiProviders ? null : 'No API key is added. Add one under AI providers.' } : await subscriptionUsable(s.ownerUserId, s.mode);
  const options = await Promise.all(AI_SOURCE_MODES.map(async (mode) => {
    if (mode === 'api') return { mode, label: AI_SOURCE_LABEL[mode], available: true, reason: apiProviders ? null : 'Add an API key under AI providers first' };
    const u = await subscriptionUsable(viewerUserId, mode);
    return { mode, label: AI_SOURCE_LABEL[mode], available: u.ok, reason: u.reason };
  }));
  return { mode: s.mode, fallbackToApi: s.fallbackToApi, owner, updatedAt: s.updatedAt, ready: current.ok, problem: current.reason, apiProviders, options };
}

/** Admins only. Choosing a subscription uses the chooser's own login, recorded server-side. */
export async function setAiSource(workspaceId: string, input: z.infer<typeof SetAiSourceSchema>, actor: Actor) {
  if (input.mode !== 'api') {
    const u = await subscriptionUsable(actor.userId ?? null, input.mode);
    if (!u.ok) throw new AppError('AI_SUBSCRIPTION_UNAVAILABLE', u.reason ?? 'Subscription unavailable', 409);
  }
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
  const stored: Stored = { mode: input.mode, ownerUserId: input.mode === 'api' ? null : actor.userId ?? null, fallbackToApi: input.fallbackToApi, updatedAt: new Date().toISOString() };
  await db().workspace.update({ where: { id: workspaceId }, data: { settings: { ...((ws.settings ?? {}) as object), aiSource: stored } as Prisma.InputJsonValue } });
  await audit(workspaceId, actor, 'ai.source_changed', { type: 'workspace', id: workspaceId }, { mode: input.mode, fallbackToApi: input.fallbackToApi });
  return getAiSource(workspaceId, actor.userId ?? null);
}

export interface ResolvedSource { mode: AiSourceMode; ownerUserId: string | null; fallbackToApi: boolean; from: 'workspace' | 'campaign' }

/**
 * The source for one AI call. A campaign's own choice wins; a campaign that picks a subscription uses the
 * workspace's chosen subscription owner, or else the first workspace member who may use and has connected it.
 */
export async function resolveAiSource(workspaceId: string, campaignId?: string | null): Promise<ResolvedSource> {
  const s = await readStored(workspaceId);
  let mode: AiSourceMode = s.mode;
  let from: ResolvedSource['from'] = 'workspace';
  if (campaignId) {
    const c = await db().campaign.findFirst({ where: { id: campaignId, workspaceId }, select: { aiOverrides: true } });
    const pick = ((c?.aiOverrides ?? {}) as { aiSource?: CampaignAiSource }).aiSource;
    if (pick && pick !== 'workspace') { mode = pick; from = 'campaign'; }
  }
  if (mode === 'api') return { mode, ownerUserId: null, fallbackToApi: false, from };
  let owner = s.ownerUserId;
  if (!owner || !(await subscriptionUsable(owner, mode)).ok) {
    const members = await db().workspaceMember.findMany({ where: { workspaceId }, select: { userId: true }, orderBy: { createdAt: 'asc' } });
    owner = null;
    for (const m of members) if ((await subscriptionUsable(m.userId, mode)).ok) { owner = m.userId; break; }
  }
  return { mode, ownerUserId: owner ?? s.ownerUserId, fallbackToApi: s.fallbackToApi, from };
}

/** Whether AI can run for this workspace/campaign at all (used by campaign validation). */
export async function aiAvailability(workspaceId: string, campaignId?: string | null) {
  const src = await resolveAiSource(workspaceId, campaignId);
  const api = await db().aiProvider.count({ where: { workspaceId, isEnabled: true } });
  if (src.mode === 'api') return { ok: api > 0, source: src, problem: api ? null : 'AI is used but no API key is added (Settings → AI providers), and no subscription is selected as the AI source' };
  const u = await subscriptionUsable(src.ownerUserId, src.mode);
  if (u.ok || (src.fallbackToApi && api > 0)) return { ok: true, source: src, problem: null };
  return { ok: false, source: src, problem: `AI source is ${AI_SOURCE_LABEL[src.mode]}, but ${u.reason?.replace(/^./, (c) => c.toLowerCase())}` };
}

/**
 * One structured call through a personal subscription, sharing the concurrency slots used by AI generation runs.
 * Waits for a free slot up to `maxWaitMs`.
 */
export async function runOnSubscription(src: ResolvedSource, req: { system: string; user: string; jsonSchema: Record<string, unknown>; timeoutMs?: number }, maxWaitMs = 120_000) {
  if (src.mode === 'api' || !src.ownerUserId) throw new SubscriptionError('UNAVAILABLE', 'No subscription is selected');
  const provider = PROVIDER[src.mode];
  const subs = await import('./ai-subscriptions.js');
  const runs = await import('./ai-workflow-runs.js');
  const runner = await subs.runnerFor(src.ownerUserId, provider);
  const conn = await subs.loadConnection(src.ownerUserId, provider);
  const holder = `runai_${randomUUID()}`;
  const started = Date.now();
  let slot = await runs.acquireProviderSlot(src.ownerUserId, provider, holder);
  while ('retryInMs' in slot) {
    if (Date.now() - started > maxWaitMs) throw new SubscriptionError('USAGE_LIMIT', `${AI_SOURCE_LABEL[src.mode]} is busy with other AI work; try again shortly`);
    const wait = slot.retryInMs;
    await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
    slot = await runs.acquireProviderSlot(src.ownerUserId, provider, holder);
  }
  const { release } = slot;
  try {
    const r = await runner.run({ system: req.system, prompt: req.user, jsonSchema: req.jsonSchema, model: conn?.model ?? null, allowWeb: false, timeoutMs: req.timeoutMs ?? 240_000 });
    await subs.recordProviderOutcome(src.ownerUserId, provider, { ok: true, rateLimit: r.rateLimit });
    return { ...r, provider: (src.mode === 'claude_subscription' ? 'ANTHROPIC' : 'OPENAI') as 'ANTHROPIC' | 'OPENAI', label: AI_SOURCE_LABEL[src.mode] };
  } catch (e) {
    const err = e instanceof SubscriptionError ? e : new SubscriptionError('FAILED', (e as Error).message);
    await subs.recordProviderOutcome(src.ownerUserId, provider, { ok: false, error: err });
    throw err;
  } finally {
    await release();
  }
}
