import { z } from 'zod';
import { type Actor } from '../core/audit.js';
import { db } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import { type Role } from '../../../shared/src/permissions.js';
import * as engine from './engine.js';

const P = {
  create_campaign_draft: z.object({ name: z.string().min(1).max(150), audienceContext: z.string().max(5000).default(''), customInstructions: z.string().max(5000).default('') }),
  draft_sequence: z.object({ campaignId: z.string().uuid(), step1: z.string().max(2000).optional(), step2: z.string().max(2000).optional(), step3: z.string().max(2000).optional(), step4: z.string().max(2000).optional() }),
  queue_research: z.object({ leadIds: z.string().max(20000), campaignId: z.uuid().optional(), sourceUrl: z.url({ protocol: /^https?$/ }).max(2000).optional() }),
  generate_reply_drafts: z.object({ conversationIds: z.string().max(20000) }),
  pause_campaign: z.object({ campaignId: z.string().uuid(), reason: z.string().max(300).default('Paused via Copilot') }),
  queue_personalization_drafts: z.object({
    campaignId: z.uuid(),
    leadIds: z.string().min(1).max(750),
    maxCostUsd: z.string().regex(/^\d{1,2}(?:\.\d{1,2})?$/).optional(),
  }),
  create_service_draft: z.object({ name: z.string().trim().min(2).max(160), description: z.string().trim().min(1).max(5000) }),
  update_prospect_title: z.object({ leadId: z.uuid(), title: z.string().trim().min(1).max(200) }),
  add_memory: z.object({ content: z.string().min(1).max(2000) }),
};
const ids = (s: string) => [...new Set(s.split(/[\s,]+/).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 200);

function defineTool<T extends z.ZodType, R>(role: Role, input: T, handler: (workspaceId: string, args: z.output<T>, actor: Actor) => Promise<R>) {
  return {
    role,
    input,
    run: (workspaceId: string, raw: unknown, actor: Actor) => handler(workspaceId, input.parse(raw), actor),
  };
}

export const actionRegistry = {
  create_campaign_draft: defineTool('MEMBER', P.create_campaign_draft, async (workspaceId, p, actor) => {
    const c = await engine.createCampaign(workspaceId, engine.CampaignSettingsSchema.parse({ name: p.name }), actor);
    await engine.updateCampaignAi(workspaceId, c.id, { aiOverrides: { writing: {}, research: {}, audienceContext: p.audienceContext, offerContext: '', customInstructions: p.customInstructions, aiSource: 'workspace' } }, actor);
    return { campaignId: c.id, status: 'DRAFT', note: 'Draft only — add lists and mailboxes, review and approve it yourself.' };
  }),
  draft_sequence: defineTool('MEMBER', P.draft_sequence, async (workspaceId, p, actor) => {
    const c = await engine.getCampaign(workspaceId, p.campaignId);
    if (!['DRAFT', 'PENDING_APPROVAL'].includes(c.status)) throw new AppError('CAMPAIGN_STATE', 'Copilot only edits draft campaigns', 409);
    const instr = [p.step1, p.step2, p.step3, p.step4].filter((x): x is string => !!x?.trim());
    if (!instr.length) throw new AppError('VALIDATION_FAILED', 'No step instructions proposed', 400);
    await engine.saveSequence(workspaceId, c.id, engine.SequenceSchema.parse({ steps: instr.map((t, i) => ({ delayDays: i === 0 ? 0 : 3, threadMode: i === 0 ? 'NEW_THREAD' : 'REPLY_IN_THREAD', personalizationMode: 'AI_FULL', aiInstructions: t, variants: [{ label: 'A', subject: i === 0 ? 'Quick idea for {{company.name|you}}' : '', body: 'Hi {{firstName|there}},\n\n(AI writes this step for each lead)\n\n{{sender.name}}' }] })) }), actor);
    return { campaignId: c.id, steps: instr.length };
  }),
  queue_research: defineTool('MEMBER', P.queue_research, async (workspaceId, p) => {
    const leads = await db().lead.findMany({ where: { workspaceId, id: { in: ids(p.leadIds) } }, select: { id: true } });
    if (!leads.length || leads.length !== ids(p.leadIds).length) throw NotFound('Research prospects');
    const intel = await import('./intelligence.js');
    const jobs = [];
    for (const l of leads) {
      const { jobId } = await intel.queueResearch(workspaceId, { leadId: l.id, campaignId: p.campaignId, sourceUrl: p.sourceUrl });
      if (jobId) jobs.push(jobId);
    }
    return { queued: jobs.length, jobs };
  }),
  generate_reply_drafts: defineTool('MEMBER', P.generate_reply_drafts, async (workspaceId, p) => {
    const convs = await db().conversation.findMany({ where: { workspaceId, id: { in: ids(p.conversationIds) } }, include: { messages: { where: { direction: 'INBOUND' }, orderBy: { sentAt: 'desc' }, take: 1 } } });
    const ra = await import('./reply-assist.js');
    let drafted = 0;
    for (const c of convs) {
      const m = c.messages[0];
      if (!m) continue;
      const existing = await db().replySuggestion.findUnique({ where: { messageId_mode: { messageId: m.id, mode: 'DRAFT' } } });
      if (existing) continue;
      const inbox = await import('./inbox.js');
      const d = await inbox.draftReply(workspaceId, c.id);
      await db().replySuggestion.create({ data: { workspaceId, conversationId: c.id, messageId: m.id, mode: 'DRAFT', category: m.category, body: d.body, reason: ra.commitmentFlags(d.body) } });
      drafted++;
    }
    return { drafted, note: 'Drafts are in the approval queue; nothing was sent.' };
  }),
  pause_campaign: defineTool('MANAGER', P.pause_campaign, async (workspaceId, p, actor) => {
    return engine.pauseCampaign(workspaceId, p.campaignId, p.reason, actor);
  }),
  queue_personalization_drafts: defineTool('MANAGER', P.queue_personalization_drafts, async (workspaceId, p, actor) => {
    const campaign = await engine.getCampaign(workspaceId, p.campaignId);
    if (campaign.status !== 'DRAFT') throw new AppError('CAMPAIGN_STATE', 'Copilot prepares personalization batches for draft campaigns only.', 409);
    const leadIds = ids(p.leadIds);
    if (!leadIds.length || leadIds.length > 20) throw new AppError('VALIDATION_FAILED', 'Select between 1 and 20 prospects.', 400);
    const personalization = await import('./personalization.js');
    if ((await personalization.campaignAudience(workspaceId, campaign.id, leadIds)).length !== leadIds.length) throw NotFound('Campaign prospects');
    const batch = await personalization.createBatch(workspaceId, campaign.id, personalization.BatchSchema.parse({
      leadIds, maxCostUsd: p.maxCostUsd === undefined ? undefined : Number(p.maxCostUsd),
    }), actor);
    return { campaignId: campaign.id, ...batch };
  }),
  create_service_draft: defineTool('ADMIN', P.create_service_draft, async (workspaceId, p, actor) => {
    const kb = await import('./business-knowledge.js');
    const service = await kb.createService(workspaceId, kb.ServiceCreateSchema.parse(p), actor);
    return { serviceId: service.id, versionId: service.versions[0].id, status: 'DRAFT' };
  }),
  update_prospect_title: defineTool('MEMBER', P.update_prospect_title, async (workspaceId, p, actor) => {
    const current = await db().lead.findFirst({ where: { workspaceId, id: p.leadId }, select: { title: true } });
    if (!current) throw NotFound('Lead');
    const { updateLead } = await import('./leads.js');
    const lead = await updateLead(workspaceId, p.leadId, { title: p.title }, actor);
    return { leadId: lead.id, previousTitle: current.title, title: lead.title };
  }),
  add_memory: defineTool('ADMIN', P.add_memory, async (workspaceId, p, actor) => {
    const m = await db().copilotMemory.create({ data: { workspaceId, content: p.content, createdById: actor.userId ?? null } });
    return { memoryId: m.id };
  }),
};

export function actionType(value: string): value is keyof typeof actionRegistry {
  return Object.hasOwn(actionRegistry, value);
}
