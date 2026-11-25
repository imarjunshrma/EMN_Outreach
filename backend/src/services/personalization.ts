import { z } from 'zod';
import { createHash } from 'node:crypto';
import { db, Prisma } from '../core/db.js';
import { sha256 } from '../core/crypto.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit, publish, notifyWorkspace, WORKER_ACTOR, type Actor } from '../core/audit.js';
import { acquireLock } from '../core/redis.js';
import { enqueue, QUEUES } from '../core/queues.js';
import { logger } from '../core/logger.js';
import { wrapUntrusted, neutralizeTags } from '../../../integrations/src/ai/guard.js';
import { instructionText, knowledgeText, KnowledgeSchema, type ResolvedConfig } from '../../../shared/src/ai-studio.js';
import { runQualityChecks, type QualityReport, type FactCheckSentence } from '../../../shared/src/quality.js';
import type { Personalization } from '../../../shared/src/ai-schemas.js';
import { checkRuleTriggerTerms, renderOutreachRules, renderRelevantExamples, retrieveRelevantExamples, type OutreachExampleLike } from '../../../shared/src/outreach-brain.js';
import { filterEligibleServices } from '../../../shared/src/service-eligibility.js';
import { identityFromScoreReason } from '../../../shared/src/identity.js';
import { evaluatePersonalizationGates } from '../../../shared/src/personalization-gates.js';
import { runAi, estimateCallCost, routeLimits } from './ai.js';
import { effectiveSnapshot, resolveFromSnapshot, renderProfilePrompt, configHash, type AiSnapshot } from './ai-studio.js';
import { currentProspectReportIds, factCheck, prospectReportScope } from './intelligence.js';
import { canContact } from './compliance.js';
import { readSettings } from './workspace.js';
import * as outreachBrain from './outreach-brain.js';
import { indexMemoryItems, searchMemory, type MemoryItem } from './intelligence-memory.js';

// =====================================================================================
// Individual prospect personalization engine
//
//   research (evidence-backed claims) + resolved instructions (workspace → profile → campaign →
//   ICP → step → variant → prospect) + business knowledge + previous emails
//     → PERSONALIZATION (AI) → evidence filter → independent FACT_CHECK → deterministic quality checks
//     → LeadPersonalization (current) + PersonalizationRevision (history)
//
// Invariants:
//   * Approved content is frozen: regeneration/editing an APPROVED row requires force and resets approval.
//   * Manually edited content is never overwritten by bulk or automatic generation unless force=true.
//   * The send engine only ever uses APPROVED content whose hash matches; it never calls AI at send time
//     for campaigns using pre-generated personalization, so an AI failure cannot produce a send.
//   * Campaigns that are approved/running use the frozen AI snapshot taken at approval.
// =====================================================================================

export const WAITING_MARKER = 'Waiting for the personalized email to be generated and approved';
const STOP_LEAD_STATUSES = ['UNSUBSCRIBED', 'BOUNCED', 'REPLIED', 'MEETING_BOOKED', 'CUSTOMER', 'NOT_INTERESTED', 'DISQUALIFIED'];

/** Deterministic variant seed so pre-generated content matches the variant the engine will send. */
export function variantSeedFor(campaignId: string, leadId: string): number {
  return parseInt(createHash('sha256').update(`${campaignId}:${leadId}`).digest('hex').slice(0, 8), 16) % 1_000_000;
}

function pickVariant<T extends { label: string; weight: number }>(variants: T[], seed: number): T {
  const sorted = [...variants].sort((a, b) => a.label.localeCompare(b.label));
  const total = sorted.reduce((s, v) => s + v.weight, 0) || 1;
  let x = seed % total;
  for (const v of sorted) { if (x < v.weight) return v; x -= v.weight; }
  return sorted[0];
}

export function contentHashOf(p: { subject: string | null; openingLine: string | null; body: string | null; cta: string | null }) {
  return sha256(JSON.stringify([p.subject ?? '', p.openingLine ?? '', p.body ?? '', p.cta ?? '']));
}

function applyCommercialRelevanceGate(quality: QualityReport, analysis: Personalization['opportunityAnalysis'], selectedServices: AiSnapshot['selectedServices']) {
  const qualified = analysis.qualification === 'STRONG_FIT' || analysis.qualification === 'POSSIBLE_FIT';
  const hasReason = !!analysis.opportunity?.trim() || !!analysis.recommendedApproach?.trim();
  const hasServiceMatch = !!analysis.serviceFit?.trim();
  const evidenceLinked = analysis.facts.some((f) => !!f.claimId) || analysis.inferences.some((i) => i.claimIds.length > 0);
  const allowedService = selectedServices.find((s) => s.serviceVersionId === analysis.serviceVersionId);
  const serviceIsAllowed = selectedServices.length > 0 && !!allowedService && hasServiceMatch && analysis.serviceMatchClaimIds.length > 0;
  const ok = qualified && hasReason && evidenceLinked && serviceIsAllowed;
  quality.checks.push({
    id: 'commercial_relevance', label: 'ICP, opportunity and service relevance', status: ok ? 'pass' : 'fail',
    detail: ok ? `Model assessment: ${analysis.qualification}; matched approved service ${allowedService!.name} v${allowedService!.version} and evidence-linked rationale` : selectedServices.length ? 'No adequate fit, evidence-linked rationale and exact match to a campaign-selected approved service were established' : 'No approved EMN service version is selected for this campaign; service matching is held',
  });
  quality.passed = !quality.checks.some((c) => c.status === 'fail');
  return quality;
}

function stripFooter(body: string | null) { return (body ?? '').split('\n\n--\n')[0].trim(); }

// ------------------------------------------------------------------ evidence

export async function evidenceForLead(workspaceId: string, lead: { id: string; companyId: string | null }, r: ResolvedConfig['research']) {
  const reportIds = await currentProspectReportIds(workspaceId, lead.id, lead.companyId);
  const claims = await db().researchClaim.findMany({
    where: { workspaceId, status: 'SUPPORTED', category: { not: 'opportunity' }, reportId: { in: reportIds }, evidence: { NOT: { url: { startsWith: 'search:' } } } },
    include: { evidence: { select: { id: true, url: true, title: true, sourceType: true, fetchedAt: true } } },
    orderBy: { createdAt: 'desc' }, take: 80,
  });
  const allowed: Record<string, boolean> = { WEBSITE: r.permittedSources.companyWebsite, SEARCH_RESULT: r.permittedSources.webSearch, DATA_PROVIDER: r.permittedSources.dataProvider, USER_PROVIDED: r.permittedSources.userProvided };
  const cutoff = r.maxEvidenceAgeDays ? Date.now() - r.maxEvidenceAgeDays * 86400_000 : 0;
  const seen = new Set<string>();
  const kept = claims.filter((c) => {
    if (!allowed[c.evidence.sourceType]) return false;
    if (c.evidence.fetchedAt.getTime() < cutoff) return false;
    const k = c.text.trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 25);
  const excluded = claims.length - kept.length;
  return { claims: kept, excluded, reportIds: [...new Set(kept.map((c) => c.reportId))] };
}

function claimsBlock(claims: Array<{ id: string; text: string; quote: string; category: string; evidence: { url: string; fetchedAt: Date } }>) {
  if (!claims.length) return '(NO EVIDENCE-BACKED CLAIMS AVAILABLE — do not state any specific fact about the prospect or their company beyond name and title.)';
  return claims.map((c) => `- [${c.id}] (${c.category}) ${c.text}\n  quote: "${c.quote}"\n  source: ${c.evidence.url} (retrieved ${c.evidence.fetchedAt.toISOString().slice(0, 10)})`).join('\n');
}

// ------------------------------------------------------------------ context

type LeadWithCompany = Prisma.LeadGetPayload<{ include: { company: true } }>;

export function promptVars(input: { lead: LeadWithCompany; claimCount: number; summary: string | null; stepOrder: number; campaignName: string; icpName: string | null; senderName: string; ourCompany: string }) {
  const l = input.lead;
  return {
    lead: { firstName: l.firstName ?? '', lastName: l.lastName ?? '', fullName: [l.firstName, l.lastName].filter(Boolean).join(' '), title: l.title ?? '', seniority: (l.customFields as Record<string, unknown>)?.seniority ?? '', city: l.city ?? '', country: l.country ?? '', score: l.currentScore ?? '', custom: l.customFields ?? {} },
    company: { name: l.company?.name ?? '', website: l.company?.website ?? l.website ?? '', industry: l.company?.industry ?? '', size: l.company?.employeeCount ?? '', description: input.claimCount ? l.company?.description ?? '' : '' },
    research: { hasClaims: input.claimCount > 0, claimCount: input.claimCount, summary: input.claimCount ? input.summary ?? '' : '' },
    step: { order: input.stepOrder, isFollowUp: input.stepOrder > 1 },
    campaign: { name: input.campaignName },
    icp: { name: input.icpName ?? '' },
    sender: { name: input.senderName },
    our: { companyName: input.ourCompany },
  };
}

async function loadCampaign(workspaceId: string, campaignId: string) {
  const c = await db().campaign.findFirst({
    where: { id: campaignId, workspaceId },
    include: { sequence: { include: { steps: { orderBy: { order: 'asc' }, include: { variants: { orderBy: { label: 'asc' } } } } } }, accounts: { include: { emailAccount: { select: { displayName: true, emailAddress: true } } } } },
  });
  if (!c) throw NotFound('Campaign');
  return c;
}

export interface BuiltContext {
  vars: Record<string, string>;
  resolved: ResolvedConfig;
  snapshot: AiSnapshot;
  frozen: boolean;
  claims: Awaited<ReturnType<typeof evidenceForLead>>['claims'];
  writerClaimIds: Set<string>;
  excludedClaims: number;
  reportIds: string[];
  previous: Array<{ stepOrder: number; subject: string | null; openingLine: string | null; body: string }>;
  variant: { id: string; label: string; subject: string; body: string; aiInstructions: string | null };
  step: { id: string; order: number; threadMode: string; aiInstructions: string | null; personalizationMode: string };
  profilePrompt: { text: string; missing: string[] };
  hash: string;
  profileFacts: string;
  approvedOfferFacts: Map<string, string>;
  allowedServices: AiSnapshot['selectedServices'];
  serviceEligibilityExcluded: Array<{ serviceVersionId: string; eligible: boolean; reason: string }>;
  retrievedKnowledgeIds: string[];
  retrievedExampleIds: string[];
  qualification: { qualified: boolean; reason: string };
  identity: { verified: boolean; reason: string; claimIds: string[] };
}

export async function buildContext(workspaceId: string, campaign: Awaited<ReturnType<typeof loadCampaign>>, lead: LeadWithCompany, stepId: string): Promise<BuiltContext> {
  const steps = campaign.sequence?.steps ?? [];
  const step = steps.find((s) => s.id === stepId);
  if (!step) throw NotFound('Sequence step');
  const variant = pickVariant(step.variants, variantSeedFor(campaign.id, lead.id));
  const { snapshot, frozen } = await effectiveSnapshot(workspaceId, campaign);
  const resolved = resolveFromSnapshot(snapshot, step, variant, lead);
  const ev = await evidenceForLead(workspaceId, lead, resolved.research);
  const latestScore = await db().leadScore.findFirst({ where: { workspaceId, leadId: lead.id, ...(snapshot.icp ? { icpId: snapshot.icp.id } : {}), icp: { workspaceId, isActive: true } }, orderBy: { createdAt: 'desc' }, select: { qualified: true, reasons: true } });
  const scoreReasons = Array.isArray(latestScore?.reasons) ? latestScore.reasons as Array<Record<string, unknown>> : [];
  const identityReason = scoreReasons.find((r) => r.criterion === 'professional_identity');
  const identity = identityFromScoreReason(
    { firstName: lead.firstName, lastName: lead.lastName, companyName: lead.company?.name },
    identityReason as { met?: boolean; identityStatus?: string; claimIds?: unknown } | undefined,
    ev.claims.map((c) => ({ id: c.id, text: c.quote, category: c.category, sourceType: c.evidence.sourceType })),
  );
  const qualification = {
    qualified: !!latestScore?.qualified,
    reason: !latestScore ? 'No lead qualification score exists; run research and qualification first.' : !latestScore.qualified ? 'The latest ICP qualification decision is not QUALIFIED.' : 'The latest ICP qualification decision is QUALIFIED.',
  };
  const report = ev.reportIds.length ? await db().researchReport.findFirst({ where: { id: { in: ev.reportIds } }, orderBy: { completedAt: 'desc' } }) : null;
  const selectedServices = snapshot.selectedServices ?? [];
  const companyCustom = lead.company?.customFields && typeof lead.company.customFields === 'object' ? lead.company.customFields as Record<string, unknown> : {};
  const leadCustom = lead.customFields && typeof lead.customFields === 'object' ? lead.customFields as Record<string, unknown> : {};
  const asFact = (value: unknown) => typeof value === 'string' ? value : null;
  const businessCategories = Array.isArray(companyCustom.businessCategories) ? companyCustom.businessCategories.filter((x): x is string => typeof x === 'string') : [];
  const serviceEligibility = filterEligibleServices(selectedServices, { industry: lead.company?.industry, country: lead.country ?? lead.company?.country, employeeCount: lead.company?.employeeCount, companyType: asFact(companyCustom.companyType), role: lead.title, seniority: asFact(leadCustom.seniority), businessCategories });
  const allowedServices = serviceEligibility.eligible;
  const knowledgeData = KnowledgeSchema.parse(snapshot.knowledge.data);
  const approvedProfileText = [
    `Company: ${knowledgeData.companyName}`, `Description: ${knowledgeData.description}`, `Website: ${knowledgeData.website}`,
    `Target audience: ${knowledgeData.targetAudience}`, `Customer profiles: ${knowledgeData.customerProfiles}`,
    `Services: ${knowledgeData.services.map((x) => `${x.name}: ${x.description}`).join('; ')}`,
    `Products: ${knowledgeData.products.map((x) => `${x.name}: ${x.description}`).join('; ')}`,
    `Positioning: ${knowledgeData.usps.join('; ')}`,
  ].filter((x) => !x.endsWith(': ')).join('\n');
  const profileMemoryItem: MemoryItem | null = snapshot.knowledge.versionId && approvedProfileText.trim().length >= 40
    ? { entityType: 'KNOWLEDGE_DOCUMENT', entityId: snapshot.knowledge.versionId, content: approvedProfileText, metadata: { kind: 'active_business_profile', version: snapshot.knowledge.version } }
    : null;
  const memoryItems: MemoryItem[] = [
    { entityType: 'LEAD', entityId: lead.id, content: `Professional profile: ${lead.title ?? 'role not listed'} at ${lead.company?.name ?? 'company not listed'}; ${lead.company?.industry ?? 'industry not listed'}; ${lead.country ?? lead.company?.country ?? 'location not listed'}.` },
    ...(lead.company ? [{ entityType: 'COMPANY' as const, entityId: lead.company.id, content: `${lead.company.name}\n${lead.company.industry ?? ''}\n${lead.company.description ?? ''}\nServices: ${lead.company.services.join('; ')}\nAudience: ${lead.company.audience ?? ''}\nBusiness model: ${lead.company.businessModel ?? ''}` }] : []),
    ...(profileMemoryItem ? [profileMemoryItem] : []),
    ...ev.claims.map((c) => ({ entityType: 'RESEARCH_CLAIM' as const, entityId: c.id, content: `${c.text}\nEvidence quote: ${c.quote}\nSource: ${c.evidence.url}`, sourceUrl: c.evidence.url, metadata: { category: c.category, reportId: c.reportId } })),
    ...snapshot.documents.map((d) => ({ entityType: 'KNOWLEDGE_DOCUMENT' as const, entityId: d.id, content: `${d.title}\n${d.text}` })),
    ...allowedServices.map((s) => ({ entityType: 'BUSINESS_SERVICE_VERSION' as const, entityId: s.serviceVersionId, content: `${s.name} v${s.version}\n${s.description}\nProblems: ${s.customerProblems.join('; ')}\nOutcomes: ${s.desiredOutcomes.join('; ')}\nDeliverables: ${s.deliverables.join('; ')}` })),
    ...allowedServices.flatMap((s) => s.proof.map((p) => ({ entityType: 'BUSINESS_PROOF' as const, entityId: p.id, content: p.claim, sourceUrl: p.sourceUrl }))),
    ...snapshot.outreachExamples.map((e) => ({ entityType: 'OUTREACH_EXAMPLE' as const, entityId: e.id, content: `${e.name}\n${e.correctedContent ?? e.content}\n${e.explanation ?? ''}`, metadata: { polarity: e.polarity, category: e.category, humanApproved: true } })),
  ];
  const memoryQuery = `${lead.title ?? ''} ${lead.company?.name ?? ''} ${lead.company?.industry ?? ''}\n${ev.claims.slice(0, 8).map((c) => c.text).join('\n')}`.trim();
  let memoryHits: Awaited<ReturnType<typeof searchMemory>> = [];
  try {
    await indexMemoryItems(workspaceId, memoryItems);
    memoryHits = await searchMemory(workspaceId, memoryQuery, {
      LEAD: [lead.id],
      COMPANY: lead.company ? [lead.company.id] : [],
      RESEARCH_CLAIM: ev.claims.map((c) => c.id),
      KNOWLEDGE_DOCUMENT: [snapshot.knowledge.versionId, ...snapshot.documents.map((d) => d.id)].filter((id): id is string => !!id),
      BUSINESS_SERVICE_VERSION: allowedServices.map((s) => s.serviceVersionId),
      BUSINESS_PROOF: allowedServices.flatMap((s) => s.proof.map((p) => p.id)),
      OUTREACH_EXAMPLE: snapshot.outreachExamples.map((e) => e.id),
    }, 18);
  } catch (error) {
    // Semantic retrieval is an optimization. Existing relational/lexical context stays available.
    logger.warn({ workspaceId, error: (error as Error).message.slice(0, 200) }, 'semantic memory unavailable; using relational context');
  }
  const knowledgeHits = memoryHits.filter((hit) => hit.entityType !== 'LEAD' && hit.entityType !== 'COMPANY');
  const rank = new Map(knowledgeHits.map((hit, i) => [hit.entityId, i]));
  const relevantDocuments = rank.size
    ? [...snapshot.documents].filter((d) => rank.has(d.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!).slice(0, 5)
    : snapshot.documents;
  const promptClaims = rank.size
    ? [...ev.claims].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    : ev.claims;
  const rankedExamples = rank.size
    ? [...snapshot.outreachExamples].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    : snapshot.outreachExamples;
  const approvedOfferFacts = new Map(allowedServices.map((s) => [s.serviceVersionId, [
    `Service ${s.name} v${s.version}: ${s.description}`,
    `Customer problems: ${s.customerProblems.join('; ')}`,
    `Desired outcomes: ${s.desiredOutcomes.join('; ')}`,
    `Deliverables: ${s.deliverables.join('; ')}`,
    `Eligibility: ${s.eligibilityCriteria.join('; ')}`,
    `Exclusions: ${s.exclusions.join('; ')}`,
    `Commercial boundaries: ${s.commercialBoundaries.join('; ')}`,
    `Approved proof: ${s.proof.map((p) => `${p.claim}${p.sourceUrl ? ` (source: ${p.sourceUrl})` : ''}`).join('; ')}`,
  ].join('\n')]));
  const profileFacts = [knowledgeData.companyName, knowledgeData.website, knowledgeData.description].filter(Boolean).join('\n');
  const knowledge = [knowledgeText(knowledgeData, relevantDocuments), ...approvedOfferFacts.values()].join('\n\n');
  const approvedServicesText = allowedServices.length ? allowedServices.map((s) => JSON.stringify({ id: s.serviceVersionId, name: s.name, version: s.version, description: s.description, targetIndustries: s.targetIndustries, targetGeographies: s.targetGeographies, employeeCountBounds: [s.minEmployeeCount, s.maxEmployeeCount], targetCustomerProfiles: s.targetCustomerProfiles, customerProblems: s.customerProblems, desiredOutcomes: s.desiredOutcomes, deliverables: s.deliverables, eligibilityCriteria: s.eligibilityCriteria, exclusions: s.exclusions, commercialBoundaries: s.commercialBoundaries, approvedProof: s.proof })).join('\n') : '(none eligible for this prospect; return no service match and hold)';
  const sender = campaign.accounts[0]?.emailAccount;
  const pv = promptVars({ lead, claimCount: ev.claims.length, summary: report?.summary ?? null, stepOrder: step.order, campaignName: campaign.name, icpName: snapshot.icp?.name ?? null, senderName: sender?.displayName ?? sender?.emailAddress?.split('@')[0] ?? '', ourCompany: knowledgeData.companyName });
  const profilePrompt = snapshot.profile ? renderProfilePrompt(snapshot.profile.instructions, pv) : { text: '(no prompt profile selected — follow the instructions above)', missing: [] };
  const rules = snapshot.outreachRules ?? [];
  const exampleContext = [lead.title, lead.company?.industry, campaign.name, campaign.aiOverrides ? JSON.stringify(campaign.aiOverrides) : '', ev.claims.map((c) => c.text).join(' '), knowledgeData.services.map((s) => `${s.name} ${s.description}`).join(' ')].filter(Boolean).join(' ');
  const examples = retrieveRelevantExamples(rankedExamples as OutreachExampleLike[], exampleContext);

  // Previous emails: what was actually sent wins over drafts.
  const previous: BuiltContext['previous'] = [];
  const earlier = steps.filter((s) => s.order < step.order);
  if (earlier.length) {
    const enrollment = await db().sequenceEnrollment.findUnique({ where: { campaignId_leadId: { campaignId: campaign.id, leadId: lead.id } } });
    const sent = enrollment ? await db().outboundEmail.findMany({ where: { enrollmentId: enrollment.id, status: 'SENT' }, include: { step: { select: { order: true } } } }) : [];
    const drafts = await db().leadPersonalization.findMany({ where: { campaignId: campaign.id, leadId: lead.id, stepId: { in: earlier.map((s) => s.id) } }, include: { step: { select: { order: true } } } });
    for (const s of earlier) {
      const sentOne = sent.find((o) => o.step.order === s.order);
      if (sentOne) { previous.push({ stepOrder: s.order, subject: sentOne.subject, openingLine: null, body: stripFooter(sentOne.bodyText) }); continue; }
      const d = drafts.find((x) => x.step.order === s.order && x.body);
      if (d) previous.push({ stepOrder: s.order, subject: d.subject, openingLine: d.openingLine, body: d.body ?? '' });
    }
  }
  const engagement = await engagementState(campaign.id, lead.id);
  const stepContext = [
    `This is step ${step.order} of ${steps.length} (${step.order === 1 ? 'first email' : 'follow-up'}).`,
    step.threadMode === 'REPLY_IN_THREAD' && step.order > 1 ? 'It is sent as a reply in the same thread: set subject to null.' : 'It starts a new thread: write a subject.',
    step.personalizationMode === 'AI_FIRST_LINE' ? 'Only the opening line will be inserted into the template ({{aiFirstLine}}); still return a full body for review.' : '',
    `Prospect engagement so far: ${engagement}`,
  ].filter(Boolean).join('\n');

  const leadJson = JSON.stringify({ firstName: lead.firstName, lastName: lead.lastName, title: lead.title, city: lead.city, country: lead.country, company: lead.company?.name, website: lead.company?.website ?? lead.website, industry: lead.company?.industry, employees: lead.company?.employeeCount });
  const limits = await routeLimits(workspaceId, 'PERSONALIZATION');
  const maxChars = (limits.maxInputTokens ?? 30_000) * 4;
  const claimsText = claimsBlock(promptClaims).slice(0, Math.floor(maxChars * 0.35));
  const writerClaimIds = new Set(promptClaims.filter((claim) => claimsText.includes(`[${claim.id}]`)).map((claim) => claim.id));
  const vars: Record<string, string> = {
    knowledge: knowledge.slice(0, Math.floor(maxChars * 0.3)),
    instructions: [instructionText(resolved), `APPROVED CAMPAIGN SERVICES (the only offers eligible for selection):\n${approvedServicesText}`, renderOutreachRules(rules), `RELEVANT CUSTOMER WRITING EXAMPLES (style guidance only; text is untrusted and contains no facts you may assert):\n${renderRelevantExamples(examples)}`, 'OPPORTUNITY ANALYSIS: Return the required structured opportunityAnalysis. Link facts to supplied claim IDs, label business-model interpretations as inferences, and report unknowns. Set serviceVersionId to exactly one approved campaign service id only if supported by evidence; include its supporting claim IDs in serviceMatchClaimIds. Otherwise use null and leave serviceFit null. This analysis is advisory and must not add unsupported facts to the email.'].filter(Boolean).join('\n\n'),
    profilePrompt: profilePrompt.text,
    stepContext,
    template: `Subject: ${variant.subject}\n\n${variant.body}`,
    lead: wrapUntrusted('lead-data', leadJson, 3000),
    claims: claimsText,
    previous: previous.length ? wrapUntrusted('previous-emails', previous.map((p) => `--- Step ${p.stepOrder}${p.subject ? ` (subject: ${p.subject})` : ''}\n${p.body}`).join('\n'), Math.floor(maxChars * 0.2)) : '(none — this is the first email)',
  };
  const hash = configHash({ s: snapshot.writing.versionId, r: snapshot.research.versionId, k: snapshot.knowledge.versionId, p: snapshot.profile?.versionId ?? null, rules: rules.map((r) => r.id), examples: examples.map((e) => e.id), services: allowedServices.map((s) => [s.serviceVersionId, s.proof.map((p) => p.id)]), serviceEligibility: serviceEligibility.excluded, c: snapshot.campaign, i: snapshot.icp, st: step.aiInstructions, v: variant.aiInstructions, l: lead.aiInstructions, t: [variant.subject, variant.body] });
  const retrievedKnowledgeIds = [...new Set([
    snapshot.knowledge.versionId, snapshot.writing.versionId, snapshot.research.versionId, snapshot.profile?.versionId,
    ...relevantDocuments.map((d) => d.id), ...snapshot.outreachRules.map((r) => r.id),
    ...allowedServices.flatMap((s) => [s.serviceVersionId, ...s.proof.map((p) => p.id)]),
    ...memoryHits.map((hit) => hit.entityId),
  ].filter((id): id is string => !!id))];
  return { vars, resolved, snapshot, frozen, claims: ev.claims, writerClaimIds, excludedClaims: ev.excluded, reportIds: ev.reportIds, previous, variant, step, profilePrompt, hash, profileFacts, approvedOfferFacts, allowedServices, serviceEligibilityExcluded: serviceEligibility.excluded, retrievedKnowledgeIds, retrievedExampleIds: examples.map((e) => e.id).filter((id): id is string => !!id), qualification, identity };
}

async function engagementState(campaignId: string, leadId: string) {
  const enrollment = await db().sequenceEnrollment.findUnique({ where: { campaignId_leadId: { campaignId, leadId } } });
  if (!enrollment) return 'not yet contacted in this campaign.';
  const [sent, opened] = await Promise.all([
    db().outboundEmail.count({ where: { enrollmentId: enrollment.id, status: 'SENT' } }),
    db().emailEvent.count({ where: { enrollmentId: enrollment.id, type: 'OPENED' } }),
  ]);
  return `${sent} email(s) sent, no reply yet (a reply stops the sequence). Opens: ${opened ? `${opened} estimated open event(s) (unreliable signal; do not mention it)` : 'unknown/none'}.`;
}

// ------------------------------------------------------------------ eligibility

async function stopReason(workspaceId: string, campaign: { id: string; requireVerifiedEmail: boolean }, lead: LeadWithCompany): Promise<string | null> {
  if (STOP_LEAD_STATUSES.includes(lead.status)) return `lead status is ${lead.status}`;
  const enrollment = await db().sequenceEnrollment.findUnique({ where: { campaignId_leadId: { campaignId: campaign.id, leadId: lead.id } } });
  if (enrollment && !['ACTIVE', 'PAUSED'].includes(enrollment.status)) return `sequence stopped (${enrollment.status}${enrollment.stopReason ? `: ${enrollment.stopReason}` : ''})`;
  const ok = await canContact(workspaceId, lead, { requireVerified: campaign.requireVerifiedEmail });
  if (!ok.allowed) return `not contactable: ${ok.reasons.join('; ')}`;
  return null;
}

// ------------------------------------------------------------------ generation

export interface GenerateOptions { force?: boolean; batchId?: string | null; actor?: Actor; note?: string; preview?: boolean }

export async function generateForLead(workspaceId: string, campaignId: string, leadId: string, stepId: string, opts: GenerateOptions = {}) {
  const campaign = await loadCampaign(workspaceId, campaignId);
  const lead = await db().lead.findFirst({ where: { id: leadId, workspaceId }, include: { company: true } });
  if (!lead) throw NotFound('Lead');
  const actor = opts.actor ?? WORKER_ACTOR;

  const existing = opts.preview ? null : await db().leadPersonalization.findUnique({ where: { campaignId_leadId_stepId: { campaignId, leadId, stepId } } });
  if (existing && !opts.force) {
    if (existing.status === 'APPROVED') return { status: 'APPROVED' as const, id: existing.id, preserved: 'approved content is frozen; use force to regenerate' };
    if (existing.manuallyEdited) return { status: existing.status, id: existing.id, preserved: 'manually edited content is preserved; use force to regenerate' };
  }

  const release = opts.preview ? async () => undefined : await acquireLock(`pz:${campaignId}:${leadId}:${stepId}`, 180_000);
  if (!release) return { status: 'GENERATING' as const, id: existing?.id ?? null, preserved: 'generation already in progress' };
  try {
    const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const settings = readSettings(ws.settings);
    const save = async (data: Prisma.LeadPersonalizationUncheckedUpdateInput) => {
      if (opts.preview) return null;
      return db().leadPersonalization.upsert({
        where: { campaignId_leadId_stepId: { campaignId, leadId, stepId } },
        update: data,
        create: { ...(data as Prisma.LeadPersonalizationUncheckedCreateInput), workspaceId, campaignId, leadId, stepId },
      });
    };

    const stop = await stopReason(workspaceId, campaign, lead);
    if (stop) {
      const row = await save({ status: 'SKIPPED', error: `Not generated: ${stop}. Automated follow-ups never continue after a reply, opt-out or other stop condition.`, batchId: opts.batchId ?? undefined });
      return { status: 'SKIPPED' as const, id: row?.id ?? null, reason: stop, gateStatus: { contactability: 'BLOCKED' as const } };
    }

    const ctx = await buildContext(workspaceId, campaign, lead, stepId);
    if (ctx.profilePrompt.missing.length && ctx.snapshot.profile) {
      // Missing variables in the PROMPT are allowed (they render empty) but are reported in quality.
      logger.debug({ missing: ctx.profilePrompt.missing }, 'prompt profile variables missing for lead');
    }
    const mode = ctx.resolved.research.onMissing;
    const researchSatisfied = ctx.claims.length >= ctx.resolved.research.minClaims || mode === 'use_role_and_company_only';
    const gates = evaluatePersonalizationGates({
      contactable: true,
      researchSatisfied,
      identityVerified: ctx.identity.verified,
      qualified: ctx.qualification.qualified,
      serviceEligible: ctx.allowedServices.length > 0,
    });
    if (gates.gates.research === 'BLOCKED') {
      {
        const status = mode === 'skip_lead' ? 'SKIPPED' : 'NEEDS_RESEARCH';
        const msg = `${ctx.claims.length} evidence-backed claim(s) available; ${ctx.resolved.research.minClaims} required. ${mode === 'skip_lead' ? 'Lead skipped by research rules.' : 'Run research for this lead, then generate again.'}${ctx.excludedClaims ? ` (${ctx.excludedClaims} claim(s) excluded by source/age rules.)` : ''}`;
        const row = await save({ status, error: msg, researchReportIds: ctx.reportIds, configHash: ctx.hash, batchId: opts.batchId ?? undefined });
        return { status, id: row?.id ?? null, reason: msg, gateStatus: gates.gates };
      }
    }

    if (gates.gates.identity === 'BLOCKED' || gates.gates.qualification === 'BLOCKED') {
      const failures = [
        ...(gates.gates.identity === 'BLOCKED' ? [{ id: 'verified_identity', label: 'Verified professional identity', detail: ctx.identity.reason }] : []),
        ...(gates.gates.qualification === 'BLOCKED' ? [{ id: 'icp_qualification', label: 'ICP qualification', detail: ctx.qualification.reason }] : []),
      ];
      const reason = `Personalization held: ${failures.map((f) => `${f.label}: ${f.detail}`).join('; ')}`;
      const report = { passed: false, score: 0, checks: failures.map((f) => ({ ...f, status: 'fail' })) };
      const row = await save({ status: 'BLOCKED', error: reason, quality: report as unknown as Prisma.InputJsonValue, qualityPassed: false, researchReportIds: ctx.reportIds, retrievedKnowledgeIds: ctx.retrievedKnowledgeIds, retrievedExampleIds: ctx.retrievedExampleIds, selectedServiceVersionIds: ctx.snapshot.selectedServices.map((s) => s.serviceVersionId), configHash: ctx.hash, batchId: opts.batchId ?? undefined });
      return { status: 'BLOCKED' as const, id: row?.id ?? null, ...(opts.preview ? { preview: true } : {}), reason, quality: report, gateStatus: gates.gates };
    }

    if (gates.gates.serviceEligibility === 'BLOCKED') {
      const reason = ctx.snapshot.selectedServices?.length ? `No selected approved EMN service is eligible for this prospect: ${ctx.serviceEligibilityExcluded.map((x) => x.reason).join('; ')}` : 'No approved EMN service is selected for this campaign. Select an approved service version before generating outreach.';
      const report = { passed: false, score: 0, checks: [{ id: 'approved_service', label: 'Approved service selection', status: 'fail', detail: reason }] };
      const row = await save({ status: 'BLOCKED', error: reason, quality: report as unknown as Prisma.InputJsonValue, qualityPassed: false, researchReportIds: ctx.reportIds, retrievedKnowledgeIds: ctx.retrievedKnowledgeIds, retrievedExampleIds: ctx.retrievedExampleIds, selectedServiceVersionIds: ctx.snapshot.selectedServices.map((s) => s.serviceVersionId), configHash: ctx.hash, batchId: opts.batchId ?? undefined });
      return { status: 'BLOCKED' as const, id: row?.id ?? null, ...(opts.preview ? { preview: true } : {}), reason, quality: report, gateStatus: gates.gates };
    }

    await save({ status: 'GENERATING', error: null, batchId: opts.batchId ?? undefined });
    const maxLead = campaign.maxAiCostPerLeadUsd !== null ? Number(campaign.maxAiCostPerLeadUsd) : settings.aiMaxCostPerLeadUsd;
    const attribution = { campaignId, leadId, profileVersionId: ctx.snapshot.profile?.versionId ?? null };
    const vars = opts.note ? { ...ctx.vars, profilePrompt: `${ctx.vars.profilePrompt}\n\nOne-off note for this regeneration: ${neutralizeTags(opts.note).slice(0, 1000)}` } : ctx.vars;
    const executionIds: string[] = [];
    let out: Personalization;
    try {
      const r = await runAi<Personalization>(workspaceId, 'PERSONALIZATION', vars, { entity: { type: 'lead_personalization', id: `${campaignId}:${leadId}:${stepId}` }, attribution, maxLeadCostUsd: maxLead });
      executionIds.push(r.executionId);
      out = r.data;
    } catch (e) {
      const err = e as AppError;
      const status = err.code === 'AI_COST_LIMIT' || err.code === 'AI_BUDGET_EXCEEDED' ? 'SKIPPED' : 'FAILED';
      const row = await save({ status, error: `${err.code ?? 'ERROR'}: ${err.message}`.slice(0, 1000) });
      if (opts.preview) throw e;
      return { status, id: row?.id ?? null, reason: err.message, code: err.code };
    }

    const others = opts.preview ? [] : await db().leadPersonalization.findMany({ where: { campaignId, stepId, leadId: { not: leadId }, openingLine: { not: null } }, select: { openingLine: true }, take: 300, orderBy: { updatedAt: 'desc' } });
    const evaluate = async (out: Personalization) => {
      // Evidence filter: only claims that were actually supplied to the writer count.
      const valid = new Map(ctx.claims.filter((c) => ctx.writerClaimIds.has(c.id)).map((c) => [c.id, c]));
      const usedClaims = out.usedClaimIds.filter((id) => valid.has(id)).map((id) => valid.get(id)!);
      const invalidClaimIds = out.usedClaimIds.filter((id) => !valid.has(id));
      const opp = out.opportunityAnalysis;
      const supportedIds = ctx.writerClaimIds;
      const opportunityAnalysis = {
        ...opp,
        serviceVersionId: ctx.allowedServices.some((s) => s.serviceVersionId === opp.serviceVersionId) ? opp.serviceVersionId : null,
        serviceMatchClaimIds: opp.serviceMatchClaimIds.filter((id) => supportedIds.has(id)),
        businessModel: opp.businessModel.basis === 'UNKNOWN' || !opp.businessModel.claimIds.length || !opp.businessModel.claimIds.every((id) => supportedIds.has(id))
          ? { statement: null, basis: 'UNKNOWN' as const, claimIds: [] }
          : opp.businessModel,
        facts: opp.facts.filter((f) => supportedIds.has(f.claimId)),
        inferences: opp.inferences.filter((i) => i.claimIds.length > 0 && i.claimIds.every((id) => supportedIds.has(id))),
        ...(ctx.claims.length ? {} : { qualification: 'INSUFFICIENT_INFORMATION' as const, confidence: 0, opportunity: null, serviceFit: null, recommendedApproach: null, unknowns: [...new Set([...opp.unknowns, 'No evidence-backed prospect claims were available.'])] }),
      };
      if (!opportunityAnalysis.serviceVersionId || !opportunityAnalysis.serviceMatchClaimIds.length) opportunityAnalysis.serviceFit = null;
      const subject = ctx.step.threadMode === 'REPLY_IN_THREAD' && ctx.step.order > 1 ? null : (out.subject?.trim() || null);
      const body = out.body.trim();
      const openingLine = out.openingLine?.trim() || null;

      let fcSentences: FactCheckSentence[] | null = null;
      const factCheckRequired = true;
      try {
        const offerFacts = ctx.approvedOfferFacts.get(opportunityAnalysis.serviceVersionId ?? '');
        const fc = await factCheck(workspaceId, leadId, [...new Set([subject, openingLine, body, out.cta].filter(Boolean))].join('\n'), [ctx.profileFacts, offerFacts].filter(Boolean).join('\n\n'), { claims: ctx.claims, attribution, maxLeadCostUsd: maxLead });
        executionIds.push(fc.executionId);
        fcSentences = fc.sentences;
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'fact-check failed during personalization');
      }

      const quality = runQualityChecks({
        subject, openingLine, body, stepOrder: ctx.step.order, newThread: ctx.step.threadMode === 'NEW_THREAD' || ctx.step.order === 1,
        writing: ctx.resolved.writing, usedClaims, invalidClaimIds, availableClaimCount: ctx.claims.length,
        previousEmails: ctx.previous, otherLeadOpenings: others.map((o) => o.openingLine!),
        factCheck: fcSentences, factCheckRequired, postalAddressConfigured: !!ws.postalAddress?.trim(), insufficientContext: out.insufficientContext,
      });
      applyCommercialRelevanceGate(quality, opportunityAnalysis, ctx.allowedServices);
      const ruleChecks = checkRuleTriggerTerms(ctx.snapshot.outreachRules ?? [], `${subject ?? ''}\n${openingLine ?? ''}\n${body}\n${out.cta ?? ''}`);
      quality.checks.push(...ruleChecks);
      if (ruleChecks.some((c) => c.status === 'fail')) quality.passed = false;
      return { out, subject, openingLine, body, usedClaims, opportunityAnalysis, fcSentences, quality };
    };

    let evaluated = await evaluate(out);
    let rewriteAttempted = false;
    if (!evaluated.quality.passed && evaluated.fcSentences?.length) {
      rewriteAttempted = true;
      const feedback = evaluated.quality.checks.filter((check) => check.status === 'fail')
        .map((check) => `${check.label}: ${check.detail}`).join('\n');
      try {
        const rewrite = await runAi<Personalization>(workspaceId, 'PERSONALIZATION', {
          ...vars,
          instructions: `${vars.instructions}\n\nRewrite once using the original approved offer and evidence. Address the following evaluation findings.\n${wrapUntrusted('evaluation', feedback, 2500)}`,
        }, { entity: { type: 'lead_personalization', id: `${campaignId}:${leadId}:${stepId}` }, attribution, maxLeadCostUsd: maxLead });
        executionIds.push(rewrite.executionId);
        evaluated = await evaluate(rewrite.data);
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'controlled personalization rewrite failed');
      }
    }
    const { subject, openingLine, body, usedClaims, opportunityAnalysis, fcSentences, quality } = evaluated;
    out = evaluated.out;
    const costAgg = await db().aiExecution.aggregate({ where: { id: { in: executionIds } }, _sum: { costUsd: true } });
    const unpriced = await db().aiExecution.count({ where: { id: { in: executionIds }, costIsEstimate: true } });
    const cost = Number(costAgg._sum.costUsd ?? 0);
    const citedIds = new Set([...usedClaims.map((claim) => claim.id), ...opportunityAnalysis.serviceMatchClaimIds, ...(fcSentences ?? []).flatMap((sentence) => sentence.claimId ? [sentence.claimId] : [])]);
    const selectedServiceVersionIds = opportunityAnalysis.serviceVersionId ? [opportunityAnalysis.serviceVersionId] : [];
    const provenance = { retrievedKnowledgeIds: ctx.retrievedKnowledgeIds, retrievedExampleIds: ctx.retrievedExampleIds,
      researchEvidenceIds: [...new Set(ctx.claims.filter((claim) => citedIds.has(claim.id)).map((claim) => claim.evidence.id))], selectedServiceVersionIds };
    const explanation = { rewriteAttempted, decision: quality.passed ? 'PASS' : 'HOLD', factors: quality.scoreExplanation, disclaimer: quality.scoreDisclaimer, basis: out.personalizationBasis, opportunityAnalysis, factCheck: fcSentences, provenance, model: null as string | null, frozenConfig: ctx.frozen, missingPromptVariables: ctx.profilePrompt.missing };

    if (opts.preview) {
      return { status: quality.passed ? 'GENERATED' : 'BLOCKED', preview: true, subject, subjectAlternatives: out.subjectAlternatives, openingLine, body, cta: out.cta, usedClaims: usedClaims.map((c) => ({ id: c.id, text: c.text, url: c.evidence.url, fetchedAt: c.evidence.fetchedAt })), opportunityAnalysis, quality, costUsd: cost, costIsEstimate: unpriced > 0, prompt: { profile: ctx.profilePrompt.text, instructions: ctx.vars.instructions }, explanation };
    }

    const prev = await db().leadPersonalization.findUniqueOrThrow({ where: { campaignId_leadId_stepId: { campaignId, leadId, stepId } } });
    const revision = prev.revision + 1;
    // Model output is never its own approval. Passing quality checks is necessary but not
    // sufficient; a human must explicitly approve this revision before send preparation.
    const content = { subject, openingLine, body, cta: out.cta?.trim() || null };
    const row = await db().$transaction(async (tx) => {
      const r = await tx.leadPersonalization.update({
        where: { id: prev.id },
        data: {
          ...content, variantId: ctx.variant.id, subjectAlternatives: out.subjectAlternatives.slice(0, 5), usedClaimIds: usedClaims.map((c) => c.id), researchReportIds: ctx.reportIds, retrievedKnowledgeIds: ctx.retrievedKnowledgeIds, retrievedExampleIds: ctx.retrievedExampleIds, selectedServiceVersionIds,
          quality: quality as unknown as Prisma.InputJsonValue, qualityPassed: quality.passed, score: quality.score, scoreExplanation: explanation as unknown as Prisma.InputJsonValue,
          costUsd: { increment: cost }, costIsEstimate: unpriced > 0, status: quality.passed ? 'GENERATED' : 'BLOCKED',
          manuallyEdited: false, editedById: null, editedAt: null,
          approvedById: null, approvedAt: null, approvedContentHash: null,
          configHash: ctx.hash, profileVersionId: ctx.snapshot.profile?.versionId ?? null, revision, error: null, generatedAt: new Date(),
        },
      });
      await tx.personalizationRevision.create({ data: { workspaceId, personalizationId: r.id, revision, source: 'AI', ...content, usedClaimIds: r.usedClaimIds, retrievedKnowledgeIds: ctx.retrievedKnowledgeIds, retrievedExampleIds: ctx.retrievedExampleIds, selectedServiceVersionIds, quality: quality as unknown as Prisma.InputJsonValue, score: quality.score, costUsd: cost, executionIds, createdById: actor.userId ?? null } });
      return r;
    });
    await publish(workspaceId, 'personalization.updated', { campaignId, leadId, stepId, status: row.status });
    return { status: row.status, id: row.id, revision, quality, costUsd: cost };
  } finally {
    await release();
  }
}

// ------------------------------------------------------------------ review actions

export const EditSchema = z.object({
  subject: z.string().max(300).nullable().optional(),
  openingLine: z.string().max(1000).nullable().optional(),
  body: z.string().min(1).max(10000).optional(),
  cta: z.string().max(1000).nullable().optional(),
  rerunFactCheck: z.boolean().default(true),
  feedbackNote: z.string().max(1000).optional(),
  feedbackScope: z.enum(['GLOBAL', 'CAMPAIGN', 'PROSPECT', 'FACTUAL']).default('CAMPAIGN'),
});

export async function getPersonalization(workspaceId: string, id: string) {
  const p = await db().leadPersonalization.findFirst({
    where: { id, workspaceId },
    include: { lead: { include: { company: true } }, step: { select: { id: true, order: true, threadMode: true, personalizationMode: true } }, variant: { select: { label: true, subject: true, body: true } }, revisions: { orderBy: { revision: 'desc' }, take: 20 }, campaign: { select: { id: true, name: true, status: true } } },
  });
  if (!p) throw NotFound('Personalization');
  const claims = p.usedClaimIds.length ? await db().researchClaim.findMany({ where: { workspaceId, id: { in: p.usedClaimIds } }, include: { evidence: { select: { url: true, title: true, fetchedAt: true, sourceType: true } } } }) : [];
  return { ...p, usedClaims: claims, contentHashMatches: p.status === 'APPROVED' ? p.approvedContentHash === contentHashOf(p) : null };
}

/** Everything a reviewer needs for one lead: research, evidence, every step's generated email, warnings, cost. */
export async function leadReview(workspaceId: string, campaignId: string, leadId: string) {
  const campaign = await loadCampaign(workspaceId, campaignId);
  const lead = await db().lead.findFirst({ where: { id: leadId, workspaceId }, include: { company: true } });
  if (!lead) throw NotFound('Lead');
  const rows = await db().leadPersonalization.findMany({ where: { campaignId, leadId }, include: { step: { select: { order: true } }, variant: { select: { label: true } } }, orderBy: { step: { order: 'asc' } } });
  const { snapshot } = await effectiveSnapshot(workspaceId, campaign);
  const research = resolveFromSnapshot(snapshot, null, null).research;
  const ev = await evidenceForLead(workspaceId, lead, research);
  const reports = await db().researchReport.findMany({ where: { workspaceId, ...prospectReportScope(leadId, lead.companyId) }, orderBy: { createdAt: 'desc' }, take: 5, include: { evidence: { select: { id: true, url: true, title: true, sourceType: true, fetchedAt: true } } } });
  const cost = await db().aiExecution.aggregate({ where: { workspaceId, campaignId, leadId }, _sum: { costUsd: true } });
  return {
    lead, steps: (campaign.sequence?.steps ?? []).map((s) => ({ id: s.id, order: s.order, personalizationMode: s.personalizationMode, threadMode: s.threadMode })),
    personalizations: rows.map((r) => ({ ...r, contentHashMatches: r.status === 'APPROVED' ? r.approvedContentHash === contentHashOf(r) : null })),
    research: { claims: ev.claims.map((c) => ({ id: c.id, text: c.text, quote: c.quote, category: c.category, confidence: c.confidence, url: c.evidence.url, title: c.evidence.title, fetchedAt: c.evidence.fetchedAt, sourceType: c.evidence.sourceType })), excludedByRules: ev.excluded, reports: reports.map((r) => ({ id: r.id, status: r.status, summary: r.summary, error: r.error, createdAt: r.createdAt, completedAt: r.completedAt, sources: r.evidence })) },
    aiCostUsd: Number(cost._sum.costUsd ?? 0),
  };
}

export async function editPersonalization(workspaceId: string, id: string, input: z.infer<typeof EditSchema>, actor: Actor) {
  const p = await db().leadPersonalization.findFirst({ where: { id, workspaceId }, include: { campaign: true, step: true, lead: { include: { company: true } } } });
  if (!p) throw NotFound('Personalization');
  const content = {
    subject: input.subject !== undefined ? input.subject : p.subject,
    openingLine: input.openingLine !== undefined ? input.openingLine : p.openingLine,
    body: input.body ?? p.body ?? '',
    cta: input.cta !== undefined ? input.cta : p.cta,
  };
  const campaign = await loadCampaign(workspaceId, p.campaignId);
  const generatedRevision = await db().personalizationRevision.findFirst({ where: { workspaceId, personalizationId: p.id, source: 'AI' }, orderBy: { revision: 'desc' } });
  const ctx = await buildContext(workspaceId, campaign, p.lead, p.stepId);
  const priorAnalysis = (p.scoreExplanation as { opportunityAnalysis?: Personalization['opportunityAnalysis'] } | null)?.opportunityAnalysis;
  const offerFacts = ctx.approvedOfferFacts.get(priorAnalysis?.serviceVersionId ?? '');
  let fc: FactCheckSentence[] | null = null;
  const executionIds: string[] = [];
  {
    try {
      const ws0 = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
      const maxLead = p.campaign.maxAiCostPerLeadUsd !== null ? Number(p.campaign.maxAiCostPerLeadUsd) : readSettings(ws0.settings).aiMaxCostPerLeadUsd;
      const r = await factCheck(workspaceId, p.leadId, [...new Set([content.subject, content.openingLine, content.body, content.cta].filter(Boolean))].join('\n'), [ctx.profileFacts, offerFacts].filter(Boolean).join('\n\n'), { claims: ctx.claims, attribution: { campaignId: p.campaignId, leadId: p.leadId }, maxLeadCostUsd: maxLead });
      fc = r.sentences; executionIds.push(r.executionId);
    } catch (e) { logger.warn({ err: (e as Error).message }, 'fact-check after edit failed'); }
  }
  const valid = new Map(ctx.claims.map((c) => [c.id, c]));
  const usedClaims = p.usedClaimIds.filter((cid) => valid.has(cid)).map((cid) => valid.get(cid)!);
  const others = await db().leadPersonalization.findMany({ where: { campaignId: p.campaignId, stepId: p.stepId, leadId: { not: p.leadId }, openingLine: { not: null } }, select: { openingLine: true }, take: 300 });
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const quality = runQualityChecks({
    ...content, stepOrder: p.step.order, newThread: p.step.threadMode === 'NEW_THREAD' || p.step.order === 1, writing: ctx.resolved.writing,
    usedClaims, invalidClaimIds: [], availableClaimCount: ctx.claims.length, previousEmails: ctx.previous, otherLeadOpenings: others.map((o) => o.openingLine!),
    factCheck: fc, factCheckRequired: true, postalAddressConfigured: !!ws.postalAddress?.trim(),
  });
  if (priorAnalysis) applyCommercialRelevanceGate(quality, {
    ...priorAnalysis,
    serviceMatchClaimIds: priorAnalysis.serviceMatchClaimIds.filter((claimId) => valid.has(claimId)),
    facts: priorAnalysis.facts.filter((fact) => valid.has(fact.claimId)),
    inferences: priorAnalysis.inferences.filter((inference) => inference.claimIds.every((claimId) => valid.has(claimId))),
  }, ctx.allowedServices);
  else {
    quality.checks.push({ id: 'commercial_relevance', label: 'ICP, opportunity and service relevance', status: 'fail', detail: 'Opportunity and service match must be regenerated and reviewed before this email can be approved' });
    quality.passed = false;
  }
  const ruleChecks = checkRuleTriggerTerms(ctx.snapshot.outreachRules ?? [], `${content.subject ?? ''}\n${content.openingLine ?? ''}\n${content.body}\n${content.cta ?? ''}`);
  quality.checks.push(...ruleChecks);
  if (ruleChecks.some((c) => c.status === 'fail')) quality.passed = false;
  const revision = p.revision + 1;
  const prevExplanation = (p.scoreExplanation ?? {}) as Record<string, unknown>;
  const row = await db().$transaction(async (tx) => {
    const r = await tx.leadPersonalization.update({
      where: { id: p.id },
      data: { ...content, manuallyEdited: true, editedById: actor.userId ?? null, editedAt: new Date(), quality: quality as unknown as Prisma.InputJsonValue, qualityPassed: quality.passed, score: quality.score, scoreExplanation: { ...prevExplanation, factors: quality.scoreExplanation, disclaimer: quality.scoreDisclaimer, factCheck: fc } as unknown as Prisma.InputJsonValue, status: quality.passed ? 'GENERATED' : 'BLOCKED', approvedById: null, approvedAt: null, approvedContentHash: null, revision },
    });
    await tx.personalizationRevision.create({ data: { workspaceId, personalizationId: p.id, revision, source: 'MANUAL', ...content, usedClaimIds: p.usedClaimIds, retrievedKnowledgeIds: p.retrievedKnowledgeIds, retrievedExampleIds: p.retrievedExampleIds, selectedServiceVersionIds: p.selectedServiceVersionIds, quality: quality as unknown as Prisma.InputJsonValue, score: quality.score, executionIds, createdById: actor.userId ?? null } });
    return r;
  });
  await audit(workspaceId, actor, 'personalization.edited', { type: 'personalization', id }, { revision, wasApproved: p.status === 'APPROVED' });
  await outreachBrain.recordFeedback(workspaceId, id, 'EDITED', { subject: generatedRevision?.subject ?? p.subject, openingLine: generatedRevision?.openingLine ?? p.openingLine, body: generatedRevision?.body ?? p.body, cta: generatedRevision?.cta ?? p.cta }, content, actor, input.feedbackNote, input.feedbackScope).catch((e) => logger.warn({ err: (e as Error).message }, 'could not save AI learning feedback'));
  return { status: row.status, revision, quality };
}

export async function approvePersonalizations(workspaceId: string, ids: string[], actor: Actor) {
  const rows = await db().leadPersonalization.findMany({ where: { workspaceId, id: { in: ids } } });
  if (rows.length !== new Set(ids).size) throw NotFound('Personalization');
  const approved: string[] = [];
  const refused: Array<{ id: string; reason: string }> = [];
  for (const r of rows) {
    if (r.status === 'APPROVED') { approved.push(r.id); continue; }
    if (!['GENERATED', 'BLOCKED'].includes(r.status) || !r.body) { refused.push({ id: r.id, reason: `status ${r.status}` }); continue; }
    if (!r.qualityPassed) { refused.push({ id: r.id, reason: 'failing quality checks — edit or regenerate first' }); continue; }
    if ((r.quality as { policyVersion?: number } | null)?.policyVersion !== 2) {
      refused.push({ id: r.id, reason: 'quality policy changed — regenerate or revalidate this email before approval' }); continue;
    }
    await db().leadPersonalization.update({ where: { id: r.id }, data: { status: 'APPROVED', approvedById: actor.userId ?? null, approvedAt: new Date(), approvedContentHash: contentHashOf(r) } });
    await outreachBrain.recordFeedback(workspaceId, r.id, 'APPROVED', { subject: r.subject, openingLine: r.openingLine, body: r.body, cta: r.cta }, { subject: r.subject, openingLine: r.openingLine, body: r.body, cta: r.cta }, actor).catch((e) => logger.warn({ err: (e as Error).message }, 'could not save AI approval feedback'));
    await releaseWaitingOutbound(workspaceId, r.campaignId, r.leadId, r.stepId);
    approved.push(r.id);
  }
  if (approved.length) await audit(workspaceId, actor, 'personalization.approved', { type: 'campaign', id: rows[0].campaignId }, { count: approved.length });
  if (ids.length === 1 && refused.length) throw new AppError('QUALITY_CHECK_FAILED', `Cannot approve: ${refused[0].reason}`, 400, refused);
  return { approved: approved.length, refused };
}

export async function rejectPersonalization(workspaceId: string, id: string, reason: string, actor: Actor, reasonCode: import('./outreach-brain.js').FeedbackReasonCode = 'OTHER') {
  const r = await db().leadPersonalization.findFirst({ where: { id, workspaceId } });
  if (!r) throw NotFound('Personalization');
  await db().leadPersonalization.update({ where: { id }, data: { status: 'REJECTED', error: reason.slice(0, 500), approvedById: null, approvedAt: null, approvedContentHash: null } });
  await outreachBrain.recordFeedback(workspaceId, id, 'REJECTED', { subject: r.subject, openingLine: r.openingLine, body: r.body, cta: r.cta }, { subject: r.subject, openingLine: r.openingLine, body: r.body, cta: r.cta }, actor, reason, 'CAMPAIGN', reasonCode).catch((e) => logger.warn({ err: (e as Error).message }, 'could not save AI rejection feedback'));
  await audit(workspaceId, actor, 'personalization.rejected', { type: 'personalization', id }, { reason });
}

/** Re-queue outbound emails that were waiting for this personalization. Idempotent: prepare only acts on PENDING. */
export async function releaseWaitingOutbound(workspaceId: string, campaignId: string, leadId: string, stepId: string) {
  const waiting = await db().outboundEmail.findMany({ where: { workspaceId, campaignId, stepId, status: 'AWAITING_APPROVAL', lastError: WAITING_MARKER, enrollment: { leadId } } });
  for (const o of waiting) {
    const r = await db().outboundEmail.updateMany({ where: { id: o.id, status: 'AWAITING_APPROVAL' }, data: { status: 'PENDING', approvalStatus: 'NOT_REQUIRED', lastError: null } });
    if (r.count) await enqueue(QUEUES.prepare, 'outbound.prepare', { workspaceId, outboundId: o.id }, { jobId: `prepare-${o.id}-pz-${Date.now()}` });
  }
  return waiting.length;
}

// ------------------------------------------------------------------ listing

export const ListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(['QUEUED', 'GENERATING', 'NEEDS_RESEARCH', 'GENERATED', 'BLOCKED', 'APPROVED', 'REJECTED', 'FAILED', 'SKIPPED']).optional(),
  stepId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
});

export async function listForCampaign(workspaceId: string, campaignId: string, q: z.infer<typeof ListSchema>) {
  await loadCampaign(workspaceId, campaignId);
  const where: Prisma.LeadPersonalizationWhereInput = { workspaceId, campaignId, ...(q.status ? { status: q.status } : {}), ...(q.stepId ? { stepId: q.stepId } : {}), ...(q.q ? { lead: { OR: [{ emailNormalized: { contains: q.q.toLowerCase() } }, { firstName: { contains: q.q, mode: 'insensitive' } }, { lastName: { contains: q.q, mode: 'insensitive' } }] } } : {}) };
  const [items, total, byStatus, cost] = await Promise.all([
    db().leadPersonalization.findMany({ where, orderBy: [{ updatedAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true, leadId: true, stepId: true, status: true, subject: true, openingLine: true, score: true, qualityPassed: true, quality: true, costUsd: true, costIsEstimate: true, manuallyEdited: true, revision: true, error: true, configHash: true, updatedAt: true, lead: { select: { id: true, email: true, firstName: true, lastName: true, title: true, company: { select: { name: true } } } }, step: { select: { order: true } }, variant: { select: { label: true } } } }),
    db().leadPersonalization.count({ where }),
    db().leadPersonalization.groupBy({ by: ['status'], where: { workspaceId, campaignId }, _count: { _all: true } }),
    db().aiExecution.aggregate({ where: { workspaceId, campaignId }, _sum: { costUsd: true } }),
  ]);
  return {
    items: items.map((i) => ({ ...i, warnings: ((i.quality as unknown as QualityReport | null)?.checks ?? []).filter((c) => c.status !== 'pass').map((c) => `${c.label}: ${c.detail}`), quality: undefined })),
    total,
    summary: { byStatus: Object.fromEntries(byStatus.map((b) => [b.status, b._count._all])), aiCostUsd: Number(cost._sum.costUsd ?? 0) },
  };
}

// ------------------------------------------------------------------ audience, estimates and batches

export async function campaignAudience(workspaceId: string, campaignId: string, leadIds?: string[]) {
  const lists = await db().campaignList.findMany({ where: { workspaceId, campaignId } });
  const members = await db().leadListMember.findMany({ where: { workspaceId, listId: { in: lists.map((l) => l.listId) }, ...(leadIds?.length ? { leadId: { in: leadIds } } : {}) }, distinct: ['leadId'], select: { leadId: true }, take: 10_000 });
  return members.map((m) => m.leadId);
}

export const BatchSchema = z.object({
  stepIds: z.array(z.string().uuid()).max(10).optional(),
  leadIds: z.array(z.string().uuid()).max(5000).optional(),
  force: z.boolean().default(false),
  onlyMissing: z.boolean().default(true),
  maxCostUsd: z.number().min(0).max(10000).nullable().optional(),
});

async function plannedPairs(workspaceId: string, campaignId: string, input: z.infer<typeof BatchSchema>) {
  const campaign = await loadCampaign(workspaceId, campaignId);
  const steps = (campaign.sequence?.steps ?? []).filter((s) => s.personalizationMode !== 'TEMPLATE_ONLY' && (!input.stepIds?.length || input.stepIds.includes(s.id)));
  const leads = await campaignAudience(workspaceId, campaignId, input.leadIds);
  const existing = await db().leadPersonalization.findMany({ where: { campaignId, leadId: { in: leads }, stepId: { in: steps.map((s) => s.id) } }, select: { leadId: true, stepId: true, status: true, manuallyEdited: true } });
  const key = (l: string, s: string) => `${l}:${s}`;
  const ex = new Map(existing.map((e) => [key(e.leadId, e.stepId), e]));
  const pairs: Array<{ leadId: string; stepId: string }> = [];
  let preserved = 0;
  for (const l of leads) for (const s of steps) {
    const e = ex.get(key(l, s.id));
    if (e && !input.force) {
      if (e.status === 'APPROVED' || e.manuallyEdited) { preserved++; continue; }
      if (input.onlyMissing && ['GENERATED', 'BLOCKED', 'GENERATING', 'QUEUED'].includes(e.status)) { preserved++; continue; }
    }
    pairs.push({ leadId: l, stepId: s.id });
  }
  return { campaign, steps, leads, pairs, preserved };
}

export async function estimateBatch(workspaceId: string, campaignId: string, input: z.infer<typeof BatchSchema>) {
  const { campaign, steps, leads, pairs, preserved } = await plannedPairs(workspaceId, campaignId, input);
  if (!pairs.length) return { leads: leads.length, steps: steps.length, generations: 0, preserved, estimatedUsd: 0, perGenerationUsd: 0, priced: true, note: 'Nothing to generate.' };
  // Build a real prompt for a sample pair to size the request.
  let chars = 9000;
  try {
    const lead = await db().lead.findFirstOrThrow({ where: { id: pairs[0].leadId }, include: { company: true } });
    const ctx = await buildContext(workspaceId, campaign, lead, pairs[0].stepId);
    chars = Object.values(ctx.vars).reduce((s, v) => s + v.length, 0) + 3000;
  } catch { /* fall back to the default size */ }
  const gen = await estimateCallCost(workspaceId, 'PERSONALIZATION', chars, 900);
  const fc = await estimateCallCost(workspaceId, 'FACT_CHECK', 6000, 700);
  const per = gen.usd + fc.usd;
  return {
    leads: leads.length, steps: steps.length, generations: pairs.length, preserved,
    perGenerationUsd: per, estimatedUsd: per * pairs.length, priced: gen.priced && fc.priced, model: gen.model,
    note: `Estimate assumes ~${Math.round(chars / 4)} input tokens and up to 900 output tokens per email plus one mandatory fact-check call. Actual cost is recorded per call.${gen.priced ? '' : ' The model has no price configured, so this estimate is $0 — add a price in AI settings.'}`,
  };
}

export async function createBatch(workspaceId: string, campaignId: string, input: z.infer<typeof BatchSchema>, actor: Actor) {
  const est = await estimateBatch(workspaceId, campaignId, input);
  const { pairs } = await plannedPairs(workspaceId, campaignId, input);
  if (!pairs.length) throw new AppError('CONFLICT', 'Nothing to generate (everything is approved, edited or already generated). Use force to regenerate.', 409);
  if (pairs.length > 5000) throw new AppError('VALIDATION_FAILED', 'At most 5,000 generations per batch', 400);
  const batch = await db().personalizationBatch.create({ data: { workspaceId, campaignId, status: 'RUNNING', total: pairs.length, estimatedCostUsd: est.estimatedUsd, maxCostUsd: input.maxCostUsd ?? null, options: input as Prisma.InputJsonValue, createdById: actor.userId ?? null } });
  for (const p of pairs) {
    await db().leadPersonalization.upsert({
      where: { campaignId_leadId_stepId: { campaignId, leadId: p.leadId, stepId: p.stepId } },
      update: { status: 'QUEUED', batchId: batch.id, error: null },
      create: { workspaceId, campaignId, leadId: p.leadId, stepId: p.stepId, status: 'QUEUED', batchId: batch.id },
    });
  }
  // Steps are generated in order per lead so follow-ups can see earlier drafts.
  const byLead = new Map<string, string[]>();
  const order = new Map((await loadCampaign(workspaceId, campaignId)).sequence?.steps.map((s) => [s.id, s.order]) ?? []);
  for (const p of pairs) byLead.set(p.leadId, [...(byLead.get(p.leadId) ?? []), p.stepId]);
  for (const [leadId, stepIds] of byLead) {
    stepIds.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    await enqueue(QUEUES.personalize, 'personalize.lead', { workspaceId, campaignId, leadId, stepIds, batchId: batch.id, force: input.force }, { jobId: `pz-${batch.id}-${leadId}`, attempts: 3, backoff: { type: 'exponential', delay: 10_000 } });
  }
  await audit(workspaceId, actor, 'personalization.batch_created', { type: 'campaign', id: campaignId }, { batchId: batch.id, generations: pairs.length, estimatedUsd: est.estimatedUsd });
  return { batchId: batch.id, generations: pairs.length, estimate: est };
}

/** Worker: generate all requested steps for one lead within a batch, respecting the batch cost cap. */
export async function processBatchLead(workspaceId: string, data: { campaignId: string; leadId: string; stepIds: string[]; batchId: string; force?: boolean }) {
  const batch = await db().personalizationBatch.findFirst({ where: { id: data.batchId, workspaceId } });
  if (!batch) return { skipped: 'batch not found' };
  for (const stepId of data.stepIds) {
    const row = await db().leadPersonalization.findUnique({ where: { campaignId_leadId_stepId: { campaignId: data.campaignId, leadId: data.leadId, stepId } } });
    if (!row || row.batchId !== batch.id || row.status !== 'QUEUED') continue; // already handled (retry-safe)
    const fresh = await db().personalizationBatch.findUniqueOrThrow({ where: { id: batch.id } });
    if (fresh.status === 'CANCELLED') {
      await db().leadPersonalization.update({ where: { id: row.id }, data: { status: 'SKIPPED', error: fresh.error ?? 'batch cancelled' } });
      await bump(batch.id, 'skipped', 0);
      continue;
    }
    // Unexpected errors propagate: the row stays QUEUED so the BullMQ retry picks it up; the last attempt marks it failed.
    const r = await generateForLead(workspaceId, data.campaignId, data.leadId, stepId, { batchId: batch.id, force: data.force });
    if (r.status === 'GENERATING') throw new Error('Generation for this lead/step is already in progress; retrying later'); // lock held elsewhere — let BullMQ retry
    const cost = 'costUsd' in r && typeof r.costUsd === 'number' ? r.costUsd : 0;
    const kind = r.status === 'FAILED' ? 'failed' : r.status === 'SKIPPED' || r.status === 'NEEDS_RESEARCH' ? 'skipped' : 'done';
    await bump(batch.id, kind, cost);
  }
  return { ok: true };
}

async function bump(batchId: string, field: 'done' | 'failed' | 'skipped', cost: number) {
  const b = await db().personalizationBatch.update({ where: { id: batchId }, data: { [field]: { increment: 1 }, spentUsd: { increment: cost } } });
  if (b.maxCostUsd !== null && Number(b.spentUsd) >= Number(b.maxCostUsd) && b.status === 'RUNNING') {
    const sk = await db().leadPersonalization.updateMany({ where: { batchId, status: 'QUEUED' }, data: { status: 'SKIPPED', error: 'batch cost cap reached' } });
    await db().personalizationBatch.update({ where: { id: batchId }, data: { status: 'CANCELLED', skipped: { increment: sk.count }, error: `Batch cost cap $${Number(b.maxCostUsd)} reached ($${Number(b.spentUsd).toFixed(4)} spent)`, completedAt: new Date() } });
    await notifyWorkspace(b.workspaceId, 'MANAGER', { type: 'ai.budget', title: 'Personalization batch stopped at its cost cap', link: `/campaigns/${b.campaignId}` });
  } else if (b.status === 'RUNNING' && b.done + b.failed + b.skipped >= b.total) {
    await db().personalizationBatch.update({ where: { id: batchId }, data: { status: 'COMPLETED', completedAt: new Date() } });
  }
  await publish(b.workspaceId, 'personalization.batch', { batchId, campaignId: b.campaignId });
}

/** Called by the worker when a batch job exhausted its retries. */
export async function markBatchLeadFailed(workspaceId: string, data: { campaignId: string; leadId: string; stepIds: string[]; batchId: string }, error: string) {
  for (const stepId of data.stepIds) {
    const r = await db().leadPersonalization.updateMany({ where: { workspaceId, campaignId: data.campaignId, leadId: data.leadId, stepId, batchId: data.batchId, status: { in: ['QUEUED', 'GENERATING'] } }, data: { status: 'FAILED', error: error.slice(0, 1000) } });
    if (r.count) await bump(data.batchId, 'failed', 0);
  }
}

export async function listBatches(workspaceId: string, campaignId: string) {
  return db().personalizationBatch.findMany({ where: { workspaceId, campaignId }, orderBy: { createdAt: 'desc' }, take: 20 });
}

export async function cancelBatch(workspaceId: string, batchId: string, actor: Actor) {
  const b = await db().personalizationBatch.findFirst({ where: { id: batchId, workspaceId } });
  if (!b) throw NotFound('Batch');
  if (b.status !== 'RUNNING') throw new AppError('CONFLICT', `Batch is ${b.status}`, 409);
  const r = await db().leadPersonalization.updateMany({ where: { batchId, status: 'QUEUED' }, data: { status: 'SKIPPED', error: 'batch cancelled' } });
  await db().personalizationBatch.update({ where: { id: batchId }, data: { status: 'CANCELLED', skipped: { increment: r.count }, error: 'cancelled by user', completedAt: new Date() } });
  await audit(workspaceId, actor, 'personalization.batch_cancelled', { type: 'campaign', id: b.campaignId }, { batchId, skipped: r.count });
}

export async function retryFailed(workspaceId: string, campaignId: string, actor: Actor) {
  const failed = await db().leadPersonalization.findMany({ where: { workspaceId, campaignId, status: 'FAILED' }, select: { leadId: true, stepId: true } });
  if (!failed.length) return { queued: 0 };
  return createBatch(workspaceId, campaignId, { leadIds: [...new Set(failed.map((f) => f.leadId))], stepIds: [...new Set(failed.map((f) => f.stepId))], force: false, onlyMissing: false }, actor);
}

/** Preview the configuration the next generation will use for one lead (no AI call, no cost). */
export async function promptPreview(workspaceId: string, campaignId: string, leadId: string, stepId: string) {
  const campaign = await loadCampaign(workspaceId, campaignId);
  const lead = await db().lead.findFirst({ where: { id: leadId, workspaceId }, include: { company: true } });
  if (!lead) throw NotFound('Lead');
  const ctx = await buildContext(workspaceId, campaign, lead, stepId);
  return {
    frozenConfig: ctx.frozen, configHash: ctx.hash, variant: ctx.variant.label,
    resolved: { writing: ctx.resolved.writing, writingSources: ctx.resolved.writingSources, research: ctx.resolved.research, blocks: ctx.resolved.blocks },
    profilePrompt: ctx.profilePrompt, claims: ctx.claims.length, excludedClaims: ctx.excludedClaims,
    previousSteps: ctx.previous.map((p) => p.stepOrder),
    prompt: { instructions: ctx.vars.instructions, stepContext: ctx.vars.stepContext, knowledgeChars: ctx.vars.knowledge.length, claims: ctx.vars.claims },
  };
}

/** Queue research for campaign leads that have no completed research yet (or older than maxAgeDays). */
export async function researchMissing(workspaceId: string, campaignId: string, maxAgeDays: number, actor: Actor) {
  const leads = await campaignAudience(workspaceId, campaignId);
  const since = new Date(Date.now() - maxAgeDays * 86400_000);
  const have = await db().researchReport.findMany({ where: { workspaceId, leadId: { in: leads }, status: 'COMPLETED', completedAt: { gte: since } }, select: { leadId: true }, distinct: ['leadId'] });
  const done = new Set(have.map((h) => h.leadId));
  const todo = leads.filter((l) => !done.has(l)).slice(0, 1000);
  for (const leadId of todo) await enqueue(QUEUES.research, 'research.lead', { workspaceId, leadId, campaignId }, { jobId: `research-${campaignId}-${leadId}-${Math.floor(Date.now() / 3_600_000)}` });
  await audit(workspaceId, actor, 'personalization.research_queued', { type: 'campaign', id: campaignId }, { leads: todo.length });
  return { queued: todo.length, alreadyResearched: done.size };
}
