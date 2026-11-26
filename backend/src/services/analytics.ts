import { emptyTracking, trackingTotals } from './tracking-analytics.js';
import { db, Prisma } from '../core/db.js';

// Analytics are computed from recorded rows. "Measured" = events we observed directly;
// "estimate" = values that depend on incomplete signals (opens, delivery) or user-entered data.

function since(days: number) { return new Date(Date.now() - days * 86400_000); }

export async function overview(workspaceId: string, days = 30) {
  const from = since(days);
  const [prospects, qualified, verified, eventCounts, meetings, opportunities, aiCost, positive, research, drafts, embeddings, tracking] = await Promise.all([
    db().lead.count({ where: { workspaceId, createdAt: { gte: from } } }),
    db().lead.count({ where: { workspaceId, createdAt: { gte: from }, scores: { some: { qualified: true } } } }),
    db().lead.count({ where: { workspaceId, createdAt: { gte: from }, emailVerificationStatus: 'VALID' } }),
    db().emailEvent.groupBy({ by: ['type'], where: { workspaceId, occurredAt: { gte: from } }, _count: { _all: true } }),
    db().leadStatusChange.count({ where: { workspaceId, toStatus: 'MEETING_BOOKED', createdAt: { gte: from } } }),
    db().opportunity.aggregate({ where: { workspaceId, stage: 'WON', closedAt: { gte: from } }, _sum: { valueCents: true }, _count: { _all: true } }),
    db().aiExecution.aggregate({ where: { workspaceId, createdAt: { gte: from } }, _sum: { costUsd: true, inputTokens: true, outputTokens: true } }),
    db().emailMessage.count({ where: { workspaceId, direction: 'INBOUND', sentAt: { gte: from }, category: { in: ['INTERESTED', 'WANTS_PRICING', 'WANTS_MEETING', 'NEEDS_INFO'] } } }),
    db().researchReport.groupBy({ by: ['status'], where: { workspaceId, leadId: { not: null }, completedAt: { gte: from } }, _count: { _all: true } }),
    db().leadPersonalization.groupBy({ by: ['qualityPassed'], where: { workspaceId, generatedAt: { gte: from }, status: { in: ['GENERATED', 'APPROVED', 'BLOCKED', 'REJECTED'] } }, _count: { _all: true } }),
    db().usageRecord.aggregate({ where: { workspaceId, kind: 'embedding', createdAt: { gte: from } }, _sum: { units: true, costUsd: true } }),
    trackingTotals(workspaceId, 'workspace'),
  ]);
  const ev = (t: string) => eventCounts.find((e) => e.type === t)?._count._all ?? 0;
  const sent = ev('SENT');
  const bounced = ev('BOUNCED_HARD');
  const replies = ev('REPLIED');
  const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
  const completedResearch = research.find((row) => row.status === 'COMPLETED')?._count._all ?? 0;
  const failedResearch = research.find((row) => row.status === 'FAILED')?._count._all ?? 0;
  const evaluatedDrafts = drafts.reduce((sum, row) => sum + row._count._all, 0);
  const passedDrafts = drafts.find((row) => row.qualityPassed)?._count._all ?? 0;
  return {
    intelligence: {
      completedResearch, failedResearch, completionRatePct: rate(completedResearch, completedResearch + failedResearch),
      evaluatedDrafts, passedDrafts, passRatePct: rate(passedDrafts, evaluatedDrafts),
      modelTokens: (aiCost._sum.inputTokens ?? 0) + (aiCost._sum.outputTokens ?? 0), embeddingTokens: embeddings._sum.units ?? 0,
    },
    periodDays: days,
    lifetimeTracking: tracking.get(workspaceId) ?? emptyTracking,
    measured: {
      prospectsAdded: prospects, qualified, verifiedEmails: verified, emailsSent: sent, bounces: bounced, softBounces: ev('BOUNCED_SOFT'),
      replies, autoReplies: ev('AUTO_REPLIED'), positiveReplies: positive, meetingsBooked: meetings, unsubscribes: ev('UNSUBSCRIBED'),
      complaintsDetected: ev('COMPLAINED'), sendFailures: ev('FAILED'), wonDeals: opportunities._count._all,
    },
    rates: { replyRatePct: rate(replies, sent), positiveReplyRatePct: rate(positive, sent), bounceRatePct: rate(bounced, sent), meetingRatePct: rate(meetings, sent), qualificationRatePct: rate(qualified, prospects) },
    estimates: {
      deliveredEmails: { value: null, note: 'Connected mailbox providers do not confirm recipient delivery.' },
      opens: { value: ev('OPENED'), note: 'Only when open tracking is enabled; inflated by privacy proxies and deflated by image blocking.' },
      clicks: { value: ev('CLICKED'), note: 'Only when click tracking is enabled.' },
      complaints: { note: 'Gmail, Microsoft Graph, and SMTP/IMAP do not supply complaint feedback through these integrations. The measured count comes from reply classification.' },
      wonValueCents: { value: opportunities._sum.valueCents ?? 0, note: 'User-entered opportunity values.' },
      aiCostUsd: { value: Number(aiCost._sum.costUsd ?? 0) + Number(embeddings._sum.costUsd ?? 0), note: 'Estimated from tracked model and embedding tokens and configured prices. Unpriced usage is excluded.' },
    },
  };
}

export async function daily(workspaceId: string, days = 30) {
  const from = since(days);
  const rows = await db().$queryRaw<Array<{ day: Date; type: string; n: bigint }>>`
    SELECT date_trunc('day', "occurredAt") AS day, type::text AS type, count(*) AS n
    FROM "EmailEvent" WHERE "workspaceId" = ${workspaceId}::uuid AND "occurredAt" >= ${from}
    GROUP BY 1, 2 ORDER BY 1`;
  const leads = await db().$queryRaw<Array<{ day: Date; n: bigint }>>`
    SELECT date_trunc('day', "createdAt") AS day, count(*) AS n FROM "Lead"
    WHERE "workspaceId" = ${workspaceId}::uuid AND "createdAt" >= ${from} GROUP BY 1 ORDER BY 1`;
  const map = new Map<string, Record<string, number>>();
  for (let i = days - 1; i >= 0; i--) map.set(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10), { SENT: 0, REPLIED: 0, BOUNCED_HARD: 0, UNSUBSCRIBED: 0, leads: 0 });
  for (const r of rows) { const k = r.day.toISOString().slice(0, 10); const o = map.get(k); if (o) o[r.type] = Number(r.n); }
  for (const r of leads) { const k = r.day.toISOString().slice(0, 10); const o = map.get(k); if (o) o.leads = Number(r.n); }
  return [...map.entries()].map(([day, v]) => ({ day, sent: v.SENT ?? 0, replied: v.REPLIED ?? 0, bounced: v.BOUNCED_HARD ?? 0, unsubscribed: v.UNSUBSCRIBED ?? 0, leads: v.leads ?? 0 }));
}

export async function monthly(workspaceId: string, months = 12) {
  const from = new Date(); from.setUTCMonth(from.getUTCMonth() - months + 1, 1); from.setUTCHours(0, 0, 0, 0);
  const rows = await db().$queryRaw<Array<{ month: Date; type: string; n: bigint }>>`
    SELECT date_trunc('month', "occurredAt") AS month, type::text AS type, count(*) AS n
    FROM "EmailEvent" WHERE "workspaceId" = ${workspaceId}::uuid AND "occurredAt" >= ${from}
    GROUP BY 1, 2 ORDER BY 1`;
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) { const k = r.month.toISOString().slice(0, 7); out.set(k, { ...(out.get(k) ?? {}), [r.type]: Number(r.n) }); }
  return [...out.entries()].map(([month, v]) => ({ month, sent: v.SENT ?? 0, replied: v.REPLIED ?? 0, bounced: v.BOUNCED_HARD ?? 0, unsubscribed: v.UNSUBSCRIBED ?? 0 }));
}

export async function campaignPerformance(workspaceId: string) {
  const campaigns = await db().campaign.findMany({ where: { workspaceId }, select: { id: true, name: true, status: true } });
  const events = await db().emailEvent.groupBy({ by: ['campaignId', 'type'], where: { workspaceId, campaignId: { not: null } }, _count: { _all: true } });
  const positive = await db().$queryRaw<Array<{ campaignId: string; n: bigint }>>`
    SELECT c."campaignId", count(*) AS n FROM "EmailMessage" m JOIN "Conversation" c ON c.id = m."conversationId"
    WHERE m."workspaceId" = ${workspaceId}::uuid AND m.direction = 'INBOUND' AND m.category IN ('INTERESTED','WANTS_PRICING','WANTS_MEETING','NEEDS_INFO') AND c."campaignId" IS NOT NULL
    GROUP BY 1`;
  const opps = await db().opportunity.groupBy({ by: ['campaignId'], where: { workspaceId, campaignId: { not: null } }, _count: { _all: true }, _sum: { valueCents: true } });
  const tracking = await trackingTotals(workspaceId, 'campaign');
  return campaigns.map((c) => {
    const get = (t: string) => events.find((e) => e.campaignId === c.id && e.type === t)?._count._all ?? 0;
    const sent = get('SENT');
    const pos = Number(positive.find((p) => p.campaignId === c.id)?.n ?? 0);
    return { ...c, lifetimeTracking: tracking.get(c.id) ?? emptyTracking, sent, estimatedOpens: get('OPENED'), estimatedClicks: get('CLICKED'), replies: get('REPLIED'), positive: pos, bounces: get('BOUNCED_HARD'), unsubscribes: get('UNSUBSCRIBED'), complaints: get('COMPLAINED'), replyRatePct: sent ? Math.round((get('REPLIED') / sent) * 1000) / 10 : null, opportunities: opps.find((o) => o.campaignId === c.id)?._count._all ?? 0, pipelineValueCents: opps.find((o) => o.campaignId === c.id)?._sum.valueCents ?? 0 };
  });
}

export async function stepPerformance(workspaceId: string, campaignId: string) {
  const rows = await db().$queryRaw<Array<{ order: number; label: string; sent: bigint; replied: bigint }>>`
    WITH campaign_sends AS (
      SELECT id, "enrollmentId", "stepId", "variantId", "sentAt"
      FROM "OutboundEmail"
      WHERE "workspaceId" = ${workspaceId}::uuid AND "campaignId" = ${campaignId}::uuid AND status = 'SENT'
    ), attributed AS (
      SELECT latest.id AS "outboundId", count(*) AS replies
      FROM "EmailEvent" e
      JOIN LATERAL (
        SELECT o.id FROM campaign_sends o
        WHERE o."enrollmentId" = e."enrollmentId" AND o."sentAt" <= e."occurredAt"
        ORDER BY o."sentAt" DESC, o.id DESC LIMIT 1
      ) latest ON true
      WHERE e."workspaceId" = ${workspaceId}::uuid AND e."campaignId" = ${campaignId}::uuid AND e.type = 'REPLIED'
      GROUP BY latest.id
    )
    SELECT s."order", v.label, count(*) AS sent, coalesce(sum(a.replies), 0)::bigint AS replied
    FROM campaign_sends o
    JOIN "SequenceStep" s ON s.id = o."stepId"
    JOIN "SequenceStepVariant" v ON v.id = o."variantId"
    LEFT JOIN attributed a ON a."outboundId" = o.id
    GROUP BY 1, 2 ORDER BY 1, 2`;
  return rows.map((r) => ({ step: r.order, variant: r.label, sent: Number(r.sent), replied: Number(r.replied), note: 'Each reply is attributed to the latest preceding send in its enrollment.' }));
}

export async function mailboxPerformance(workspaceId: string, days = 30) {
  const from = since(days);
  const accounts = await db().emailAccount.findMany({ where: { workspaceId }, select: { id: true, emailAddress: true, status: true, provider: true, dailySendLimit: true } });
  const events = await db().emailEvent.groupBy({ by: ['emailAccountId', 'type'], where: { workspaceId, occurredAt: { gte: from } }, _count: { _all: true } });
  return accounts.map((a) => {
    const get = (t: string) => events.find((e) => e.emailAccountId === a.id && e.type === t)?._count._all ?? 0;
    const sent = get('SENT');
    return { ...a, sent, replies: get('REPLIED'), bounces: get('BOUNCED_HARD'), failures: get('FAILED'), bounceRatePct: sent ? Math.round((get('BOUNCED_HARD') / sent) * 1000) / 10 : null, replyRatePct: sent ? Math.round((get('REPLIED') / sent) * 1000) / 10 : null };
  });
}

export async function providerUsage(workspaceId: string, days = 30) {
  const rows = await db().usageRecord.groupBy({ by: ['provider', 'kind'], where: { workspaceId, createdAt: { gte: since(days) } }, _sum: { units: true }, _count: { _all: true } });
  return { rows: rows.map((r) => ({ provider: r.provider, kind: r.kind, calls: r._count._all, units: r._sum.units ?? 0 })), note: 'Unit counts are recorded per API call; check provider dashboards for billed credits.' };
}

export type _Unused = Prisma.Decimal;
