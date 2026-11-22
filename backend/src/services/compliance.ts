import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { db } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit, publish, type Actor } from '../core/audit.js';
import { evaluateCompliance, type LawfulBasisValue } from '../../../shared/src/compliance.js';
import { verifyPayload } from '../core/crypto.js';
import type { WorkspaceSettings } from './workspace.js';

// Suppression list, unsubscribe processing and country rules.
// Technical safeguards only — not legal advice.

export async function isSuppressed(workspaceId: string, email: string): Promise<{ suppressed: boolean; reason?: string }> {
  const e = email.trim().toLowerCase();
  const domain = e.split('@')[1] ?? '';
  const hit = await db().suppressionEntry.findFirst({ where: { workspaceId, OR: [{ type: 'EMAIL', value: e }, { type: 'DOMAIN', value: domain }] } });
  return hit ? { suppressed: true, reason: hit.reason } : { suppressed: false };
}

export async function addSuppression(
  workspaceId: string,
  input: { type: 'EMAIL' | 'DOMAIN'; value: string; reason: 'UNSUBSCRIBED' | 'HARD_BOUNCE' | 'COMPLAINT' | 'DO_NOT_CONTACT_REQUEST' | 'MANUAL' | 'LEGAL'; source?: string; note?: string },
  actor: Actor,
) {
  const value = input.value.trim().toLowerCase().replace(/^@/, '');
  const entry = await db().suppressionEntry.upsert({
    where: { workspaceId_type_value: { workspaceId, type: input.type, value } },
    update: {},
    create: { workspaceId, type: input.type, value, reason: input.reason, source: input.source, note: input.note },
  });
  // Stop every active sequence for this address/domain.
  const leads = await db().lead.findMany({ where: { workspaceId, ...(input.type === 'EMAIL' ? { emailNormalized: value } : { emailNormalized: { endsWith: `@${value}` } }) }, select: { id: true } });
  const { stopEnrollmentsForLead } = await import('./engine.js');
  const status = input.reason === 'UNSUBSCRIBED' ? 'STOPPED_UNSUBSCRIBED' : input.reason === 'HARD_BOUNCE' ? 'STOPPED_BOUNCED' : input.reason === 'COMPLAINT' ? 'STOPPED_COMPLAINT' : 'STOPPED_SUPPRESSED';
  for (const l of leads) await stopEnrollmentsForLead(workspaceId, l.id, status, `suppressed: ${input.reason}`);
  await audit(workspaceId, actor, 'suppression.added', { type: 'suppression', id: entry.id }, { type: input.type, reason: input.reason, source: input.source });
  return entry;
}

export async function removeSuppression(workspaceId: string, id: string, reason: string, actor: Actor) {
  const e = await db().suppressionEntry.findFirst({ where: { id, workspaceId } });
  if (!e) throw NotFound('Suppression entry');
  if (['UNSUBSCRIBED', 'COMPLAINT', 'DO_NOT_CONTACT_REQUEST'].includes(e.reason) && reason.trim().length < 10) {
    throw new AppError('VALIDATION_FAILED', 'Removing an opt-out requires a documented reason (min 10 characters), e.g. the person re-subscribed in writing.', 400);
  }
  await db().suppressionEntry.delete({ where: { id } });
  await audit(workspaceId, actor, 'suppression.removed', { type: 'suppression', id }, { value: e.value, previousReason: e.reason, reason });
}

/** Pure policy portion of campaign email verification; useful for unit checks and previews. */
export function emailVerificationPolicyReasons(input: {
  status: string; verifiedAt?: Date | null; disposable?: boolean; roleBased?: boolean;
  rawResult?: string | null;
}, settings: Pick<WorkspaceSettings, 'verificationFreshnessDays' | 'verificationUnknownPolicy' | 'verificationDisposablePolicy' | 'verificationRolePolicy'>, now = Date.now()) {
  const reasons: string[] = [];
  if (input.status === 'INVALID') reasons.push('email verified as invalid');
  if (settings.verificationDisposablePolicy === 'block' && (input.disposable || input.rawResult?.toLowerCase().includes('disposable domain'))) reasons.push('email uses a known disposable domain');
  const allowed = ['VALID', 'CATCH_ALL'].includes(input.status)
    || (input.status === 'UNKNOWN' && settings.verificationUnknownPolicy === 'allow')
    || (input.status === 'ROLE_BASED' && settings.verificationRolePolicy === 'allow');
  if (!allowed && input.status !== 'INVALID') reasons.push(`email not eligible for sending (${input.status})`);
  if (input.roleBased && settings.verificationRolePolicy !== 'allow') reasons.push(`role-based address policy is ${settings.verificationRolePolicy}`);
  if (allowed && (!input.verifiedAt || now - input.verifiedAt.getTime() > settings.verificationFreshnessDays * 86_400_000)) reasons.push('email verification is stale or has no verification timestamp');
  return reasons;
}

export async function listSuppressions(workspaceId: string, q: { page: number; pageSize: number; q?: string; reason?: string }) {
  const where = { workspaceId, ...(q.q ? { value: { contains: q.q.toLowerCase() } } : {}), ...(q.reason ? { reason: q.reason as never } : {}) };
  const [items, total] = await Promise.all([
    db().suppressionEntry.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    db().suppressionEntry.count({ where }),
  ]);
  return { items, total };
}

export async function importSuppressions(workspaceId: string, csv: Buffer, actor: Actor) {
  const rows = parse(csv, { bom: true, skip_empty_lines: true, relax_column_count: true }) as string[][];
  let added = 0;
  for (const r of rows) {
    const v = (r[0] ?? '').trim().toLowerCase();
    if (!v || v === 'email' || v === 'value') continue;
    const type = v.includes('@') && !v.startsWith('@') ? 'EMAIL' : 'DOMAIN';
    await addSuppression(workspaceId, { type, value: v, reason: 'MANUAL', source: 'csv' }, actor);
    added++;
  }
  return { added };
}

/** Public unsubscribe (link click or RFC 8058 one-click POST). Idempotent. */
export async function processUnsubscribe(token: string, secret: string) {
  const p = verifyPayload<{ w: string; e: string; l: string | null }>(secret, token);
  if (!p) throw new AppError('INVALID_TOKEN', 'This unsubscribe link is invalid', 400);
  const ws = await db().workspace.findUnique({ where: { id: p.w } });
  if (!ws) throw new AppError('INVALID_TOKEN', 'This unsubscribe link is invalid', 400);
  await addSuppression(p.w, { type: 'EMAIL', value: p.e, reason: 'UNSUBSCRIBED', source: 'unsubscribe_link' }, { type: 'SYSTEM' });
  const lead = await db().lead.findUnique({ where: { workspaceId_emailNormalized: { workspaceId: p.w, emailNormalized: p.e } } });
  if (lead) {
    if (lead.status !== 'UNSUBSCRIBED') {
      await db().lead.update({ where: { id: lead.id }, data: { status: 'UNSUBSCRIBED', statusChanges: { create: { workspaceId: p.w, fromStatus: lead.status, toStatus: 'UNSUBSCRIBED', reason: 'unsubscribe link' } } } });
    }
    await db().emailEvent.upsert({ where: { dedupeKey: `UNSUBSCRIBED:${lead.id}` }, update: {}, create: { workspaceId: p.w, type: 'UNSUBSCRIBED', leadId: lead.id, dedupeKey: `UNSUBSCRIBED:${lead.id}`, metadata: { source: 'link' } } });
  }
  await publish(p.w, 'lead.unsubscribed', { email: p.e });
  return { workspaceName: ws.senderLegalName ?? ws.name };
}

// ---------------------------------------------------------------- country rules

export async function listRules(workspaceId: string) {
  return db().complianceRule.findMany({ where: { workspaceId }, orderBy: { countryCode: 'asc' } });
}

export const RuleSchema = z.object({
  countryCode: z.string().min(1).max(3).toUpperCase(),
  label: z.string().min(1).max(80),
  sendingAllowed: z.boolean(),
  allowedLawfulBases: z.array(z.enum(['UNKNOWN', 'CONSENT', 'LEGITIMATE_INTEREST', 'EXISTING_RELATIONSHIP', 'NOT_REQUIRED'])),
  requirePostalAddress: z.boolean(),
  requireUnsubscribeLink: z.boolean(),
  reviewedByOwner: z.boolean(),
  notes: z.string().max(2000).nullable().optional(),
});

export async function upsertRule(workspaceId: string, input: z.infer<typeof RuleSchema>, actor: Actor) {
  if (input.sendingAllowed && !input.reviewedByOwner && ['EU', 'CA', 'AU', '*'].includes(input.countryCode)) {
    throw new AppError('REVIEW_REQUIRED', 'This country is restricted by default. Confirm it has been reviewed (tick "reviewed") before enabling sending.', 400);
  }
  if (!input.requireUnsubscribeLink) throw new AppError('VALIDATION_FAILED', 'An unsubscribe mechanism is always required.', 400);
  const r = await db().complianceRule.upsert({ where: { workspaceId_countryCode: { workspaceId, countryCode: input.countryCode } }, update: { ...input, notes: input.notes ?? null }, create: { workspaceId, ...input, notes: input.notes ?? null } });
  await audit(workspaceId, actor, 'compliance.rule_updated', { type: 'compliance_rule', id: r.id }, input);
  return r;
}

export async function deleteRule(workspaceId: string, id: string, actor: Actor) {
  const r = await db().complianceRule.findFirst({ where: { id, workspaceId } });
  if (!r) throw NotFound('Rule');
  if (r.countryCode === '*') throw new AppError('VALIDATION_FAILED', 'The default rule cannot be deleted', 400);
  await db().complianceRule.delete({ where: { id } });
  await audit(workspaceId, actor, 'compliance.rule_deleted', { type: 'compliance_rule', id }, { countryCode: r.countryCode });
}

/** Full eligibility check used at enrollment AND again right before every send. */
export async function canContact(workspaceId: string, lead: { emailNormalized: string; country: string | null; lawfulBasis: LawfulBasisValue; status: string; emailVerificationStatus: string; emailVerifiedAt?: Date | null }, opts: { requireVerified: boolean }) {
  void opts; // retained for API compatibility; verification is a workspace-wide safety gate.
  const reasons: string[] = [];
  const sup = await isSuppressed(workspaceId, lead.emailNormalized);
  if (sup.suppressed) reasons.push(`suppressed (${sup.reason})`);
  if (['UNSUBSCRIBED', 'BOUNCED', 'CUSTOMER', 'DISQUALIFIED', 'NOT_INTERESTED'].includes(lead.status)) reasons.push(`lead status ${lead.status}`);
  const ws = await db().workspace.findUnique({ where: { id: workspaceId }, select: { postalAddress: true, settings: true } });
  const { readSettings } = await import('./workspace.js');
  const settings = readSettings(ws?.settings);
  const recentCheck = await db().emailVerification.findFirst({ where: { workspaceId, email: lead.emailNormalized, provider: { in: ['first-party-dns', 'offline-disposable-list'] }, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, select: { details: true, rawResult: true } });
  const details = recentCheck?.details as { attributes?: { disposable?: boolean; roleBased?: boolean } } | null;
  // Workspace-level verification is mandatory even when a campaign's legacy toggle is off.
  reasons.push(...emailVerificationPolicyReasons({ status: lead.emailVerificationStatus, verifiedAt: lead.emailVerifiedAt, disposable: details?.attributes?.disposable, roleBased: details?.attributes?.roleBased, rawResult: recentCheck?.rawResult }, settings));
  const rules = await db().complianceRule.findMany({ where: { workspaceId } });
  const decision = evaluateCompliance(rules, { country: lead.country, lawfulBasis: lead.lawfulBasis, workspaceHasPostalAddress: !!ws?.postalAddress?.trim() });
  reasons.push(...decision.reasons);
  return { allowed: reasons.length === 0, reasons };
}
