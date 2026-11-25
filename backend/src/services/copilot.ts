import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { AppError, Forbidden, NotFound } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { hasRole, type Role } from '../../../shared/src/permissions.js';
import { COPILOT_ACTION_TYPES, type CopilotReply } from '../../../shared/src/ai-schemas.js';
import { similarity, firstSentence } from '../../../shared/src/quality.js';
import { neutralizeTags } from '../../../integrations/src/ai/guard.js';
import { runAi } from './ai.js';
import { getConfig } from './ai-studio.js';

// AI Copilot. Reads a bounded, workspace-scoped snapshot of REAL data (no cross-tenant access, no raw
// secrets), answers + recommends, and PROPOSES actions from a fixed allow-list. Proposed actions only run
// when a user whose role permits them confirms. The Copilot cannot send email, start campaigns or change
// providers, billing or security.

const ACTION_ROLES: Record<(typeof COPILOT_ACTION_TYPES)[number], Role> = {
  create_campaign_draft: 'MEMBER', draft_sequence: 'MEMBER', queue_research: 'MEMBER', generate_reply_drafts: 'MEMBER', pause_campaign: 'MANAGER', add_memory: 'ADMIN',
};

/** Deterministic analysis the Copilot can cite: repeated openings/phrases across generated emails. */
export async function repetitiveWording(workspaceId: string, campaignId?: string) {
  const rows = await db().leadPersonalization.findMany({ where: { workspaceId, ...(campaignId ? { campaignId } : {}), body: { not: null } }, select: { openingLine: true, body: true }, take: 300, orderBy: { updatedAt: 'desc' } });
  const openings = rows.map((r) => r.openingLine || firstSentence(r.body ?? '')).filter(Boolean) as string[];
  let nearDup = 0;
  for (let i = 0; i < openings.length; i++) for (let j = i + 1; j < Math.min(openings.length, i + 50); j++) if (similarity(openings[i], openings[j]) >= 0.6) nearDup++;
  const phraseCount = new Map<string, number>();
  for (const r of rows) {
    const w = (r.body ?? '').toLowerCase().match(/[a-z']+/g) ?? [];
    const seen = new Set<string>();
    for (let i = 0; i + 3 < w.length; i++) { const p = w.slice(i, i + 4).join(' '); if (!seen.has(p)) { seen.add(p); phraseCount.set(p, (phraseCount.get(p) ?? 0) + 1); } }
  }
  const top = [...phraseCount.entries()].filter(([, n]) => n >= Math.max(3, rows.length * 0.3)).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([phrase, count]) => ({ phrase, count }));
  return { emailsAnalyzed: rows.length, nearDuplicateOpeningPairs: nearDup, repeatedPhrases: top };
}

async function businessKnowledgeSnapshot(workspaceId: string) {
  const now = new Date();
  const serviceLimit = 20;
  const inactiveVersionLimit = 20;
  const [knowledge, inactiveVersions, services] = await Promise.all([
    getConfig(workspaceId, 'KNOWLEDGE'),
    db().aiConfigVersion.findMany({
      where: { workspaceId, kind: 'KNOWLEDGE', isActive: false },
      orderBy: { version: 'desc' }, take: inactiveVersionLimit + 1,
      select: { id: true, version: true, isActive: true, createdAt: true },
    }),
    db().businessServiceVersion.findMany({
      where: { workspaceId, status: 'APPROVED', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], service: { isArchived: false } },
      orderBy: [{ service: { name: 'asc' } }, { version: 'desc' }, { id: 'asc' }], take: serviceLimit + 1,
      select: {
        id: true, serviceId: true, version: true, status: true, description: true, approvedAt: true, expiresAt: true,
        service: { select: { name: true } },
        targetIndustries: true, excludedIndustries: true, targetGeographies: true, excludedGeographies: true,
        minEmployeeCount: true, maxEmployeeCount: true, targetCustomerProfiles: true, customerProblems: true,
        desiredOutcomes: true, deliverables: true, eligibilityCriteria: true, exclusions: true,
        exclusionRules: true, commercialBoundaries: true,
        proof: {
          where: { workspaceId, status: 'APPROVED_FOR_USE', permittedUse: true, OR: [{ reviewDueAt: null }, { reviewDueAt: { gt: now } }] },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 5,
          select: { id: true, claim: true, description: true, sourceUrl: true, status: true },
        },
      },
    }),
  ]);
  const { data, version, versionId } = knowledge;
  const approvedServices = services.slice(0, serviceLimit);
  return {
    company: data.companyName,
    businessKnowledge: {
      activeVersion: versionId ? { id: versionId, version, isActive: true } : null,
      companyDescription: versionId ? data.description.trim() || null : null,
      targetAudience: versionId ? data.targetAudience.trim() || null : null,
      customerProfiles: versionId ? data.customerProfiles.trim() || null : null,
      commercialOffers: versionId ? data.offers : [],
      approvedServices: approvedServices.map(({ service, proof: _proof, ...entry }) => ({ ...entry, name: service.name })),
      approvedProof: approvedServices.flatMap(({ id, proof }) => proof.map((entry) => ({ ...entry, serviceVersionId: id }))),
      inactiveVersions: inactiveVersions.slice(0, inactiveVersionLimit),
      moreApprovedServices: services.length > serviceLimit,
      moreInactiveVersions: inactiveVersions.length > inactiveVersionLimit,
      interpretation: 'Commercial offers and approved services are separate. Inactive version metadata describes history and is not a source of approved facts. An active version is the source of current company knowledge.',
    },
  };
}

export async function buildSnapshot(workspaceId: string) {
  const since = new Date(Date.now() - 14 * 86400_000);
  const [campaigns, events, replies, pipeline, icps, knowledge, spend, interested, topLeads] = await Promise.all([
    db().campaign.findMany({ where: { workspaceId, status: { not: 'ARCHIVED' } }, select: { id: true, name: true, status: true, createdAt: true }, orderBy: { updatedAt: 'desc' }, take: 15 }),
    db().emailEvent.groupBy({ by: ['campaignId', 'type'], where: { workspaceId }, _count: { _all: true } }),
    db().emailMessage.findMany({ where: { workspaceId, direction: 'INBOUND', isBounce: false, sentAt: { gte: since } }, select: { conversationId: true, category: true, fromAddress: true, subject: true, snippet: true, sentAt: true }, orderBy: { sentAt: 'desc' }, take: 25 }),
    db().opportunity.groupBy({ by: ['stage'], where: { workspaceId }, _count: { _all: true }, _sum: { valueCents: true } }),
    db().idealCustomerProfile.findMany({ where: { workspaceId, isActive: true }, select: { id: true, name: true, minScore: true } }),
    businessKnowledgeSnapshot(workspaceId),
    db().aiExecution.aggregate({ where: { workspaceId, createdAt: { gte: new Date(new Date().setUTCDate(1)) } }, _sum: { costUsd: true } }),
    db().conversation.findMany({ where: { workspaceId, category: { in: ['INTERESTED', 'WANTS_MEETING', 'WANTS_PRICING'] }, lastMessageAt: { gte: since } }, select: { id: true, category: true, subject: true, lead: { select: { email: true, firstName: true, lastName: true } } }, take: 15 }),
    db().lead.findMany({ where: { workspaceId, currentScore: { not: null }, status: { in: ['NEW', 'RESEARCHED', 'QUALIFIED'] }, enrollments: { none: {} } }, select: { id: true, email: true, firstName: true, title: true, currentScore: true, company: { select: { name: true } } }, orderBy: { currentScore: 'desc' }, take: 15 }),
  ]);
  const stat = (cid: string, t: string) => events.find((e) => e.campaignId === cid && e.type === t)?._count._all ?? 0;
  const repetition = await repetitiveWording(workspaceId);
  return {
    ...knowledge, offers: knowledge.businessKnowledge.commercialOffers.map((offer) => offer.name),
    campaigns: campaigns.map((c) => { const sent = stat(c.id, 'SENT'); const rep = stat(c.id, 'REPLIED'); return { id: c.id, name: c.name, status: c.status, sent, replies: rep, replyRatePct: sent ? +(100 * rep / sent).toFixed(1) : null, bouncesHard: stat(c.id, 'BOUNCED_HARD'), unsubscribes: stat(c.id, 'UNSUBSCRIBED'), opensEstimate: stat(c.id, 'OPENED') }; }),
    repliesLast14Days: { total: replies.length, byCategory: replies.reduce<Record<string, number>>((a, r) => { const k = r.category ?? 'UNCLASSIFIED'; a[k] = (a[k] ?? 0) + 1; return a; }, {}), latest: replies.slice(0, 12).map((r) => ({ conversationId: r.conversationId, category: r.category, from: r.fromAddress, subject: r.subject, snippet: neutralizeTags((r.snippet ?? '').slice(0, 160)), at: r.sentAt.toISOString().slice(0, 16) })) },
    interestedConversations: interested.map((c) => ({ conversationId: c.id, category: c.category, subject: c.subject, lead: c.lead ? `${c.lead.firstName ?? ''} ${c.lead.lastName ?? ''} <${c.lead.email}>`.trim() : null })),
    pipeline: pipeline.map((p) => ({ stage: p.stage, count: p._count._all, valueUsd: Number(p._sum.valueCents ?? 0) / 100 })),
    icps, topScoredUncontactedLeads: topLeads.map((l) => ({ id: l.id, email: l.email, name: l.firstName, title: l.title, company: l.company?.name, score: l.currentScore })),
    aiSpendThisMonthUsd: Number(spend._sum.costUsd ?? 0), wordingRepetition: repetition,
  };
}

export async function listThreads(workspaceId: string, userId: string) {
  return db().copilotThread.findMany({ where: { workspaceId, userId }, orderBy: { updatedAt: 'desc' }, take: 50 });
}
export async function getThread(workspaceId: string, userId: string, id: string) {
  const t = await db().copilotThread.findFirst({ where: { id, workspaceId, userId }, include: { messages: { orderBy: { createdAt: 'asc' } }, actions: { orderBy: { createdAt: 'asc' } } } });
  if (!t) throw NotFound('Copilot thread');
  return t;
}

export async function resolveResearchRequest(workspaceId: string, question: string, selection: { leadId?: string; campaignId?: string }) {
  if (!/^(?:please\s+)?(?:research|investigate|look up)\b/i.test(question.trim())) return null;
  const query = question.trim().replace(/^(?:please\s+)?(?:research|investigate|look up)\s*/i, '').replace(/[.!?]+$/, '');
  const rawUrl = query.match(/https?:\/\/[^\s<>]+/i)?.[0];
  const sourceUrl = z.url({ protocol: /^https?$/ }).max(2000).safeParse(rawUrl);
  const email = query.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0].toLowerCase();
  const named = query.replace(/^(?:the prospect|prospect)\s+/i, '').match(/^(.+?)\s+(?:at|from)\s+(.+)$/i);
  const name = (named?.[1] ?? query).replace(/https?:\/\/[^\s<>]+/gi, '').trim().split(/\s+/);
  const [first, ...rest] = name;
  const identityFilter: Prisma.LeadWhereInput | undefined = selection.leadId ? { id: selection.leadId }
    : email ? { emailNormalized: email }
    : name.length > 1 ? {
      firstName: { equals: first, mode: 'insensitive' },
      lastName: { equals: rest.join(' '), mode: 'insensitive' },
      ...(named ? { company: { name: { equals: named[2], mode: 'insensitive' } } } : {}),
    } : undefined;
  if (!identityFilter) return { answer: 'Select a prospect or provide their full name and company.' };
  const matches = await db().lead.findMany({
    where: { workspaceId, ...identityFilter }, take: 2,
    select: { id: true, firstName: true, lastName: true, website: true, linkedinUrl: true, customFields: true,
      company: { select: { name: true, website: true, domain: true } } },
  });
  if (selection.leadId && !matches.length) throw NotFound('Prospect');
  if (matches.length !== 1) return { answer: matches.length ? 'I found multiple matching prospects. Select the prospect or specify their company.' : 'I could not match a saved prospect. Select their record or provide their full name and company.' };
  const lead = matches[0];
  if (selection.campaignId) {
    const { campaignAudience } = await import('./personalization.js');
    if (!(await campaignAudience(workspaceId, selection.campaignId, [lead.id])).includes(lead.id)) throw NotFound('Campaign prospect');
  }
  if (!lead.firstName || !lead.lastName) return { answer: 'The selected prospect is missing a full name. Add the missing name on their record to verify identity.' };
  if (!lead.company?.name && !lead.website && !sourceUrl.success) return { answer: 'The selected prospect has a name. Add their company or company website so I can verify their affiliation.' };
  return { answer: `I found ${lead.firstName} ${lead.lastName}${lead.company?.name ? ` at ${lead.company.name}` : ''}. Confirm to research the saved prospect.`,
    action: { type: 'queue_research' as const, summary: `Research ${lead.firstName} ${lead.lastName}`,
      params: [{ key: 'leadIds', value: lead.id }, ...(selection.campaignId ? [{ key: 'campaignId', value: selection.campaignId }] : []), ...(sourceUrl.success ? [{ key: 'sourceUrl', value: sourceUrl.data }] : [])] } };
}

export async function ask(workspaceId: string, userId: string, role: Role, threadId: string | null, question: string, selection: { leadId?: string; campaignId?: string } = {}) {
  await (await import('./billing.js')).assertEntitled(workspaceId, 'feature:copilot');
  const research = await resolveResearchRequest(workspaceId, question, selection);
  const thread = threadId ? await getThread(workspaceId, userId, threadId) : await db().copilotThread.create({ data: { workspaceId, userId, title: question.slice(0, 80) }, include: { messages: true, actions: true } });
  await db().copilotMessage.create({ data: { workspaceId, threadId: thread.id, role: 'USER', content: question } });
  const reply: CopilotReply = research
    ? { answer: research.answer, recommendations: [], proposedActions: research.action ? [research.action] : [] }
    : await (async () => {
      const [snapshot, memory] = await Promise.all([buildSnapshot(workspaceId), db().copilotMemory.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' }, take: 50 })]);
      const history = thread.messages.slice(-10).map((m) => `${m.role}: ${m.content.slice(0, 1500)}`).join('\n') || '(new conversation)';
      return (await runAi<CopilotReply>(workspaceId, 'COPILOT', {
        memory: memory.map((m) => `- ${m.content}`).join('\n') || '(none)', snapshot: JSON.stringify(snapshot), generatedAt: new Date().toISOString(),
        history: neutralizeTags(history), role, question: neutralizeTags(question),
      }, { entity: { type: 'copilot_thread', id: thread.id } })).data;
    })();
  const msg = await db().copilotMessage.create({ data: { workspaceId, threadId: thread.id, role: 'ASSISTANT', content: reply.answer, data: { recommendations: reply.recommendations } as Prisma.InputJsonValue } });
  const actions = [];
  for (const a of reply.proposedActions) {
    const params = Object.fromEntries(a.params.map((p) => [p.key, p.value]));
    actions.push(await db().copilotAction.create({ data: { workspaceId, threadId: thread.id, type: a.type, params, summary: a.summary.slice(0, 500), requiredRole: ACTION_ROLES[a.type] } }));
  }
  await db().copilotThread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });
  return { threadId: thread.id, messageId: msg.id, answer: reply.answer, recommendations: reply.recommendations, proposedActions: actions.map((a) => ({ ...a, youCanExecute: hasRole(role, a.requiredRole as Role) })) };
}

const P = {
  create_campaign_draft: z.object({ name: z.string().min(1).max(150), audienceContext: z.string().max(5000).default(''), customInstructions: z.string().max(5000).default('') }),
  draft_sequence: z.object({ campaignId: z.string().uuid(), step1: z.string().max(2000).optional(), step2: z.string().max(2000).optional(), step3: z.string().max(2000).optional(), step4: z.string().max(2000).optional() }),
  queue_research: z.object({ leadIds: z.string().max(20000), campaignId: z.uuid().optional(), sourceUrl: z.url({ protocol: /^https?$/ }).max(2000).optional() }),
  generate_reply_drafts: z.object({ conversationIds: z.string().max(20000) }),
  pause_campaign: z.object({ campaignId: z.string().uuid(), reason: z.string().max(300).default('Paused via Copilot') }),
  add_memory: z.object({ content: z.string().min(1).max(2000) }),
};
const ids = (s: string) => [...new Set(s.split(/[\s,]+/).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 200);

/** Execute a proposed action after explicit user confirmation. Atomic claim → never runs twice. */
export async function executeAction(workspaceId: string, actionId: string, role: Role, actor: Actor) {
  const a = await db().copilotAction.findFirst({ where: { id: actionId, workspaceId } });
  if (!a) throw NotFound('Copilot action');
  if (!hasRole(role, a.requiredRole as Role)) throw Forbidden(`This action needs the ${a.requiredRole} role`);
  const claimed = await db().copilotAction.updateMany({ where: { id: actionId, status: 'PROPOSED' }, data: { status: 'EXECUTED', executedById: actor.userId ?? null, executedAt: new Date() } });
  if (!claimed.count) throw new AppError('CONFLICT', `Action is already ${a.status}`, 409);
  try {
    const result = await run(workspaceId, a.type as keyof typeof P, a.params as Record<string, string>, actor);
    await db().copilotAction.update({ where: { id: actionId }, data: { result: result as Prisma.InputJsonValue } });
    await audit(workspaceId, actor, 'copilot.action_executed', { type: 'copilot_action', id: actionId }, { type: a.type });
    return { status: 'EXECUTED', result };
  } catch (e) {
    await db().copilotAction.update({ where: { id: actionId }, data: { status: 'FAILED', result: { error: (e as Error).message } } });
    throw e;
  }
}

async function run(workspaceId: string, type: keyof typeof P, raw: Record<string, string>, actor: Actor) {
  const engine = await import('./engine.js');
  switch (type) {
    case 'create_campaign_draft': {
      const p = P.create_campaign_draft.parse(raw);
      const c = await engine.createCampaign(workspaceId, engine.CampaignSettingsSchema.parse({ name: p.name }), actor);
      await engine.updateCampaignAi(workspaceId, c.id, { aiOverrides: { writing: {}, research: {}, audienceContext: p.audienceContext, offerContext: '', customInstructions: p.customInstructions, aiSource: 'workspace' } }, actor);
      return { campaignId: c.id, status: 'DRAFT', note: 'Draft only — add lists and mailboxes, review and approve it yourself.' };
    }
    case 'draft_sequence': {
      const p = P.draft_sequence.parse(raw);
      const c = await engine.getCampaign(workspaceId, p.campaignId);
      if (!['DRAFT', 'PENDING_APPROVAL'].includes(c.status)) throw new AppError('CAMPAIGN_STATE', 'Copilot only edits draft campaigns', 409);
      const instr = [p.step1, p.step2, p.step3, p.step4].filter((x): x is string => !!x?.trim());
      if (!instr.length) throw new AppError('VALIDATION_FAILED', 'No step instructions proposed', 400);
      await engine.saveSequence(workspaceId, c.id, engine.SequenceSchema.parse({ steps: instr.map((t, i) => ({ delayDays: i === 0 ? 0 : 3, threadMode: i === 0 ? 'NEW_THREAD' : 'REPLY_IN_THREAD', personalizationMode: 'AI_FULL', aiInstructions: t, variants: [{ label: 'A', subject: i === 0 ? 'Quick idea for {{company.name|you}}' : '', body: 'Hi {{firstName|there}},\n\n(AI writes this step for each lead)\n\n{{sender.name}}' }] })) }), actor);
      return { campaignId: c.id, steps: instr.length };
    }
    case 'queue_research': {
      const p = P.queue_research.parse(raw);
      const leads = await db().lead.findMany({ where: { workspaceId, id: { in: ids(p.leadIds) } }, select: { id: true } });
      const intel = await import('./intelligence.js');
      for (const l of leads) await intel.queueResearch(workspaceId, { leadId: l.id, campaignId: p.campaignId, sourceUrl: p.sourceUrl }, { thenScore: true });
      return { queued: leads.length };
    }
    case 'generate_reply_drafts': {
      const p = P.generate_reply_drafts.parse(raw);
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
    }
    case 'pause_campaign': {
      const p = P.pause_campaign.parse(raw);
      return engine.pauseCampaign(workspaceId, p.campaignId, p.reason, actor);
    }
    case 'add_memory': {
      const p = P.add_memory.parse(raw);
      const m = await db().copilotMemory.create({ data: { workspaceId, content: p.content, createdById: actor.userId ?? null } });
      return { memoryId: m.id };
    }
  }
}

export async function rejectAction(workspaceId: string, actionId: string, actor: Actor) {
  const r = await db().copilotAction.updateMany({ where: { id: actionId, workspaceId, status: 'PROPOSED' }, data: { status: 'REJECTED', executedById: actor.userId ?? null, executedAt: new Date() } });
  if (!r.count) throw NotFound('Proposed action');
}

export async function listMemory(workspaceId: string) { return db().copilotMemory.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } }); }
export async function addMemory(workspaceId: string, content: string, actor: Actor) {
  const m = await db().copilotMemory.create({ data: { workspaceId, content, createdById: actor.userId ?? null } });
  await audit(workspaceId, actor, 'copilot.memory_added', { type: 'copilot_memory', id: m.id });
  return m;
}
export async function deleteMemory(workspaceId: string, id: string, actor: Actor) {
  const r = await db().copilotMemory.deleteMany({ where: { id, workspaceId } });
  if (!r.count) throw NotFound('Memory');
  await audit(workspaceId, actor, 'copilot.memory_deleted', { type: 'copilot_memory', id });
}
