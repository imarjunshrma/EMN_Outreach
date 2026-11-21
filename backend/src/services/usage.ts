import { db } from '../core/db.js';
import { orgIdOf } from '../core/tenant.js';
import type { UsageMetric } from '../../../shared/src/tenancy.js';

// Usage metering. Each event carries an idempotency key that is unique per tenant, so a retried job or request
// is never counted twice. Counters are per calendar month (UTC) and updated with a single atomic upsert.
//
// When usage is counted (see docs/saas/USAGE_METERING_AND_ENTITLEMENTS.md):
//   email_sends        when the mail provider ACCEPTED the message (not on attempt)      key send:<outboundId>
//   ai_requests/tokens/ai_cost_micro_usd  after a successful AI response                key ai:<executionId>
//   enrichments        per verification/finder provider call that returned a result    key verify:<verificationId>
//   api_calls          per authenticated API-key request                                 key api:<requestId>
//   workflow_runs      per non-test workflow run that started                            key wf:<runId>
//   storage_bytes      per stored file (positive) and deletion (negative)                key store:<key>[:del]

export function periodOf(at = new Date()) {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
}

export async function recordUsage(p: { organizationId?: string; workspaceId?: string | null; metric: UsageMetric; quantity: number | bigint; key: string; at?: Date }) {
  const organizationId = p.organizationId ?? (p.workspaceId ? await orgIdOf(p.workspaceId) : null);
  if (!organizationId || !p.quantity) return { counted: false };
  const q = BigInt(Math.round(Number(p.quantity)));
  const { start, end } = periodOf(p.at);
  return db().$transaction(async (tx) => {
    const inserted = await tx.$executeRaw`
      INSERT INTO "UsageEvent" ("id","organizationId","workspaceId","metric","quantity","idempotencyKey","occurredAt")
      VALUES (gen_random_uuid(), ${organizationId}::uuid, ${p.workspaceId ?? null}::uuid, ${p.metric}, ${q}, ${p.key}, ${p.at ?? new Date()})
      ON CONFLICT ("organizationId","idempotencyKey") DO NOTHING`;
    if (!inserted) return { counted: false, duplicate: true };
    await tx.$executeRaw`
      INSERT INTO "UsageCounter" ("id","organizationId","metric","periodStart","periodEnd","value","updatedAt")
      VALUES (gen_random_uuid(), ${organizationId}::uuid, ${p.metric}, ${start}, ${end}, ${q}, now())
      ON CONFLICT ("organizationId","metric","periodStart") DO UPDATE SET "value" = "UsageCounter"."value" + EXCLUDED."value", "updatedAt" = now()`;
    return { counted: true };
  });
}

/** Fire-and-forget variant for hot paths: metering must never break the operation it measures. */
export function meter(p: Parameters<typeof recordUsage>[0]) {
  recordUsage(p).catch(() => undefined);
}

export async function currentUsage(organizationId: string, at = new Date()) {
  const { start, end } = periodOf(at);
  const rows = await db().usageCounter.findMany({ where: { organizationId, periodStart: start } });
  const metered = Object.fromEntries(rows.map((r) => [r.metric, Number(r.value)])) as Partial<Record<UsageMetric, number>>;
  const wsIds = (await db().workspace.findMany({ where: { organizationId }, select: { id: true } })).map((w) => w.id);
  const [users, workspaces, mailboxes, runningCampaigns, leads] = await Promise.all([
    db().organizationMember.count({ where: { organizationId } }),
    db().workspace.count({ where: { organizationId, archivedAt: null } }),
    db().emailAccount.count({ where: { workspaceId: { in: wsIds } } }),
    db().campaign.count({ where: { workspaceId: { in: wsIds }, status: 'RUNNING' } }),
    db().lead.count({ where: { workspaceId: { in: wsIds } } }),
  ]);
  const { storageBytes } = await import('./storage-accounting.js');
  const storageMb = Math.round((await storageBytes(organizationId)) / 1048576 * 10) / 10;
  return { period: { start, end }, counts: { users, workspaces, mailboxes, runningCampaigns, leads, storageMb }, metered };
}

export async function usageHistory(organizationId: string, months = 6) {
  const since = new Date(); since.setUTCMonth(since.getUTCMonth() - months);
  const rows = await db().usageCounter.findMany({ where: { organizationId, periodStart: { gte: since } }, orderBy: { periodStart: 'asc' } });
  return rows.map((r) => ({ metric: r.metric, periodStart: r.periodStart, value: Number(r.value) }));
}
