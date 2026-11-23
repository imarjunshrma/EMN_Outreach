import { z } from 'zod';
import { stringify } from 'csv-stringify/sync';
import { db, Prisma } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { trySendSystemMail } from '../core/mailer.js';
import { logger } from '../core/logger.js';
import { decryptSecret, encryptSecret } from './workspace.js';
import { STAGES } from './crm.js';
import * as analytics from './analytics.js';

// CRM forecasting, saved filters, CSV exports, scheduled email reports and external notification channels.

// ------------------------------------------------------------------ forecasting
export const DEFAULT_STAGE_PROBABILITY: Record<(typeof STAGES)[number], number> = { NEW: 0.1, QUALIFIED: 0.25, MEETING: 0.4, PROPOSAL: 0.6, WON: 1, LOST: 0 };

export async function forecast(workspaceId: string) {
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const custom = (((ws.settings ?? {}) as { stageProbabilities?: Partial<Record<string, number>> }).stageProbabilities ?? {}) as Record<string, number>;
  const prob = { ...DEFAULT_STAGE_PROBABILITY, ...custom } as Record<string, number>;
  const opps = await db().opportunity.findMany({ where: { workspaceId }, select: { stage: true, valueCents: true, currency: true, expectedCloseAt: true, closedAt: true, createdAt: true } });
  const byStage = STAGES.map((stage) => { const xs = opps.filter((o) => o.stage === stage); const v = xs.reduce((s, o) => s + o.valueCents, 0); return { stage, count: xs.length, valueCents: v, probability: prob[stage], weightedCents: Math.round(v * prob[stage]) }; });
  const open = opps.filter((o) => o.stage !== 'WON' && o.stage !== 'LOST');
  const month = (d: Date) => d.toISOString().slice(0, 7);
  const expected = new Map<string, number>();
  for (const o of open) { const m = o.expectedCloseAt ? month(o.expectedCloseAt) : 'unscheduled'; expected.set(m, (expected.get(m) ?? 0) + Math.round(o.valueCents * prob[o.stage])); }
  const won = new Map<string, number>();
  for (const o of opps.filter((x) => x.stage === 'WON')) { const m = month(o.closedAt ?? o.createdAt); won.set(m, (won.get(m) ?? 0) + o.valueCents); }
  const closed = opps.filter((o) => o.stage === 'WON' || o.stage === 'LOST');
  const currencies = [...new Set(opps.map((o) => o.currency))];
  return {
    byStage, weightedPipelineCents: byStage.filter((s) => s.stage !== 'WON' && s.stage !== 'LOST').reduce((s, x) => s + x.weightedCents, 0),
    expectedByMonth: [...expected.entries()].sort().map(([m, cents]) => ({ month: m, weightedCents: cents })),
    wonByMonth: [...won.entries()].sort().map(([m, cents]) => ({ month: m, cents })),
    winRate: closed.length ? closed.filter((o) => o.stage === 'WON').length / closed.length : null,
    currencies, note: currencies.length > 1 ? 'Opportunities use several currencies; totals add raw amounts without conversion.' : 'Forecast = deal value × stage probability (editable in settings). Values are user-entered.',
  };
}

// ------------------------------------------------------------------ saved filters
export const SavedFilterSchema = z.object({ entity: z.enum(['leads', 'conversations', 'campaigns', 'opportunities']), name: z.string().min(1).max(80), query: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.array(z.string().max(100)).max(50)])), isShared: z.boolean().default(false) });
export async function listSavedFilters(workspaceId: string, userId: string, entity?: string) {
  return db().savedFilter.findMany({ where: { workspaceId, ...(entity ? { entity } : {}), OR: [{ userId }, { isShared: true }] }, orderBy: { name: 'asc' } });
}
export async function createSavedFilter(workspaceId: string, userId: string, input: z.infer<typeof SavedFilterSchema>) {
  return db().savedFilter.create({ data: { workspaceId, userId, ...input, query: input.query as Prisma.InputJsonValue } });
}
export async function deleteSavedFilter(workspaceId: string, userId: string, id: string, canManageShared: boolean) {
  const f = await db().savedFilter.findFirst({ where: { id, workspaceId } });
  if (!f || (f.userId !== userId && !(f.isShared && canManageShared))) throw NotFound('Saved filter');
  await db().savedFilter.delete({ where: { id } });
}

// ------------------------------------------------------------------ CSV exports
const cell = (v: unknown) => { const s = v instanceof Date ? v.toISOString() : String(v ?? ''); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; }; // CSV-injection guard
export async function exportOpportunitiesCsv(workspaceId: string) {
  const opps = await db().opportunity.findMany({ where: { workspaceId }, include: { lead: { select: { email: true, firstName: true, lastName: true } }, company: { select: { name: true } }, campaign: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 50_000 });
  return stringify(opps.map((o) => [o.title, o.stage, (o.valueCents / 100).toFixed(2), o.currency, o.lead.email, `${o.lead.firstName ?? ''} ${o.lead.lastName ?? ''}`.trim(), o.company?.name, o.campaign?.name, o.expectedCloseAt, o.closedAt, o.createdAt].map(cell)), { header: true, columns: ['title', 'stage', 'value', 'currency', 'leadEmail', 'leadName', 'company', 'campaign', 'expectedClose', 'closedAt', 'createdAt'] });
}
export async function exportCampaignsCsv(workspaceId: string) {
  const rows = await analytics.campaignPerformance(workspaceId) as unknown as Array<Record<string, unknown>>;
  const cols = rows.length ? Object.keys(rows[0]).filter((k) => typeof rows[0][k] !== 'object' || rows[0][k] === null || rows[0][k] instanceof Date) : ['name'];
  return stringify(rows.map((r) => cols.map((c) => cell(r[c]))), { header: true, columns: cols });
}

// ------------------------------------------------------------------ scheduled reports (system email)
export const ReportSchema = z.object({ name: z.string().min(1).max(100), kind: z.enum(['campaign_summary', 'pipeline', 'ai_cost']), frequency: z.enum(['DAILY', 'WEEKLY']), recipients: z.array(z.string().email()).min(1).max(20), isActive: z.boolean().default(true) });
export async function listReports(workspaceId: string) { return db().scheduledReport.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } }); }
export async function saveReport(workspaceId: string, id: string | null, input: z.infer<typeof ReportSchema>, actor: Actor) {
  // Recipients must be workspace members — reports never go to arbitrary outside addresses.
  const members = await db().workspaceMember.findMany({ where: { workspaceId }, include: { user: { select: { email: true } } } });
  const allowed = new Set(members.map((m) => m.user.email.toLowerCase()));
  const bad = input.recipients.filter((r) => !allowed.has(r.toLowerCase()));
  if (bad.length) throw new AppError('VALIDATION_FAILED', `Recipients must be workspace members: ${bad.join(', ')}`, 400);
  const r = id ? await db().scheduledReport.updateMany({ where: { id, workspaceId }, data: input }).then(async (x) => { if (!x.count) throw NotFound('Report'); return db().scheduledReport.findUniqueOrThrow({ where: { id } }); }) : await db().scheduledReport.create({ data: { workspaceId, ...input, createdById: actor.userId ?? null } });
  await audit(workspaceId, actor, 'report.saved', { type: 'report', id: r.id });
  return r;
}
export async function deleteReport(workspaceId: string, id: string) { const r = await db().scheduledReport.deleteMany({ where: { id, workspaceId } }); if (!r.count) throw NotFound('Report'); }

export async function renderReport(workspaceId: string, kind: string) {
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const lines: string[] = [`${ws.name} — ${kind.replace('_', ' ')} (${new Date().toISOString().slice(0, 10)})`, ''];
  if (kind === 'campaign_summary') {
    const o = await analytics.overview(workspaceId, 7) as Record<string, unknown>;
    lines.push('Last 7 days:'); for (const [k, v] of Object.entries(o)) if (typeof v === 'number') lines.push(`  ${k}: ${Number.isInteger(v) ? v : v.toFixed(3)}`);
  } else if (kind === 'pipeline') {
    const f = await forecast(workspaceId);
    for (const s of f.byStage) lines.push(`  ${s.stage}: ${s.count} deals, ${(s.valueCents / 100).toFixed(2)} (weighted ${(s.weightedCents / 100).toFixed(2)})`);
    lines.push('', `Weighted open pipeline: ${(f.weightedPipelineCents / 100).toFixed(2)}`);
  } else {
    const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    const rows = await db().aiExecution.groupBy({ by: ['task'], where: { workspaceId, createdAt: { gte: start } }, _sum: { costUsd: true }, _count: true });
    lines.push('AI spend this month:'); for (const r of rows) lines.push(`  ${r.task}: $${Number(r._sum.costUsd ?? 0).toFixed(4)} (${r._count} calls)`);
  }
  return lines.join('\n');
}

/** Daily job. WEEKLY reports go out on Mondays (UTC). Failures are recorded, never thrown. */
export async function runScheduledReports(now = new Date()) {
  const due = await db().scheduledReport.findMany({ where: { isActive: true } });
  let sent = 0;
  for (const r of due) {
    if (r.frequency === 'WEEKLY' && now.getUTCDay() !== 1) continue;
    if (r.lastSentAt && now.getTime() - r.lastSentAt.getTime() < 20 * 3600_000) continue;
    const text = await renderReport(r.workspaceId, r.kind);
    let ok = true;
    for (const to of r.recipients) ok = (await trySendSystemMail({ to, subject: `[EMN] ${r.name}`, text })) && ok;
    await db().scheduledReport.update({ where: { id: r.id }, data: ok ? { lastSentAt: now, lastError: null } : { lastError: 'System email not configured or delivery failed' } });
    if (ok) sent++;
  }
  return { sent };
}

// ------------------------------------------------------------------ notification channels (Slack / email)
export const ChannelSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SLACK'), name: z.string().min(1).max(80), webhookUrl: z.string().url().refine((u) => /^https:\/\/hooks\.slack\.com\/services\//.test(u), 'Must be a Slack incoming-webhook URL (https://hooks.slack.com/services/…)'), events: z.array(z.string().max(60)).min(1).max(30), isActive: z.boolean().default(true) }),
  z.object({ type: z.literal('EMAIL'), name: z.string().min(1).max(80), to: z.string().email(), events: z.array(z.string().max(60)).min(1).max(30), isActive: z.boolean().default(true) }),
]);
export async function listChannels(workspaceId: string) {
  const cs = await db().notificationChannel.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } });
  return cs.map(({ encryptedConfig: _e, ...c }) => c); // never return the webhook URL (it is a secret)
}
export async function createChannel(workspaceId: string, input: z.infer<typeof ChannelSchema>, actor: Actor) {
  const config = input.type === 'SLACK' ? { webhookUrl: input.webhookUrl } : { to: input.to };
  const c = await db().notificationChannel.create({ data: { workspaceId, type: input.type, name: input.name, events: input.events, isActive: input.isActive, encryptedConfig: encryptSecret(JSON.stringify(config)) } });
  await audit(workspaceId, actor, 'notification_channel.created', { type: 'channel', id: c.id }, { type: input.type });
  const { encryptedConfig: _e, ...rest } = c; return rest;
}
export async function deleteChannel(workspaceId: string, id: string, actor: Actor) {
  const r = await db().notificationChannel.deleteMany({ where: { id, workspaceId } }); if (!r.count) throw NotFound('Channel');
  await audit(workspaceId, actor, 'notification_channel.deleted', { type: 'channel', id });
}

let slackFetch: typeof fetch = (...a) => fetch(...a);
export function setSlackFetchForTests(f: typeof fetch | null) { slackFetch = f ?? ((...a) => fetch(...a)); }

/** Fan a notification out to matching external channels. Best-effort; errors are recorded on the channel. */
export async function deliverToChannels(workspaceId: string, n: { type: string; title: string; link?: string }) {
  const chans = await db().notificationChannel.findMany({ where: { workspaceId, isActive: true } });
  const match = chans.filter((c) => n.type === '*' || c.events.includes('*') || c.events.includes(n.type) || c.events.some((e) => e.endsWith('.*') && n.type.startsWith(e.slice(0, -1))));
  const link = n.link ? `${process.env.APP_URL ?? ''}/w/${workspaceId}${n.link}` : '';
  let delivered = 0;
  for (const c of match) {
    try {
      const cfg = JSON.parse(decryptSecret(c.encryptedConfig)) as { webhookUrl?: string; to?: string };
      if (c.type === 'SLACK') {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
        const res = await slackFetch(cfg.webhookUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `${n.title}${link ? `\n<${link}|Open in Outvexa>` : ''}` }), signal: ctrl.signal, redirect: 'error' }).finally(() => clearTimeout(t));
        if (!res.ok) throw new Error(`Slack responded ${res.status}`);
      } else if (!(await trySendSystemMail({ to: cfg.to!, subject: `[EMN] ${n.title.slice(0, 150)}`, text: `${n.title}\n\n${link}` }))) throw new Error('System email not configured');
      delivered++;
      if (c.lastError) await db().notificationChannel.update({ where: { id: c.id }, data: { lastError: null } });
    } catch (e) {
      logger.warn({ channel: c.id, err: (e as Error).message }, 'notification channel delivery failed');
      await db().notificationChannel.update({ where: { id: c.id }, data: { lastError: (e as Error).message.slice(0, 300) } });
    }
  }
  return { delivered };
}

// ------------------------------------------------------------------ campaign organisation (does not touch approval)
export const OrganizeSchema = z.object({ folder: z.string().max(60).nullable().optional(), tags: z.array(z.string().min(1).max(40)).max(20).optional() });
export async function organizeCampaign(workspaceId: string, id: string, input: z.infer<typeof OrganizeSchema>) {
  const r = await db().campaign.updateMany({ where: { id, workspaceId }, data: { ...(input.folder !== undefined ? { folder: input.folder } : {}), ...(input.tags ? { tags: [...new Set(input.tags)] } : {}) } });
  if (!r.count) throw NotFound('Campaign');
  return db().campaign.findUniqueOrThrow({ where: { id }, select: { id: true, folder: true, tags: true, status: true } });
}
