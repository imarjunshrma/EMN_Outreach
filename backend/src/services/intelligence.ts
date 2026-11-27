import { initialCoverage, overallCoverage, type ResearchArea } from '../../../shared/src/research-coverage.js';
import { z } from 'zod';
import { CampaignAiOverridesSchema, researchFocusText } from '../../../shared/src/ai-studio.js';
import { db, Prisma } from '../core/db.js';
import { adapters } from '../core/container.js';
import { AppError, BadRequest, NotFound } from '../core/errors.js';
import { audit, publish, type Actor } from '../core/audit.js';
import { sha256 } from '../core/crypto.js';
import { acquireLock } from '../core/redis.js';
import { enqueue, QUEUES } from '../core/queues.js';
import { logger } from '../core/logger.js';
import { runAi } from './ai.js';
import { getImportExclusions, retrieveImportedKnowledge } from './knowledge-import-apply.js';
import { IcpSchema, saveIcpVersion } from './icp-versions.js';
import { verifyProspectIdentity } from '../../../shared/src/identity.js';
import { evaluateIcpQualification } from '../../../shared/src/personalization-gates.js';
import { getSecret, recordUsage, requireSecret } from './integrations.js';
import { readSettings } from './workspace.js';
import { canonicalLinkedInProfile, domainFromUrlOrEmail, isValidEmail, normalizeEmail, upsertCompany, LAWFUL_BASES } from './leads.js';
import { emitEvent } from './automation.js';
import { isSuppressed } from './compliance.js';
import { IcpCriteriaSchema, type FactCheck, type FactExtraction, type IcpCriteria } from '../../../shared/src/ai-schemas.js';
import { quoteIsSupported, wrapUntrusted, hasUnresolvedVariables, neutralizeTags } from '../../../integrations/src/ai/guard.js';
import { sameResearchHomepage, sourceUrlKey } from '../../../integrations/src/research/source-url.js';
import { isRestrictedResearchHost } from '../../../integrations/src/research/fetcher.js';
import type { ProspectResult, SearchHit } from '../../../integrations/src/providers/index.js';

// ---------------------------------------------------------------- ICP

export { IcpSchema };

export async function listIcps(workspaceId: string) {
  return db().idealCustomerProfile.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
}

export async function createIcp(workspaceId: string, input: z.infer<typeof IcpSchema>, actor: Actor) {
  return saveIcpVersion(workspaceId, null, input, actor);
}

export async function updateIcp(workspaceId: string, id: string, input: z.infer<typeof IcpSchema>, actor: Actor) {
  return saveIcpVersion(workspaceId, id, input, actor);
}

export async function deleteIcp(workspaceId: string, id: string, actor: Actor) {
  const r = await db().idealCustomerProfile.deleteMany({ where: { id, workspaceId } });
  if (!r.count) throw NotFound('ICP');
  await audit(workspaceId, actor, 'icp.deleted', { type: 'icp', id });
}

/** Natural language → structured ICP filters (AI). The result is a draft the user reviews. */
export async function icpFromText(workspaceId: string, description: string) {
  const r = await runAi<{ name: string; criteria: IcpCriteria; assumptions: string[] }>(workspaceId, 'ICP_FROM_TEXT', { description: wrapUntrusted('user', description, 4000) });
  return { ...r.data, criteria: IcpCriteriaSchema.parse(r.data.criteria), executionId: r.executionId };
}

// ---------------------------------------------------------------- prospect discovery

export const ProspectSearchSchema = z.object({
  icpId: z.string().uuid().nullable().optional(),
  query: z.string().max(4000).default(''),
  criteria: IcpCriteriaSchema,
  page: z.number().int().min(1).max(100).default(1),
  perPage: z.number().int().min(1).max(100).default(25),
});

export async function searchProspects(workspaceId: string, input: z.infer<typeof ProspectSearchSchema>, actor: Actor) {
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const provider = readSettings(ws.settings).leadProvider;
  if (provider === 'none') throw new AppError('PROVIDER_NOT_CONFIGURED', 'No lead-data provider selected. Choose Apollo in Settings → System and add its API key under Integrations, or import a CSV instead.', 400);
  const { secret, publicConfig } = await requireSecret(workspaceId, provider);
  const adapter = adapters().leadData[provider];
  if (publicConfig.searchPath && 'searchPath' in (adapter as object)) (adapter as unknown as { searchPath: string }).searchPath = publicConfig.searchPath;
  const search = await db().prospectSearch.create({ data: { workspaceId, icpId: input.icpId ?? null, provider, query: input.query, filters: input.criteria as Prisma.InputJsonValue, status: 'RUNNING', createdById: actor.userId ?? null } });
  try {
    const { results, total } = await adapter.search(secret, { ...input.criteria, page: input.page, perPage: input.perPage });
    // Mark people already in the workspace so the UI can show duplicates.
    const emails = results.map((r) => r.email).filter(Boolean) as string[];
    const existing = new Set((await db().lead.findMany({ where: { workspaceId, OR: [{ emailNormalized: { in: emails } }, { externalId: { in: results.map((r) => r.externalId) } }] }, select: { emailNormalized: true, externalId: true } })).flatMap((l) => [l.emailNormalized, l.externalId]));
    const annotated = results.map((r) => ({ ...r, alreadyInWorkspace: existing.has(r.externalId) || (!!r.email && existing.has(r.email)) }));
    await db().prospectSearch.update({ where: { id: search.id }, data: { status: 'COMPLETED', results: annotated as unknown as Prisma.InputJsonValue, resultCount: results.length } });
    await recordUsage(workspaceId, provider, 'search', 1, { results: results.length });
    return { searchId: search.id, total, results: annotated };
  } catch (e) {
    await db().prospectSearch.update({ where: { id: search.id }, data: { status: 'FAILED', error: (e as Error).message.slice(0, 500) } });
    throw new AppError('PROVIDER_ERROR', (e as Error).message, 502);
  }
}

export const ProspectImportSchema = z.object({
  searchId: z.string().uuid(),
  externalIds: z.array(z.string()).min(1).max(100),
  listId: z.string().uuid().nullable().optional(),
  lawfulBasis: z.enum(LAWFUL_BASES),
  lawfulBasisNote: z.string().max(500).optional(),
  enrich: z.boolean().default(true),
  autoVerify: z.boolean().default(true),
  autoResearch: z.boolean().default(true),
  autoScore: z.boolean().default(true),
});

export async function importProspects(workspaceId: string, input: z.infer<typeof ProspectImportSchema>, actor: Actor) {
  const search = await db().prospectSearch.findFirst({ where: { id: input.searchId, workspaceId } });
  if (!search) throw NotFound('Search');
  if (input.listId && !(await db().leadList.findFirst({ where: { id: input.listId, workspaceId } }))) throw NotFound('List');
  let people = (search.results as unknown as ProspectResult[]).filter((p) => input.externalIds.includes(p.externalId));
  if (input.enrich && people.some((p) => !p.email)) {
    const { secret } = await requireSecret(workspaceId, search.provider as 'apollo');
    people = await adapters().leadData[search.provider].enrich(secret, people.filter((p) => !p.email)).then((enriched) => [...people.filter((p) => p.email), ...enriched]);
    await recordUsage(workspaceId, search.provider, 'enrich', people.length);
  }
  const source = await db().leadSource.upsert({ where: { workspaceId_name: { workspaceId, name: `${search.provider} search` } }, update: {}, create: { workspaceId, name: `${search.provider} search`, type: 'PROVIDER_SEARCH', provider: search.provider } });
  const summary = { created: 0, duplicates: 0, noEmail: 0, suppressed: 0 };
  const createdIds: string[] = [];
  for (const p of people) {
    if (!p.email || !isValidEmail(p.email)) { summary.noEmail++; continue; }
    const email = normalizeEmail(p.email);
    if ((await isSuppressed(workspaceId, email)).suppressed) { summary.suppressed++; continue; }
    const existing = await db().lead.findUnique({ where: { workspaceId_emailNormalized: { workspaceId, emailNormalized: email } } });
    if (existing) { summary.duplicates++; if (input.listId) await db().leadListMember.createMany({ data: [{ workspaceId, listId: input.listId, leadId: existing.id }], skipDuplicates: true }); continue; }
    const profile = canonicalLinkedInProfile(p.linkedinUrl);
    if (profile) {
      const slug = profile.split('/').at(-1)!;
      const candidates = await db().lead.findMany({ where: { workspaceId, linkedinUrl: { contains: slug, mode: 'insensitive' } }, select: { id: true, linkedinUrl: true } });
      const duplicate = candidates.find((candidate) => canonicalLinkedInProfile(candidate.linkedinUrl) === profile);
      if (duplicate) { summary.duplicates++; if (input.listId) await db().leadListMember.createMany({ data: [{ workspaceId, listId: input.listId, leadId: duplicate.id }], skipDuplicates: true }); continue; }
    }
    await (await import('./entitlements.js')).ws.quota(workspaceId, 'leads');
    const company = await upsertCompany(workspaceId, p.company.name, p.company.domain ?? p.company.website, { industry: p.company.industry, employeeCount: p.company.employeeCount, country: p.country });
    const lead = await db().lead.create({
      data: {
        workspaceId, email, emailNormalized: email, firstName: p.firstName, lastName: p.lastName, title: p.title, linkedinUrl: p.linkedinUrl,
        city: p.city, country: p.country, externalId: p.externalId, sourceId: source.id, companyId: company?.id,
        lawfulBasis: input.lawfulBasis, lawfulBasisNote: input.lawfulBasisNote,
        statusChanges: { create: { workspaceId, toStatus: 'NEW', reason: `${search.provider} import` } },
      },
    });
    if (input.listId) await db().leadListMember.create({ data: { workspaceId, listId: input.listId, leadId: lead.id } });
    createdIds.push(lead.id);
    summary.created++;
  }
  for (const id of createdIds) {
    if (input.autoVerify) await enqueue(QUEUES.verify, 'verify.lead', { workspaceId, leadId: id });
    if (input.autoResearch) await enqueue(QUEUES.research, 'research.lead', { workspaceId, leadId: id, thenScore: input.autoScore, icpId: search.icpId });
    else if (input.autoScore) await enqueue(QUEUES.ai, 'ai.qualify', { workspaceId, leadId: id, icpId: search.icpId });
  }
  await audit(workspaceId, actor, 'prospects.imported', { type: 'prospect_search', id: search.id }, summary);
  return summary;
}

export async function listSearches(workspaceId: string) {
  return db().prospectSearch.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, provider: true, query: true, status: true, resultCount: true, error: true, createdAt: true } });
}

export async function getSearch(workspaceId: string, id: string) {
  const s = await db().prospectSearch.findFirst({ where: { id, workspaceId } });
  if (!s) throw NotFound('Search');
  return s;
}

// ---------------------------------------------------------------- verification

export async function verifyLead(workspaceId: string, leadId: string) {
  const lead = await db().lead.findFirst({ where: { id: leadId, workspaceId } });
  if (!lead) return;
  if (!isValidEmail(lead.email)) throw BadRequest('VALIDATION_FAILED', 'Add a valid email address before verification.');
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const provider = readSettings(ws.settings).verifierProvider;
  if (provider === 'none') throw new AppError('PROVIDER_NOT_CONFIGURED', 'No email verifier selected (Settings → System).', 400);
  const { secret } = await requireSecret(workspaceId, provider);
  const r = await adapters().verifiers[provider].verify(secret, lead.emailNormalized);
  await db().$transaction([
    db().emailVerification.create({ data: { workspaceId, leadId, email: lead.emailNormalized, provider, result: r.result, rawResult: r.raw } }),
    db().lead.update({ where: { id: leadId }, data: { emailVerificationStatus: r.result, emailVerifiedAt: new Date() } }),
  ]);
  await recordUsage(workspaceId, provider, 'verify', 1);
  await publish(workspaceId, 'lead.updated', { leadId });
  return r;
}

// ---------------------------------------------------------------- research


export async function queueResearch(workspaceId: string, target: { leadId?: string; companyId?: string; campaignId?: string; sourceUrl?: string }, opts: { thenScore?: boolean; refresh?: boolean; retryMissing?: boolean; retryReportId?: string } = {}) {
  if (target.leadId && !(await db().lead.findFirst({ where: { id: target.leadId, workspaceId } }))) throw NotFound('Lead');
  if (target.companyId && !(await db().company.findFirst({ where: { id: target.companyId, workspaceId } }))) throw NotFound('Company');
  if (opts.retryReportId && (!target.leadId || !(await db().researchReport.findFirst({
    where: { id: opts.retryReportId, workspaceId, leadId: target.leadId }, select: { id: true },
  })))) throw NotFound('Research report');
  if (target.campaignId) {
    const { campaignAudience } = await import('./personalization.js');
    if (!target.leadId || !(await campaignAudience(workspaceId, target.campaignId, [target.leadId])).includes(target.leadId)) throw NotFound('Campaign prospect');
  }
  const job = await enqueue(QUEUES.research, target.leadId ? 'research.lead' : 'research.company', { workspaceId, ...target, thenScore: !!opts.thenScore, refresh: !!opts.refresh, retryMissing: !!opts.retryMissing, retryReportId: opts.retryReportId });
  return { queued: true, jobId: job.id };
}

type ResearchTarget = { leadId?: string; companyId?: string; campaignId?: string; depth?: 'INITIAL' | 'DEEP'; refresh?: boolean; sourceUrl?: string; retryMissing?: boolean; retryReportId?: string };

/** Serialize research for each prospect so retries and duplicate jobs cannot append the same evidence. */
export async function runResearch(workspaceId: string, target: ResearchTarget) {
  const subjectId = target.leadId ?? target.companyId;
  if (!subjectId) return null;
  const release = await acquireLock(`research:${workspaceId}:${subjectId}`, 600_000);
  if (!release) throw new AppError('RESEARCH_IN_PROGRESS', 'Research is already running for this prospect.', 409);
  try { return await collectResearch(workspaceId, target); }
  finally { await release(); }
}

async function collectResearch(workspaceId: string, target: ResearchTarget) {
  const lead = target.leadId ? await db().lead.findFirst({ where: { id: target.leadId, workspaceId }, include: { company: true } }) : null;
  const company = lead?.company ?? (target.companyId ? await db().company.findFirst({ where: { id: target.companyId, workspaceId } }) : null);
  if ((target.leadId && !lead) || (!lead && !company)) return null;
  if (lead && target.companyId && target.companyId !== lead.companyId) throw NotFound('Lead company');
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const settings = readSettings(ws.settings);
  let researchCostLimit = settings.aiMaxCostPerLeadUsd;
  // Research rules from AI Studio (+ campaign research overrides when research is run for a campaign).
  const { getConfig } = await import('./ai-studio.js');
  const rules = (await getConfig(workspaceId, 'RESEARCH')).data;
  if (target.campaignId) {
    const camp = await db().campaign.findFirst({ where: { id: target.campaignId, workspaceId }, select: { aiOverrides: true, maxAiCostPerLeadUsd: true } });
    researchCostLimit = camp?.maxAiCostPerLeadUsd !== null && camp?.maxAiCostPerLeadUsd !== undefined
      ? Number(camp.maxAiCostPerLeadUsd) : settings.aiMaxCostPerLeadUsd;
    const o = CampaignAiOverridesSchema.safeParse(camp?.aiOverrides ?? {});
    if (o.success) {
      const r = o.data.research;
      if (r.personTopics?.length) rules.personTopics = [...rules.personTopics, ...r.personTopics];
      if (r.companyTopics?.length) rules.companyTopics = [...rules.companyTopics, ...r.companyTopics];
      if (r.signals?.length) rules.signals = [...rules.signals, ...r.signals];
      if (r.mustNotInfer?.length) rules.mustNotInfer = [...rules.mustNotInfer, ...r.mustNotInfer];
      if (r.customInstructions) rules.customInstructions = `${rules.customInstructions}\n${r.customInstructions}`.trim();
    }
  }
  const importedResearchRules = Object.values(rules.importedRules ?? {});
  const excludedSourceNames = new Set(importedResearchRules.flatMap(rule => rule.excludedSources).map(source => source.toLowerCase().replace(/[^a-z]/g, '')));
  for (const source of Object.keys(rules.permittedSources) as Array<keyof typeof rules.permittedSources>) {
    if (excludedSourceNames.has(source.toLowerCase())) rules.permittedSources[source] = false;
  }
  const bannedHosts = importedResearchRules.flatMap(rule => rule.excludedSources).flatMap(source => {
    try {
      const host = new URL(source.includes('://') ? source : `https://${source}`).hostname.toLowerCase();
      return host.includes('.') ? [host.replace(/^www\./, '')] : [];
    } catch { return []; }
  });
  const excludedHost = (hostname: string) => bannedHosts.some(host => hostname === host || hostname.endsWith(`.${host}`));
  const researchStrategy = await retrieveImportedKnowledge(workspaceId, '', [
    'TARGET_AUDIENCE', 'TARGET_PERSONA', 'ICP_CRITERIA', 'BUSINESS_OPPORTUNITY', 'RESEARCH_RULE',
  ], 6);
  const custom = lead?.customFields && typeof lead.customFields === 'object' && !Array.isArray(lead.customFields) ? lead.customFields : {};
  const publicProfile = typeof custom.publicProfileUrl === 'string' ? custom.publicProfileUrl : null;
  const youtube = typeof custom.youtubeUrl === 'string' ? custom.youtubeUrl : null;
  const suppliedLinks = [lead?.linkedinUrl, youtube, publicProfile, custom.instagramUrl, custom.facebookUrl, custom.socialUrl, custom.transcriptUrl, target.sourceUrl];
  const depth = target.depth ?? 'INITIAL';
  const subjectFingerprint = sha256(JSON.stringify({
    collectorVersion: 2, suppliedLinks, sourceLimits: [rules.maxPagesPerRun, rules.maxSearchQueriesPerRun, rules.recentSignalDays, rules.extendedSignalDays],
    person: lead ? { firstName: lead.firstName, lastName: lead.lastName, title: lead.title, linkedinUrl: lead.linkedinUrl, website: lead.website, publicProfile, youtube } : null,
    company: company ? { name: company.name, domain: company.domain, website: company.website, industry: company.industry, employeeCount: company.employeeCount, country: company.country } : null,
    researchRules: {
      personTopics: rules.personTopics, companyTopics: rules.companyTopics, permittedSources: rules.permittedSources,
      signals: rules.signals, mustNotInfer: rules.mustNotInfer, customInstructions: rules.customInstructions, importedResearchRules,
      strategyDocumentIds: researchStrategy.map(item => item.id),
      campaignId: target.campaignId ?? null,
    },
  }));
  const cutoff = new Date(Date.now() - Math.min(rules.maxEvidenceAgeDays ?? Infinity, rules.recentSignalDays) * 86_400_000);
  const reusable = target.refresh || target.retryMissing || target.retryReportId ? null : await db().researchReport.findFirst({
    where: {
      workspaceId, leadId: lead?.id ?? null, companyId: company?.id ?? null, subjectFingerprint, status: 'COMPLETED',
      ...(depth === 'DEEP' ? { researchDepth: 'DEEP' } : {}),
      completedAt: { gte: cutoff },
      claims: { some: { status: { in: ['SUPPORTED', 'NEEDS_REVIEW'] } } },
    },
    orderBy: { completedAt: 'desc' }, select: { id: true, _count: { select: { claims: true } } },
  });
  if (reusable) return { reportId: reusable.id, claims: reusable._count.claims, reused: true, depth };
  const previous = target.retryMissing || target.retryReportId ? await db().researchReport.findFirst({
    where: { workspaceId, leadId: lead?.id ?? null, companyId: company?.id ?? null,
      ...(target.retryReportId ? { id: target.retryReportId } : { subjectFingerprint }),
      status: { in: ['COMPLETED', 'FAILED'] }, createdAt: { gte: cutoff }, coverage: { not: Prisma.DbNull } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: { evidence: true, claims: { select: { text: true, evidenceId: true, status: true } } },
  }) : null;
  if (target.retryReportId && !previous) throw NotFound('Eligible research report');
  const report = previous ?? await db().researchReport.create({
    data: { workspaceId, leadId: lead?.id, companyId: company?.id, subjectFingerprint, researchDepth: depth, status: 'RUNNING' },
  });
  const evidence: Array<{ id: string; url: string; content: string; title: string | null; publishedAt?: Date }> = [];
  const errors: string[] = [];
  type SavedCoverage = Partial<ReturnType<typeof initialCoverage>> & {
    sourceProvenance?: Array<{ requestedUrl: string; finalUrl: string }>;
    pendingExtractionIds?: string[];
  };
  const savedCoverage = previous?.coverage as SavedCoverage | null;
  const coverage = initialCoverage();
  for (const area of Object.keys(coverage) as ResearchArea[]) {
    if (savedCoverage?.[area]) coverage[area] = savedCoverage[area];
  }
  const attemptedAreas = new Set<ResearchArea>();
  const inspectedAreas = new Set<ResearchArea>();
  const unavailableAreas = new Set<ResearchArea>();
  const sourceProvenance = [...(savedCoverage?.sourceProvenance ?? [])];
  const visited = new Set(previous?.evidence.map((item) => sourceUrlKey(item.url)).filter(Boolean));
  for (const alias of sourceProvenance) visited.add(sourceUrlKey(alias.requestedUrl));
  const retainedSources = previous?.evidence.filter((item) => sourceUrlKey(item.url)).length ?? 0;
  const searchSecret = rules.permittedSources.webSearch && settings.searchProvider !== 'none'
    ? await getSecret(workspaceId, settings.searchProvider) : null;
  let searchUnavailable: string | null = null;
  const sourceFailures: Array<{ url: string; area: ResearchArea | null; reason: string }> = [];
  const eligibleOnRetry = (area: ResearchArea) => !previous || (coverage[area].status !== 'COMPLETED' && coverage[area].status !== 'NOT_APPLICABLE');
  const retrySummary = (technicalFailure = false) => {
    const newSources = evidence.filter((item) => !priorEvidenceIds.has(item.id) && sourceUrlKey(item.url)).length;
    return {
      retainedSources, newSources, attemptedCategories: [...attemptedAreas], inspectedCategories: [...inspectedAreas],
      completedCategories: [...inspectedAreas].filter((area) => coverage[area].status === 'COMPLETED'),
      unavailableCategories: [...unavailableAreas], sourceFailures, searchUnavailable, technicalFailure,
      message: technicalFailure ? 'Retry failed during evidence extraction.'
        : newSources ? `Retained ${retainedSources} source(s) and collected ${newSources} new source(s).`
        : retainedSources ? `Retained ${retainedSources} source(s). No new sources were collected.`
        : 'No usable sources were collected.',
    };
  };
  const reportCoverage = (technicalFailure = false) => ({
    ...coverage, sourceProvenance,
    pendingExtractionIds: technicalFailure ? evidence.filter((item) => sourceUrlKey(item.url)).map((item) => item.id) : [],
    ...(previous || target.retryMissing ? { retry: retrySummary(technicalFailure) } : {}),
  });
  const priorEvidenceIds = new Set(previous?.evidence.map((item) => item.id));
  const evidenceHashes = new Map(previous?.evidence.map((item) => [item.contentHash, item.id]));
  // Reuse successfully fetched evidence when its earlier extraction failed.
  for (const item of previous?.evidence ?? []) {
    if (sourceUrlKey(item.url) && (previous?.status === 'FAILED' || savedCoverage?.pendingExtractionIds?.includes(item.id))) evidence.push({ ...item, publishedAt: item.publishedAt ?? undefined });
  }
  const evidenceAreas = new Map<string, Set<ResearchArea>>();
  const signalWindows = [rules.recentSignalDays, Math.max(rules.recentSignalDays, rules.extendedSignalDays)];
  if (!lead) for (const area of ['identity', 'background', 'linkedin'] as const) {
    coverage[area] = { status: 'NOT_APPLICABLE', detail: 'Company-only research.' };
  }
  let pageCount = 0;
  let searchCount = 0;

  async function addEvidence(sourceType: 'WEBSITE' | 'SEARCH_RESULT', url: string, title: string | null, content: string, httpStatus?: number, publishedAt?: Date) {
    if (!content.trim()) return;
    if (httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300)) return;
    if (sourceType !== 'SEARCH_RESULT' || !url.startsWith('search:')) {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || isRestrictedResearchHost(parsed.hostname) || excludedHost(parsed.hostname)) return;
    }
    const hash = sha256(content.slice(0, 30_000).trim().replace(/\s+/g, ' '));
    const existing = [...(previous?.evidence ?? []), ...evidence].find((item) => item.url === url || (sourceUrlKey(url) && sourceUrlKey(item.url) === sourceUrlKey(url)))?.id ?? evidenceHashes.get(hash);
    if (existing) return existing;
    const e = await db().researchEvidence.create({ data: { workspaceId, reportId: report.id, sourceType, url, title, content: content.slice(0, 30_000), contentHash: hash, httpStatus, publishedAt } });
    evidence.push({ id: e.id, url, content: e.content, title, publishedAt });
    evidenceHashes.set(hash, e.id);
    return e.id;
  }

  async function fetchAndStore(url: string, sourceType: 'WEBSITE' | 'SEARCH_RESULT', area: ResearchArea | null = 'company') {
    if (pageCount >= rules.maxPagesPerRun || (area && !eligibleOnRetry(area))) return null;
    const targetUrl = new URL(url);
    if (!['http:', 'https:'].includes(targetUrl.protocol) || targetUrl.username || targetUrl.password || isRestrictedResearchHost(targetUrl.hostname)) throw new Error('Source is unavailable for permitted automated research.');
    if (excludedHost(targetUrl.hostname)) return null;
    targetUrl.hash = '';
    const key = sourceUrlKey(targetUrl.href)!;
    if (visited.has(key)) return null;
    visited.add(key);
    pageCount++;
    if (area) attemptedAreas.add(area);
    let page;
    try { page = await adapters().fetcher.fetchPage(url); }
    catch (error) {
      sourceFailures.push({ url: targetUrl.origin + targetUrl.pathname, area, reason: (error as Error).message.slice(0, 200) });
      if (area && coverage[area].status !== 'COMPLETED' && coverage[area].status !== 'PARTIAL') coverage[area] = {
        status: /robots|403|restricted|unavailable for permitted/i.test((error as Error).message) ? 'INACCESSIBLE' : 'FAILED',
        detail: 'A public source could not be retrieved.',
      };
      if (area && /robots|401|403|429|restricted/i.test((error as Error).message)) unavailableAreas.add(area);
      throw error;
    }
    if (page.status < 200 || page.status >= 300) {
      sourceFailures.push({ url: targetUrl.origin + targetUrl.pathname, area, reason: `HTTP ${page.status}` });
      if (area && coverage[area].status !== 'COMPLETED' && coverage[area].status !== 'PARTIAL') coverage[area] = {
        status: [401, 403, 429].includes(page.status) ? 'INACCESSIBLE' : 'FAILED', detail: `Source returned HTTP ${page.status}.`,
      };
      if (area && [401, 403, 429].includes(page.status)) unavailableAreas.add(area);
      throw new Error(`Source returned HTTP ${page.status}.`);
    }
    const finalKey = sourceUrlKey(page.url);
    if (finalKey) {
      visited.add(finalKey);
      if (key !== finalKey && !sourceProvenance.some((entry) => entry.requestedUrl === key && entry.finalUrl === finalKey)) {
        sourceProvenance.push({ requestedUrl: key, finalUrl: finalKey });
      }
    }
    if (!area) return page;
    inspectedAreas.add(area);
    const evidenceId = await addEvidence(sourceType, page.url, page.title, page.text, page.status, page.publishedAt);
    if (evidenceId && !priorEvidenceIds.has(evidenceId)) {
      const areas = evidenceAreas.get(evidenceId) ?? new Set<ResearchArea>();
      areas.add(area);
      evidenceAreas.set(evidenceId, areas);
      coverage[area] = { status: 'PARTIAL', detail: 'A public page was read. Findings require evidence review.' };
    } else if (!evidenceId && coverage[area].status === 'NOT_INVESTIGATED') {
      coverage[area] = { status: 'COMPLETED', detail: 'Source checked. No usable text found.' };
    }
    return page;
  }

  // 1) Company website (initial run is compact; the deep pass can follow a verified, qualified score).
  const domain = company?.domain ?? domainFromUrlOrEmail(company?.website ?? lead?.website ?? null);
  if (domain && rules.permittedSources.companyWebsite) {
    const companyWebsite = company?.website ?? lead?.website;
    const home = companyWebsite && /^https?:\/\//i.test(companyWebsite) ? companyWebsite : `https://${domain}`;
    try {
      const recordedHome = sourceProvenance.find((entry) => entry.requestedUrl === sourceUrlKey(home))?.finalUrl;
      const cachedHome = previous?.evidence.find((item) =>
        item.url === recordedHome || sameResearchHomepage(home, item.url));
      if (cachedHome && !recordedHome && sourceUrlKey(home) !== sourceUrlKey(cachedHome.url)) {
        sourceProvenance.push({ requestedUrl: sourceUrlKey(home)!, finalUrl: sourceUrlKey(cachedHome.url)! });
      }
      const page = cachedHome ? null : await fetchAndStore(home, 'WEBSITE', previous ? null : 'company');
      const base = cachedHome?.url ?? page?.url;
      if (base) {
        const host = new URL(base).hostname;
        let links = page?.links ?? [];
        if (previous && ['company', 'background', 'signals', 'interviews'].some((area) => eligibleOnRetry(area as ResearchArea))) {
          try { links = [...links, ...(await fetchAndStore(new URL('/sitemap.xml', base).href, 'WEBSITE', null))?.links ?? []]; }
          catch (error) { errors.push(`Company sitemap: ${(error as Error).message}`); }
          links.push('/news', '/podcast', '/team', '/about');
        }
        const candidates = new Map<string, ResearchArea>();
        for (const link of links) {
          try {
            const url = new URL(link, base);
            const key = sourceUrlKey(url.href);
            if (!key || url.hostname !== host || visited.has(key)) continue;
            const path = url.pathname;
            const area = /podcast|interview|transcript|webinar|webcast/i.test(path) ? 'interviews'
              : /news|announce|blog|article/i.test(path) ? 'signals'
              : /team|leadership|personal-profile/i.test(path) && lead ? 'background'
              : /about|service|what-we-do|solutions|products?|consult|work|case-stud/i.test(path) ? 'company' : null;
            if (!area || !eligibleOnRetry(area) ||
                (area === 'interviews' && !rules.permittedSources.podcastsAndInterviews) ||
                (area === 'signals' && !rules.permittedSources.newsAndArticles)) continue;
            candidates.set(key, area);
          } catch { /* Ignore malformed links. */ }
        }
        const ordered = [...candidates];
        if (previous) {
          // Give each missing category a chance before reading more pages from any one category.
          const firstByArea = new Map<ResearchArea, string>();
          for (const [url, area] of ordered) if (!firstByArea.has(area)) firstByArea.set(area, url);
          ordered.sort(([a, areaA], [b, areaB]) => Number(firstByArea.get(areaB) === b) - Number(firstByArea.get(areaA) === a));
        }
        const limit = previous ? Math.max(0, rules.maxPagesPerRun - pageCount - (searchSecret && rules.maxSearchQueriesPerRun ? 2 : 0)) : Math.min(3, Math.max(0, rules.maxPagesPerRun - 3));
        for (const [url, area] of ordered.slice(0, limit)) {
          try { await fetchAndStore(url, 'WEBSITE', area); }
          catch (e) { errors.push(`Company subpage (${area}): ${(e as Error).message}`); }
        }
      }
    } catch (e) { errors.push(`Company website: ${(e as Error).message}`); }
  }

  for (const raw of suppliedLinks) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      const url = new URL(raw);
      const area = /(^|\.)linkedin\.com$/i.test(url.hostname) ? 'linkedin'
        : /(^|\.)(youtube\.com|youtu\.be)$/i.test(url.hostname) ? 'interviews'
        : /transcript|podcast|interview|webinar/i.test(url.pathname) ? 'interviews'
        : raw === publicProfile ? 'background' : raw === target.sourceUrl ? 'company' : 'social';
      if (isRestrictedResearchHost(url.hostname)) {
        const detail = area === 'interviews' ? 'YouTube URL was supplied. No permitted transcript was retrieved.'
          : `${url.hostname} was supplied. Automated access is unavailable through configured collectors.`;
        coverage[area] = { status: coverage[area].status === 'PARTIAL' ? 'PARTIAL' : 'INACCESSIBLE', detail };
        unavailableAreas.add(area);
        errors.push(detail);
      } else if ((area === 'company' ? rules.permittedSources.companyWebsite : rules.permittedSources.webSearch) && (area !== 'interviews' || rules.permittedSources.podcastsAndInterviews)) {
        await fetchAndStore(url.href, area === 'company' ? 'WEBSITE' : 'SEARCH_RESULT', area);
      }
    } catch (error) { errors.push(`Public source: ${(error as Error).message}`); }
  }

  // 2) Web search via a licensed search API: general, interviews/podcasts, news — each only if permitted.
  if (!rules.permittedSources.webSearch) searchUnavailable = 'Web search is disabled by the research policy.';
  else if (settings.searchProvider === 'none') searchUnavailable = 'No web search provider is configured for this workspace.';
  if (settings.searchProvider !== 'none' && rules.permittedSources.webSearch) {
    const sec = searchSecret;
    if (!sec) searchUnavailable = 'The configured web search provider has no available credentials.';
    if (sec) {
      const person = lead ? [lead.firstName, lead.lastName].filter(Boolean).join(' ') : '';
      const queries: Array<{ query: string; area: ResearchArea; after?: string }> = [];
      const base = [person && `"${person}"`, company?.name && `"${company.name}"`].filter(Boolean).join(' ') || domain || '';
      if (base) queries.push({ query: base, area: lead ? 'background' : 'company' });
      if (person && rules.permittedSources.podcastsAndInterviews) queries.push({ query: `${base} (podcast OR interview OR webinar OR transcript)`, area: 'interviews' });
      if (company?.name && rules.permittedSources.newsAndArticles) for (const days of [...new Set(signalWindows)]) {
        const after = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
        queries.push({ query: `"${company.name}" (launch OR partnership OR expansion OR news) after:${after}`, area: 'signals', after });
      }
      if (person && lead && coverage.linkedin.status === 'NOT_INVESTIGATED') {
        queries.push({ query: `${base} site:linkedin.com`, area: 'linkedin' });
      }
      if (person || company?.name) queries.push({ query: `${base} (Instagram OR Facebook OR public professional profile)`, area: 'social' });
      if (previous) queries.sort((a, b) => Number(coverage[b.area].status === 'NOT_INVESTIGATED') - Number(coverage[a.area].status === 'NOT_INVESTIGATED'));
      const previousSearches = await db().researchReport.aggregate({
        where: { workspaceId, leadId: lead?.id ?? null, ...(lead ? {} : { companyId: company?.id ?? null }) },
        _sum: { searchCount: true },
      });
      const searchBudgetRemaining = Math.max(0, rules.maxSearchesPerProspect - (previousSearches._sum.searchCount ?? 0));
      const stageSearchLimit = rules.maxSearchQueriesPerRun;
      for (const { query, area, after } of queries) {
        if (searchCount >= Math.min(stageSearchLimit, searchBudgetRemaining)) break;
        if (!eligibleOnRetry(area)) continue;
        if (previous?.evidence.some((item) => item.url === `search:${settings.searchProvider}?q=${encodeURIComponent(query)}`)) continue;
        if (after && after !== queries.find((entry) => entry.area === 'signals')?.after &&
          evidence.some((item) => evidenceAreas.get(item.id)?.has('signals') && item.publishedAt &&
            item.publishedAt.getTime() >= Date.now() - signalWindows[0] * 86_400_000)) continue;
        try {
          attemptedAreas.add(area);
          searchCount++;
          await db().researchReport.update({ where: { id: report.id }, data: { searchCount: (previous?.searchCount ?? 0) + searchCount } });
          const hits: SearchHit[] = await adapters().search[settings.searchProvider].search(sec.secret, query, 5);
          for (const hit of hits) {
            try {
              const { hostname } = new URL(hit.url);
              if (!isRestrictedResearchHost(hostname)) continue;
              const restrictedArea = /linkedin\.com$/i.test(hostname) ? 'linkedin'
                : /youtube\.com$|youtu\.be$/i.test(hostname) ? 'interviews' : 'social';
              unavailableAreas.add(restrictedArea);
              if (coverage[restrictedArea].status === 'NOT_INVESTIGATED') coverage[restrictedArea] = {
                status: 'INACCESSIBLE', detail: 'A restricted platform was discovered. No content was retrieved.',
              };
            } catch { /* Ignore malformed discovery URLs. */ }
          }
          const accessible = hits.filter((hit) => {
            try { return !isRestrictedResearchHost(new URL(hit.url).hostname); } catch { return false; }
          });
          await recordUsage(workspaceId, settings.searchProvider, 'web_search', 1, { leadId: lead?.id ?? null, companyId: company?.id ?? null, campaignId: target.campaignId ?? null, reportId: report.id, researchDepth: depth });
          if (!hits.length) {
            inspectedAreas.add(area);
            if (coverage[area].status === 'NOT_INVESTIGATED') coverage[area] = { status: 'COMPLETED', detail: 'Search completed. No accessible results found.' };
            continue;
          }
          const snippetDoc = hits.map((h) => `${h.title} — ${h.snippet} (${h.url})`).join('\n');
          await addEvidence('SEARCH_RESULT', `search:${settings.searchProvider}?q=${encodeURIComponent(query)}`, `Search results for ${query}`, snippetDoc);
          for (const h of accessible.slice(0, 2)) {
            if (pageCount >= rules.maxPagesPerRun || visited.has(sourceUrlKey(h.url))) continue;
            try { await fetchAndStore(h.url, 'SEARCH_RESULT', area); } catch (e) { errors.push(`Discovered source: ${(e as Error).message}`); }
          }
        } catch (e) {
          if (coverage[area].status === 'NOT_INVESTIGATED') coverage[area] = { status: 'FAILED', detail: 'Search provider request failed.' };
          errors.push(`search: ${(e as Error).message}`); }
      }
    }
  }

  if (!evidence.some((e) => !e.url.startsWith('search:'))) {
    await db().researchReport.update({ where: { id: report.id }, data: {
      status: previous?.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED', coverage: reportCoverage(),
      searchCount: (previous?.searchCount ?? 0) + searchCount, pageCount: (previous?.pageCount ?? 0) + pageCount, error: [...errors, ...(!retainedSources && searchUnavailable ? [searchUnavailable] : [])].join('; ').slice(0, 1000) || (retainedSources ? null : 'No usable sources were collected.'), completedAt: previous?.status === 'COMPLETED' ? previous.completedAt : new Date() } });
    if (previous) await publish(workspaceId, 'research.completed', { reportId: report.id, leadId: lead?.id });
    return { reportId: report.id, claims: 0 };
  }

  // 3) AI extraction with mandatory evidence + verbatim quote check
  const fetchedEvidence = evidence.filter((e) => !e.url.startsWith('search:'));
  const documents = fetchedEvidence.map((e) => `<document evidenceId="${e.id}" url="${neutralizeTags(e.url)}"${e.publishedAt ? ` publishedAt="${e.publishedAt.toISOString()}"` : ''}>\n${wrapUntrusted('web', e.content, 12_000)}\n</document>`).join('\n');
  const subject = [lead && `${lead.firstName ?? ''} ${lead.lastName ?? ''} (${lead.title ?? 'unknown title'})`, company && `${company.name} (${domain ?? 'no domain'})`].filter(Boolean).join(' at ')
    + `\nResearch focus (from the workspace's research instructions — extract facts about these topics only when the documents state them):\n${researchFocusText(rules)}\nWorkspace-approved research priorities and targeting guidance are reference data, not prospect evidence.\n${wrapUntrusted('imported_research_guidance', researchStrategy.map(item => item.text).join('\n'), 4500)}\nResearch policy: return at most eight concise, distinct claims; prefer original sources, record only explicitly documented facts, distinguish publication and event dates, and require explicit name and employer evidence before attributing any activity. A video title is not a transcript. Keep opportunity suggestions separate from factual claims. Use categories professional_identity, professional_background, service, business_model, audience, content, interview, signal and opportunity where appropriate. Prioritize signals from the last ${signalWindows[0]} days, falling back to ${signalWindows[1]} days.`;
  const extract = async (extractionSubject: string, input: string) =>
    (await runAi<FactExtraction>(workspaceId, 'FACT_EXTRACTION', { subject: extractionSubject, documents: input }, {
      entity: { type: 'research_report', id: report.id },
      attribution: { campaignId: target.campaignId ?? null, leadId: lead?.id ?? null },
      maxLeadCostUsd: researchCostLimit,
    })).data;

  let extraction: FactExtraction;
  try {
    extraction = await extract(subject, documents).catch((error: unknown) => {
      if (!(error instanceof AppError) || error.code !== 'AI_OUTPUT_LIMIT') throw error;
      const compactDocuments = fetchedEvidence.map((e) =>
        `<document evidenceId="${e.id}" url="${neutralizeTags(e.url)}">\n${wrapUntrusted('web', e.content, 3500)}\n</document>`).join('\n');
      return extract(subject.replace('at most eight concise', 'at most two concise') + ' Keep the summary to one sentence and leave optional fields empty unless directly supported.', compactDocuments);
    });
  } catch (e) {
    await db().researchReport.update({ where: { id: report.id }, data: { status: previous?.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED', coverage: reportCoverage(true), pageCount: (previous?.pageCount ?? 0) + pageCount, searchCount: (previous?.searchCount ?? 0) + searchCount, error: `Evidence saved but AI extraction failed: ${(e as Error).message}`.slice(0, 1000), completedAt: previous?.status === 'COMPLETED' ? previous.completedAt : new Date() } });
    if (previous) await publish(workspaceId, 'research.completed', { reportId: report.id, leadId: lead?.id });
    return { reportId: report.id, claims: 0 };
  }
  const byId = new Map(fetchedEvidence.map((e) => [e.id, e]));
  const seenClaims = new Set(previous?.claims.map((claim) => claim.text.trim().toLowerCase().replace(/\s+/g, ' ')));
  const subjectForIdentity = { firstName: lead?.firstName, lastName: lead?.lastName, companyName: company?.name };
  const kept = extraction.claims.filter((claim) => {
    const key = claim.text.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!key || seenClaims.has(key) || !quoteIsSupported(claim.quote, byId.get(claim.evidenceId)?.content ?? '')) return false;
    if (claim.category === 'professional_identity' && !verifyProspectIdentity(subjectForIdentity, 'VERIFIED',
      [claim.evidenceId], [{ id: claim.evidenceId, text: claim.quote, category: claim.category, sourceType: 'WEBSITE' }]).verified) return false;
    seenClaims.add(key);
    return true;
  });
  for (const [area, entry] of Object.entries(coverage)) {
    if (entry.status !== 'PARTIAL' || ![...evidenceAreas.values()].some((areas) => areas.has(area as ResearchArea))) continue;
    const count = kept.filter((claim) => evidenceAreas.get(claim.evidenceId)?.has(area as ResearchArea)).length;
    coverage[area as ResearchArea] = {
      status: count ? 'PARTIAL' : 'COMPLETED',
      detail: count ? `${count} cited finding(s) awaiting review.` : 'Sources checked. No relevant findings extracted.',
    };
  }
  if (lead && coverage.identity.status === 'NOT_INVESTIGATED') {
    coverage.identity = { status: 'PARTIAL', detail: 'Public sources were checked. No reviewed identity match is available.' };
  }
  if (lead && kept.some((claim) => claim.category === 'professional_identity')) {
    coverage.identity = { status: 'PARTIAL', detail: 'Identity evidence is awaiting review.' };
  }
  const sourceCount = new Set(kept.map((claim) => new URL(byId.get(claim.evidenceId)!.url).hostname.replace(/^www\./, ''))).size;
  if (kept.length || !previous?.claims.length) coverage.evidence = {
    status: sourceCount ? 'PARTIAL' : 'FAILED',
    detail: sourceCount ? `${sourceCount} distinct source host(s) with cited findings awaiting review.` : 'No cited findings were extracted.',
  };
  if (kept.length) await db().researchClaim.createMany({
    data: kept.map((c) => ({ workspaceId, reportId: report.id, evidenceId: c.evidenceId, category: c.category, text: c.text, quote: c.quote, confidence: c.confidence, status: 'NEEDS_REVIEW' })),
  });
  // Summary fields are only stored when at least one supported claim backs the research.
  await db().researchReport.update({
    where: { id: report.id },
    data: {
      status: 'COMPLETED', coverage: reportCoverage(), completedAt: new Date(), searchCount: (previous?.searchCount ?? 0) + searchCount,
      pageCount: (previous?.pageCount ?? 0) + pageCount, summary: kept.length ? extraction.summary : previous?.summary,
      industry: kept.some((c) => c.category === 'industry') ? extraction.industry : previous?.industry,
      services: kept.some((c) => c.category === 'service') ? [...new Set([...(previous?.services ?? []), ...extraction.services])] : previous?.services ?? [],
      audience: kept.some((c) => c.category === 'audience') ? extraction.audience : previous?.audience,
      businessModel: kept.some((c) => c.category === 'business_model') ? extraction.businessModel : previous?.businessModel,
      error: [`${extraction.claims.length - kept.length} unsupported claim(s) discarded`, ...errors].filter((x) => !x.startsWith('0 ')).join('; ').slice(0, 1000) || null,
    },
  });
  if (!previous && lead && kept.length && lead.status === 'NEW') await db().lead.update({ where: { id: lead.id }, data: { status: 'RESEARCHED', statusChanges: { create: { workspaceId, fromStatus: 'NEW', toStatus: 'RESEARCHED', reason: 'research findings awaiting review' } } } });
  await publish(workspaceId, 'research.completed', { reportId: report.id, leadId: lead?.id });
  return { reportId: report.id, claims: kept.length, discarded: extraction.claims.length - kept.length };
}

export async function getReport(workspaceId: string, id: string) {
  const r = await db().researchReport.findFirst({ where: { id, workspaceId }, include: { evidence: { select: { id: true, url: true, title: true, sourceType: true, fetchedAt: true, publishedAt: true, httpStatus: true } }, claims: { include: { evidence: { select: { url: true, title: true, fetchedAt: true, publishedAt: true } } } }, lead: { select: { id: true, email: true, firstName: true, lastName: true } }, company: { select: { id: true, name: true, domain: true } } } });
  if (!r) throw NotFound('Research report');
  const grounded = r.claims.filter((claim) => claim.status === 'SUPPORTED' && claim.category !== 'opportunity' && !claim.evidence.url.startsWith('search:'));
  const { retry, sourceProvenance, pendingExtractionIds: _pending, ...savedAreas } = (r.coverage ?? {}) as Partial<ReturnType<typeof initialCoverage>> & {
    retry?: unknown; sourceProvenance?: unknown; pendingExtractionIds?: string[];
  };
  const areas = { ...initialCoverage(), ...savedAreas };
  const { getConfig } = await import('./ai-studio.js');
  const { data: policy } = await getConfig(workspaceId, 'RESEARCH');
  const signalCutoff = Date.now() - Math.max(policy.recentSignalDays, policy.extendedSignalDays) * 86_400_000;
  if (grounded.some((claim) => claim.category === 'signal' && (claim.evidence.publishedAt?.getTime() ?? 0) >= signalCutoff)) {
    areas.signals = { status: 'COMPLETED', detail: 'Reviewed signals with publication dates inside the configured window.' };
  }
  const categories = new Set(grounded.map((claim) => claim.category));
  const verifiedAreas: Partial<Record<ResearchArea, string[]>> = {
    company: ['service', 'industry', 'audience', 'business_model'], background: ['professional_background'],
    linkedin: ['linkedin'], social: ['social'], interviews: ['interview'],
  };
  for (const [area, kinds] of Object.entries(verifiedAreas)) {
    if (kinds.some((kind) => categories.has(kind))) areas[area as ResearchArea] = { status: 'COMPLETED', detail: 'Reviewed source-backed findings are available.' };
  }
  const score = r.leadId ? await db().leadScore.findFirst({ where: { workspaceId, leadId: r.leadId }, orderBy: { createdAt: 'desc' }, select: { reasons: true } }) : null;
  const identity = Array.isArray(score?.reasons) && score.reasons.some((reason) => {
    const entry = reason as { criterion?: string; identityStatus?: string; claimIds?: string[] } | null;
    return entry?.criterion === 'professional_identity' && entry.identityStatus === 'VERIFIED' &&
      entry.claimIds?.some((id) => grounded.some((claim) => claim.id === id));
  });
  if (identity) areas.identity = { status: 'COMPLETED', detail: 'Professional identity verified against reviewed evidence.' };
  const distinctSources = new Set(grounded.map((claim) => { try { return new URL(claim.evidence.url).hostname.replace(/^www\./, ''); } catch { return ''; } }).filter(Boolean)).size;
  if (grounded.length) areas.evidence = { status: distinctSources >= 2 ? 'COMPLETED' : 'PARTIAL', detail: `${distinctSources} distinct source host(s) with reviewed evidence.` };
  const missingInformation = [
    ...(r.lead && (!r.lead.firstName || !r.lead.lastName || !categories.has('professional_identity')) ? ['Professional identity evidence'] : []),
    ...(!r.company || !grounded.some((claim) => !['professional_identity', 'content'].includes(claim.category)) ? ['Company and offering evidence'] : []),
    ...(!categories.has('content') && !categories.has('signal') ? ['Relevant published content or company activity'] : []),
  ];
  const evidenceQuality = grounded.length === 0 ? (r.claims.some((claim) => claim.status === 'NEEDS_REVIEW') ? 'AWAITING_REVIEW' : 'INSUFFICIENT') : grounded.some((claim) => claim.confidence >= 0.8) ? 'HAS_HIGH_CONFIDENCE_CITATIONS' : 'LIMITED';
  const researchCompleteness = overallCoverage(areas);
  return { ...r, coverage: { areas, retry, sourceProvenance, researchCompleteness, evidenceQuality, supportedClaims: grounded.length, missingInformation } };
}

export async function listReports(workspaceId: string, q: { page: number; pageSize: number; status?: string }) {
  const where = { workspaceId, ...(q.status ? { status: q.status as never } : {}) };
  const [items, total] = await Promise.all([
    db().researchReport.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { lead: { select: { id: true, email: true, firstName: true, lastName: true } }, company: { select: { id: true, name: true } }, _count: { select: { claims: true, evidence: true } } } }),
    db().researchReport.count({ where }),
  ]);
  return { items, total };
}

export async function setClaimStatus(workspaceId: string, claimId: string, status: 'SUPPORTED' | 'REJECTED', actor: Actor) {
  const evidence = status === 'SUPPORTED' ? { NOT: { url: { startsWith: 'search:' } } } : undefined;
  await db().$transaction(async (tx) => {
    const result = await tx.researchClaim.updateMany({ where: { id: claimId, workspaceId, evidence }, data: { status } });
    if (!result.count) throw NotFound('Claim');
    if (status === 'REJECTED') {
      await tx.intelligenceEmbedding.updateMany({
        where: { workspaceId, entityType: 'RESEARCH_CLAIM', entityId: claimId, isCurrent: true }, data: { isCurrent: false },
      });
      await tx.leadPersonalization.updateMany({
        where: {
          workspaceId, status: { in: ['GENERATED', 'APPROVED'] },
          OR: [
            { usedClaimIds: { has: claimId } },
            { scoreExplanation: { path: ['opportunityAnalysis', 'serviceMatchClaimIds'], array_contains: [claimId] } },
          ],
        },
        data: {
          status: 'BLOCKED', qualityPassed: false, approvedContentHash: null, approvedAt: null, approvedById: null,
          error: 'A cited research claim was rejected. Regenerate and review this email.',
        },
      });
    }
  });
  await audit(workspaceId, actor, 'research.claim_status', { type: 'claim', id: claimId }, { status });
}

/** Personal reports belong only to their lead. Company-only reports can be shared. */
export function prospectReportScope(leadId: string, companyId: string | null): Prisma.ResearchReportWhereInput {
  return { OR: [{ leadId }, ...(companyId ? [{ leadId: null, companyId }] : [])] };
}

export async function currentProspectReportIds(workspaceId: string, leadId: string, companyId: string | null) {
  const latest = (subject: Prisma.ResearchReportWhereInput) => db().researchReport.findFirst({
    where: { workspaceId, status: 'COMPLETED', ...subject },
    orderBy: [{ completedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  const [personal, company] = await Promise.all([
    latest({ leadId }),
    companyId ? latest({ leadId: null, companyId }) : null,
  ]);
  return [personal?.id, company?.id].filter((id): id is string => !!id);
}

export async function supportedClaims(workspaceId: string, leadId: string) {
  const lead = await db().lead.findFirst({ where: { id: leadId, workspaceId } });
  if (!lead) throw NotFound('Lead');
  const { getConfig } = await import('./ai-studio.js');
  const [reportIds, { data: policy }] = await Promise.all([
    currentProspectReportIds(workspaceId, leadId, lead.companyId), getConfig(workspaceId, 'RESEARCH'),
  ]);
  const { companyWebsite, webSearch, dataProvider, userProvided } = policy.permittedSources;
  const sourceTypes: Array<'WEBSITE' | 'SEARCH_RESULT' | 'DATA_PROVIDER' | 'USER_PROVIDED'> = [];
  if (companyWebsite) sourceTypes.push('WEBSITE');
  if (webSearch) sourceTypes.push('SEARCH_RESULT');
  if (dataProvider) sourceTypes.push('DATA_PROVIDER');
  if (userProvided) sourceTypes.push('USER_PROVIDED');
  const cutoff = policy.maxEvidenceAgeDays === null ? undefined : new Date(Date.now() - policy.maxEvidenceAgeDays * 86_400_000);
  return db().researchClaim.findMany({
    where: {
      workspaceId, status: 'SUPPORTED', category: { not: 'opportunity' }, reportId: { in: reportIds },
      evidence: { NOT: { url: { startsWith: 'search:' } }, sourceType: { in: sourceTypes }, ...(cutoff ? { fetchedAt: { gte: cutoff } } : {}) },
    },
    include: { evidence: { select: { url: true, sourceType: true, fetchedAt: true } } },
    orderBy: { createdAt: 'desc' },
    take: 40,
  });
}

function claimsBlock(claims: Array<{ id: string; text: string; quote?: string; evidence: { url: string } }>) {
  return claims.length ? claims.map((c) => `- [${c.id}] ${wrapUntrusted('claim', c.text, 1000)} ${c.quote ? wrapUntrusted('source excerpt', c.quote, 1200) : ''} (source: ${neutralizeTags(c.evidence.url)})`).join('\n') : '(no supported claims — do not state any specific facts about the prospect)';
}

// ---------------------------------------------------------------- scoring

export async function scoreLead(workspaceId: string, leadId: string, icpId?: string | null) {
  const lead = await db().lead.findFirst({ where: { id: leadId, workspaceId }, include: { company: true } });
  if (!lead) return null;
  const icp = icpId ? await db().idealCustomerProfile.findFirst({ where: { id: icpId, workspaceId, isActive: true } }) : await db().idealCustomerProfile.findFirst({ where: { workspaceId, isActive: true }, orderBy: { createdAt: 'asc' } });
  if (!icp) throw new AppError('ICP_REQUIRED', 'Create an ICP before scoring leads.', 400);
  const criteria = IcpCriteriaSchema.parse(icp.criteria);
  const revision = await db().idealCustomerProfileRevision.findFirst({
    where: { workspaceId, icpId: icp.id, version: icp.version }, select: { data: true },
  });
  const revisionData = revision?.data as { provenance?: { weights?: Array<{ criterion: string; weight: number }> } } | null;
  const scoringWeights = revisionData?.provenance?.weights ?? [];
  const companyFields = lead.company?.customFields as Record<string, unknown> | null | undefined;
  const exclusionsForWorkspace = await getImportExclusions(workspaceId, {
    industry: lead.company?.industry, geography: lead.country ?? lead.company?.country, title: lead.title,
    companyType: typeof companyFields?.companyType === 'string' ? companyFields.companyType : null,
  });
  criteria.disqualifiers = [...new Set([...criteria.disqualifiers, ...exclusionsForWorkspace.flatMap(rule => rule.conditions)])];
  const matchedWorkspaceExclusions = exclusionsForWorkspace.filter(rule => rule.match);
  const { getConfig } = await import('./ai-studio.js');
  const { data: research } = await getConfig(workspaceId, 'RESEARCH');
  const cutoff = research.maxEvidenceAgeDays === null ? 0 : Date.now() - research.maxEvidenceAgeDays * 86_400_000;
  const allowedSources: Record<string, boolean> = {
    WEBSITE: research.permittedSources.companyWebsite,
    SEARCH_RESULT: research.permittedSources.webSearch,
    DATA_PROVIDER: research.permittedSources.dataProvider,
    USER_PROVIDED: research.permittedSources.userProvided,
  };
  const claims = (await supportedClaims(workspaceId, leadId))
    .filter((c) => allowedSources[c.evidence.sourceType] && c.evidence.fetchedAt.getTime() >= cutoff);
  const evidenceSufficient = claims.length >= Math.max(1, research.minClaims);
  const workspace = await db().workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
  const leadJson = JSON.stringify({ firstName: lead.firstName, lastName: lead.lastName, title: lead.title, country: lead.country, city: lead.city, company: lead.company ? { name: lead.company.name, industry: lead.company.industry, employees: lead.company.employeeCount, services: lead.company.services, audience: lead.company.audience } : null });
  const r = await runAi<{ score: number; reasons: Array<{ criterion: string; met: boolean; explanation: string; claimIds: string[] }>; risks: string[]; identityAssessment: { status: 'VERIFIED' | 'AMBIGUOUS' | 'MISMATCH' | 'UNKNOWN'; evidenceClaimIds: string[]; reason: string } }>(
    workspaceId, 'LEAD_QUALIFICATION', { icp: JSON.stringify({
      ...criteria,
      ...(scoringWeights.length ? { scoringWeights } : {}),
      reasonRequirements: 'Return one reason for each mustHave, disqualifiers and scoringWeights criterion using its exact rule text. For a disqualifier, met=true means the exclusion applies. Cite evidence whenever a required, scored or exclusion criterion applies.',
    }), lead: wrapUntrusted('lead-data', leadJson, 4000), claims: claimsBlock(claims) }, { entity: { type: 'lead', id: leadId }, attribution: { leadId }, maxLeadCostUsd: readSettings(workspace?.settings).aiMaxCostPerLeadUsd },
  );
  const validIds = new Set(claims.map((c) => c.id));
  const reasons = r.data.reasons.map((x) => ({ ...x, claimIds: x.claimIds.filter((id) => validIds.has(id)) }));
  const identityEvidenceIds = r.data.identityAssessment.evidenceClaimIds.filter((id) => validIds.has(id));
  const identity = verifyProspectIdentity({ firstName: lead.firstName, lastName: lead.lastName, companyName: lead.company?.name }, r.data.identityAssessment.status, identityEvidenceIds, claims.map((c) => ({ id: c.id, text: c.quote, category: c.category, sourceType: c.evidence.sourceType })));
  const identityStatus = identity.verified ? 'VERIFIED' as const
    : identity.reason === 'Identity is ambiguous in research.' ? 'AMBIGUOUS' as const
      : /conflicting|different person|did not match/i.test(identity.reason) || r.data.identityAssessment.status === 'MISMATCH' ? 'MISMATCH' as const
        : 'UNKNOWN' as const;
  let score = Math.max(0, Math.min(100, Math.round(r.data.score)));
  const risks = [...r.data.risks, ...matchedWorkspaceExclusions.map(rule => `Workspace exclusion: ${rule.name}`)];
  if (!identity.verified) risks.push(identity.reason);
  // Deterministic guardrails on top of the model.
  const countryExcluded = !!(criteria.countries.length && lead.country && !criteria.countries.includes(lead.country));
  if (countryExcluded) { score = Math.min(score, 30); risks.push(`Country ${lead.country} is outside the ICP`); }
  const size = lead.company?.employeeCount;
  const sizeExcluded = size != null && ((criteria.employeeMin != null && size < criteria.employeeMin) || (criteria.employeeMax != null && size > criteria.employeeMax));
  if (sizeExcluded) { score = Math.min(score, 40); risks.push('Company headcount is outside the ICP range'); }
  const criterionKey = (label: string) => label.trim().toLowerCase();
  const matchingReason = (criterion: string) => reasons.find((reason) => criterionKey(reason.criterion) === criterionKey(criterion));
  const uncheckedWeights = scoringWeights.filter(rule => !matchingReason(rule.criterion));
  if (scoringWeights.length) {
    const total = scoringWeights.reduce((sum, rule) => sum + rule.weight, 0);
    const earned = scoringWeights.reduce((sum, rule) => {
      const result = matchingReason(rule.criterion);
      return sum + (result?.met && result.claimIds.length ? rule.weight : 0);
    }, 0);
    score = Math.min(score, Math.round(100 * earned / total));
  }
  const missingRequired = criteria.mustHave.filter((criterion) => {
    const reason = matchingReason(criterion);
    return !reason?.met || !reason.claimIds.length;
  });
  const exclusions = criteria.disqualifiers.filter((criterion) => matchingReason(criterion)?.met);
  const uncheckedExclusions = criteria.disqualifiers.filter((criterion) => !matchingReason(criterion));
  risks.push(...missingRequired.map((criterion) => `Required ICP evidence missing: ${criterion}`),
    ...exclusions.map((criterion) => `ICP exclusion: ${criterion}`),
    ...uncheckedExclusions.map((criterion) => `ICP exclusion still needs checking: ${criterion}`),
    ...uncheckedWeights.map((rule) => `Weighted ICP criterion still needs checking: ${rule.criterion}`));
  const tier = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
  // ICP fit, professional identity and contactability are separate decisions.
  // The overall outreach decision remains HOLD when identity is unverified.
  const qualification = evaluateIcpQualification(score, icp.minScore);
  const incompleteFit = !evidenceSufficient || missingRequired.length > 0 || uncheckedExclusions.length > 0 || uncheckedWeights.length > 0;
  const excluded = countryExcluded || sizeExcluded || exclusions.length > 0 || matchedWorkspaceExclusions.length > 0;
  const qualified = qualification.qualified && !incompleteFit && !excluded && reasons.some((reason) => reason.met && reason.claimIds.length > 0);
  if (!evidenceSufficient) risks.push('Insufficient current evidence for ICP qualification.');
  await db().$transaction(async (tx) => {
    await tx.leadScore.create({ data: { workspaceId, leadId, icpId: icp.id, score, tier, qualified, reasons: [...reasons, { criterion: 'professional_identity', met: identity.verified, identityStatus, explanation: identity.verified ? identity.reason : `${identity.reason} ${r.data.identityAssessment.reason}`.trim(), claimIds: identity.claimIds }] as Prisma.InputJsonValue, risks } });
    await tx.lead.update({ where: { id: leadId }, data: { currentScore: score } });
    await tx.lead.updateMany({
      where: { id: leadId, workspaceId, qualificationReview: 'QUALIFIED' },
      data: { qualificationReview: 'NEEDS_REVIEW', qualificationReviewScoreId: null, qualificationReviewReason: 'ICP score changed. Review the new assessment.' },
    });
    if (['NEW', 'RESEARCHED'].includes(lead.status)) {
      const to = !identity.verified || incompleteFit ? 'RESEARCHED' : qualified ? 'QUALIFIED' : 'DISQUALIFIED';
      await tx.lead.update({ where: { id: leadId }, data: { status: to } });
      await tx.leadStatusChange.create({ data: { workspaceId, leadId, fromStatus: lead.status, toStatus: to, reason: `ICP score ${score} (${icp.name})` } });
    }
  });
  await emitEvent(workspaceId, 'lead.scored', `${leadId}:${r.executionId}`, { leadId, score, qualified, tier });
  await publish(workspaceId, 'lead.updated', { leadId });
  return { score, tier, qualified, qualificationDecision: qualified ? qualification.decision : 'NOT_QUALIFIED', decision: !identity.verified || incompleteFit ? 'HOLD' : qualified ? 'QUALIFIED' : 'REJECTED', identityVerified: identity.verified, identityStatus, identityReason: identity.reason, identityEvidenceClaimIds: identity.claimIds };
}

// ---------------------------------------------------------------- writing & fact-check

export function leadVars(lead: { firstName: string | null; lastName: string | null; email: string; title: string | null; city: string | null; country: string | null; customFields: unknown; company?: { name: string; website: string | null; industry: string | null } | null }, extra: Record<string, unknown> = {}) {
  return {
    firstName: lead.firstName ?? '', lastName: lead.lastName ?? '', fullName: [lead.firstName, lead.lastName].filter(Boolean).join(' '),
    email: lead.email, title: lead.title ?? '', city: lead.city ?? '', country: lead.country ?? '',
    company: { name: lead.company?.name ?? '', website: lead.company?.website ?? '', industry: lead.company?.industry ?? '' },
    custom: (lead.customFields ?? {}) as Record<string, string>,
    ...extra,
  };
}

export async function factCheck(
  workspaceId: string, leadId: string, email: string, offerFacts: string,
  opts: { claims?: Array<{ id: string; text: string; quote?: string; evidence: { url: string } }>; attribution?: { campaignId?: string | null; leadId?: string | null }; maxLeadCostUsd?: number | null } = {},
) {
  const lead = await db().lead.findFirst({ where: { id: leadId, workspaceId }, include: { company: true } });
  if (!lead) throw NotFound('Lead');
  const claims = opts.claims ?? await supportedClaims(workspaceId, leadId);
  const r = await runAi<FactCheck>(workspaceId, 'FACT_CHECK', {
    email: neutralizeTags(email), offer: offerFacts || '(none provided)',
    lead: JSON.stringify({ firstName: lead.firstName, lastName: lead.lastName, title: lead.title, company: lead.company?.name, website: lead.company?.website }),
    claims: claimsBlock(claims),
  }, { entity: { type: 'lead', id: leadId }, attribution: opts.attribution, maxLeadCostUsd: opts.maxLeadCostUsd });
  const valid = new Set(claims.map((c) => c.id));
  const sentences = r.data.sentences.map((s) => (s.verdict === 'SUPPORTED' && (!s.claimId || !valid.has(s.claimId)) ? { ...s, verdict: 'UNSUPPORTED' as const, reason: `${s.reason} (cited claim not found)` } : s));
  const passed = sentences.length > 0 && sentences.every((s) => s.verdict !== 'UNSUPPORTED') && !hasUnresolvedVariables(email);
  return { passed, sentences, executionId: r.executionId };
}

export const GenerateSchema = z.object({
  leadId: z.string().uuid(),
  mode: z.enum(['first_line', 'full', 'followup']).default('full'),
  templateSubject: z.string().max(300).default(''),
  templateBody: z.string().max(8000).default(''),
  previousEmails: z.string().max(8000).default(''),
  instructions: z.string().max(2000).default(''),
});

export async function generateEmail(workspaceId: string, input: z.infer<typeof GenerateSchema>) {
  const lead = await db().lead.findFirst({ where: { id: input.leadId, workspaceId }, include: { company: true } });
  if (!lead) throw NotFound('Lead');
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const offer = readSettings(ws.settings).offerFacts;
  const claims = await supportedClaims(workspaceId, lead.id);
  const leadJson = JSON.stringify({ firstName: lead.firstName, title: lead.title, company: lead.company?.name, industry: lead.company?.industry });
  const task = input.mode === 'followup' ? 'FOLLOWUP_WRITING' : 'EMAIL_WRITING';
  const r = await runAi<{ subject: string | null; firstLine: string | null; body: string | null; usedClaimIds: string[] }>(workspaceId, task, {
    mode: input.mode, offer: offer || '(none provided)', template: `${input.templateSubject}\n\n${input.templateBody}`,
    lead: wrapUntrusted('lead-data', leadJson, 2000), claims: claimsBlock(claims), instructions: input.instructions || '(none)',
    previous: wrapUntrusted('previous-emails', input.previousEmails, 8000),
  }, { entity: { type: 'lead', id: lead.id } });
  const valid = new Set(claims.map((c) => c.id));
  const usedClaimIds = r.data.usedClaimIds.filter((id) => valid.has(id));
  const text = input.mode === 'first_line' ? r.data.firstLine ?? '' : `${r.data.subject ?? ''}\n${r.data.body ?? ''}`;
  const check = await factCheck(workspaceId, lead.id, text, offer);
  return { subject: r.data.subject, firstLine: r.data.firstLine, body: r.data.body, usedClaimIds, claims: claims.filter((c) => usedClaimIds.includes(c.id)), factCheck: check, executionId: r.executionId };
}

export async function subjectLines(workspaceId: string, leadId: string, body: string, count: number) {
  const lead = await db().lead.findFirst({ where: { id: leadId, workspaceId }, include: { company: true } });
  if (!lead) throw NotFound('Lead');
  const r = await runAi<{ subjects: string[] }>(workspaceId, 'SUBJECT_LINES', { body: wrapUntrusted('draft', body, 6000), lead: JSON.stringify({ firstName: lead.firstName, company: lead.company?.name }), count: String(count) });
  return r.data.subjects.slice(0, count);
}

export function assertNoSecretsInDraft(text: string) {
  if (/\{\{[^}]+\}\}/.test(text)) throw BadRequest('UNRESOLVED_VARIABLES', 'Draft still contains {{variables}}');
}

export { logger as _intelligenceLogger };
