import { z } from 'zod';
import { DateTime } from 'luxon';
import { db, Prisma } from '../core/db.js';

export const CampaignSendingPolicy = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('MANUAL'), maximum: z.number().int().min(1).max(2000) }),
  z.object({
    mode: z.literal('GRADUAL'), starting: z.number().int().min(1).max(2000),
    maximum: z.number().int().min(1).max(2000), increase: z.number().int().min(1).max(2000),
    qualifyingDays: z.number().int().min(1).max(30), minimumDailySample: z.number().int().min(1).max(2000),
  }).refine(p => p.starting <= p.maximum, 'Starting target must not exceed the maximum.'),
]);
type Policy = z.infer<typeof CampaignSendingPolicy>;

export function policyTarget(policy: Policy, healthyDays: number, canIncrease: boolean) {
  if (policy.mode === 'MANUAL') return policy.maximum;
  return Math.min(policy.maximum, policy.starting + (canIncrease ? Math.floor(healthyDays / policy.qualifyingDays) * policy.increase : 0));
}

const AUTH_FRESH_MS = 3 * 86_400_000;

export function domainAuthenticationReason(domain: { spfStatus?: string | null; dkimStatus?: string | null; dmarcStatus?: string | null; lastCheckedAt?: Date | null; sendingHoldReason?: string | null } | null, now = new Date()) {
  if (!domain) return 'Domain authentication has not been configured';
  if (domain.sendingHoldReason) return domain.sendingHoldReason;
  const missing = (['SPF', 'DKIM', 'DMARC'] as const).filter(k => !domain[`${k.toLowerCase()}Status` as 'spfStatus' | 'dkimStatus' | 'dmarcStatus']);
  if (missing.length) return `Missing domain authentication result: ${missing.join(', ')}`;
  const failed = (['SPF', 'DKIM', 'DMARC'] as const).filter(k => domain[`${k.toLowerCase()}Status` as 'spfStatus' | 'dkimStatus' | 'dmarcStatus'] !== 'PASS');
  if (failed.length) return `Domain authentication failed: ${failed.join(', ')}`;
  if (!domain.lastCheckedAt || +now - +domain.lastCheckedAt > AUTH_FRESH_MS) return 'Domain authentication checks are stale; refresh SPF, DKIM and DMARC';
  return null;
}

export async function mailboxSendingPolicy(workspaceId: string, mailboxId: string, address: string, timezone: string, now: Date) {
  const name = address.split('@').at(-1)?.toLowerCase() ?? '';
  const [domain, allocations] = await Promise.all([
    db().domain.findUnique({ where: { workspaceId_name: { workspaceId, name } }, select: { spfStatus: true, dkimStatus: true, dmarcStatus: true, lastCheckedAt: true, sendingHoldReason: true } }),
    db().campaignEmailAccount.findMany({ where: { workspaceId, emailAccountId: mailboxId, campaign: { workspaceId, status: 'RUNNING', sendingPolicy: { not: Prisma.DbNull } } },
      select: { campaign: { select: { sendingPolicy: true } } } }),
  ]);
  const checks = Object.entries({ SPF: domain?.spfStatus, DKIM: domain?.dkimStatus, DMARC: domain?.dmarcStatus });
  const authReason = domainAuthenticationReason(domain, now);
  if (authReason) return { target: null, blocked: true, reason: authReason };
  const parsed = allocations.map(a => CampaignSendingPolicy.safeParse(a.campaign.sendingPolicy));
  if (parsed.some(p => !p.success)) return { target: null, blocked: true, reason: 'Mailbox has an invalid campaign sending policy' };
  const policies = parsed.flatMap(p => p.success ? [p.data] : []);
  if (!policies.length) return { target: null, blocked: false, reason: null };
  const domainFresh = !authReason && Boolean(domain?.lastCheckedAt && +now - +domain.lastCheckedAt <= AUTH_FRESH_MS && checks.every(([, v]) => v === 'PASS'));
  const today = DateTime.fromJSDate(now).setZone(timezone).startOf('day');
  const from = today.minus({ days: 30 }).toJSDate();
  const history = domainFresh && policies.some(p => p.mode === 'GRADUAL') ? await db().$queryRaw<{ sent: number; adverse: number }[]>`
    SELECT count(DISTINCT COALESCE("outboundEmailId"::text, "dedupeKey")) FILTER (WHERE type = 'SENT' AND ("outboundEmailId" IS NOT NULL OR "dedupeKey" IS NOT NULL))::int AS sent,
      count(DISTINCT COALESCE("outboundEmailId"::text, "dedupeKey")) FILTER (WHERE type <> 'SENT' AND ("outboundEmailId" IS NOT NULL OR "dedupeKey" IS NOT NULL))::int AS adverse
    FROM "EmailEvent" WHERE "workspaceId" = ${workspaceId}::uuid AND "emailAccountId" = ${mailboxId}::uuid
      AND "occurredAt" >= ${from} AND "occurredAt" < ${today.toJSDate()}
      AND type IN ('SENT', 'BOUNCED_HARD', 'BOUNCED_SOFT', 'COMPLAINED', 'FAILED')
    GROUP BY date_trunc('day', "occurredAt" AT TIME ZONE ${timezone})
  ` : [];
  const recentErrors = domainFresh && policies.some(p => p.mode === 'GRADUAL') ? await db().emailEvent.count({
    where: { workspaceId, emailAccountId: mailboxId, occurredAt: { gte: today.toJSDate() },
      type: { in: ['BOUNCED_HARD', 'BOUNCED_SOFT', 'COMPLAINED', 'FAILED'] } },
  }) : 0;
  const canIncrease = domainFresh && !recentErrors && !history.some(day => day.adverse);
  const target = Math.min(...policies.map(policy => policyTarget(policy,
    policy.mode === 'GRADUAL' ? history.filter(day => day.sent >= policy.minimumDailySample).length : 0, canIncrease)));
  return { target, blocked: false, reason: canIncrease ? 'Shared mailbox sending policy' : 'Shared mailbox sending policy with progression held for health evidence' };
}

/** Classification describes the evidence without inferring delivery or non-submission. */
export function providerFailureClass(status?: number, code?: string) {
  if (code === 'RECIPIENT_NOT_FOUND') return 'INVALID_RECIPIENT';
  if (status === 401 || code === 'invalid_grant' || code === 'InvalidAuthenticationToken') return 'AUTHENTICATION';
  if (status === 429 || code === 'TooManyRequests') return 'THROTTLED';
  if (status === 403) return 'PROVIDER_POLICY_OR_PERMISSION';
  if (status === 408 || status === undefined) return 'CONNECTION_OR_UNKNOWN';
  if (status >= 500) return 'PROVIDER_TRANSIENT';
  return 'PROVIDER_REJECTION';
}

export function bounceFailureClass(status: string | null | undefined) {
  if (status === '5.1.1' || status === '5.1.3') return 'INVALID_RECIPIENT';
  if (/^[45]\.2\.2$/.test(status ?? '')) return 'MAILBOX_FULL';
  if (/^[45]\.7\./.test(status ?? '')) return 'POLICY_REJECTION';
  if (status?.startsWith('4.')) return 'TEMPORARY_RECIPIENT_FAILURE';
  return 'UNKNOWN_RECIPIENT_FAILURE';
}
