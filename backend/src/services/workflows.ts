import { z } from 'zod';
import { createHmac, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { stringify } from 'csv-stringify/sync';
import { db, Prisma } from '../core/db.js';
import { AppError, Forbidden, NotFound } from '../core/errors.js';
import { audit, notifyWorkspace, WORKER_ACTOR, type Actor } from '../core/audit.js';
import { enqueue, QUEUES } from '../core/queues.js';
import { store } from '../core/storage.js';
import { randomToken, sha256, safeEqual } from '../core/crypto.js';
import { GraphSchema, WORKFLOW_TRIGGERS, evalCondition, type Block } from '../../../shared/src/workflow.js';
import { assertPublicUrl } from '../../../integrations/src/research/fetcher.js';

// Visual workflow engine: versioned graphs, execution log per run, test (dry-run) mode, retries via
// BullMQ, per-workflow daily run limit, idempotent per event (dedupeKey).

export const WorkflowSchema = z.object({ name: z.string().min(1).max(120), trigger: z.enum(WORKFLOW_TRIGGERS), graph: GraphSchema, maxRunsPerDay: z.number().int().min(1).max(100000).default(1000), changeNote: z.string().max(300).optional() });

export async function listWorkflows(workspaceId: string) {
  return db().workflow.findMany({ where: { workspaceId }, orderBy: { name: 'asc' }, include: { _count: { select: { runs: true, versions: true } } } });
}
export async function getWorkflow(workspaceId: string, id: string) {
  const w = await db().workflow.findFirst({ where: { id, workspaceId }, include: { versions: { orderBy: { version: 'desc' } } } });
  if (!w) throw NotFound('Workflow');
  return w;
}

export async function saveWorkflow(workspaceId: string, id: string | null, input: z.infer<typeof WorkflowSchema>, actor: Actor) {
  await (await import('./billing.js')).assertEntitled(workspaceId, 'feature:workflows');
  await validateRefs(workspaceId, input.graph.blocks);
  const wf = id ? await getWorkflow(workspaceId, id) : await db().workflow.create({ data: { workspaceId, name: input.name, trigger: input.trigger, maxRunsPerDay: input.maxRunsPerDay } });
  const last = await db().workflowVersion.findFirst({ where: { workflowId: wf.id }, orderBy: { version: 'desc' } });
  const v = await db().workflowVersion.create({ data: { workspaceId, workflowId: wf.id, version: (last?.version ?? 0) + 1, graph: input.graph as unknown as Prisma.InputJsonValue, changeNote: input.changeNote ?? null, createdById: actor.userId ?? null } });
  await db().workflow.update({ where: { id: wf.id }, data: { name: input.name, trigger: input.trigger, maxRunsPerDay: input.maxRunsPerDay, activeVersionId: v.id } });
  await audit(workspaceId, actor, 'workflow.saved', { type: 'workflow', id: wf.id }, { version: v.version });
  return getWorkflow(workspaceId, wf.id);
}

export async function setActive(workspaceId: string, id: string, active: boolean, actor: Actor) {
  const w = await getWorkflow(workspaceId, id);
  if (active && !w.activeVersionId) throw new AppError('VALIDATION_FAILED', 'Save a version first', 400);
  await db().workflow.update({ where: { id }, data: { isActive: active } });
  await audit(workspaceId, actor, active ? 'workflow.activated' : 'workflow.deactivated', { type: 'workflow', id });
}

export async function restoreVersion(workspaceId: string, id: string, versionId: string, actor: Actor) {
  const v = await db().workflowVersion.findFirst({ where: { id: versionId, workflowId: id, workspaceId } });
  if (!v) throw NotFound('Version');
  await db().workflow.update({ where: { id }, data: { activeVersionId: v.id } });
  await audit(workspaceId, actor, 'workflow.version_restored', { type: 'workflow', id }, { version: v.version });
}

export async function deleteWorkflow(workspaceId: string, id: string, actor: Actor) {
  const r = await db().workflow.deleteMany({ where: { id, workspaceId } });
  if (!r.count) throw NotFound('Workflow');
  await audit(workspaceId, actor, 'workflow.deleted', { type: 'workflow', id });
}

async function validateRefs(workspaceId: string, blocks: Block[]) {
  for (const b of blocks) {
    if (b.kind === 'condition') { await validateRefs(workspaceId, b.then); await validateRefs(workspaceId, b.else); continue; }
    const p = b.params;
    if (['pause_campaign', 'resume_campaign'].includes(b.action) && p.campaignId && !(await db().campaign.findFirst({ where: { id: p.campaignId, workspaceId } }))) throw NotFound('Campaign');
    if (b.action === 'assign_user' && !(await db().workspaceMember.findFirst({ where: { workspaceId, userId: p.userId } }))) throw NotFound('Member');
    if (b.action === 'trigger_webhook') { if (!p.url) throw new AppError('VALIDATION_FAILED', 'trigger_webhook needs a url', 400); await assertPublicUrl(p.url); }
    if (b.action === 'update_lead_status' && !p.status) throw new AppError('VALIDATION_FAILED', 'update_lead_status needs a status', 400);
  }
}

/** Called from emitEvent for every domain event. */
export async function dispatch(workspaceId: string, trigger: string, eventKey: string, payload: Record<string, unknown>) {
  const wfs = await db().workflow.findMany({ where: { workspaceId, trigger, isActive: true }, select: { id: true } });
  for (const w of wfs) await enqueue(QUEUES.automation, 'workflow.run', { workspaceId, workflowId: w.id, eventKey, payload, testMode: false }, { jobId: `wf-${w.id}-${sha256(eventKey).slice(0, 24)}`, attempts: 3, backoff: { type: 'exponential', delay: 15_000 } });
  return wfs.length;
}

export async function triggerManual(workspaceId: string, id: string, payload: Record<string, unknown>, testMode: boolean, actor: Actor) {
  const w = await getWorkflow(workspaceId, id);
  if (!testMode && !w.isActive) throw new AppError('VALIDATION_FAILED', 'Activate the workflow first (or run in test mode)', 400);
  await audit(workspaceId, actor, testMode ? 'workflow.test_run' : 'workflow.manual_run', { type: 'workflow', id });
  return runWorkflow(workspaceId, id, `manual:${randomUUID()}`, payload, testMode, actor);
}

type Log = Array<{ blockId: string; kind: string; detail: string; at: string; ok: boolean }>;

export async function runWorkflow(workspaceId: string, workflowId: string, eventKey: string, payload: Record<string, unknown>, testMode: boolean, actor: Actor = WORKER_ACTOR) {
  const wf = await db().workflow.findFirst({ where: { id: workflowId, workspaceId } });
  if (!wf || !wf.activeVersionId) return { skipped: 'workflow missing or has no version' };
  if (!testMode) {
    const prior = await db().workflowRun.findFirst({ where: { workflowId, dedupeKey: sha256(eventKey).slice(0, 40) } });
    if (prior?.status === 'COMPLETED') return { skipped: 'already ran for this event', runId: prior.id };
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const runs = await db().workflowRun.count({ where: { workflowId, testMode: false, startedAt: { gte: today } } });
    if (!prior && runs >= wf.maxRunsPerDay) return { skipped: `daily run limit (${wf.maxRunsPerDay}) reached` };
  }
  if (!testMode) {
    const { ws: ent } = await import('./entitlements.js');
    const st = await ent.state(workspaceId);
    if (!st.operational) return { skipped: `organization inactive: ${st.reason ?? ''}` };
    try { await ent.metered(workspaceId, 'workflow_runs'); } catch { return { skipped: 'monthly workflow-run allowance used up' }; }
  }
  const version = await db().workflowVersion.findUniqueOrThrow({ where: { id: wf.activeVersionId } });
  const dedupeKey = testMode ? null : sha256(eventKey).slice(0, 40);
  let run;
  try {
    run = await db().workflowRun.create({ data: { workspaceId, workflowId, versionId: version.id, dedupeKey, event: payload as Prisma.InputJsonValue, testMode } });
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    const prev = await db().workflowRun.findFirstOrThrow({ where: { workflowId, dedupeKey } });
    if (prev.status === 'COMPLETED') return { skipped: 'already ran for this event', runId: prev.id };
    run = await db().workflowRun.update({ where: { id: prev.id }, data: { status: 'RUNNING', attempts: { increment: 1 }, error: null, log: [] } });
  }
  if (!testMode) (await import('./usage.js')).meter({ workspaceId, metric: 'workflow_runs', quantity: 1, key: `wf:${run.id}` });
  const log: Log = [];
  const ctx = await contextFor(workspaceId, payload);
  try {
    await execBlocks(workspaceId, GraphSchema.parse(version.graph).blocks, ctx, payload, log, testMode, run.id, wf.name);
    await db().workflowRun.update({ where: { id: run.id }, data: { status: 'COMPLETED', log: log as Prisma.InputJsonValue, finishedAt: new Date() } });
    if (actor.type !== 'WORKER') await audit(workspaceId, actor, testMode ? 'workflow.test_completed' : 'workflow.run_completed', { type: 'workflow', id: workflowId }, { runId: run.id, steps: log.length });
    return { runId: run.id, status: 'COMPLETED', log };
  } catch (e) {
    log.push({ blockId: '-', kind: 'error', detail: (e as Error).message.slice(0, 500), at: new Date().toISOString(), ok: false });
    await db().workflowRun.update({ where: { id: run.id }, data: { status: 'FAILED', log: log as Prisma.InputJsonValue, error: (e as Error).message.slice(0, 1000), finishedAt: new Date() } });
    await notifyWorkspace(workspaceId, 'MANAGER', { type: 'workflow.failed', title: `Workflow "${wf.name}" failed: ${(e as Error).message.slice(0, 120)}`, link: `/workflows/${workflowId}` });
    if (testMode) return { runId: run.id, status: 'FAILED', log };
    throw e; // BullMQ retry (dedupeKey makes the retry reuse the same run row)
  }
}

async function contextFor(workspaceId: string, payload: Record<string, unknown>) {
  const leadId = typeof payload.leadId === 'string' ? payload.leadId : null;
  const lead = leadId ? await db().lead.findFirst({ where: { id: leadId, workspaceId }, include: { company: true } }) : null;
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const now = DateTime.now().setZone(ws.timezone || 'UTC');
  return {
    lead: lead ? { id: lead.id, country: lead.country, status: lead.status, currentScore: lead.currentScore, title: lead.title, tags: lead.tags, custom: lead.customFields ?? {} } : null,
    company: lead?.company ? { industry: lead.company.industry, employeeCount: lead.company.employeeCount } : null,
    event: payload, time: { weekday: now.weekday, hour: now.hour },
  } as Record<string, unknown>;
}

async function execBlocks(workspaceId: string, blocks: Block[], ctx: Record<string, unknown>, payload: Record<string, unknown>, log: Log, test: boolean, runId: string, wfName: string): Promise<void> {
  for (const b of blocks) {
    if (b.kind === 'condition') {
      const ok = b.all.every((c) => evalCondition(c, ctx));
      log.push({ blockId: b.id, kind: 'condition', detail: `${b.all.map((c) => `${c.field} ${c.op} ${JSON.stringify(c.value ?? '')}`).join(' AND ')} → ${ok}`, at: new Date().toISOString(), ok: true });
      await execBlocks(workspaceId, ok ? b.then : b.else, ctx, payload, log, test, runId, wfName);
      continue;
    }
    const detail = test ? `[test] would ${b.action} ${JSON.stringify(b.params)}` : await runAction(workspaceId, b, ctx, payload, runId, wfName);
    log.push({ blockId: b.id, kind: b.action, detail, at: new Date().toISOString(), ok: true });
  }
}

async function runAction(workspaceId: string, b: Extract<Block, { kind: 'action' }>, ctx: Record<string, unknown>, payload: Record<string, unknown>, runId: string, wfName: string): Promise<string> {
  const lead = ctx.lead as { id: string } | null;
  const p = b.params;
  const needLead = () => { if (!lead) throw new Error(`${b.action} needs a lead in the event`); return lead.id; };
  switch (b.action) {
    case 'add_tag': { const id = needLead(); const l = await db().lead.findUniqueOrThrow({ where: { id } }); if (!l.tags.includes(p.tag)) await db().lead.update({ where: { id }, data: { tags: { push: p.tag.slice(0, 40) } } }); return `tag "${p.tag}" added`; }
    case 'update_lead_status': { const id = needLead(); const { setLeadStatus } = await import('./leads.js'); await setLeadStatus(workspaceId, id, p.status as never, `workflow ${wfName}`, WORKER_ACTOR); return `status → ${p.status}`; }
    case 'create_task': { const t = await db().task.create({ data: { workspaceId, title: (p.title ?? 'Follow up').slice(0, 200), leadId: lead?.id ?? null, dueAt: new Date(Date.now() + Number(p.dueInDays ?? 1) * 86400_000), assigneeId: p.assigneeId || null } }); return `task ${t.id}`; }
    case 'assign_user': { const id = needLead(); await db().lead.update({ where: { id }, data: { ownerId: p.userId } }); return `owner → ${p.userId}`; }
    case 'create_opportunity': { const id = needLead(); const l = await db().lead.findUniqueOrThrow({ where: { id } }); const o = await db().opportunity.create({ data: { workspaceId, leadId: id, companyId: l.companyId, title: (p.title ?? 'Opportunity').slice(0, 200), valueCents: Number(p.valueCents ?? 0) || 0, campaignId: typeof payload.campaignId === 'string' ? payload.campaignId : null } }); return `opportunity ${o.id}`; }
    case 'notify_team': { await notifyWorkspace(workspaceId, (p.role as never) ?? 'MEMBER', { type: 'workflow', title: (p.title ?? `Workflow ${wfName}`).slice(0, 200), link: lead ? `/leads/${lead.id}` : '/workflows' }); return 'notification sent'; }
    case 'research_lead': { const id = needLead(); await enqueue(QUEUES.research, 'research.lead', { workspaceId, leadId: id }, { jobId: `wf-research-${runId}-${id}` }); return 'research queued'; }
    case 'generate_reply_draft': {
      const mid = typeof payload.messageId === 'string' ? payload.messageId : null;
      if (!mid) throw new Error('generate_reply_draft needs a reply event');
      const { processInbound } = await import('./reply-assist.js');
      const r = await processInbound(workspaceId, mid); // respects the workspace reply mode (default: draft for approval)
      return `reply assistant: ${JSON.stringify(r)}`;
    }
    case 'pause_campaign': { const cid = p.campaignId || (payload.campaignId as string); const { pauseCampaign } = await import('./engine.js'); await pauseCampaign(workspaceId, cid, `Paused by workflow "${wfName}"`, WORKER_ACTOR); return `campaign ${cid} paused`; }
    case 'resume_campaign': {
      // "Resume only when permitted": the campaign must still be approved with an unchanged content hash.
      const cid = p.campaignId || (payload.campaignId as string);
      const { startCampaign, getCampaign, contentHash } = await import('./engine.js');
      const c = await getCampaign(workspaceId, cid);
      if (c.status !== 'PAUSED' || !c.approvedContentHash || contentHash(c) !== c.approvedContentHash) throw new Error('Resume refused: campaign is not a paused, still-approved campaign');
      if (c.pauseReason && /bounce|complaint|content changed|disconnected/i.test(c.pauseReason)) throw new Error(`Resume refused: safety auto-pause (${c.pauseReason}) needs a human`);
      await startCampaign(workspaceId, cid, WORKER_ACTOR); return `campaign ${cid} resumed`;
    }
    case 'trigger_webhook': {
      await assertPublicUrl(p.url);
      const body = JSON.stringify({ workflow: wfName, runId, event: payload });
      const ts = Math.floor(Date.now() / 1000).toString();
      const sig = createHmac('sha256', p.secret || workspaceId).update(`${ts}.${body}`).digest('hex');
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(p.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-emn-signature': `t=${ts},v1=${sig}` }, body, signal: ctrl.signal, redirect: 'error' }).finally(() => clearTimeout(t));
      if (!res.ok) throw new Error(`webhook responded ${res.status}`);
      return `webhook ${res.status}`;
    }
    case 'export_leads': {
      const where: Prisma.LeadWhereInput = { workspaceId, ...(p.status ? { status: p.status as never } : {}), ...(p.tag ? { tags: { has: p.tag } } : {}) };
      const leads = await db().lead.findMany({ where, take: 50_000, select: { email: true, firstName: true, lastName: true, title: true, country: true, status: true, tags: true } });
      const guard = (v: unknown) => { const s = String(v ?? ''); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; };
      const csv = stringify(leads.map((l) => [l.email, l.firstName, l.lastName, l.title, l.country, l.status, l.tags.join('|')].map(guard)), { header: true, columns: ['email', 'firstName', 'lastName', 'title', 'country', 'status', 'tags'] });
      const key = await store().put(workspaceId, 'exports', Buffer.from(csv), 'csv');
      await notifyWorkspace(workspaceId, 'MANAGER', { type: 'export.ready', title: `Workflow export ready (${leads.length} leads)`, link: `/settings/privacy?export=${encodeURIComponent(key)}` });
      return `exported ${leads.length} leads`;
    }
  }
}

export async function listRuns(workspaceId: string, workflowId: string) {
  return db().workflowRun.findMany({ where: { workspaceId, workflowId }, orderBy: { startedAt: 'desc' }, take: 100 });
}

// Inbound webhook trigger: POST /api/v1/hooks/workflow/:id with header X-EMN-Workflow-Token
export async function webhookToken(workspaceId: string, id: string, actor: Actor) {
  await getWorkflow(workspaceId, id);
  const token = randomToken(24);
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const settings = (ws.settings ?? {}) as Record<string, unknown>;
  const map = { ...((settings.workflowTokens as Record<string, string>) ?? {}), [id]: sha256(token) };
  await db().workspace.update({ where: { id: workspaceId }, data: { settings: { ...settings, workflowTokens: map } as Prisma.InputJsonValue } });
  await audit(workspaceId, actor, 'workflow.webhook_token_rotated', { type: 'workflow', id });
  return { url: `${process.env.APP_URL}/api/v1/hooks/workflow/${id}`, header: 'X-EMN-Workflow-Token', token, note: 'Shown once.' };
}

export async function receiveWebhook(workflowId: string, token: string | undefined, body: unknown) {
  const wf = await db().workflow.findUnique({ where: { id: workflowId } });
  if (!wf || wf.trigger !== 'webhook.received' || !wf.isActive) throw NotFound('Workflow');
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: wf.workspaceId } });
  const expected = ((ws.settings as Record<string, unknown>)?.workflowTokens as Record<string, string> | undefined)?.[workflowId];
  if (!expected || !token || !safeEqual(expected, sha256(token))) throw Forbidden('Invalid workflow token');
  const payload = body && typeof body === 'object' ? { ...(body as Record<string, unknown>) } : {};
  if (typeof payload.leadId === 'string' && !(await db().lead.findFirst({ where: { id: payload.leadId, workspaceId: wf.workspaceId } }))) delete payload.leadId; // never cross tenants
  await enqueue(QUEUES.automation, 'workflow.run', { workspaceId: wf.workspaceId, workflowId, eventKey: `hook:${randomUUID()}`, payload, testMode: false }, { attempts: 3, backoff: { type: 'exponential', delay: 15_000 } });
  return { accepted: true };
}

export async function dailyScheduled() {
  const wfs = await db().workflow.findMany({ where: { trigger: 'schedule.daily', isActive: true } });
  const day = new Date().toISOString().slice(0, 10);
  for (const w of wfs) await enqueue(QUEUES.automation, 'workflow.run', { workspaceId: w.workspaceId, workflowId: w.id, eventKey: `daily:${day}`, payload: { date: day }, testMode: false }, { jobId: `wf-daily-${w.id}-${day}`, attempts: 3 });
  return { queued: wfs.length };
}
