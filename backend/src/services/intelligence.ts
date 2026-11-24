import { z } from 'zod';
import { CampaignAiOverridesSchema, researchFocusText } from '../../../shared/src/ai-studio.js';
import { db, Prisma } from '../core/db.js';
import { adapters } from '../core/container.js';
import { AppError, BadRequest, NotFound } from '../core/errors.js';
import { audit, publish, type Actor } from '../core/audit.js';
import { sha256 } from '../core/crypto.js';
import { enqueue, QUEUES } from '../core/queues.js';
import { logger } from '../core/logger.js';
import { runAi } from './ai.js';
import { verifyProspectIdentity } from '../../../shared/src/identity.js';
import { evaluateIcpQualification } from '../../../shared/src/personalization-gates.js';
import { getSecret, recordUsage, requireSecret } from './integrations.js';
import { readSettings } from './workspace.js';
import { domainFromUrlOrEmail, isValidEmail, normalizeEmail, upsertCompany, LAWFUL_BASES } from './leads.js';
import { emitEvent } from './automation.js';
import { isSuppressed } from './compliance.js';
import { IcpCriteriaSchema, type FactCheck, type FactExtraction, type IcpCriteria } from '../../../shared/src/ai-schemas.js';
import { quoteIsSupported, wrapUntrusted, hasUnresolvedVariables, neutralizeTags } from '../../../integrations/src/ai/guard.js';
import type { ProspectResult } from '../../../integrations/src/providers/index.js';

// ---------------------------------------------------------------- ICP

export const IcpSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(4000).nullable().optional(),
  criteria: IcpCriteriaSchema,
  minScore: z.number().int().min(0).max(100).default(60),
  isActive: z.boolean().default(true),
});

export async function listIcps(workspaceId: string) {
  return db().idealCustomerProfile.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
}

export async function createIcp(workspaceId: string, input: z.infer<typeof IcpSchema>, actor: Actor) {
  const icp = await db().idealCustomerProfile.create({ data: { workspaceId, name: input.name, description: input.description ?? null, criteria: input.criteria as Prisma.InputJsonValue, minScore: input.minScore, isActive: input.isActive } });
  await audit(workspaceId, actor, 'icp.created', { type: 'icp', id: icp.id });
  return icp;
}

export async function updateIcp(workspaceId: string, id: string, input: z.infer<typeof IcpSchema>, actor: Actor) {
  const r = await db().idealCustomerProfile.updateMany({ where: { id, workspaceId }, data: { name: input.name, description: input.description ?? null, criteria: input.criteria as Prisma.InputJsonValue, minScore: input.minScore, isActive: input.isActive } });
  if (!r.count) throw NotFound('ICP');
  await audit(workspaceId, actor, 'icp.updated', { type: 'icp', id });
  return db().idealCustomerProfile.findUnique({ where: { id } });
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

const BLOCKED_HOSTS = /(^|\.)(linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com)$/i; // terms prohibit automated collection

export async function queueResearch(workspaceId: string, target: { leadId?: string; companyId?: string }, opts: { thenScore?: boolean } = {}) {
  if (target.leadId && !(await db().lead.findFirst({ where: { id: target.leadId, workspaceId } }))) throw NotFound('Lead');
  if (target.companyId && !(await db().company.findFirst({ where: { id: target.companyId, workspaceId } }))) throw NotFound('Company');
  await enqueue(QUEUES.research, target.leadId ? 'research.lead' : 'research.company', { workspaceId, ...target, thenScore: !!opts.thenScore });
  return { queued: true };
}

/** Worker: collect evidence, extract evidence-backed claims, store report. */
export async function runResearch(workspaceId: string, target: { leadId?: string; companyId?: string; campaignId?: string }) {
  const lead = target.leadId ? await db().lead.findFirst({ where: { id: target.leadId, workspaceId }, include: { company: true } }) : null;
  const company = lead?.company ?? (target.companyId ? await db().company.findFirst({ where: { id: target.companyId, workspaceId } }) : null);
  if (!lead && !company) return null;
  const report = await db().researchReport.create({ data: { workspaceId, leadId: lead?.id, companyId: company?.id, status: 'RUNNING' } });
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const settings = readSettings(ws.settings);
  // Research rules from AI Studio (+ campaign research overrides when research is run for a campaign).
  const { getConfig } = await import('./ai-studio.js');
  const rules = (await getConfig(workspaceId, 'RESEARCH')).data;
  if (target.campaignId) {
    const camp = await db().campaign.findFirst({ where: { id: target.campaignId, workspaceId }, select: { aiOverrides: true } });
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
  const evidence: Array<{ id: string; url: string; content: string; title: string | null }> = [];
  const errors: string[] = [];

  async function addEvidence(sourceType: 'WEBSITE' | 'SEARCH_RESULT', url: string, title: string | null, content: string, httpStatus?: number) {
    if (!content.trim()) return;
    const e = await db().researchEvidence.create({ data: { workspaceId, reportId: report.id, sourceType, url, title, content: content.slice(0, 30_000), contentHash: sha256(content), httpStatus } });
    evidence.push({ id: e.id, url, content: e.content, title });
  }

  // 1) Company website (home + a few same-host pages such as /about, /services)
  const domain = company?.domain ?? domainFromUrlOrEmail(company?.website ?? lead?.website ?? null);
  if (domain && rules.permittedSources.companyWebsite) {
    const home = `https://${domain}`;
    try {
      const page = await adapters().fetcher.fetchPage(home);
      await addEvidence('WEBSITE', page.url, page.title, page.text, page.status);
      const host = new URL(page.url).hostname;
      const interesting = [...new Set(page.links.map((l) => { try { return new URL(l, page.url).toString(); } catch { return null; } }).filter((u): u is string => !!u && new URL(u).hostname === host && /about|service|what-we-do|solutions|podcast|consult|team|work/i.test(u)))].slice(0, 3);
      for (const u of interesting) {
        try { const p = await adapters().fetcher.fetchPage(u); await addEvidence('WEBSITE', p.url, p.title, p.text, p.status); } catch (e) { errors.push(`${u}: ${(e as Error).message}`); }
      }
    } catch (e) { errors.push(`${home}: ${(e as Error).message}`); }
  }

  // 2) Web search via a licensed search API: general, interviews/podcasts, news — each only if permitted.
  if (settings.searchProvider !== 'none' && rules.permittedSources.webSearch) {
    const sec = await getSecret(workspaceId, settings.searchProvider);
    if (sec) {
      const person = lead ? [lead.firstName, lead.lastName].filter(Boolean).join(' ') : '';
      const queries: string[] = [];
      const base = [person && `"${person}"`, company?.name && `"${company.name}"`].filter(Boolean).join(' ') || domain || '';
      if (base) queries.push(base);
      if (person && rules.permittedSources.podcastsAndInterviews) queries.push(`"${person}" (podcast OR interview OR episode OR talk)`);
      if (company?.name && rules.permittedSources.newsAndArticles) queries.push(`"${company.name}" (announces OR launches OR news OR article)`);
      let fetched = 0;
      for (const query of queries.slice(0, 3)) {
        try {
          const hits = (await adapters().search[settings.searchProvider].search(sec.secret, query, 5)).filter((h) => { try { return !BLOCKED_HOSTS.test(new URL(h.url).hostname); } catch { return false; } });
          await recordUsage(workspaceId, settings.searchProvider, 'web_search', 1);
          if (!hits.length) continue;
          const snippetDoc = hits.map((h) => `${h.title} — ${h.snippet} (${h.url})`).join('\n');
          await addEvidence('SEARCH_RESULT', `search:${settings.searchProvider}?q=${encodeURIComponent(query)}`, `Search results for ${query}`, snippetDoc);
          for (const h of hits.slice(0, 2)) {
            if (fetched >= 4 || (domain && h.url.includes(domain))) continue;
            try { const pg = await adapters().fetcher.fetchPage(h.url); await addEvidence('SEARCH_RESULT', pg.url, pg.title, pg.text, pg.status); fetched++; } catch (e) { errors.push(`${h.url}: ${(e as Error).message}`); }
          }
        } catch (e) { errors.push(`search: ${(e as Error).message}`); }
      }
    }
  }

  if (evidence.length === 0) {
    await db().researchReport.update({ where: { id: report.id }, data: { status: 'FAILED', error: errors.join('; ').slice(0, 1000) || 'No public sources available (no website or search provider).', completedAt: new Date() } });
    return { reportId: report.id, claims: 0 };
  }

  // 3) AI extraction with mandatory evidence + verbatim quote check
  const documents = evidence.map((e) => `<document evidenceId="${e.id}" url="${e.url}">\n${wrapUntrusted('web', e.content, 12_000)}\n</document>`).join('\n');
  const subject = [lead && `${lead.firstName ?? ''} ${lead.lastName ?? ''} (${lead.title ?? 'unknown title'})`, company && `${company.name} (${domain ?? 'no domain'})`].filter(Boolean).join(' at ')
    + `\nResearch focus (from the workspace's research instructions — extract facts about these topics only when the documents state them):\n${researchFocusText(rules)}`;
  let extraction: FactExtraction;
  try {
    extraction = (await runAi<FactExtraction>(workspaceId, 'FACT_EXTRACTION', { subject, documents }, { entity: { type: 'research_report', id: report.id } })).data;
  } catch (e) {
    await db().researchReport.update({ where: { id: report.id }, data: { status: 'FAILED', error: `Evidence saved but AI extraction failed: ${(e as Error).message}`.slice(0, 1000), completedAt: new Date() } });
    return { reportId: report.id, claims: 0 };
  }
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const kept = extraction.claims.filter((c) => byId.has(c.evidenceId) && quoteIsSupported(c.quote, byId.get(c.evidenceId)!.content));
  if (kept.length) {
    await db().researchClaim.createMany({ data: kept.map((c) => ({ workspaceId, reportId: report.id, evidenceId: c.evidenceId, category: c.category, text: c.text, quote: c.quote, confidence: c.confidence })) });
  }
  // Summary fields are only stored when at least one supported claim backs the research.
  await db().researchReport.update({
    where: { id: report.id },
    data: {
      status: 'COMPLETED', completedAt: new Date(), summary: kept.length ? extraction.summary : null,
      industry: kept.some((c) => c.category === 'industry') ? extraction.industry : null,
      services: kept.some((c) => c.category === 'service') ? extraction.services : [],
      audience: kept.some((c) => c.category === 'audience') ? extraction.audience : null,
      businessModel: kept.some((c) => c.category === 'business_model') ? extraction.businessModel : null,
      error: [`${extraction.claims.length - kept.length} unsupported claim(s) discarded`, ...errors].filter((x) => !x.startsWith('0 ')).join('; ').slice(0, 1000) || null,
    },
  });
  if (company && kept.length) {
    await db().company.update({ where: { id: company.id }, data: {
      industry: company.industry ?? (kept.some((c) => c.category === 'industry') ? extraction.industry : null),
      services: company.services.length ? company.services : kept.some((c) => c.category === 'service') ? extraction.services : [],
      audience: company.audience ?? (kept.some((c) => c.category === 'audience') ? extraction.audience : null),
      businessModel: company.businessModel ?? (kept.some((c) => c.category === 'business_model') ? extraction.businessModel : null),
      description: company.description ?? (kept.length ? extraction.summary : null),
    } });
  }
  if (lead && lead.status === 'NEW') await db().lead.update({ where: { id: lead.id }, data: { status: 'RESEARCHED', statusChanges: { create: { workspaceId, fromStatus: 'NEW', toStatus: 'RESEARCHED', reason: 'research completed' } } } });
  await publish(workspaceId, 'research.completed', { reportId: report.id, leadId: lead?.id });
  return { reportId: report.id, claims: kept.length, discarded: extraction.claims.length - kept.length };
}

export async function getReport(workspaceId: string, id: string) {
  const r = await db().researchReport.findFirst({ where: { id, workspaceId }, include: { evidence: { select: { id: true, url: true, title: true, sourceType: true, fetchedAt: true, httpStatus: true } }, claims: { include: { evidence: { select: { url: true, title: true } } } }, lead: { select: { id: true, email: true, firstName: true, lastName: true } }, company: { select: { id: true, name: true, domain: true } } } });
  if (!r) throw NotFound('Research report');
  return r;
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
  const r = await db().researchClaim.updateMany({ where: { id: claimId, workspaceId }, data: { status } });
  if (!r.count) throw NotFound('Claim');
  await audit(workspaceId, actor, 'research.claim_status', { type: 'claim', id: claimId }, { status });
}

/** Claims the writer may use: SUPPORTED claims from the latest completed reports for the lead/company. */
export async function supportedClaims(workspaceId: string, leadId: string) {
  const lead = await db().lead.findFirst({ where: { id: leadId, workspaceId } });
  if (!lead) throw NotFound('Lead');
  return db().researchClaim.findMany({
    where: { workspaceId, status: 'SUPPORTED', report: { status: 'COMPLETED', OR: [{ leadId }, ...(lead.companyId ? [{ companyId: lead.companyId }] : [])] } },
    include: { evidence: { select: { url: true, sourceType: true } } },
    orderBy: { createdAt: 'desc' },
    take: 40,
  });
}

function claimsBlock(claims: Array<{ id: string; text: string; evidence: { url: string } }>) {
  return claims.length ? claims.map((c) => `- [${c.id}] ${c.text} (source: ${c.evidence.url})`).join('\n') : '(no supported claims — do not state any specific facts about the prospect)';
}

// ---------------------------------------------------------------- scoring

export async function scoreLead(workspaceId: string, leadId: string, icpId?: string | null) {
  const lead = await db().lead.findFirst({ where: { id: leadId, workspaceId }, include: { company: true } });
  if (!lead) return null;
  const icp = icpId ? await db().idealCustomerProfile.findFirst({ where: { id: icpId, workspaceId } }) : await db().idealCustomerProfile.findFirst({ where: { workspaceId, isActive: true }, orderBy: { createdAt: 'asc' } });
  if (!icp) throw new AppError('ICP_REQUIRED', 'Create an ICP before scoring leads.', 400);
  const criteria = IcpCriteriaSchema.parse(icp.criteria);
  const claims = await supportedClaims(workspaceId, leadId);
  const leadJson = JSON.stringify({ firstName: lead.firstName, lastName: lead.lastName, title: lead.title, country: lead.country, city: lead.city, company: lead.company ? { name: lead.company.name, industry: lead.company.industry, employees: lead.company.employeeCount, services: lead.company.services, audience: lead.company.audience } : null });
  const r = await runAi<{ score: number; reasons: Array<{ criterion: string; met: boolean; explanation: string; claimIds: string[] }>; risks: string[]; identityAssessment: { status: 'VERIFIED' | 'AMBIGUOUS' | 'MISMATCH' | 'UNKNOWN'; evidenceClaimIds: string[]; reason: string } }>(
    workspaceId, 'LEAD_QUALIFICATION', { icp: JSON.stringify(criteria), lead: wrapUntrusted('lead-data', leadJson, 4000), claims: claimsBlock(claims) }, { entity: { type: 'lead', id: leadId } },
  );
  const validIds = new Set(claims.map((c) => c.id));
  const reasons = r.data.reasons.map((x) => ({ ...x, claimIds: x.claimIds.filter((id) => validIds.has(id)) }));
  const identityEvidenceIds = r.data.identityAssessment.evidenceClaimIds.filter((id) => validIds.has(id));
  const identity = verifyProspectIdentity({ firstName: lead.firstName, lastName: lead.lastName, companyName: lead.company?.name }, r.data.identityAssessment.status, identityEvidenceIds, claims.map((c) => ({ id: c.id, text: c.text, category: c.category, sourceType: c.evidence.sourceType })));
  const identityStatus = identity.verified ? 'VERIFIED' as const
    : identity.reason === 'Identity is ambiguous in research.' ? 'AMBIGUOUS' as const
      : /conflicting|different person|did not match/i.test(identity.reason) || r.data.identityAssessment.status === 'MISMATCH' ? 'MISMATCH' as const
        : 'UNKNOWN' as const;
  let score = Math.max(0, Math.min(100, Math.round(r.data.score)));
  const risks = [...r.data.risks];
  if (!identity.verified) risks.push(identity.reason);
  // Deterministic guardrails on top of the model.
  if (criteria.countries.length && lead.country && !criteria.countries.includes(lead.country)) { score = Math.min(score, 30); risks.push(`Country ${lead.country} is outside the ICP`); }
  if (criteria.employeeMax && lead.company?.employeeCount && lead.company.employeeCount > criteria.employeeMax * 2) { score = Math.min(score, 40); risks.push('Company is much larger than the ICP range'); }
  const tier = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
  // ICP fit, professional identity and contactability are separate decisions.
  // The overall outreach decision remains HOLD when identity is unverified.
  const qualification = evaluateIcpQualification(score, icp.minScore);
  const qualified = qualification.qualified;
  await db().$transaction(async (tx) => {
    await tx.leadScore.create({ data: { workspaceId, leadId, icpId: icp.id, score, tier, qualified, reasons: [...reasons, { criterion: 'professional_identity', met: identity.verified, identityStatus, explanation: identity.verified ? identity.reason : `${identity.reason} ${r.data.identityAssessment.reason}`.trim(), claimIds: identity.claimIds }] as Prisma.InputJsonValue, risks } });
    await tx.lead.update({ where: { id: leadId }, data: { currentScore: score } });
    if (['NEW', 'RESEARCHED'].includes(lead.status)) {
      const to = !identity.verified ? 'RESEARCHED' : qualified ? 'QUALIFIED' : 'DISQUALIFIED';
      await tx.lead.update({ where: { id: leadId }, data: { status: to } });
      await tx.leadStatusChange.create({ data: { workspaceId, leadId, fromStatus: lead.status, toStatus: to, reason: `ICP score ${score} (${icp.name})` } });
    }
  });
  await emitEvent(workspaceId, 'lead.scored', `${leadId}:${r.executionId}`, { leadId, score, qualified, tier });
  await publish(workspaceId, 'lead.updated', { leadId });
  return { score, tier, qualified, qualificationDecision: qualification.decision, decision: !identity.verified ? 'HOLD' : qualified ? 'QUALIFIED' : 'REJECTED', identityVerified: identity.verified, identityStatus, identityReason: identity.reason, identityEvidenceClaimIds: identity.claimIds };
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
  opts: { claims?: Array<{ id: string; text: string; evidence: { url: string } }>; attribution?: { campaignId?: string | null; leadId?: string | null }; maxLeadCostUsd?: number | null } = {},
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
  const passed = sentences.every((s) => s.verdict !== 'UNSUPPORTED') && !hasUnresolvedVariables(email);
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
