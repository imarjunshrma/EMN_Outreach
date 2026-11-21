import { z } from 'zod';
import { db } from '../core/db.js';
import { adapters } from '../core/container.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit, publish, type Actor } from '../core/audit.js';
import { DISPOSABLE_DOMAINS } from '../../../integrations/src/providers/extra.js';
import { readSettings } from './workspace.js';
import { getSecret, recordUsage } from './integrations.js';

// Verification / enrichment waterfall.
// Verify: try verifiers in the workspace's order until one gives a definitive answer (VALID, INVALID or
// CATCH_ALL); UNKNOWN/RISKY or provider errors fall through to the next configured provider.
// Already-verified leads (VALID/INVALID within `freshDays`) are skipped unless forced — no wasted credits.
// Disposable domains are rejected offline. A verification result is NEVER permission to contact.

const DEFINITIVE = new Set(['VALID', 'INVALID', 'CATCH_ALL']);
const LEGACY = new Set(['millionverifier', 'zerobounce', 'neverbounce']);

export async function verifyWaterfall(workspaceId: string, leadId: string, opts: { force?: boolean; freshDays?: number } = {}) {
  const lead = await db().lead.findFirst({ where: { id: leadId, workspaceId } });
  if (!lead) throw NotFound('Lead');
  const fresh = opts.freshDays ?? 90;
  if (!opts.force && ['VALID', 'INVALID'].includes(lead.emailVerificationStatus) && lead.emailVerifiedAt && lead.emailVerifiedAt > new Date(Date.now() - fresh * 86400_000)) {
    return { result: lead.emailVerificationStatus, skipped: 'recently verified', steps: [] as Array<Record<string, unknown>> };
  }
  const steps: Array<{ provider: string; result?: string; error?: string }> = [];
  const { ws: ent } = await import('./entitlements.js');
  const { meter } = await import('./usage.js');
  const save = async (provider: string, result: string, raw: string, step: number, cost: number | null) => {
    const v = await db().emailVerification.create({ data: { workspaceId, leadId, email: lead.emailNormalized, provider, result: result as never, rawResult: raw.slice(0, 500), kind: 'VERIFY', step, costCredits: cost } });
    if (cost) meter({ workspaceId, metric: 'enrichments', quantity: 1, key: `verify:${v.id}` });
  };
  const domain = lead.emailNormalized.split('@')[1] ?? '';
  let final: string | null = null;
  if (DISPOSABLE_DOMAINS.has(domain)) {
    await save('offline-disposable-list', 'UNKNOWN', 'disposable domain attribute; mailbox validity not checked', 0, 0);
    steps.push({ provider: 'offline-disposable-list', result: 'UNKNOWN' });
    final = 'UNKNOWN';
  } else {
    const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const st = readSettings(ws.settings);
    let order = [...new Set([...st.verifierOrder, ...(st.verifierProvider !== 'none' ? [st.verifierProvider] : [])])].filter((p) => LEGACY.has(p));
    const bill = await import('./billing.js');
    if (bill.billingEnabled() && !(await bill.billingState(workspaceId)).entitlements.features.waterfall) order = order.slice(0, 1); // plan without waterfall: single provider
    let step = 0;
    let lastNonDefinitive: string | null = null;
    for (const provider of order) {
      const sec = await getSecret(workspaceId, provider as never);
      if (!sec) { steps.push({ provider, error: 'not configured' }); continue; }
      await ent.metered(workspaceId, 'enrichments'); // monthly allowance (paid provider credits)
      step++;
      try {
        const r = await adapters().verifiers[provider].verify(sec.secret, lead.emailNormalized);
        await save(provider, r.result, r.raw, step, 1);
        await recordUsage(workspaceId, provider, 'verify', 1, { leadId, waterfallStep: step });
        steps.push({ provider, result: r.result });
        if (DEFINITIVE.has(r.result)) { final = r.result; break; }
        lastNonDefinitive = r.result;
      } catch (e) {
        steps.push({ provider, error: (e as Error).message.slice(0, 200) });
      }
    }
    if (!steps.some((x) => x.result)) {
      if (!order.length || steps.every((x) => x.error === 'not configured')) throw new AppError('PROVIDER_NOT_CONFIGURED', 'No email verifier is configured. Add MillionVerifier, ZeroBounce or NeverBounce under Integrations.', 400);
      return { result: lead.emailVerificationStatus, steps, note: 'All configured verifiers failed; nothing changed' };
    }
    final ??= lastNonDefinitive;
  }
  await db().lead.update({ where: { id: leadId }, data: { emailVerificationStatus: final as never, emailVerifiedAt: new Date() } });
  await publish(workspaceId, 'lead.updated', { leadId });
  const { emitEvent } = await import('./automation.js');
  await emitEvent(workspaceId, 'lead.enriched', `${leadId}:${Date.now()}`, { leadId, verification: final });
  return { result: final, steps };
}

export const FindSchema = z.object({ firstName: z.string().min(1).max(100), lastName: z.string().min(1).max(100), domain: z.string().min(3).max(253) });

/** Email discovery waterfall (finders in order), each candidate verified before it is returned as usable. */
export async function findEmail(workspaceId: string, q: z.infer<typeof FindSchema>, actor: Actor) {
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const order = readSettings(ws.settings).finderOrder;
  const domain = q.domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const attempts: Array<{ provider: string; email?: string | null; confidence?: number | null; error?: string }> = [];
  for (const provider of order) {
    const sec = await getSecret(workspaceId, provider as never);
    if (!sec) { attempts.push({ provider, error: 'not configured' }); continue; }
    const { ws: ent } = await import('./entitlements.js');
    await ent.metered(workspaceId, 'enrichments');
    try {
      const r = await adapters().finders[provider].find(sec.secret, { ...q, domain });
      await recordUsage(workspaceId, provider, 'find', 1, { domain });
      (await import('./usage.js')).meter({ workspaceId, metric: 'enrichments', quantity: 1, key: `find:${provider}:${domain}:${q.firstName}:${q.lastName}:${Date.now()}` });
      attempts.push({ provider, email: r.email, confidence: r.confidence });
      if (r.email) {
        await audit(workspaceId, actor, 'enrichment.email_found', undefined, { provider, domain });
        return { email: r.email.toLowerCase(), confidence: r.confidence, source: provider, attempts, note: 'Discovered address — verify it (and confirm you have a lawful basis) before contacting.' };
      }
    } catch (e) { attempts.push({ provider, error: (e as Error).message.slice(0, 200) }); }
  }
  if (!order.length) throw new AppError('PROVIDER_NOT_CONFIGURED', 'No email finder configured (add Hunter under Integrations and enable it in the waterfall order).', 400);
  return { email: null, confidence: null, source: null, attempts };
}

/** Provider comparison: checks, definitive rate and credits used (from the stored history). */
export async function enrichmentStats(workspaceId: string, days = 90) {
  const since = new Date(Date.now() - days * 86400_000);
  const rows = await db().emailVerification.groupBy({ by: ['provider', 'result'], where: { workspaceId, createdAt: { gte: since } }, _count: { _all: true }, _sum: { costCredits: true } });
  const byProvider = new Map<string, { provider: string; checks: number; definitive: number; credits: number; results: Record<string, number> }>();
  for (const r of rows) {
    const p = byProvider.get(r.provider) ?? { provider: r.provider, checks: 0, definitive: 0, credits: 0, results: {} };
    p.checks += r._count._all; p.credits += Number(r._sum.costCredits ?? 0); p.results[r.result] = r._count._all;
    if (DEFINITIVE.has(r.result)) p.definitive += r._count._all;
    byProvider.set(r.provider, p);
  }
  return [...byProvider.values()].map((p) => ({ ...p, definitiveRatePct: p.checks ? +(100 * p.definitive / p.checks).toFixed(1) : 0 }));
}

export async function verificationHistory(workspaceId: string, leadId: string) {
  return db().emailVerification.findMany({ where: { workspaceId, leadId }, orderBy: { createdAt: 'desc' }, take: 50 });
}
