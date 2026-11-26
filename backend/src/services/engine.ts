import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { db, Prisma } from '../core/db.js';
import { adapters } from '../core/container.js';
import { randomToken, sha256 } from '../core/crypto.js';
import { AppError, BadRequest, NotFound } from '../core/errors.js';
import { audit, notifyWorkspace, publish, WORKER_ACTOR, type Actor } from '../core/audit.js';
import { enqueue, QUEUES } from '../core/queues.js';
import { acquireLock } from '../core/redis.js';
import { logger } from '../core/logger.js';
import { ProviderError } from '../../../integrations/src/http.js';
import { OUTBOUND_HEADER, type OutgoingMessage } from '../../../integrations/src/email/types.js';
import { renderTemplate, lintTemplate, bodyContentProblem } from '../../../shared/src/template.js';
import { DEFAULT_WINDOW, SendingWindowSchema, computeNextStepAt, isInWindow, isValidZone, nextWindowStart, startOfDayIn, startOfNextDayIn, type SendingWindow } from '../../../shared/src/schedule.js';
import { addSuppression, canContact } from './compliance.js';
import { getAuth, markNeedsReauth } from './accounts.js';
import { readSettings, unsubscribeToken } from './workspace.js';
import { factCheck, generateEmail, leadVars } from './intelligence.js';
import { emitEvent } from './automation.js';
import { variantSeedFor, contentHashOf, WAITING_MARKER } from './personalization.js';
import { buildSnapshot } from './ai-studio.js';
import { CampaignAiOverridesSchema } from '../../../shared/src/ai-studio.js';
import { captureCampaignTaskExecution } from './ai.js';

// =====================================================================================
// Campaign management
// =====================================================================================

export const CampaignSettingsSchema = z.object({
  name: z.string().min(1).max(150),
  timezone: z.string().refine(isValidZone, 'Unknown IANA timezone').default('UTC'),
  useLeadTimezone: z.boolean().default(true),
  sendingWindow: SendingWindowSchema.default(DEFAULT_WINDOW),
  dailyNewLeadLimit: z.number().int().min(1).max(1000).default(25),
  dailySendLimit: z.number().int().min(1).max(5000).default(100),
  stopOnReply: z.boolean().default(true),
  stopOnAutoReply: z.boolean().default(false),
  reviewMode: z.enum(['NONE', 'AI_CONTENT_ONLY', 'ALL']).default('AI_CONTENT_ONLY'),
  requireFactCheck: z.boolean().default(true),
  trackOpens: z.boolean().default(false),
  trackClicks: z.boolean().default(false),
  requireVerifiedEmail: z.boolean().default(true),
  minLeadScore: z.number().int().min(0).max(100).nullable().default(null),
  maxBounceRatePct: z.number().min(0.5).max(50).default(5),
  maxComplaints: z.number().int().min(1).max(100).default(1),
  usePregeneratedAi: z.boolean().default(true),
  scheduledStartAt: z.coerce.date().nullable().default(null),
});

export const CampaignAiSchema = z.object({
  aiProfileId: z.string().uuid().nullable().optional(),
  icpId: z.string().uuid().nullable().optional(),
  aiOverrides: CampaignAiOverridesSchema.optional(),
  maxAiCostPerLeadUsd: z.number().min(0).max(100).nullable().optional(),
  usePregeneratedAi: z.boolean().optional(),
});

export const StepSchema = z.object({
  delayDays: z.number().int().min(0).max(90),
  threadMode: z.enum(['NEW_THREAD', 'REPLY_IN_THREAD']).default('REPLY_IN_THREAD'),
  personalizationMode: z.enum(['TEMPLATE_ONLY', 'AI_FIRST_LINE', 'AI_FULL']).default('TEMPLATE_ONLY'),
  condition: z.enum(['ALWAYS', 'IF_OPENED', 'IF_NOT_OPENED']).default('ALWAYS'),
  aiInstructions: z.string().max(5000).nullable().optional(),
  variants: z.array(z.object({ label: z.string().min(1).max(5), subject: z.string().max(300), body: z.string().min(1).max(10000), weight: z.number().int().min(1).max(100).default(1), aiInstructions: z.string().max(5000).nullable().optional() })).min(1).max(5),
});
export const SequenceSchema = z.object({ steps: z.array(StepSchema).min(1).max(10) });

const EDITABLE_STATES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED'];

async function getCampaignOr404(workspaceId: string, id: string) {
  const c = await db().campaign.findFirst({ where: { id, workspaceId } });
  if (!c) throw NotFound('Campaign');
  return c;
}

export async function createCampaign(workspaceId: string, input: z.infer<typeof CampaignSettingsSchema>, actor: Actor) {
  const defaultSteps: Array<{ order: number; delayDays: number; threadMode: 'NEW_THREAD' | 'REPLY_IN_THREAD'; subject: string; body: string }> = [
    { order: 1, delayDays: 0, threadMode: 'NEW_THREAD', subject: 'Quick question, {{firstName|there}}', body: 'Hi {{firstName|there}},\n\n[Write your message here]\n\nBest,\n{{sender.name}}' }, // a campaign cannot be approved until this is replaced
    { order: 2, delayDays: 3, threadMode: 'REPLY_IN_THREAD', subject: 'Re: Quick question', body: 'Hi {{firstName|there}},\n\nJust following up on my note. Would it be useful if I shared a short example of our work, or should I close the loop?\n\nBest,\n{{sender.name}}' },
    { order: 3, delayDays: 5, threadMode: 'REPLY_IN_THREAD', subject: 'Re: Quick question', body: 'Hi {{firstName|there}},\n\nOne more thought: if improving short-form content or paid social is on your roadmap, I can share a relevant example. Would that be useful?\n\nBest,\n{{sender.name}}' },
    { order: 4, delayDays: 7, threadMode: 'REPLY_IN_THREAD', subject: 'Re: Quick question', body: 'Hi {{firstName|there}},\n\nI will leave it here for now. If this becomes relevant later, happy to reconnect. Should I close this out?\n\nBest,\n{{sender.name}}' },
  ];
  const c = await db().campaign.create({
    data: {
      workspaceId, ...input, sendingWindow: input.sendingWindow as Prisma.InputJsonValue,
      sequence: { create: { workspaceId, steps: { create: defaultSteps.map((step) => ({ workspaceId, order: step.order, delayDays: step.delayDays, threadMode: step.threadMode, variants: { create: { workspaceId, label: 'A', subject: step.subject, body: step.body } } })) } } },
    },
  });
  await audit(workspaceId, actor, 'campaign.created', { type: 'campaign', id: c.id });
  return c;
}

/** Any edit to an approved campaign sends it back for approval and stops sending until re-approved. */
async function invalidateApproval(campaignId: string) {
  const c = await db().campaign.findUniqueOrThrow({ where: { id: campaignId } });
  if (['APPROVED', 'RUNNING', 'PAUSED'].includes(c.status)) {
    await db().campaign.update({ where: { id: campaignId }, data: { status: 'PENDING_APPROVAL', approvedContentHash: null, approvedAt: null, approvedById: null, pauseReason: 'Edited after approval — re-approval required', pausedAt: new Date() } });
  }
}

export async function updateCampaign(workspaceId: string, id: string, input: Partial<z.infer<typeof CampaignSettingsSchema>>, actor: Actor) {
  const c = await getCampaignOr404(workspaceId, id);
  if (!EDITABLE_STATES.includes(c.status)) throw new AppError('CAMPAIGN_STATE', `Cannot edit a ${c.status} campaign`, 409);
  await db().campaign.update({ where: { id }, data: { ...input, sendingWindow: input.sendingWindow as Prisma.InputJsonValue | undefined } });
  await invalidateApproval(id);
  await audit(workspaceId, actor, 'campaign.updated', { type: 'campaign', id }, { fields: Object.keys(input) });
  return getCampaign(workspaceId, id);
}

export async function saveSequence(workspaceId: string, id: string, input: z.infer<typeof SequenceSchema>, actor: Actor) {
  const c = await getCampaignOr404(workspaceId, id);
  if (!EDITABLE_STATES.includes(c.status)) throw new AppError('CAMPAIGN_STATE', `Cannot edit a ${c.status} campaign`, 409);
  const seq = await db().sequence.findUniqueOrThrow({ where: { campaignId: id }, include: { steps: { include: { variants: true } } } });
  await db().$transaction(async (tx) => {
    for (let i = 0; i < input.steps.length; i++) {
      const s = input.steps[i];
      const order = i + 1;
      const step = await tx.sequenceStep.upsert({
        where: { sequenceId_order: { sequenceId: seq.id, order } },
        update: { delayDays: order === 1 ? 0 : s.delayDays, threadMode: order === 1 ? 'NEW_THREAD' : s.threadMode, personalizationMode: s.personalizationMode, condition: order === 1 ? 'ALWAYS' : s.condition, aiInstructions: s.aiInstructions?.trim() || null },
        create: { workspaceId, sequenceId: seq.id, order, delayDays: order === 1 ? 0 : s.delayDays, threadMode: order === 1 ? 'NEW_THREAD' : s.threadMode, personalizationMode: s.personalizationMode, condition: order === 1 ? 'ALWAYS' : s.condition, aiInstructions: s.aiInstructions?.trim() || null },
      });
      for (const v of s.variants) {
        const vd = { subject: v.subject, body: v.body, weight: v.weight, aiInstructions: v.aiInstructions?.trim() || null };
        await tx.sequenceStepVariant.upsert({ where: { stepId_label: { stepId: step.id, label: v.label } }, update: vd, create: { workspaceId, stepId: step.id, label: v.label, ...vd } });
      }
      const keep = new Set(s.variants.map((v) => v.label));
      const removeVariants = await tx.sequenceStepVariant.findMany({ where: { stepId: step.id, label: { notIn: [...keep] } }, include: { _count: { select: { outboundEmails: true } } } });
      for (const rv of removeVariants) {
        if (rv._count.outboundEmails > 0) throw new AppError('CONFLICT', `Variant ${rv.label} of step ${order} has already been sent and cannot be removed`, 409);
        await tx.sequenceStepVariant.delete({ where: { id: rv.id } });
      }
    }
    const extra = await tx.sequenceStep.findMany({ where: { sequenceId: seq.id, order: { gt: input.steps.length } }, include: { _count: { select: { outboundEmails: true } } } });
    for (const st of extra) {
      if (st._count.outboundEmails > 0) throw new AppError('CONFLICT', `Step ${st.order} has already been sent and cannot be removed`, 409);
      await tx.sequenceStep.delete({ where: { id: st.id } });
    }
  });
  await invalidateApproval(id);
  await audit(workspaceId, actor, 'campaign.sequence_saved', { type: 'campaign', id }, { steps: input.steps.length });
  return getCampaign(workspaceId, id);
}

export async function setCampaignLists(workspaceId: string, id: string, listIds: string[], actor: Actor) {
  await getCampaignOr404(workspaceId, id);
  const lists = await db().leadList.findMany({ where: { workspaceId, id: { in: listIds } } });
  if (lists.length !== new Set(listIds).size) throw NotFound('List');
  await db().$transaction([
    db().campaignList.deleteMany({ where: { campaignId: id } }),
    db().campaignList.createMany({ data: lists.map((l) => ({ workspaceId, campaignId: id, listId: l.id })) }),
  ]);
  await invalidateApproval(id);
  await audit(workspaceId, actor, 'campaign.lists_set', { type: 'campaign', id }, { listIds });
}

export async function setCampaignAccounts(workspaceId: string, id: string, accountIds: string[], actor: Actor) {
  await getCampaignOr404(workspaceId, id);
  const accounts = await db().emailAccount.findMany({ where: { workspaceId, id: { in: accountIds } } });
  if (accounts.length !== new Set(accountIds).size) throw NotFound('Email account');
  await db().$transaction([
    db().campaignEmailAccount.deleteMany({ where: { campaignId: id } }),
    db().campaignEmailAccount.createMany({ data: accounts.map((a) => ({ workspaceId, campaignId: id, emailAccountId: a.id })) }),
  ]);
  await invalidateApproval(id);
  await audit(workspaceId, actor, 'campaign.accounts_set', { type: 'campaign', id }, { accountIds });
}

export async function getCampaign(workspaceId: string, id: string) {
  const c = await db().campaign.findFirst({
    where: { id, workspaceId },
    include: {
      sequence: { include: { steps: { orderBy: { order: 'asc' }, include: { variants: { orderBy: { label: 'asc' } } } } } },
      lists: { include: { list: { select: { id: true, name: true, _count: { select: { members: true } } } } } },
      accounts: { include: { emailAccount: { select: { id: true, emailAddress: true, status: true, provider: true, operatorPaused: true, sendingWindow: true } } } },
      serviceSelections: { include: { serviceVersion: { include: { service: { select: { id: true, name: true } } } } } },
    },
  });
  if (!c) throw NotFound('Campaign');
  return c;
}

export async function listCampaigns(workspaceId: string) {
  const cs = await db().campaign.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
  const counts = await db().emailEvent.groupBy({ by: ['campaignId', 'type'], where: { workspaceId, campaignId: { in: cs.map((c) => c.id) } }, _count: { _all: true } });
  const enr = await db().sequenceEnrollment.groupBy({ by: ['campaignId'], where: { workspaceId }, _count: { _all: true } });
  return cs.map((c) => {
    const get = (t: string) => counts.find((x) => x.campaignId === c.id && x.type === t)?._count._all ?? 0;
    return { ...c, stats: { enrolled: enr.find((e) => e.campaignId === c.id)?._count._all ?? 0, sent: get('SENT'), replied: get('REPLIED'), bounced: get('BOUNCED_HARD'), unsubscribed: get('UNSUBSCRIBED') } };
  });
}

type FullCampaign = Awaited<ReturnType<typeof getCampaign>>;

export function contentHash(c: FullCampaign): string {
  const payload = {
    settings: [c.name, c.timezone, c.useLeadTimezone, c.sendingWindow, c.dailyNewLeadLimit, c.dailySendLimit, c.stopOnReply, c.stopOnAutoReply, c.reviewMode, c.requireFactCheck, c.trackOpens, c.trackClicks, c.requireVerifiedEmail, c.minLeadScore, c.maxBounceRatePct, c.maxComplaints],
    steps: c.sequence?.steps.map((s) => [s.order, s.delayDays, s.threadMode, s.personalizationMode, s.condition, s.aiInstructions, s.variants.map((v) => [v.label, v.subject, v.body, v.weight, v.aiInstructions])]),
    ai: [c.aiProfileId, c.icpId, c.aiOverrides, c.maxAiCostPerLeadUsd?.toString() ?? null, c.usePregeneratedAi, c.scheduledStartAt?.toISOString() ?? null],
    lists: c.lists.map((l) => l.listId).sort(),
    accounts: c.accounts.map((a) => a.emailAccountId).sort(),
    services: c.serviceSelections.map((s) => [s.serviceVersionId, s.isPreferred]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };
  return sha256(JSON.stringify(payload));
}

export async function validateCampaign(workspaceId: string, id: string) {
  const c = await getCampaign(workspaceId, id);
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const blocking: string[] = [];
  const warnings: string[] = [];
  const steps = c.sequence?.steps ?? [];
  if (!steps.length) blocking.push('Sequence has no steps');
  if (steps.some((s) => s.personalizationMode !== 'TEMPLATE_ONLY')) {
    const approvedServiceCount = await db().campaignServiceSelection.count({ where: { workspaceId, campaignId: id, serviceVersion: { status: 'APPROVED', service: { isArchived: false } } } });
    if (!approvedServiceCount) blocking.push('AI-personalized campaigns need at least one approved EMN service selected under AI personalization.');
  }
  for (const s of steps) {
    for (const v of s.variants) {
      if ((s.order === 1 || s.threadMode === 'NEW_THREAD') && !v.subject.trim()) blocking.push(`Step ${s.order} variant ${v.label} needs a subject`);
      const unknown = [...lintTemplate(v.subject), ...lintTemplate(v.body)];
      if (unknown.length) blocking.push(`Step ${s.order} variant ${v.label} uses unknown variables: ${[...new Set(unknown)].join(', ')}`);
      // The AI writes the whole email in AI_FULL mode (the template is its guidance); otherwise this text is what gets sent.
      const problem = s.personalizationMode === 'AI_FULL' ? null : bodyContentProblem(v.body.replace(/\{\{\s*aiFirstLine\s*\}\}/g, ''));
      if (problem) blocking.push(`Step ${s.order} variant ${v.label}: ${problem}. Write the email before submitting.`);
      if (s.personalizationMode === 'AI_FIRST_LINE' && !v.body.includes('aiFirstLine')) warnings.push(`Step ${s.order} variant ${v.label} uses AI first line but the body has no {{aiFirstLine}} placeholder`);
    }
    if (s.condition !== 'ALWAYS') blocking.push(`Step ${s.order} must use an unconditional schedule. Open signals cannot control sending.`);
  }
  if (!c.lists.length) blocking.push('Select at least one lead list');
  const connected = c.accounts.filter(({ emailAccount }) => emailAccount.status === 'CONNECTED' && !emailAccount.operatorPaused
    && (emailAccount.sendingWindow as { participateInRotation?: boolean })?.participateInRotation !== false);
  if (!connected.length) blocking.push('Select at least one connected sending mailbox');
  if (c.accounts.length > connected.length) warnings.push(`${c.accounts.length - connected.length} selected mailbox(es) are not connected and will not send`);
  if (!ws.postalAddress?.trim()) blocking.push('Set the sender postal address in Settings → Compliance (required in the email footer)');
  if (steps.some((s) => s.personalizationMode !== 'TEMPLATE_ONLY')) {
    // Counts API keys or the selected Claude/Codex subscription (workspace AI source or this campaign's own choice).
    const avail = await (await import('./ai-source.js')).aiAvailability(workspaceId, id);
    if (!avail.ok) blocking.push(avail.problem ?? 'AI personalization is used but no AI source is ready');
  }
  if (c.trackOpens || c.trackClicks) warnings.push('Open/click tracking is enabled: tracking pixels and rewritten links can reduce deliverability and require a privacy notice. Open data is an estimate (image blocking, privacy proxies).');
  if (c.reviewMode === 'NONE' && steps.some((s) => s.personalizationMode !== 'TEMPLATE_ONLY')) blocking.push('AI-written emails require explicit human approval after evidence, fact-check and quality review; review mode NONE is not allowed for AI-personalized campaigns.');

  // Recipient eligibility preview (sampled)
  const members = await db().leadListMember.findMany({ where: { workspaceId, listId: { in: c.lists.map((l) => l.listId) } }, include: { lead: true }, take: 2000, distinct: ['leadId'] });
  let eligible = 0;
  const reasons = new Map<string, number>();
  for (const m of members) {
    const r = await canContact(workspaceId, m.lead, { requireVerified: c.requireVerifiedEmail, icpId: c.icpId });
    if (c.minLeadScore !== null && (m.lead.currentScore ?? -1) < c.minLeadScore) { r.reasons.push(`score below ${c.minLeadScore}`); r.allowed = false; }
    if (r.allowed) eligible++;
    for (const reason of r.reasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  if (members.length && eligible === 0) blocking.push('No recipients are currently eligible (see exclusion reasons)');
  return { blocking, warnings, recipients: { total: members.length, eligible, excluded: Object.fromEntries(reasons) } };
}

export async function submitCampaign(workspaceId: string, id: string, actor: Actor) {
  const c = await getCampaignOr404(workspaceId, id);
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(c.status)) throw new AppError('CAMPAIGN_STATE', `Cannot submit a ${c.status} campaign`, 409);
  const v = await validateCampaign(workspaceId, id);
  if (v.blocking.length) throw new AppError('CAMPAIGN_INVALID', 'Campaign has blocking issues', 400, v);
  await db().campaign.update({ where: { id }, data: { status: 'PENDING_APPROVAL' } });
  await audit(workspaceId, actor, 'campaign.submitted', { type: 'campaign', id });
  await notifyWorkspace(workspaceId, 'MANAGER', { type: 'campaign.approval_needed', title: `Campaign "${c.name}" needs approval`, link: `/campaigns/${id}` });
  return v;
}

export async function approveCampaign(workspaceId: string, id: string, actor: Actor) {
  const c = await getCampaignOr404(workspaceId, id);
  if (c.status !== 'PENDING_APPROVAL') throw new AppError('CAMPAIGN_STATE', 'Only campaigns pending approval can be approved', 409);
  const v = await validateCampaign(workspaceId, id);
  if (v.blocking.length) throw new AppError('CAMPAIGN_INVALID', 'Campaign has blocking issues', 400, v);
  const full = await getCampaign(workspaceId, id);
  const hash = contentHash(full);
  // Freeze the AI configuration: later edits to AI Studio settings or prompt profiles never silently
  // change what this approved campaign generates.
  const built = await buildSnapshot(workspaceId, id);
  const usesAi = full.sequence?.steps.some((step) => step.personalizationMode !== 'TEMPLATE_ONLY') ?? false;
  const taskExecution = usesAi ? await captureCampaignTaskExecution(workspaceId, ['PERSONALIZATION', 'FACT_CHECK'], id) : {};
  const executionSnapshotId = randomUUID();
  const snapshot = { ...built, taskExecution, executionSnapshotId };
  const last = await db().sequenceVersion.findFirst({ where: { campaignId: id }, orderBy: { version: 'desc' } });
  const version = (last?.version ?? 0) + 1;
  const stale = usesAi ? await db().leadPersonalization.count({ where: { campaignId: id, status: { in: ['GENERATED', 'APPROVED'] } } }) : 0;
  await db().$transaction([
    db().campaign.update({ where: { id }, data: { status: 'APPROVED', approvedContentHash: hash, approvedAt: new Date(), approvedById: actor.userId ?? null, pauseReason: null, aiConfigSnapshot: snapshot as unknown as Prisma.InputJsonValue, aiSnapshotAt: new Date() } }),
    // Existing AI drafts were generated under the prior live configuration. Preserve their text,
    // but hold them until they are regenerated and explicitly reviewed against this snapshot.
    ...(usesAi ? [db().leadPersonalization.updateMany({ where: { campaignId: id, status: { in: ['GENERATED', 'APPROVED'] } }, data: { status: 'BLOCKED', error: 'Campaign configuration was frozen after this draft was generated. Regenerate and review it against the approved snapshot.', qualityPassed: false, approvedById: null, approvedAt: null, approvedContentHash: null } })] : []),
    db().sequenceVersion.create({ data: { id: executionSnapshotId, workspaceId, campaignId: id, version, contentHash: hash, approvedById: actor.userId ?? null, snapshot: { settings: campaignSettingsOf(full), steps: stepsOf(full), lists: full.lists.map((l) => l.listId), accounts: full.accounts.map((a) => a.emailAccountId), aiConfigSnapshot: snapshot, serviceVersions: snapshot.selectedServices.map((s) => ({ serviceVersionId: s.serviceVersionId, version: s.version, name: s.name })), ai: { aiProfileId: full.aiProfileId, icpId: full.icpId, aiOverrides: full.aiOverrides, maxAiCostPerLeadUsd: full.maxAiCostPerLeadUsd?.toString() ?? null, usePregeneratedAi: full.usePregeneratedAi, profileVersion: snapshot.profile?.version ?? null, writingVersion: snapshot.writing.version, researchVersion: snapshot.research.version, knowledgeVersion: snapshot.knowledge.version } } as unknown as Prisma.InputJsonValue } }),
  ]);
  await audit(workspaceId, actor, 'campaign.approved', { type: 'campaign', id }, { contentHash: hash, sequenceVersion: version, approvedPersonalizations: stale });
  return { approved: true, contentHash: hash, sequenceVersion: version };
}

async function assertHash(workspaceId: string, id: string) {
  const full = await getCampaign(workspaceId, id);
  if (!full.approvedContentHash || contentHash(full) !== full.approvedContentHash) throw new AppError('CAMPAIGN_STATE', 'Campaign content changed since approval; approve again', 409);
  return full;
}

export async function startCampaign(workspaceId: string, id: string, actor: Actor) {
  const c = await getCampaignOr404(workspaceId, id);
  if (!['APPROVED', 'PAUSED'].includes(c.status)) throw new AppError('CAMPAIGN_STATE', `Cannot start a ${c.status} campaign — it must be approved first`, 409);
  await (await import('./billing.js')).assertEntitled(workspaceId, 'activeCampaigns');
  await (await import('./tenancy.js')).assertEmailVerified(actor.userId);
  await assertHash(workspaceId, id);
  await db().campaign.update({ where: { id }, data: { status: 'RUNNING', startedAt: c.startedAt ?? new Date(), pausedAt: null, pauseReason: null } });
  await db().sequenceEnrollment.updateMany({ where: { campaignId: id, status: 'PAUSED', stopReason: 'campaign paused' }, data: { status: 'ACTIVE', stopReason: null } });
  await audit(workspaceId, actor, c.status === 'PAUSED' ? 'campaign.resumed' : 'campaign.started', { type: 'campaign', id });
  await enqueue(QUEUES.scheduler, 'campaign.tick', { campaignId: id }, { jobId: `tick-start-${id}-${Date.now()}` });
  await publish(workspaceId, 'campaign.updated', { campaignId: id });
  return { status: 'RUNNING' };
}

export async function pauseCampaign(workspaceId: string, id: string, reason: string, actor: Actor) {
  const c = await getCampaignOr404(workspaceId, id);
  if (c.status !== 'RUNNING') throw new AppError('CAMPAIGN_STATE', 'Only running campaigns can be paused', 409);
  await db().campaign.update({ where: { id }, data: { status: 'PAUSED', pausedAt: new Date(), pauseReason: reason } });
  await db().sequenceEnrollment.updateMany({ where: { campaignId: id, status: 'ACTIVE' }, data: { status: 'PAUSED', stopReason: 'campaign paused' } });
  await audit(workspaceId, actor, 'campaign.paused', { type: 'campaign', id }, { reason });
  await emitEvent(workspaceId, 'campaign.paused', `${id}:${Date.now()}`, { campaignId: id, reason });
  await publish(workspaceId, 'campaign.updated', { campaignId: id });
  return { status: 'PAUSED' };
}

export async function archiveCampaign(workspaceId: string, id: string, actor: Actor) {
  const c = await getCampaignOr404(workspaceId, id);
  if (c.status === 'RUNNING') throw new AppError('CAMPAIGN_STATE', 'Pause the campaign before archiving', 409);
  await db().campaign.update({ where: { id }, data: { status: 'ARCHIVED' } });
  await stopCampaignEnrollments(id, 'STOPPED_MANUAL', 'campaign archived');
  await audit(workspaceId, actor, 'campaign.archived', { type: 'campaign', id });
}

export async function deleteCampaign(workspaceId: string, id: string, actor: Actor) {
  const c = await getCampaignOr404(workspaceId, id);
  const sent = await db().outboundEmail.count({ where: { campaignId: id, status: 'SENT' } });
  if (c.status !== 'DRAFT' || sent > 0) throw new AppError('CAMPAIGN_STATE', 'Only draft campaigns that never sent can be deleted; archive instead', 409);
  await db().campaign.delete({ where: { id } });
  await audit(workspaceId, actor, 'campaign.deleted', { type: 'campaign', id });
}

async function stopCampaignEnrollments(campaignId: string, status: 'STOPPED_MANUAL', reason: string) {
  await db().sequenceEnrollment.updateMany({ where: { campaignId, status: { in: ['ACTIVE', 'PAUSED'] } }, data: { status, stopReason: reason, completedAt: new Date() } });
  await db().outboundEmail.updateMany({ where: { campaignId, status: { in: ['PENDING', 'AWAITING_APPROVAL', 'QUEUED'] } }, data: { status: 'CANCELLED', lastError: reason } });
}

export async function listRecipients(workspaceId: string, id: string, q: { page: number; pageSize: number; status?: string }) {
  await getCampaignOr404(workspaceId, id);
  const where: Prisma.SequenceEnrollmentWhereInput = { workspaceId, campaignId: id, ...(q.status ? { status: q.status as never } : {}) };
  const [items, total] = await Promise.all([
    db().sequenceEnrollment.findMany({ where, orderBy: { enrolledAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { lead: { select: { id: true, email: true, firstName: true, lastName: true, status: true } }, emailAccount: { select: { emailAddress: true } } } }),
    db().sequenceEnrollment.count({ where }),
  ]);
  return { items, total };
}

export async function listOutbound(workspaceId: string, q: { page: number; pageSize: number; campaignId?: string; status?: string; awaitingApproval?: boolean }) {
  const where: Prisma.OutboundEmailWhereInput = {
    workspaceId, ...(q.campaignId ? { campaignId: q.campaignId } : {}), ...(q.status ? { status: q.status as never } : {}), ...(q.awaitingApproval ? { status: 'AWAITING_APPROVAL' } : {}),
  };
  const [items, total] = await Promise.all([
    db().outboundEmail.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { enrollment: { include: { lead: { select: { id: true, email: true, firstName: true, lastName: true } } } }, step: { select: { order: true } }, variant: { select: { label: true } }, campaign: { select: { id: true, name: true } }, emailAccount: { select: { emailAddress: true } } } }),
    db().outboundEmail.count({ where }),
  ]);
  return { items, total };
}

export async function getOutbound(workspaceId: string, id: string) {
  const o = await db().outboundEmail.findFirst({ where: { id, workspaceId }, include: { enrollment: { include: { lead: true } }, campaign: { select: { id: true, name: true, requireFactCheck: true } }, step: true, variant: true, emailAccount: { select: { emailAddress: true } } } });
  if (!o) throw NotFound('Outbound email');
  const claims = o.usedClaimIds.length ? await db().researchClaim.findMany({ where: { workspaceId, id: { in: o.usedClaimIds } }, include: { evidence: { select: { url: true } } } }) : [];
  return { ...o, claims };
}

export async function reviewOutbound(workspaceId: string, id: string, input: { decision: 'approve' | 'reject'; subject?: string; bodyText?: string; reason?: string }, actor: Actor) {
  const o = await db().outboundEmail.findFirst({ where: { id, workspaceId }, include: { campaign: true, enrollment: true } });
  if (!o) throw NotFound('Outbound email');
  if (o.status !== 'AWAITING_APPROVAL') throw new AppError('CONFLICT', `This email is ${o.status}`, 409);
  if (o.lastError?.includes('needs revalidation under the current evidence and quality policy')) throw new AppError('QUALITY_CHECK_FAILED', 'Regenerate and approve this content in the campaign personalization review before sending.', 409);
  if (o.lastError === WAITING_MARKER || !o.bodyText) throw new AppError('CONFLICT', 'This email is waiting for its personalized content. Review and approve it in the campaign\'s AI personalization tab.', 409);
  if (input.decision === 'reject') {
    await db().outboundEmail.update({ where: { id }, data: { status: 'CANCELLED', approvalStatus: 'REJECTED', lastError: input.reason ?? 'rejected by reviewer' } });
    await db().sequenceEnrollment.update({ where: { id: o.enrollmentId }, data: { status: 'STOPPED_MANUAL', stopReason: 'email rejected in review', completedAt: new Date() } });
    await audit(workspaceId, actor, 'outbound.rejected', { type: 'outbound', id }, { reason: input.reason });
    return { status: 'CANCELLED' };
  }
  const factCheckStatus = o.factCheckStatus;
  const factCheckReport = o.factCheckReport;
  const edited = (input.bodyText !== undefined && input.bodyText !== o.bodyText) || (input.subject !== undefined && input.subject !== o.subject);
  const subject = input.subject ?? o.subject;
  const bodyText = input.bodyText ?? o.bodyText;
  if (/\{\{[^}]+\}\}/.test(`${subject}\n${bodyText}`)) throw BadRequest('UNRESOLVED_VARIABLES', 'Email still contains {{variables}}');
  if (edited && o.aiGenerated) throw new AppError('QUALITY_CHECK_FAILED', 'Edit AI-generated content in the campaign personalization editor so evidence, fact-check and quality gates run again.', 409);
  if (factCheckStatus === 'FAILED') {
    await db().outboundEmail.update({ where: { id }, data: { subject, bodyText, factCheckStatus, factCheckReport: factCheckReport as Prisma.InputJsonValue } });
    throw new AppError('FACT_CHECK_FAILED', 'The email contains statements the fact-checker could not verify. Edit them out before approving.', 400, factCheckReport);
  }
  await db().outboundEmail.update({ where: { id }, data: { subject, bodyText, status: 'QUEUED', approvalStatus: 'APPROVED', approvedById: actor.userId ?? null, approvedAt: new Date(), factCheckStatus, factCheckReport: (factCheckReport ?? undefined) as Prisma.InputJsonValue | undefined } });
  await enqueue(QUEUES.send, 'outbound.send', { workspaceId, outboundId: id }, { jobId: `send-${id}-${Date.now()}`, attempts: 5 });
  await audit(workspaceId, actor, 'outbound.approved', { type: 'outbound', id }, { edited });
  return { status: 'QUEUED' };
}

// =====================================================================================
// Stop rules
// =====================================================================================

type StopStatus = 'STOPPED_REPLIED' | 'STOPPED_BOUNCED' | 'STOPPED_UNSUBSCRIBED' | 'STOPPED_SUPPRESSED' | 'STOPPED_COMPLAINT' | 'STOPPED_INELIGIBLE' | 'STOPPED_MANUAL';

export async function stopEnrollmentsForLead(workspaceId: string, leadId: string, status: StopStatus, reason: string, onlyCampaignId?: string) {
  const enrollments = await db().sequenceEnrollment.findMany({ where: { workspaceId, leadId, status: { in: ['ACTIVE', 'PAUSED'] }, ...(onlyCampaignId ? { campaignId: onlyCampaignId } : {}) } });
  if (!enrollments.length) return 0;
  const ids = enrollments.map((e) => e.id);
  await db().$transaction([
    db().sequenceEnrollment.updateMany({ where: { id: { in: ids } }, data: { status, stopReason: reason, completedAt: new Date(), nextActionAt: null } }),
    db().outboundEmail.updateMany({ where: { enrollmentId: { in: ids }, status: { in: ['PENDING', 'AWAITING_APPROVAL', 'QUEUED'] } }, data: { status: 'CANCELLED', lastError: reason } }),
  ]);
  return ids.length;
}

export async function stopEnrollment(workspaceId: string, enrollmentId: string, actor: Actor) {
  const e = await db().sequenceEnrollment.findFirst({ where: { id: enrollmentId, workspaceId } });
  if (!e) throw NotFound('Enrollment');
  await stopEnrollmentsForLead(workspaceId, e.leadId, 'STOPPED_MANUAL', 'stopped by user', e.campaignId);
  await audit(workspaceId, actor, 'enrollment.stopped', { type: 'enrollment', id: enrollmentId });
}

// =====================================================================================
// Scheduler
// =====================================================================================

function windowOf(c: { sendingWindow: unknown }): SendingWindow {
  const p = SendingWindowSchema.safeParse(c.sendingWindow);
  return p.success ? p.data : DEFAULT_WINDOW;
}

export function recipientZone(campaign: { useLeadTimezone: boolean; timezone: string }, lead: { timezone: string | null }) {
  return campaign.useLeadTimezone && isValidZone(lead.timezone) ? lead.timezone! : campaign.timezone;
}

export function pickVariant<T extends { label: string; weight: number }>(variants: T[], seed: number): T {
  const sorted = [...variants].sort((a, b) => a.label.localeCompare(b.label));
  const total = sorted.reduce((s, v) => s + v.weight, 0);
  let x = seed % total;
  for (const v of sorted) { if (x < v.weight) return v; x -= v.weight; }
  return sorted[0];
}

async function checkThresholds(c: { id: string; workspaceId: string; name: string; maxBounceRatePct: number; maxComplaints: number }) {
  const [sent, bounced, complaints] = await Promise.all([
    db().emailEvent.count({ where: { campaignId: c.id, type: 'SENT' } }),
    db().emailEvent.count({ where: { campaignId: c.id, type: 'BOUNCED_HARD' } }),
    db().emailEvent.count({ where: { campaignId: c.id, type: 'COMPLAINED' } }),
  ]);
  let reason: string | null = null;
  if (sent >= 20 && (bounced / sent) * 100 > c.maxBounceRatePct) reason = `Bounce rate ${((bounced / sent) * 100).toFixed(1)}% exceeded ${c.maxBounceRatePct}%`;
  if (complaints >= c.maxComplaints) reason = `${complaints} complaint(s) recorded (limit ${c.maxComplaints})`;
  if (reason) {
    await pauseCampaign(c.workspaceId, c.id, `Auto-paused: ${reason}`, WORKER_ACTOR);
    await notifyWorkspace(c.workspaceId, 'MANAGER', { type: 'campaign.auto_paused', title: `Campaign "${c.name}" auto-paused`, body: reason, link: `/campaigns/${c.id}` });
    return true;
  }
  return false;
}

/** One scheduler pass over running campaigns (or one campaign). Safe to run concurrently-ish: all writes are idempotent. */
export async function tick(now = new Date(), onlyCampaignId?: string) {
  const campaigns = await db().campaign.findMany({ where: { status: 'RUNNING', ...(onlyCampaignId ? { id: onlyCampaignId } : {}) } });
  const summary = { campaigns: campaigns.length, enrolled: 0, outboundCreated: 0, completed: 0, requeued: 0 };
  for (const c of campaigns) {
    try {
      if (await checkThresholds(c)) continue;
      const rawWs = await db().workspace.findUnique({ where: { id: c.workspaceId }, select: { settings: true } });
      const automation = readSettings(rawWs?.settings);
      if (automation.emergencyPause || !automation.automaticCampaignSending) continue;
      const bill = await import('./billing.js');
      const tstate = await bill.billingState(c.workspaceId);
      if (!tstate.active) {
        await pauseCampaign(c.workspaceId, c.id, `Auto-paused: ${tstate.reason ?? 'organization inactive'}`, WORKER_ACTOR);
        continue;
      }
      const full = await getCampaign(c.workspaceId, c.id);
      if (!full.approvedContentHash || contentHash(full) !== full.approvedContentHash) {
        await pauseCampaign(c.workspaceId, c.id, 'Auto-paused: content changed after approval', WORKER_ACTOR);
        continue;
      }
      summary.enrolled += await enrollNew(full, now);
      const r = await advanceDue(full, now);
      summary.outboundCreated += r.created;
      summary.completed += r.completed;
      const remaining = await db().sequenceEnrollment.count({ where: { campaignId: c.id, status: { in: ['ACTIVE', 'PAUSED'] } } });
      const pendingMembers = await db().leadListMember.count({ where: { listId: { in: full.lists.map((l) => l.listId) }, lead: { enrollments: { none: { campaignId: c.id } } } } });
      if (remaining === 0 && pendingMembers === 0 && (await db().outboundEmail.count({ where: { campaignId: c.id, status: { in: ['PENDING', 'AWAITING_APPROVAL', 'QUEUED', 'SENDING'] } } })) === 0 && summary.enrolled === 0) {
        const anyEnrollment = await db().sequenceEnrollment.count({ where: { campaignId: c.id } });
        if (anyEnrollment > 0) await db().campaign.update({ where: { id: c.id }, data: { status: 'COMPLETED', completedAt: now } });
      }
    } catch (e) {
      logger.error({ err: e, campaignId: c.id }, 'tick failed for campaign');
    }
  }
  summary.requeued = await sweepQueued(now);
  return summary;
}

async function enrollNew(c: FullCampaign, now: Date): Promise<number> {
  if (c.scheduledStartAt && c.scheduledStartAt > now) return 0; // campaign scheduled to start later
  const accounts = c.accounts.filter(({ emailAccount }) => emailAccount.status === 'CONNECTED' && !emailAccount.operatorPaused
    && (emailAccount.sendingWindow as { participateInRotation?: boolean })?.participateInRotation !== false).map(a => a.emailAccountId);
  if (!accounts.length) return 0;
  const enrolledToday = await db().sequenceEnrollment.count({ where: { campaignId: c.id, enrolledAt: { gte: startOfDayIn(c.timezone, now) } } });
  let capacity = c.dailyNewLeadLimit - enrolledToday;
  if (capacity <= 0) return 0;
  const candidates = await db().leadListMember.findMany({
    where: { listId: { in: c.lists.map((l) => l.listId) }, lead: { enrollments: { none: { OR: [{ campaignId: c.id }, { status: 'ACTIVE' }] } } } },
    include: { lead: true }, distinct: ['leadId'], orderBy: { addedAt: 'asc' }, take: capacity * 4,
  });
  const load = new Map<string, number>(accounts.map((a) => [a, 0]));
  for (const g of await db().sequenceEnrollment.groupBy({ by: ['emailAccountId'], where: { campaignId: c.id, status: 'ACTIVE' }, _count: { _all: true } })) if (load.has(g.emailAccountId)) load.set(g.emailAccountId, g._count._all);
  let created = 0;
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: c.workspaceId }, select: { settings: true } });
  const automation = readSettings(ws.settings);
  let externalVerifierAvailable = false;
  if (automation.emailVerificationMode === 'external') {
    const { getSecret } = await import('./integrations.js');
    const providers = [...new Set([...automation.verifierOrder, ...(automation.verifierProvider === 'none' ? [] : [automation.verifierProvider])])];
    for (const provider of providers) if (await getSecret(c.workspaceId, provider)) { externalVerifierAvailable = true; break; }
  }
  for (const m of candidates) {
    if (capacity <= 0) break;
    const lead = m.lead;
    if (c.minLeadScore !== null && (lead.currentScore ?? -1) < c.minLeadScore) continue;
    const ok = await canContact(c.workspaceId, lead, { requireVerified: c.requireVerifiedEmail, icpId: c.icpId });
    if (!ok.allowed) {
      // Queue verification only for potentially eligible addresses. The mail is held from
      // enrollment until the result is known; UNKNOWN and risky outcomes remain held.
      const needsCheck = lead.emailVerificationStatus !== 'INVALID'
        && (!lead.emailVerifiedAt || now.getTime() - lead.emailVerifiedAt.getTime() > automation.verificationFreshnessDays * 86_400_000);
      if (needsCheck && automation.emailVerificationMode === 'custom') {
        const fp = await import('./first-party-verification.js');
        const v = await fp.createVerification(c.workspaceId, lead.emailNormalized, { leadId: lead.id });
        if (!v.cached) await enqueue(QUEUES.verify, 'verify.address', { workspaceId: c.workspaceId, verificationId: v.id }, { jobId: `fpv-${v.id}`, attempts: 4, backoff: { type: 'emnVerify' } });
      } else if (needsCheck && automation.emailVerificationMode === 'external' && externalVerifierAvailable) {
        await enqueue(QUEUES.verify, 'verify.lead', { workspaceId: c.workspaceId, leadId: lead.id, freshDays: automation.verificationFreshnessDays }, { jobId: `campaign-verify-${lead.id}-${Math.floor(now.getTime() / (automation.verificationFreshnessDays * 86_400_000))}`, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } });
      }
      continue;
    }
    // Fixed sender per prospect: least-loaded connected mailbox at enrollment time, never changed afterwards.
    const accountId = [...load.entries()].sort((a, b) => a[1] - b[1])[0][0];
    try {
      await db().sequenceEnrollment.create({ data: { workspaceId: c.workspaceId, campaignId: c.id, leadId: lead.id, emailAccountId: accountId, variantSeed: variantSeedFor(c.id, lead.id), nextActionAt: nextWindowStart(now, windowOf(c), recipientZone(c, lead)) } });
      load.set(accountId, (load.get(accountId) ?? 0) + 1);
      capacity--; created++;
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
    }
  }
  return created;
}

async function advanceDue(c: FullCampaign, now: Date) {
  const steps = c.sequence?.steps ?? [];
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: c.workspaceId }, select: { settings: true } });
  const automation = readSettings(ws.settings);
  const due = await db().sequenceEnrollment.findMany({ where: { campaignId: c.id, status: 'ACTIVE', nextActionAt: { lte: now } }, include: { lead: true }, take: 500 });
  let created = 0;
  let completed = 0;
  for (const e of due) {
    const order = e.currentStepOrder + 1;
    if (order > 1 && !automation.automaticFollowups) {
      // Keep the enrollment and its step position intact while pausing follow-up scheduling.
      await db().sequenceEnrollment.update({ where: { id: e.id }, data: { nextActionAt: new Date(now.getTime() + 60 * 60_000) } });
      continue;
    }
    const step = steps.find((s) => s.order === order);
    if (step && step.condition !== 'ALWAYS') {
      await db().sequenceEnrollment.update({ where: { id: e.id }, data: { nextActionAt: new Date(now.getTime() + 60 * 60_000) } });
      continue;
    }
    if (!step) {
      await db().sequenceEnrollment.update({ where: { id: e.id }, data: { status: 'COMPLETED', completedAt: now, nextActionAt: null } });
      completed++;
      continue;
    }
    const variant = pickVariant(step.variants, e.variantSeed);
    const id = randomUUID();
    const domain = (await db().emailAccount.findUniqueOrThrow({ where: { id: e.emailAccountId } })).emailAddress.split('@')[1];
    try {
      await db().$transaction([
        db().outboundEmail.create({ data: { id, workspaceId: c.workspaceId, campaignId: c.id, enrollmentId: e.id, stepId: step.id, variantId: variant.id, emailAccountId: e.emailAccountId, idempotencyKey: `${e.id}:${step.id}`, internetMessageId: `<${id}@${domain}>`, toAddress: e.lead.emailNormalized, scheduledFor: now } }),
        db().sequenceEnrollment.update({ where: { id: e.id }, data: { nextActionAt: null } }),
      ]);
      created++;
      await enqueue(QUEUES.prepare, 'outbound.prepare', { workspaceId: c.workspaceId, outboundId: id }, { jobId: `prepare-${id}` });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        await db().sequenceEnrollment.update({ where: { id: e.id }, data: { nextActionAt: null } }); // already created by a previous pass
        continue;
      }
      throw err;
    }
  }
  return { created, completed };
}

/** Re-enqueue QUEUED emails whose job may have been lost or deferred (window/limits/pause). */
async function sweepQueued(now: Date) {
  const stale = await db().outboundEmail.findMany({ where: { status: 'QUEUED', scheduledFor: { lte: now }, updatedAt: { lte: new Date(now.getTime() - 60_000) } }, select: { id: true, workspaceId: true }, take: 500 });
  const stuck = await db().outboundEmail.findMany({ where: { status: 'SENDING', sendStartedAt: { lte: new Date(now.getTime() - 3 * 60_000) } }, select: { id: true, workspaceId: true }, take: 100 });
  for (const o of [...stale, ...stuck]) await enqueue(QUEUES.send, 'outbound.send', { workspaceId: o.workspaceId, outboundId: o.id }, { jobId: `send-${o.id}-${Math.floor(now.getTime() / 60_000)}`, attempts: 5 });
  return stale.length + stuck.length;
}

// =====================================================================================
// Prepare: render → personalize → fact-check → review gate
// =====================================================================================

export function buildFooter(ws: { senderLegalName: string | null; name: string; postalAddress: string | null }, unsubscribeUrl: string) {
  return `\n\n--\n${ws.senderLegalName ?? ws.name}${ws.postalAddress ? `, ${ws.postalAddress.replace(/\n/g, ', ')}` : ''}\nIf you'd prefer not to hear from me again, unsubscribe here: ${unsubscribeUrl}`;
}

export async function prepareOutbound(workspaceId: string, outboundId: string) {
  const o = await db().outboundEmail.findFirst({ where: { id: outboundId, workspaceId }, include: { campaign: true, step: true, variant: true, emailAccount: true, enrollment: { include: { lead: { include: { company: true } } } } } });
  if (!o || o.status !== 'PENDING') return { skipped: true };
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const settings = readSettings(ws.settings);
  const lead = o.enrollment.lead;
  const unsubscribeUrl = `${process.env.APP_URL}/u/${unsubscribeToken(workspaceId, lead.emailNormalized, lead.id, o.id)}`;
  const fail = async (msg: string) => {
    await db().outboundEmail.update({ where: { id: o.id }, data: { status: 'FAILED', lastError: msg } });
    await db().sequenceEnrollment.update({ where: { id: o.enrollmentId }, data: { status: 'FAILED', stopReason: msg } });
    return { failed: msg };
  };

  // Previous emails in this enrollment (for threading & follow-up context)
  const previous = await db().outboundEmail.findMany({ where: { enrollmentId: o.enrollmentId, status: 'SENT' }, orderBy: { sentAt: 'asc' } });
  let aiFirstLine = '';
  let subject = o.variant.subject;
  let body = o.variant.body;
  let usedClaimIds: string[] = [];
  let aiGenerated = false;
  let preApproved = false;
  const allowAiForStep = o.step.order === 1 || settings.aiFollowupGeneration;
  // The legacy send-time generator has no structured prospect-fit/service-match decision. Do not
  // allow it to bypass the campaign personalization quality gate when pre-generation is disabled.
  if (allowAiForStep && o.step.personalizationMode !== 'TEMPLATE_ONLY' && !o.campaign.usePregeneratedAi) {
    return fail('AI send-time generation is on hold because it cannot satisfy the campaign evidence and service-match gates. Enable pre-generated AI personalization, review the prospect brief, and approve the generated content.');
  }
  if (allowAiForStep && o.step.personalizationMode !== 'TEMPLATE_ONLY' && o.campaign.usePregeneratedAi) {
    // Pre-generated, individually approved personalization. The engine never calls AI here, so an AI
    // failure can only delay this email — never produce an unreviewed or duplicate send.
    const p = await db().leadPersonalization.findUnique({ where: { campaignId_leadId_stepId: { campaignId: o.campaignId, leadId: lead.id, stepId: o.stepId } } });
    if (p?.status === 'APPROVED' && (p.quality as { policyVersion?: number } | null)?.policyVersion !== 2) {
      await db().outboundEmail.update({ where: { id: o.id }, data: { status: 'AWAITING_APPROVAL', approvalStatus: 'PENDING', lastError: 'Previously approved personalization needs revalidation under the current evidence and quality policy.' } });
      await publish(workspaceId, 'review.pending', { outboundId: o.id, campaignId: o.campaignId, personalization: true, revalidationRequired: true });
      return { status: 'AWAITING_REVALIDATION' };
    }
    if (!p || p.status !== 'APPROVED' || !p.body || p.approvedContentHash !== contentHashOf(p)) {
      if (!p || ['FAILED', 'QUEUED', 'REJECTED'].includes(p.status) && !p.manuallyEdited) {
        await enqueue(QUEUES.personalize, 'personalize.single', { workspaceId, campaignId: o.campaignId, leadId: lead.id, stepId: o.stepId }, { jobId: `pz-single-${o.id}-${p?.revision ?? 0}-${p?.status ?? 'new'}-${Math.floor(Date.now() / 3_600_000)}`, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } });
      }
      await db().outboundEmail.update({ where: { id: o.id }, data: { status: 'AWAITING_APPROVAL', approvalStatus: 'PENDING', lastError: WAITING_MARKER } });
      await publish(workspaceId, 'review.pending', { outboundId: o.id, campaignId: o.campaignId, personalization: true });
      return { status: 'AWAITING_PERSONALIZATION' };
    }
    if (o.step.personalizationMode === 'AI_FIRST_LINE') aiFirstLine = p.openingLine ?? '';
    else { if (p.subject && !previous.length) subject = p.subject; body = p.body; }
    usedClaimIds = p.usedClaimIds; aiGenerated = true; preApproved = true;
  }
  try {
    if (!allowAiForStep) { /* administrator disabled AI generation for follow-up steps; use the approved template */ }
    else if (preApproved) { /* content already generated, checked and approved */ } else if (o.step.personalizationMode === 'AI_FIRST_LINE') {
      const g = await generateEmail(workspaceId, { leadId: lead.id, mode: 'first_line', templateSubject: subject, templateBody: body, previousEmails: '', instructions: '' });
      aiFirstLine = g.firstLine ?? '';
      usedClaimIds = g.usedClaimIds; aiGenerated = true;
    } else if (o.step.personalizationMode === 'AI_FULL') {
      const g = await generateEmail(workspaceId, { leadId: lead.id, mode: previous.length ? 'followup' : 'full', templateSubject: subject, templateBody: body, previousEmails: previous.map((p) => `${p.subject}\n${p.bodyText}`).join('\n---\n'), instructions: '' });
      if (g.subject && !previous.length) subject = g.subject;
      if (!g.body?.trim()) return fail('AI returned an empty email; nothing was sent (the template is guidance only, never sent instead)');
      body = g.body;
      usedClaimIds = g.usedClaimIds; aiGenerated = true;
    }
  } catch (e) {
    return fail(`AI personalization failed: ${(e as Error).message}`);
  }

  const vars = leadVars(lead, {
    sender: { name: o.emailAccount.displayName ?? ws.senderLegalName ?? ws.name, email: o.emailAccount.emailAddress },
    aiFirstLine, bookingLink: settings.bookingLink ?? '', unsubscribeUrl,
  });
  const s = renderTemplate(subject, vars);
  const b = renderTemplate(body, vars);
  const missing = [...new Set([...s.missing, ...b.missing])];
  if (missing.length) return fail(`Missing template variables: ${missing.join(', ')}`);
  // Last line of defence: whatever produced the text (template, AI, approved personalization), never mail a non-message.
  const contentProblem = bodyContentProblem(b.text);
  if (contentProblem) return fail(`${contentProblem}; nothing was sent`);

  let finalSubject = s.text.trim();
  if (o.step.threadMode === 'REPLY_IN_THREAD' && previous.length) {
    const first = previous[0].subject ?? '';
    finalSubject = finalSubject || (first.toLowerCase().startsWith('re:') ? first : `Re: ${first}`);
  }
  let bodyText = b.text.trim();
  if (o.emailAccount.signatureText) bodyText += `\n\n${o.emailAccount.signatureText}`;
  bodyText += buildFooter(ws, unsubscribeUrl);

  let factCheckStatus: 'NOT_REQUIRED' | 'PASSED' | 'FAILED' = 'NOT_REQUIRED';
  let factCheckReport: unknown = null;
  if (preApproved) factCheckStatus = 'PASSED'; // checked at personalization approval
  else if (aiGenerated && o.campaign.requireFactCheck) {
    try {
      const fc = await factCheck(workspaceId, lead.id, `${finalSubject}\n${b.text}`, settings.offerFacts);
      factCheckStatus = fc.passed ? 'PASSED' : 'FAILED';
      factCheckReport = fc.sentences;
    } catch (e) {
      return fail(`Fact-check failed to run: ${(e as Error).message}`);
    }
  }
  const needsReview = !preApproved && (o.campaign.reviewMode === 'ALL' || (o.campaign.reviewMode === 'AI_CONTENT_ONLY' && aiGenerated) || factCheckStatus === 'FAILED');
  await db().outboundEmail.update({
    where: { id: o.id },
    data: {
      subject: finalSubject, bodyText, usedClaimIds, aiGenerated, factCheckStatus, factCheckReport: factCheckReport as Prisma.InputJsonValue ?? Prisma.JsonNull,
      status: needsReview ? 'AWAITING_APPROVAL' : 'QUEUED', approvalStatus: needsReview ? 'PENDING' : 'NOT_REQUIRED',
    },
  });
  if (needsReview) {
    await publish(workspaceId, 'review.pending', { outboundId: o.id, campaignId: o.campaignId });
  } else {
    await enqueue(QUEUES.send, 'outbound.send', { workspaceId, outboundId: o.id }, { jobId: `send-${o.id}-first`, attempts: 5 });
  }
  return { status: needsReview ? 'AWAITING_APPROVAL' : 'QUEUED', factCheckStatus };
}

// =====================================================================================
// Send: gates → atomic claim → reconcile → provider send → finalize (idempotent)
// =====================================================================================

function textToHtml(text: string) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${esc.replace(/\n/g, '<br>')}</div>`;
}

async function applyTracking(workspaceId: string, outboundId: string, text: string, opts: { opens: boolean; clicks: boolean }, base: string) {
  let html = textToHtml(text);
  if (opts.clicks) {
    const urls = [...new Set(text.match(/https?:\/\/[^\s<>"')]+/g) ?? [])].filter((u) => !u.includes('/u/'));
    for (const url of urls) {
      const token = randomToken(12);
      await db().trackedLink.create({ data: { workspaceId, outboundEmailId: outboundId, url, token } });
      html = html.split(url.replace(/&/g, '&amp;')).join(`<a href="${base}/t/c/${token}">${url.replace(/&/g, '&amp;')}</a>`);
    }
  }
  if (opts.opens) html += `<img src="${base}/t/o/${outboundId}.gif" width="1" height="1" alt="" style="display:none">`;
  return html;
}

/** Counts accepted sends plus in-flight reservations so concurrent workers cannot overshoot a cap. */
async function reservedSendCountSince(where: Prisma.OutboundEmailWhereInput, since: Date) {
  return db().outboundEmail.count({ where: { ...where, OR: [{ status: 'SENT', sentAt: { gte: since } }, { status: { in: ['SENDING', 'UNCERTAIN'] }, sendStartedAt: { gte: since } }] } });
}

async function maybePauseMailboxAfterProviderErrors(workspaceId: string, accountId: string, now: Date, error: string) {
  const mailbox = await db().emailAccount.findFirst({ where: { workspaceId, id: accountId, status: 'CONNECTED' }, select: { sendingWindow: true } });
  if (!mailbox) return;
  const settings = mailbox.sendingWindow as { temporaryFailureLimit?: number; recoveryCooldownMinutes?: number };
  const limit = settings.temporaryFailureLimit ?? 3;
  const lastAccepted = await db().outboundEmail.aggregate({ where: { workspaceId, emailAccountId: accountId, status: 'SENT' }, _max: { sentAt: true } });
  const since = new Date(Math.max(now.getTime() - 15 * 60_000, lastAccepted._max.sentAt?.getTime() ?? 0));
  const recent = await db().outboundEmail.findMany({
    where: { workspaceId, emailAccountId: accountId, updatedAt: { gt: since }, OR: [
      { status: 'SENDING', lastError: { not: null } },
      { status: { in: ['QUEUED', 'FAILED'] }, lastError: { startsWith: 'Temporary submission failure:' } },
      { status: 'UNCERTAIN' },
    ] },
    select: { attempts: true },
  });
  const attempts = recent.reduce((n, row) => n + row.attempts, 0);
  if (attempts < limit) return;
  const paused = await db().emailAccount.updateMany({
    where: { id: accountId, workspaceId, status: 'CONNECTED' },
    data: { status: 'PAUSED', statusReason: `Auto-paused after transient provider errors (${attempts} attempts, threshold ${limit}).`, lastError: error.slice(0, 500), lastErrorAt: now,
      autoPauseUntil: new Date(now.getTime() + (settings.recoveryCooldownMinutes ?? 30) * 60_000) },
  });
  if (!paused.count) return;
  await audit(workspaceId, WORKER_ACTOR, 'email_account.auto_paused_provider_errors', { type: 'email_account', id: accountId }, { attempts, windowMinutes: 15 });
  await notifyWorkspace(workspaceId, 'ADMIN', { type: 'account.provider_error_pause', title: 'Mailbox paused after repeated provider errors', body: 'Review mailbox health and provider status before resuming.', link: '/mailbox-health' });
}

export type SendOutcome = 'sent' | 'reconciled' | 'deferred' | 'cancelled' | 'failed' | 'skipped';

const UNCERTAIN_REASON = 'Submission state unknown; not retried to avoid a duplicate. Review provider evidence.';

async function holdUncertain(workspaceId: string, outboundId: string, enrollmentId: string, at: Date) {
  const newlyHeld = await db().$transaction(async tx => {
    const held = await tx.outboundEmail.updateMany({
      where: { id: outboundId, workspaceId, status: 'SENDING' },
      data: { status: 'UNCERTAIN', uncertainAt: at, lastError: UNCERTAIN_REASON },
    });
    if (!held.count) return false;
    await tx.sequenceEnrollment.updateMany({
      where: { id: enrollmentId, workspaceId, status: { in: ['ACTIVE', 'PAUSED'] } },
      data: { status: 'FAILED', stopReason: UNCERTAIN_REASON, nextActionAt: null },
    });
    return true;
  });
  if (newlyHeld) {
    try {
      const recent = await db().outboundEmail.count({ where: { workspaceId, status: 'UNCERTAIN', resolvedAt: null, uncertainAt: { gte: new Date(at.getTime() - 3600_000) } } });
      if (recent === 1 || recent === 3) await notifyWorkspace(workspaceId, 'ADMIN', {
        type: 'outbound.uncertain', title: recent === 1 ? 'A send needs reconciliation' : 'Repeated uncertain sends',
        body: 'Review submission evidence before taking any action. Automatic resend is blocked.', link: '/mailbox-health/reconciliation',
      });
    } catch { logger.warn({ workspaceId, outboundId }, 'could not notify operators about an uncertain send'); }
  }
}

export async function sendOutbound(workspaceId: string, outboundId: string, now = new Date()): Promise<{ outcome: SendOutcome; detail?: string }> {
  const o = await db().outboundEmail.findFirst({ where: { id: outboundId, workspaceId }, include: { campaign: true, step: true, emailAccount: true, enrollment: { include: { lead: true } } } });
  if (!o) return { outcome: 'skipped', detail: 'not found' };
  if (o.status === 'UNCERTAIN' && o.resolvedAt) return { outcome: 'skipped', detail: 'operator decision recorded' };
  if (['SENT', 'CANCELLED', 'SKIPPED', 'FAILED', 'PENDING', 'AWAITING_APPROVAL'].includes(o.status)) return { outcome: 'skipped', detail: o.status };

  const recordSubmission = (submission: string, retryDecision: string, status?: number, suppressed = false) => audit(
    workspaceId, WORKER_ACTOR, 'outbound.submission_decision', { type: 'outbound_email', id: o.id }, {
      provider: o.emailAccount.provider, mailboxId: o.emailAccountId, campaignId: o.campaignId,
      prospectId: o.enrollment.leadId, attempt: o.attempts + (o.status === 'QUEUED' ? 1 : 0),
      submission, providerStatus: status, retryDecision, failoverDecision: 'DISABLED', suppressed, mailboxStatus: o.emailAccount.status,
    },
  ).catch(() => logger.warn({ workspaceId, outboundId }, 'could not persist submission audit'));

  if (o.status === 'QUEUED' && o.lastError?.startsWith('Temporary submission failure:') && o.scheduledFor > now) {
    return { outcome: 'deferred', detail: 'provider retry window has not elapsed' };
  }

  const cancel = async (reason: string, stop?: StopStatus) => {
    const changed = await db().outboundEmail.updateMany({ where: { id: o.id, workspaceId, status: 'QUEUED' }, data: { status: 'CANCELLED', lastError: reason } });
    if (!changed.count) return { outcome: 'skipped' as const, detail: 'send state changed' };
    if (stop) await stopEnrollmentsForLead(workspaceId, o.enrollment.leadId, stop, reason, o.campaignId);
    return { outcome: 'cancelled' as const, detail: reason };
  };
  const defer = async (until: Date, reason: string) => {
    await db().outboundEmail.updateMany({ where: { id: o.id, workspaceId, status: 'QUEUED' }, data: { scheduledFor: until, lastError: `deferred: ${reason}` } });
    return { outcome: 'deferred' as const, detail: reason };
  };

  if (o.status === 'QUEUED' && o.step.condition !== 'ALWAYS') {
    return defer(new Date(now.getTime() + 3600_000), 'open-based follow-up is held until the campaign is updated');
  }

  // ---- Tenant gate: suspended/cancelled tenants and exhausted monthly send allowances never send.
  if (o.status !== 'SENDING' && o.status !== 'UNCERTAIN') {
    const ent = await import('./entitlements.js');
    const st = await ent.tenantStateForWorkspace(workspaceId);
    if (!st.operational) return defer(new Date(now.getTime() + 3600_000), st.reason ?? 'organization inactive');
    try { await ent.assertMetered(st.organizationId, 'email_sends'); } catch {
      const { periodOf } = await import('./usage.js');
      return defer(periodOf(now).end, 'monthly email allowance used up');
    }
  }

  // ---- Crash recovery: a previous attempt may have sent the email before we recorded it.
  if (o.status === 'SENDING' || o.status === 'UNCERTAIN') {
    if (o.status === 'SENDING' && o.sendStartedAt && now.getTime() - o.sendStartedAt.getTime() < 2 * 60_000) return { outcome: 'skipped', detail: 'send in progress' };
    try {
      const found = await adapters().email[o.emailAccount.provider].findSentByOutboundId(await getAuth(o.emailAccountId), { outboundId: o.id, to: o.toAddress, since: o.sendStartedAt ?? o.createdAt });
      if (found) {
        await finalizeSent(o.id, { providerMessageId: found.providerMessageId, providerThreadId: found.providerThreadId, internetMessageId: found.internetMessageId || o.internetMessageId }, now, true);
        await recordSubmission('ACCEPTED', 'RECONCILED');
        return { outcome: 'reconciled' };
      }
    } catch (e) {
      await holdUncertain(workspaceId, o.id, o.enrollmentId, now);
      logger.warn({ outboundId, workspaceId, provider: o.emailAccount.provider }, 'Sent lookup failed; held for reconciliation');
      throw e;
    }
    await holdUncertain(workspaceId, o.id, o.enrollmentId, now);
    await recordSubmission('UNKNOWN_OUTCOME', 'BLOCKED_SENT_LOOKUP_EMPTY');
    return { outcome: 'cancelled', detail: UNCERTAIN_REASON };
  }

  // ---- Gates (re-evaluated at send time)
  const workspaceState = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true, timezone: true } });
  const globalAutomation = readSettings(workspaceState.settings);
  if (globalAutomation.emergencyPause) return defer(new Date(now.getTime() + 15 * 60_000), 'workspace emergency pause is active');
  if (!globalAutomation.automaticCampaignSending) return defer(new Date(now.getTime() + 60 * 60_000), 'automatic campaign sending is disabled');
  if (o.campaign.status !== 'RUNNING') return { outcome: 'deferred', detail: `campaign ${o.campaign.status}` };
  const full = await getCampaign(workspaceId, o.campaignId);
  if (!full.approvedContentHash || contentHash(full) !== full.approvedContentHash) return { outcome: 'deferred', detail: 'campaign not approved in current form' };
  if (o.enrollment.status !== 'ACTIVE') return cancel(`enrollment ${o.enrollment.status}`);
  if (o.approvalStatus === 'PENDING' || o.approvalStatus === 'REJECTED') return { outcome: 'skipped', detail: 'not approved' };
  if (o.factCheckStatus === 'FAILED') return { outcome: 'skipped', detail: 'fact-check failed' };
  if (o.emailAccount.status !== 'CONNECTED' || o.emailAccount.operatorPaused) return defer(new Date(now.getTime() + 15 * 60_000), `mailbox ${o.emailAccount.status}`);
  const lead = o.enrollment.lead;
  const eligibility = await canContact(workspaceId, lead, { requireVerified: o.campaign.requireVerifiedEmail, icpId: o.campaign.icpId });
  if (!eligibility.allowed) return cancel(`not eligible: ${eligibility.reasons.join('; ')}`, 'STOPPED_INELIGIBLE');
  const replied = await db().emailEvent.count({ where: { enrollmentId: o.enrollmentId, type: 'REPLIED' } });
  if (replied && o.campaign.stopOnReply) return cancel('prospect replied', 'STOPPED_REPLIED');

  const zone = recipientZone(o.campaign, lead);
  const window = windowOf(o.campaign);
  if (!isInWindow(now, window, zone)) return defer(nextWindowStart(now, window, zone), 'outside campaign sending window');
  const accWin = (o.emailAccount.sendingWindow ?? {}) as { enabled?: boolean } & Partial<SendingWindow>;
  if (accWin.enabled) {
    const w = SendingWindowSchema.safeParse(accWin);
    if (w.success && !isInWindow(now, w.data, w.data.timezone ?? 'UTC')) return defer(nextWindowStart(now, w.data, w.data.timezone ?? 'UTC'), 'outside mailbox sending window');
  }
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  // Serialize quota checks and SENDING reservations per workspace across worker instances.
  const releaseQuotaLock = await acquireLock(`send-quota:${workspaceId}`, 15_000);
  if (!releaseQuotaLock) return defer(new Date(now.getTime() + 2_000), 'workspace send quota is being checked');
  try {
    const mailbox = await db().emailAccount.findFirst({ where: { workspaceId, id: o.emailAccountId }, select: { status: true, operatorPaused: true, lastSentAt: true, minSecondsBetweenSends: true, sendingWindow: true } });
    if (mailbox?.status !== 'CONNECTED' || mailbox.operatorPaused) return defer(new Date(now.getTime() + 15 * 60_000), 'mailbox is unavailable');
    const limits = mailbox.sendingWindow as { hourlySendLimit?: number | null; maxSecondsBetweenSends?: number | null } | null;
    const minimum = mailbox.minSecondsBetweenSends;
    const maximum = Math.max(minimum, limits?.maxSecondsBetweenSends ?? minimum);
    if (mailbox.lastSentAt) {
      const seed = Number.parseInt(sha256(`${o.emailAccountId}:${mailbox.lastSentAt.toISOString()}`).slice(0, 8), 16);
      const gap = minimum + seed % (maximum - minimum + 1);
      const next = new Date(mailbox.lastSentAt.getTime() + gap * 1000);
      if (now < next) return defer(next, 'mailbox spacing between sends');
    }
    if (limits?.hourlySendLimit) {
      const since = new Date(now.getTime() - 3600_000);
      const where = { workspaceId, emailAccountId: o.emailAccountId };
      if (await reservedSendCountSince(where, since) >= limits.hourlySendLimit) {
        const oldest = await db().outboundEmail.aggregate({
          where: { ...where, status: 'SENT', sentAt: { gte: since } }, _min: { sentAt: true },
        });
        const retryAt = Math.max(now.getTime() + 60_000, (oldest._min.sentAt?.getTime() ?? now.getTime()) + 3600_001);
        return defer(new Date(retryAt), 'mailbox rolling hourly limit reached');
      }
    }
    const accountToday = await reservedSendCountSince({ workspaceId, emailAccountId: o.emailAccountId }, startOfDayIn(accWin.timezone ?? ws.timezone, now));
    const readiness = (o.emailAccount.connectionConfig as { readiness?: { enabled?: boolean; currentDailyCap?: number } } | null)?.readiness;
    const useReadiness = globalAutomation.mailboxReadinessManagement && readiness?.enabled === true;
    const effectiveMailboxLimit = useReadiness ? Math.min(o.emailAccount.dailySendLimit, readiness.currentDailyCap ?? 5) : o.emailAccount.dailySendLimit;
    if (accountToday >= effectiveMailboxLimit) return defer(nextWindowStart(startOfNextDayIn(accWin.timezone ?? ws.timezone, now), window, zone), useReadiness ? 'mailbox readiness daily cap reached' : 'mailbox daily limit reached');
    const campaignToday = await reservedSendCountSince({ workspaceId, campaignId: o.campaignId }, startOfDayIn(o.campaign.timezone, now));
    if (campaignToday >= o.campaign.dailySendLimit) return defer(nextWindowStart(startOfNextDayIn(o.campaign.timezone, now), window, zone), 'campaign daily limit reached');
    const workspaceLimit = readSettings(ws.settings).dailyEmailSendLimit;
    if (workspaceLimit !== null) {
      const workspaceToday = await reservedSendCountSince({ workspaceId }, startOfDayIn(ws.timezone, now));
      if (workspaceToday >= workspaceLimit) return defer(nextWindowStart(startOfNextDayIn(ws.timezone, now), window, zone), 'workspace daily send limit reached');
    }
    const domainLimit = readSettings(ws.settings).dailyDomainSendLimit;
    if (domainLimit !== null) {
      const domain = o.emailAccount.emailAddress.split('@').at(-1)?.toLowerCase();
      if (domain) {
        const domainAccounts = await db().emailAccount.findMany({ where: { workspaceId, emailAddress: { endsWith: `@${domain}` } }, select: { id: true } });
        const domainToday = await reservedSendCountSince({ workspaceId, emailAccountId: { in: domainAccounts.map((a) => a.id) } }, startOfDayIn(ws.timezone, now));
        if (domainToday >= domainLimit) return defer(nextWindowStart(startOfNextDayIn(ws.timezone, now), window, zone), 'domain daily send limit reached');
      }
    }
    const latestWorkspaceSettings = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
    const latestAutomation = readSettings(latestWorkspaceSettings.settings);
    if (latestAutomation.emergencyPause) return defer(new Date(now.getTime() + 15 * 60_000), 'workspace emergency pause is active');
    if (!latestAutomation.automaticCampaignSending) return defer(new Date(now.getTime() + 60 * 60_000), 'automatic campaign sending is disabled');
    // The reservation is visible to the next lock holder before this lock is released.
    const claim = await db().$transaction(async tx => {
      const claimed = await tx.outboundEmail.updateMany({ where: { id: o.id, status: 'QUEUED' }, data: { status: 'SENDING', sendStartedAt: now, attempts: { increment: 1 } } });
      if (claimed.count) await tx.emailAccount.update({ where: { id: o.emailAccountId }, data: { lastSentAt: now } });
      return claimed;
    });
    if (claim.count === 0) return { outcome: 'skipped', detail: 'claimed by another worker' };
  } finally {
    await releaseQuotaLock();
  }
  // ---- Build message (threading + compliance headers)
  const previous = await db().outboundEmail.findMany({ where: { enrollmentId: o.enrollmentId, status: 'SENT' }, orderBy: { sentAt: 'asc' } });
  const inThread = o.step.threadMode === 'REPLY_IN_THREAD' && previous.length > 0;
  const lastPrev = previous[previous.length - 1];
  const settings = readSettings(ws.settings);
  const unsubToken = unsubscribeToken(workspaceId, lead.emailNormalized, lead.id, o.id);
  const unsubscribeHttp = `${process.env.APP_URL}/api/v1/public/unsubscribe/${unsubToken}`;
  const html = settings.trackingEnabled && (o.campaign.trackOpens || o.campaign.trackClicks) ? await applyTracking(workspaceId, o.id, o.bodyText ?? '', { opens: o.campaign.trackOpens, clicks: o.campaign.trackClicks }, settings.trackingBaseUrl ?? `${process.env.APP_URL}/api/v1/public`) : undefined;
  const msg: OutgoingMessage = {
    from: { address: o.emailAccount.emailAddress, name: o.emailAccount.displayName ?? undefined },
    to: o.toAddress,
    replyTo: o.emailAccount.replyTo ?? undefined,
    subject: o.subject ?? '',
    text: o.bodyText ?? '',
    html,
    messageId: o.internetMessageId,
    inReplyTo: inThread ? lastPrev.internetMessageId : undefined,
    references: inThread ? previous.map((p) => p.internetMessageId) : undefined,
    threadId: inThread ? lastPrev.providerThreadId ?? undefined : undefined,
    headers: {
      [OUTBOUND_HEADER]: o.id,
      'List-Unsubscribe': `<${unsubscribeHttp}>, <mailto:${o.emailAccount.emailAddress}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };

  let submissionStarted = false;
  let accepted = false;
  try {
    const auth = await getAuth(o.emailAccountId);
    submissionStarted = true;
    const result = await adapters().email[o.emailAccount.provider].send(auth, msg);
    accepted = true;
    await recordSubmission('ACCEPTED', 'NO_RETRY');
    await finalizeSent(o.id, result, now, false);
    return { outcome: 'sent' };
  } catch (e) {
    const err = e as ProviderError;
    if (accepted) {
      await holdUncertain(workspaceId, o.id, o.enrollmentId, now);
      throw e;
    }
    const status = err instanceof ProviderError ? err.status : undefined;
    const submission = !submissionStarted ? 'DEFINITELY_NOT_SENT'
      : err instanceof ProviderError && err.submissionOutcome ? err.submissionOutcome
      : status && status >= 400 && status < 500 && status !== 408 ? 'PROVIDER_REJECTED'
      : 'UNKNOWN_OUTCOME';
    await db().emailAccount.update({ where: { id: o.emailAccountId }, data: { lastError: (err as Error).message.slice(0, 500), lastErrorAt: now } }).catch(() => undefined);
    if (status === 401 || (err instanceof Error && /invalid_grant/.test(err.message))) {
      await db().outboundEmail.update({ where: { id: o.id }, data: { status: 'QUEUED', lastError: err.message.slice(0, 500) } });
      await markNeedsReauth(workspaceId, o.emailAccountId, err.message);
      await recordSubmission(submission, 'REAUTHORIZE', status);
      return { outcome: 'deferred', detail: 'mailbox needs re-authorization' };
    }
    if (status && status >= 400 && status < 500 && status !== 429 && status !== 408) {
      const suppressed = o.emailAccount.provider === 'SMTP_IMAP' && err.code === 'RECIPIENT_NOT_FOUND';
      if (suppressed) {
        await addSuppression(workspaceId, { type: 'EMAIL', value: o.toAddress, reason: 'HARD_BOUNCE', source: 'smtp_recipient_rejection' }, WORKER_ACTOR);
      }
      await db().outboundEmail.update({ where: { id: o.id }, data: { status: 'FAILED', lastError: err.message.slice(0, 500) } });
      await db().emailEvent.create({ data: { workspaceId, type: 'FAILED', leadId: lead.id, campaignId: o.campaignId, enrollmentId: o.enrollmentId, outboundEmailId: o.id, emailAccountId: o.emailAccountId, metadata: { error: err.message.slice(0, 300) } } });
      await db().sequenceEnrollment.updateMany({ where: { id: o.enrollmentId, status: 'ACTIVE' }, data: { status: 'FAILED', stopReason: err.message.slice(0, 200) } });
      await recordSubmission(submission, 'BLOCKED', status, suppressed);
      return { outcome: 'failed', detail: err.message };
    }
    if (submission === 'DEFINITELY_NOT_SENT' || (submission === 'PROVIDER_REJECTED' && err.retryable)) {
      const message = `Temporary submission failure: ${err.message}`.slice(0, 500);
      const exhausted = o.attempts + 1 >= 5;
      const retryAfterMs = err instanceof ProviderError ? err.retryAfterMs : undefined;
      const retryAt = retryAfterMs && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? new Date(Math.min(8.64e15, now.getTime() + retryAfterMs)) : undefined;
      await db().$transaction(async tx => {
        await tx.outboundEmail.update({ where: { id: o.id }, data: { status: exhausted ? 'FAILED' : 'QUEUED', lastError: message, scheduledFor: retryAt } });
        if (exhausted) {
          await tx.sequenceEnrollment.updateMany({ where: { id: o.enrollmentId, status: 'ACTIVE' }, data: { status: 'FAILED', stopReason: message.slice(0, 200) } });
          await tx.emailEvent.upsert({ where: { dedupeKey: `FAILED:${o.id}` }, update: {}, create: { workspaceId, type: 'FAILED', leadId: lead.id, campaignId: o.campaignId, enrollmentId: o.enrollmentId, outboundEmailId: o.id, emailAccountId: o.emailAccountId, dedupeKey: `FAILED:${o.id}`, metadata: { error: message.slice(0, 300) } } });
        }
      });
      await maybePauseMailboxAfterProviderErrors(workspaceId, o.emailAccountId, now, err.message);
      await recordSubmission(submission, exhausted ? 'EXHAUSTED' : 'SAME_MAILBOX', status);
      if (exhausted) return { outcome: 'failed', detail: message };
      throw e;
    }
    await recordSubmission(submission, 'RECONCILE_ONLY', status);
    // The provider may have accepted the message. Subsequent jobs can reconcile but cannot resubmit.
    await holdUncertain(workspaceId, o.id, o.enrollmentId, now);
    if (status === undefined || status === 408 || status === 429 || status >= 500) await maybePauseMailboxAfterProviderErrors(workspaceId, o.emailAccountId, now, (err as Error).message);
    throw e;
  }
}

async function finalizeSent(outboundId: string, result: { providerMessageId: string | null; providerThreadId: string | null; internetMessageId: string }, at: Date, reconciled: boolean) {
  const o = await db().outboundEmail.findUniqueOrThrow({ where: { id: outboundId }, include: { enrollment: { include: { lead: true } }, campaign: true, step: true } });
  if (o.status === 'SENT') return;
  const steps = await db().sequenceStep.findMany({ where: { sequenceId: o.step.sequenceId }, orderBy: { order: 'asc' } });
  const next = steps.find((s) => s.order === o.step.order + 1);
  const zone = recipientZone(o.campaign, o.enrollment.lead);
  const threadKey = result.providerThreadId ?? result.internetMessageId;
  const finalized = await db().$transaction(async (tx) => {
    const claimed = await tx.outboundEmail.updateMany({ where: { id: outboundId, status: { in: ['SENDING', 'UNCERTAIN'] }, resolvedAt: null }, data: { status: 'SENT' } });
    if (!claimed.count) return false;
    const conv = await tx.conversation.upsert({
      where: { emailAccountId_providerThreadId: { emailAccountId: o.emailAccountId, providerThreadId: threadKey } },
      update: { lastMessageAt: at },
      create: { workspaceId: o.workspaceId, emailAccountId: o.emailAccountId, leadId: o.enrollment.leadId, campaignId: o.campaignId, providerThreadId: threadKey, subject: o.subject, lastMessageAt: at, isUnread: false, status: 'WAITING' },
    });
    const msg = await tx.emailMessage.upsert({
      where: { emailAccountId_providerMessageId: { emailAccountId: o.emailAccountId, providerMessageId: result.providerMessageId ?? `pending:${o.id}` } },
      update: {},
      create: {
        workspaceId: o.workspaceId, conversationId: conv.id, emailAccountId: o.emailAccountId, direction: 'OUTBOUND',
        providerMessageId: result.providerMessageId ?? `pending:${o.id}`, internetMessageId: result.internetMessageId,
        fromAddress: (await tx.emailAccount.findUniqueOrThrow({ where: { id: o.emailAccountId } })).emailAddress, toAddresses: [o.toAddress], ccAddresses: [], references: [],
        subject: o.subject, bodyText: o.bodyText, snippet: (o.bodyText ?? '').slice(0, 200), sentAt: at,
      },
    });
    await tx.outboundEmail.update({ where: { id: o.id }, data: { status: 'SENT', sentAt: at, providerMessageId: result.providerMessageId, providerThreadId: result.providerThreadId, internetMessageId: result.internetMessageId || o.internetMessageId, emailMessageId: msg.id, lastError: reconciled ? 'reconciled after crash' : null } });
    await tx.emailEvent.upsert({ where: { dedupeKey: `SENT:${o.id}` }, update: {}, create: { workspaceId: o.workspaceId, type: 'SENT', leadId: o.enrollment.leadId, campaignId: o.campaignId, enrollmentId: o.enrollmentId, outboundEmailId: o.id, emailMessageId: msg.id, emailAccountId: o.emailAccountId, dedupeKey: `SENT:${o.id}`, occurredAt: at } });
    await tx.sequenceEnrollment.updateMany({
      where: { id: o.enrollmentId, status: 'ACTIVE' },
      data: next
        ? { currentStepOrder: o.step.order, conversationId: conv.id, nextActionAt: computeNextStepAt(at, next.delayDays, windowOf(o.campaign), zone) }
        : { currentStepOrder: o.step.order, conversationId: conv.id, nextActionAt: null, status: 'COMPLETED', completedAt: at },
    });
    const lead = o.enrollment.lead;
    await tx.lead.update({ where: { id: lead.id }, data: { lastContactedAt: at, ...(['NEW', 'RESEARCHED', 'QUALIFIED'].includes(lead.status) ? { status: 'CONTACTED' } : {}) } });
    if (['NEW', 'RESEARCHED', 'QUALIFIED'].includes(lead.status)) await tx.leadStatusChange.create({ data: { workspaceId: o.workspaceId, leadId: lead.id, fromStatus: lead.status, toStatus: 'CONTACTED', reason: `campaign ${o.campaign.name}` } });
    return true;
  });
  if (!finalized) return;
  (await import('./usage.js')).meter({ workspaceId: o.workspaceId, metric: 'email_sends', quantity: 1, key: `send:${o.id}`, at });
  await emitEvent(o.workspaceId, 'email.sent', `sent:${o.id}`, { outboundId: o.id, leadId: o.enrollment.leadId, campaignId: o.campaignId });
  await publish(o.workspaceId, 'outbound.sent', { outboundId: o.id, campaignId: o.campaignId });
}

/** Enroll one lead (automation / manual) into an approved or running campaign. */
export async function enrollLeadManually(workspaceId: string, campaignId: string, leadId: string): Promise<string> {
  const c = await getCampaign(workspaceId, campaignId);
  if (!['APPROVED', 'RUNNING'].includes(c.status)) throw new AppError('CAMPAIGN_STATE', 'Campaign must be approved or running', 409);
  const lead = await db().lead.findFirst({ where: { id: leadId, workspaceId } });
  if (!lead) throw NotFound('Lead');
  const ok = await canContact(workspaceId, lead, { requireVerified: c.requireVerifiedEmail, icpId: c.icpId });
  if (!ok.allowed) throw new AppError('NOT_ELIGIBLE', `Lead not eligible: ${ok.reasons.join('; ')}`, 400);
  const accounts = c.accounts.filter(({ emailAccount }) => emailAccount.status === 'CONNECTED' && !emailAccount.operatorPaused
    && (emailAccount.sendingWindow as { participateInRotation?: boolean })?.participateInRotation !== false);
  if (!accounts.length) throw new AppError('CAMPAIGN_INVALID', 'No connected mailbox on this campaign', 400);
  const existing = await db().sequenceEnrollment.findUnique({ where: { campaignId_leadId: { campaignId, leadId } } });
  if (existing) return 'already enrolled';
  await db().sequenceEnrollment.create({ data: { workspaceId, campaignId, leadId, emailAccountId: accounts[Math.floor(Math.random() * accounts.length)].emailAccountId, variantSeed: Math.floor(Math.random() * 1_000_000), nextActionAt: nextWindowStart(new Date(), windowOf(c), recipientZone(c, lead)) } });
  return 'enrolled';
}

export { sha256 as _hash };

// =====================================================================================
// Campaign editor extras: AI settings, versions, cloning, preview, test emails
// =====================================================================================

function campaignSettingsOf(c: FullCampaign) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(CampaignSettingsSchema.shape) as Array<keyof typeof CampaignSettingsSchema.shape>) out[k] = (c as unknown as Record<string, unknown>)[k] ?? null;
  return out;
}

function stepsOf(c: FullCampaign) {
  return (c.sequence?.steps ?? []).map((s) => ({ order: s.order, delayDays: s.delayDays, threadMode: s.threadMode, personalizationMode: s.personalizationMode, condition: s.condition, aiInstructions: s.aiInstructions, variants: s.variants.map((v) => ({ label: v.label, subject: v.subject, body: v.body, weight: v.weight, aiInstructions: v.aiInstructions })) }));
}

export async function updateCampaignAi(workspaceId: string, id: string, input: z.infer<typeof CampaignAiSchema>, actor: Actor) {
  const c = await getCampaignOr404(workspaceId, id);
  if (!EDITABLE_STATES.includes(c.status)) throw new AppError('CAMPAIGN_STATE', `Cannot edit a ${c.status} campaign`, 409);
  if (input.aiProfileId && !(await db().promptProfile.findFirst({ where: { id: input.aiProfileId, workspaceId, isArchived: false } }))) throw NotFound('Prompt profile');
  if (input.icpId && !(await db().idealCustomerProfile.findFirst({ where: { id: input.icpId, workspaceId } }))) throw NotFound('ICP');
  await db().campaign.update({ where: { id }, data: {
    aiProfileId: input.aiProfileId === undefined ? undefined : input.aiProfileId,
    icpId: input.icpId === undefined ? undefined : input.icpId,
    aiOverrides: input.aiOverrides ? (input.aiOverrides as Prisma.InputJsonValue) : undefined,
    maxAiCostPerLeadUsd: input.maxAiCostPerLeadUsd === undefined ? undefined : input.maxAiCostPerLeadUsd,
    usePregeneratedAi: input.usePregeneratedAi,
  } });
  await invalidateApproval(id);
  await audit(workspaceId, actor, 'campaign.ai_updated', { type: 'campaign', id }, { fields: Object.keys(input) });
  return getCampaign(workspaceId, id);
}

export async function listVersions(workspaceId: string, id: string) {
  await getCampaignOr404(workspaceId, id);
  return db().sequenceVersion.findMany({ where: { campaignId: id, workspaceId }, orderBy: { version: 'desc' }, select: { id: true, version: true, contentHash: true, approvedById: true, createdAt: true, snapshot: true } });
}

/** Load an approved version back into the editable sequence (requires re-approval). */
export async function restoreVersion(workspaceId: string, id: string, version: number, actor: Actor) {
  const c = await getCampaignOr404(workspaceId, id);
  if (c.status === 'RUNNING') throw new AppError('CAMPAIGN_STATE', 'Pause the campaign before restoring an earlier version', 409);
  const v = await db().sequenceVersion.findFirst({ where: { campaignId: id, workspaceId, version } });
  if (!v) throw NotFound('Sequence version');
  const snap = v.snapshot as { steps: z.infer<typeof SequenceSchema>['steps'] };
  await saveSequence(workspaceId, id, SequenceSchema.parse({ steps: snap.steps }), actor);
  await audit(workspaceId, actor, 'campaign.version_restored', { type: 'campaign', id }, { version });
  return getCampaign(workspaceId, id);
}

/** Clone a campaign: settings, sequence, lists, mailboxes and AI configuration — never recipients, sends or approvals. */
export async function duplicateCampaign(workspaceId: string, id: string, name: string | undefined, actor: Actor) {
  const c = await getCampaign(workspaceId, id);
  const settings = CampaignSettingsSchema.parse({ ...campaignSettingsOf(c), name: (name ?? `${c.name} (copy)`).slice(0, 150), scheduledStartAt: null });
  const copy = await createCampaign(workspaceId, settings, actor);
  await saveSequence(workspaceId, copy.id, SequenceSchema.parse({ steps: stepsOf(c) }), actor);
  await db().campaign.update({ where: { id: copy.id }, data: { aiProfileId: c.aiProfileId, icpId: c.icpId, aiOverrides: c.aiOverrides as Prisma.InputJsonValue, maxAiCostPerLeadUsd: c.maxAiCostPerLeadUsd } });
  if (c.lists.length) await setCampaignLists(workspaceId, copy.id, c.lists.map((l) => l.listId), actor);
  if (c.accounts.length) await setCampaignAccounts(workspaceId, copy.id, c.accounts.map((a) => a.emailAccountId), actor);
  await audit(workspaceId, actor, 'campaign.duplicated', { type: 'campaign', id: copy.id }, { from: id });
  return getCampaign(workspaceId, copy.id);
}

/** Render exactly what one lead would receive for a step (template + approved/draft personalization + footer). No AI call. */
export async function previewForLead(workspaceId: string, id: string, leadId: string, stepOrder: number) {
  const c = await getCampaign(workspaceId, id);
  const step = c.sequence?.steps.find((s) => s.order === stepOrder);
  if (!step) throw NotFound('Sequence step');
  const lead = await db().lead.findFirst({ where: { id: leadId, workspaceId }, include: { company: true } });
  if (!lead) throw NotFound('Lead');
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const settings = readSettings(ws.settings);
  const variant = pickVariant(step.variants, variantSeedFor(c.id, lead.id));
  const account = c.accounts[0]?.emailAccount ? await db().emailAccount.findUnique({ where: { id: c.accounts[0].emailAccountId } }) : null;
  const p = step.personalizationMode !== 'TEMPLATE_ONLY' ? await db().leadPersonalization.findUnique({ where: { campaignId_leadId_stepId: { campaignId: c.id, leadId, stepId: step.id } } }) : null;
  let subject = variant.subject; let body = variant.body; let aiFirstLine = '';
  const notes: string[] = [];
  if (step.personalizationMode !== 'TEMPLATE_ONLY') {
    if (p?.body) {
      if (step.personalizationMode === 'AI_FIRST_LINE') aiFirstLine = p.openingLine ?? '';
      else { if (p.subject) subject = p.subject; body = p.body; }
      notes.push(`Personalized content: ${p.status}${p.manuallyEdited ? ' (manually edited)' : ''}, revision ${p.revision}`);
    } else notes.push(`No personalized content yet (${p?.status ?? 'not generated'}); showing the template.`);
  }
  const unsubscribeUrl = `${process.env.APP_URL}/u/preview`;
  const vars = leadVars(lead, { sender: { name: account?.displayName ?? ws.senderLegalName ?? ws.name, email: account?.emailAddress ?? '' }, aiFirstLine, bookingLink: settings.bookingLink ?? '', unsubscribeUrl });
  const s = renderTemplate(subject, vars); const b = renderTemplate(body, vars);
  let text = b.text.trim();
  if (account?.signatureText) text += `\n\n${account.signatureText}`;
  text += buildFooter(ws, unsubscribeUrl);
  return { stepOrder, variant: variant.label, subject: s.text, body: text, missingVariables: [...new Set([...s.missing, ...b.missing])], personalizationStatus: p?.status ?? null, notes, contentProblem: bodyContentProblem(b.text) };
}

export const TestEmailSchema = z.object({ leadId: z.string().uuid(), stepOrder: z.number().int().min(1).max(10), to: z.string().email(), emailAccountId: z.string().uuid().optional() });

/**
 * Send one rendered step to a workspace member's own address. Never to prospects, never counted as a
 * campaign send, no tracking. Restricting the recipient to members stops "test" from becoming a bypass.
 */
export async function sendTestEmail(workspaceId: string, id: string, input: z.infer<typeof TestEmailSchema>, actor: Actor) {
  const to = input.to.toLowerCase();
  const member = await db().workspaceMember.findFirst({ where: { workspaceId, user: { email: to } } });
  if (!member) throw new AppError('FORBIDDEN', 'Test emails can only be sent to the email address of a member of this workspace', 403);
  const c = await getCampaign(workspaceId, id);
  const accountId = input.emailAccountId ?? c.accounts.find((a) => a.emailAccount.status === 'CONNECTED')?.emailAccountId;
  const account = accountId ? await db().emailAccount.findFirst({ where: { id: accountId, workspaceId, status: 'CONNECTED' } }) : null;
  if (!account) throw new AppError('ACCOUNT_NOT_CONNECTED', 'Select a connected mailbox for the test', 400);
  const pv = await previewForLead(workspaceId, id, input.leadId, input.stepOrder);
  if (pv.missingVariables.length) throw BadRequest('UNRESOLVED_VARIABLES', `Missing variables for this lead: ${pv.missingVariables.join(', ')}`);
  if (pv.contentProblem) throw BadRequest('EMPTY_EMAIL', `${pv.contentProblem}. Write the email first.`);
  const messageId = `<test-${randomUUID()}@${account.emailAddress.split('@')[1]}>`;
  await adapters().email[account.provider].send(await getAuth(account.id), {
    from: { address: account.emailAddress, name: account.displayName ?? undefined }, to,
    subject: `[TEST] ${pv.subject || '(no subject — reply step)'}`, text: `${pv.body}\n\n[Test email from Outvexa — campaign "${c.name}", step ${input.stepOrder}, variant ${pv.variant}. Not sent to the prospect.]`,
    messageId, headers: { 'X-EMN-Test': '1' },
  });
  await audit(workspaceId, actor, 'campaign.test_email_sent', { type: 'campaign', id }, { to, leadId: input.leadId, stepOrder: input.stepOrder, mailbox: account.emailAddress });
  return { sent: true, to, subject: `[TEST] ${pv.subject}` };
}
