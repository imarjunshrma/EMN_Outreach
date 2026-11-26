import { z } from 'zod';
import { db } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import type { Actor } from '../core/audit.js';

const evidenceText = z.string().trim().max(500).refine(
  value => !/\b(?:bearer\s+|(?:password|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)\s*[:=])/i.test(value),
  'Use an evidence reference with credentials removed.',
);
export const ReconciliationSchema = z.object({
  decision: z.enum(['CONFIRMED_ACCEPTED', 'CONFIRMED_NOT_SUBMITTED', 'STILL_UNCERTAIN', 'MANUALLY_CLOSED']),
  reason: evidenceText.min(10),
  evidence: evidenceText.optional(),
  confirmed: z.literal(true),
}).refine(value => !value.decision.startsWith('CONFIRMED_') || !!value.evidence,
  { path: ['evidence'], message: 'A provider evidence reference is required for a confirmed decision.' });

export async function listUncertainSends(workspaceId: string, page: number, pageSize: number, resolved: boolean) {
  const where = { workspaceId, status: 'UNCERTAIN' as const, resolvedAt: resolved ? { not: null } : null };
  const [items, total] = await Promise.all([
    db().outboundEmail.findMany({
      where, orderBy: [{ uncertainAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize,
      select: {
        id: true, attempts: true, sendStartedAt: true, uncertainAt: true, resolvedAt: true, reconciliation: true,
        providerMessageId: true, internetMessageId: true, lastError: true,
        campaign: { select: { name: true } }, emailAccount: { select: { provider: true, emailAddress: true } },
        enrollment: { select: { lead: { select: { id: true, email: true } } } },
      },
    }),
    db().outboundEmail.count({ where }),
  ]);
  const history = await db().auditLog.findMany({
    where: { workspaceId, entityType: 'outbound_email', entityId: { in: items.map(item => item.id) },
      action: { in: ['outbound.submission_decision', 'outbound.reconciliation_reviewed'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200,
    select: { entityId: true, action: true, createdAt: true, actorUserId: true, metadata: true },
  });
  return { items: items.map(item => ({ ...item, history: history.filter(event => event.entityId === item.id).slice(0, 10) })), total };
}

export async function resolveUncertainSend(workspaceId: string, id: string, input: z.infer<typeof ReconciliationSchema>, actor: Actor) {
  if (actor.type !== 'USER' || !actor.userId) throw new AppError('FORBIDDEN', 'A signed-in administrator is required.', 403);
  const { decision, reason, evidence } = input;
  const reviewedAt = new Date();
  const reconciliation = { decision, reason, evidence: evidence ?? null, reviewedAt: reviewedAt.toISOString(), reviewedBy: actor.userId };
  const resolvedAt = decision === 'STILL_UNCERTAIN' ? null : reviewedAt;
  await db().$transaction(async tx => {
    const row = await tx.outboundEmail.findFirst({ where: { workspaceId, id, status: 'UNCERTAIN' }, select: { updatedAt: true } });
    if (!row) throw NotFound('Uncertain send');
    const result = await tx.outboundEmail.updateMany({
      where: { workspaceId, id, status: 'UNCERTAIN', resolvedAt: null, updatedAt: row.updatedAt },
      data: { resolvedAt, reconciliation },
    });
    if (!result.count) throw new AppError('CONFLICT', 'This attempt was already reconciled or updated. Refresh the queue.', 409);
    await tx.auditLog.create({ data: {
      workspaceId, actorType: actor.type, actorUserId: actor.userId, action: 'outbound.reconciliation_reviewed',
      entityType: 'outbound_email', entityId: id, metadata: { ...reconciliation, retryDecision: 'BLOCKED', failoverDecision: 'DISABLED' },
    } });
  });
  return { resolvedAt, reconciliation };
}
