import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { queue, QUEUES } from '../core/queues.js';
import { AppError, Forbidden, NotFound } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { hasRole, type Role } from '../../../shared/src/permissions.js';
import { type CopilotReply } from '../../../shared/src/ai-schemas.js';
import { similarity, firstSentence } from '../../../shared/src/quality.js';
import { neutralizeTags, wrapUntrusted } from '../../../integrations/src/ai/guard.js';
import { runAi } from './ai.js';
import { getConfig } from './ai-studio.js';
import { retrieveImportedKnowledge } from './knowledge-import-apply.js';
import { actionRegistry, actionType } from './copilot-tools.js';

// AI Copilot. Reads a bounded, workspace-scoped snapshot of REAL data (no cross-tenant access, no raw
// secrets), answers + recommends, and PROPOSES actions from a fixed allow-list. Proposed actions only run
// when a user whose role permits them confirms. The Copilot cannot send email, start campaigns or change
// providers, billing or security.

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
  const refersToSelection = !query || /^(?:(?:the |this )?(?:selected )?prospect|them|him|her)(?:\s+https?:\/\/\S+)?$/i.test(query);
  const selectedId = refersToSelection ? selection.leadId : undefined;
  const identityFilter: Prisma.LeadWhereInput | undefined = selectedId ? { id: selectedId }
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
  if (selectedId && !matches.length) throw NotFound('Prospect');
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

async function prospectContext(workspaceId: string, leadId?: string) {
  if (!leadId) return null;
  const lead = await db().lead.findFirst({
    where: { id: leadId, workspaceId },
    select: { id: true, firstName: true, lastName: true, title: true, company: { select: { name: true } } },
  });
  if (!lead) return null;
  const intel = await import('./intelligence.js');
  const [report, claims] = await Promise.all([
    db().researchReport.findFirst({
      where: { workspaceId, leadId }, orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, coverage: true, pageCount: true },
    }),
    intel.supportedClaims(workspaceId, leadId),
  ]);
  return { ...lead, report, supportedClaims: claims.slice(0, 12).map(({ text, category }) => ({ text, category })) };
}

export function serializeCopilotSnapshot(snapshot: object) {
  const json = JSON.stringify(snapshot);
  return wrapUntrusted('workspace_snapshot', json, json.length);
}

export async function ask(workspaceId: string, userId: string, role: Role, threadId: string | null, question: string, selection: { leadId?: string; campaignId?: string } = {}, actor?: Actor) {
  await (await import('./billing.js')).assertEntitled(workspaceId, 'feature:copilot');
  const thread = threadId ? await getThread(workspaceId, userId, threadId) : await db().copilotThread.create({ data: { workspaceId, userId, title: question.slice(0, 80) }, include: { messages: true, actions: true } });
  const previousResearch = [...thread.actions].reverse().find(a => a.type === 'queue_research');
  const previousLead = z.object({ leadIds: z.uuid(), campaignId: z.uuid().optional() }).safeParse(previousResearch?.params);
  const selectedLead = selection.leadId ? selection : /^\s*(?:research|investigate|look up)\s+(?:this prospect|the prospect|them|him|her)[.!?]?\s*$/i.test(question) && previousLead.success
    ? { leadId: previousLead.data.leadIds, campaignId: previousLead.data.campaignId }
    : selection;
  const research = await resolveResearchRequest(workspaceId, question, selectedLead);
  const contextLeadId = selection.leadId ?? (previousLead.success ? previousLead.data.leadIds : undefined);
  const autoResearch = !!(actor && research?.action && hasRole(role, actionRegistry.queue_research.role));
  if (research?.action && !hasRole(role, actionRegistry.queue_research.role)) research.answer = 'I found the saved prospect. Starting research requires the Member role.';
  await db().copilotMessage.create({ data: { workspaceId, threadId: thread.id, role: 'USER', content: question } });
  const reply: CopilotReply = research
    ? { answer: research.answer, recommendations: [], proposedActions: research.action && hasRole(role, actionRegistry.queue_research.role) ? [research.action] : [] }
    : await (async () => {
      const [snapshot, memory, selectedProspect, importedKnowledge] = await Promise.all([
        buildSnapshot(workspaceId),
        db().copilotMemory.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' }, take: 50 }),
        prospectContext(workspaceId, contextLeadId),
        retrieveImportedKnowledge(workspaceId, question),
      ]);
      const history = thread.messages.slice(-10).map((m) => `${m.role}: ${m.content.slice(0, 1500)}`).join('\n') || '(new conversation)';
      return (await runAi<CopilotReply>(workspaceId, 'COPILOT', {
        memory: wrapUntrusted('workspace_memory', memory.map((m) => `- ${m.content}`).join('\n') || '(none)'), snapshot: serializeCopilotSnapshot({
          ...snapshot,
          selectedProspect,
          importedKnowledge: importedKnowledge.map(({ text, ...source }) => ({
            ...source, evidence: text,
          })),
          importedKnowledgeInterpretation: 'Use imported items as workspace-approved reference data. Cite the import provenance. Source classification does not independently verify external claims. Recommendations and policy references are guidance.',
          availableActions: Object.entries(actionRegistry).filter(([, tool]) => hasRole(role, tool.role))
            .map(([name, tool]) => ({ name, input: z.toJSONSchema(tool.input), confirmationRequired: true })),
        }), generatedAt: new Date().toISOString(),
        history: wrapUntrusted('conversation_history', history), role, question: neutralizeTags(question),
      }, { entity: { type: 'copilot_thread', id: thread.id } })).data;
    })();
  const actions = [];
  for (const a of reply.proposedActions) {
    const tool = actionRegistry[a.type];
    const params = Object.fromEntries(a.params.map((p) => [p.key, p.value]));
    if (!tool.input.safeParse(params).success) continue;
    actions.push(await db().copilotAction.create({ data: { workspaceId, threadId: thread.id, type: a.type, params, summary: a.summary.slice(0, 500), requiredRole: actionRegistry[a.type].role } }));
  }
  if (autoResearch && actor && actions[0]) {
    try {
      await executeAction(workspaceId, actions[0].id, role, actor);
      actions[0] = await db().copilotAction.findUniqueOrThrow({ where: { id: actions[0].id } });
      reply.answer = 'Research was queued for the saved prospect. Results will appear in Research once the worker finishes.';
    } catch {
      actions[0] = await db().copilotAction.findUniqueOrThrow({ where: { id: actions[0].id } });
      reply.answer = 'Research could not be queued. Check the action status and retry.';
    }
  }
  const msg = await db().copilotMessage.create({ data: { workspaceId, threadId: thread.id, role: 'ASSISTANT', content: reply.answer, data: { recommendations: reply.recommendations } as Prisma.InputJsonValue } });
  await db().copilotThread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });
  return { threadId: thread.id, messageId: msg.id, answer: reply.answer, recommendations: reply.recommendations, proposedActions: actions.map((a) => ({ ...a, youCanExecute: hasRole(role, a.requiredRole as Role) })) };
}

/** Execute a proposed action after explicit user confirmation. Atomic claim → never runs twice. */
export async function executeAction(workspaceId: string, actionId: string, role: Role, actor: Actor) {
  const a = await db().copilotAction.findFirst({ where: { id: actionId, workspaceId, ...(actor.userId ? { thread: { userId: actor.userId } } : {}) } });
  if (!a) throw NotFound('Copilot action');
  if (!actionType(a.type)) throw NotFound('Copilot tool');
  const tool = actionRegistry[a.type];
  if (!hasRole(role, tool.role)) throw Forbidden(`This action needs the ${a.requiredRole} role`);
  const claimed = await db().copilotAction.updateMany({ where: { id: actionId, workspaceId, status: 'PROPOSED', executedAt: null }, data: { executedById: actor.userId ?? null, executedAt: new Date() } });
  if (!claimed.count) throw new AppError('CONFLICT', `Action is already ${a.status === 'PROPOSED' ? 'running' : a.status.toLowerCase()}`, 409);
  try {
    const result = await tool.run(workspaceId, a.params, actor);
    await db().copilotAction.update({ where: { id: actionId }, data: { status: 'EXECUTED', result: result as Prisma.InputJsonValue } });
    await audit(workspaceId, actor, 'copilot.action_executed', { type: 'copilot_action', id: actionId }, { type: a.type });
    return { status: 'EXECUTED', result };
  } catch (e) {
    await db().copilotAction.update({ where: { id: actionId }, data: { status: 'FAILED', result: { error: (e as Error).message } } });
    await audit(workspaceId, actor, 'copilot.action_failed', { type: 'copilot_action', id: actionId }, { type: a.type });
    throw e;
  }
}

export async function rejectAction(workspaceId: string, actionId: string, actor: Actor) {
  const r = await db().copilotAction.updateMany({ where: { id: actionId, workspaceId, status: 'PROPOSED', executedAt: null, ...(actor.userId ? { thread: { userId: actor.userId } } : {}) }, data: { status: 'REJECTED', executedById: actor.userId ?? null, executedAt: new Date() } });
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

export async function researchActionStatus(workspaceId: string, userId: string, actionId: string) {
  const action = await db().copilotAction.findFirst({
    where: { id: actionId, workspaceId, thread: { userId }, type: 'queue_research' },
    select: { result: true },
  });
  if (!action) throw NotFound('Copilot research action');
  const result = z.object({ jobs: z.array(z.string()).max(200) }).safeParse(action.result);
  if (!result.success) return [];
  return Promise.all(result.data.jobs.map(async id => {
    const job = await queue(QUEUES.research).getJob(id);
    if (!job || job.data.workspaceId !== workspaceId) return { id, state: 'unknown', reportId: null, reportStatus: null };
    const reportId = z.uuid().safeParse((job.returnvalue as { reportId?: string } | null)?.reportId);
    const report = reportId.success ? await db().researchReport.findFirst({
      where: { id: reportId.data, workspaceId }, select: { id: true, status: true },
    }) : null;
    return { id, state: await job.getState(), reportId: report?.id ?? null, reportStatus: report?.status ?? null };
  }));
}
