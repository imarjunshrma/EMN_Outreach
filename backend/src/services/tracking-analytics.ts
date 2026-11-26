import { db, Prisma } from '../core/db.js';

export interface TrackingTotals {
  rawPixels: number;
  uniquePixels: number;
  automatedPixels: number;
  estimatedOpens: number;
  rawClicks: number;
  uniqueLinks: number;
  automatedClicks: number;
  estimatedClicks: number;
}

export const emptyTracking: TrackingTotals = {
  rawPixels: 0, uniquePixels: 0, automatedPixels: 0, estimatedOpens: 0,
  rawClicks: 0, uniqueLinks: 0, automatedClicks: 0, estimatedClicks: 0,
};

/** Lifetime counts. Unique pixels are outbound IDs and unique links are tracked link IDs. */
export async function trackingTotals(workspaceId: string, scope: 'workspace' | 'campaign' | 'mailbox' | 'prospect', scopeId?: string) {
  const group = {
    workspace: Prisma.sql`o."workspaceId"`,
    campaign: Prisma.sql`o."campaignId"`,
    mailbox: Prisma.sql`o."emailAccountId"`,
    prospect: Prisma.sql`e."leadId"`,
  }[scope];
  const prospect = scope === 'prospect'
    ? Prisma.sql`JOIN "SequenceEnrollment" e ON e.id = o."enrollmentId" AND e."workspaceId" = o."workspaceId" AND e."leadId" = ${scopeId}::uuid`
    : Prisma.empty;
  const rows = await db().$queryRaw<Array<{ id: string } & Record<keyof TrackingTotals, bigint>>>`
    SELECT ${group} AS id,
      sum(o."pixelRequestCount") AS "rawPixels",
      count(*) FILTER (WHERE o."pixelRequestCount" > 0) AS "uniquePixels",
      sum(o."automatedPixelRequestCount") AS "automatedPixels",
      sum(engagement.opens) AS "estimatedOpens",
      sum(links.hits) AS "rawClicks",
      sum(links.unique_links) AS "uniqueLinks",
      sum(links.automated) AS "automatedClicks",
      sum(engagement.clicks) AS "estimatedClicks"
    FROM "OutboundEmail" o
    ${prospect}
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(l."clickCount"), 0)::bigint AS hits,
        count(*) FILTER (WHERE l."clickCount" > 0) AS unique_links,
        coalesce(sum(l."automatedClickCount"), 0)::bigint AS automated
      FROM "TrackedLink" l WHERE l."outboundEmailId" = o.id AND l."workspaceId" = o."workspaceId"
    ) links
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE ev.type = 'OPENED') AS opens,
        count(*) FILTER (WHERE ev.type = 'CLICKED') AS clicks
      FROM "EmailEvent" ev WHERE ev."outboundEmailId" = o.id AND ev."workspaceId" = o."workspaceId"
    ) engagement
    WHERE o."workspaceId" = ${workspaceId}::uuid
    ${scope === 'campaign' && scopeId ? Prisma.sql`AND o."campaignId" = ${scopeId}::uuid` : Prisma.empty}
    GROUP BY 1`;
  return new Map(rows.map(({ id, ...row }) => [
    id, Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])) as unknown as TrackingTotals,
  ]));
}
