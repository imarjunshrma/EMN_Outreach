import { z } from 'zod';
import { sha256 } from '../core/crypto.js';
import { db, Prisma } from '../core/db.js';
import { adapters } from '../core/container.js';
import { AppError } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { neutralizeTags, quoteIsSupported, wrapUntrusted } from '../../../integrations/src/ai/guard.js';
import { runAi } from './ai.js';
import { KnowledgeSchema, type Knowledge } from '../../../shared/src/ai-studio.js';
import type { FactExtraction } from '../../../shared/src/ai-schemas.js';

export const WebsiteIntakeSchema = z.object({
  website: z.string().url().max(2000),
  urls: z.array(z.string().url().max(2000)).max(10).default([]),
});

const MAX_PAGES = 6;
const MAX_PAGE_CHARS = 20_000;
const SERVICE_CATEGORIES = new Set(['service']);

function normalizeWebsiteUrl(raw: string): URL {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80', '443'].includes(u.port))) {
    throw new AppError('VALIDATION_FAILED', 'Only public HTTP or HTTPS website URLs are allowed.', 400);
  }
  u.hash = '';
  u.search = '';
  return u;
}

/** Keep intake scoped to the user supplied business site and a small set of relevant pages. */
export function selectIntakePages(website: string, supplied: string[], links: string[]): string[] {
  const root = normalizeWebsiteUrl(website);
  const candidates = [root.toString(), ...supplied, ...links.filter((u) => /about|service|solution|offer|case[-_ ]?stud|client|result|work|team|pricing|products?|blog|articles?|insights/i.test(u))];
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const raw of candidates) {
    try {
      const u = normalizeWebsiteUrl(new URL(raw, root).toString());
      if (u.hostname.toLowerCase() !== root.hostname.toLowerCase()) continue;
      const key = u.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(key);
      if (selected.length === MAX_PAGES) break;
    } catch { /* Ignore malformed or off-domain links. */ }
  }
  return selected;
}

function supportedExtraction(extraction: FactExtraction, docs: Array<{ id: string; url: string; text: string }>) {
  const byId = new Map(docs.map((d) => [d.id, d]));
  return extraction.claims.filter((claim) => {
    const source = byId.get(claim.evidenceId);
    return !!source && quoteIsSupported(claim.quote, source.text);
  });
}

/**
 * Crawl a small, same-site public surface. Source documents and extracted content remain inactive
 * or draft until a workspace administrator reviews them. No claims, proof, or service is approved.
 */
export async function ingestBusinessWebsite(workspaceId: string, rawInput: unknown, actor: Actor) {
  const input = WebsiteIntakeSchema.parse(rawInput);
  const root = normalizeWebsiteUrl(input.website);
  const supplied = input.urls.map((raw) => {
    const u = normalizeWebsiteUrl(raw);
    if (u.hostname.toLowerCase() !== root.hostname.toLowerCase()) throw new AppError('VALIDATION_FAILED', 'All service and case-study URLs must use the company website host.', 400);
    return u.toString();
  });

  const fetcher = adapters().fetcher;
  const fetchHomepage = () => fetcher.fetchPage(root.toString());
  const first = await fetchHomepage().then(
    (page) => [502, 503, 504].includes(page.status) ? fetchHomepage() : page,
    (error: unknown) => {
      if (error instanceof Error && /timeout/i.test(error.message)) return fetchHomepage();
      throw error;
    },
  );
  if (first.status < 200 || first.status >= 300) throw new AppError('PROVIDER_ERROR', `Website returned HTTP ${first.status}.`, 502);
  const landing = normalizeWebsiteUrl(first.url);
  const canonicalHost = (url: URL) => url.hostname.replace(/^www\./i, '');
  if (canonicalHost(landing) !== canonicalHost(root)) throw new AppError('VALIDATION_FAILED', 'The website redirected to a different host. Enter the final website URL.', 400);
  const sitemap = await fetcher.fetchPage(new URL('/sitemap.xml', landing).toString()).catch(() => null);
  const sitemapLinks = sitemap && sitemap.status >= 200 && sitemap.status < 300 && new URL(sitemap.url).origin === landing.origin ? sitemap.links : [];
  const urls = selectIntakePages(landing.toString(), supplied.map((raw) => {
    const url = new URL(raw);
    return new URL(url.pathname, landing.origin).toString();
  }), [...first.links, ...sitemapLinks].map((href) => {
    try { return new URL(href, landing).toString(); } catch { return ''; }
  }).filter(Boolean));

  const pages: Array<{ url: string; title: string | null; text: string }> = [{ url: landing.toString(), title: first.title, text: first.text.slice(0, MAX_PAGE_CHARS) }];
  const candidates = urls.filter((url) => url !== landing.toString());
  for (let offset = 0; offset < candidates.length; offset += 2) {
    const fetched = await Promise.allSettled(candidates.slice(offset, offset + 2).map((url) => fetcher.fetchPage(url)));
    for (const result of fetched) {
      if (result.status !== 'fulfilled') continue;
      const page = result.value;
      const url = normalizeWebsiteUrl(page.url);
      if (page.status < 200 || page.status >= 300 || canonicalHost(url) !== canonicalHost(root) || !page.text.trim() || pages.some((p) => p.url === url.toString())) continue;
      pages.push({ url: url.toString(), title: page.title, text: page.text.slice(0, MAX_PAGE_CHARS) });
    }
  }
  if (!pages.some((p) => p.text.trim())) throw new AppError('PROVIDER_ERROR', 'No readable public website content was found.', 502);

  const notePrefix = `Website intake draft from ${landing.origin}; `;
  const fingerprint = sha256(JSON.stringify(pages.map(({ url, text }) => [url, sha256(text)]).sort(([a], [b]) => a.localeCompare(b))));
  const changeNote = `${notePrefix}content ${fingerprint}; review before activation.`;
  const lastIntake = await db().aiConfigVersion.findFirst({
    where: { workspaceId, kind: 'KNOWLEDGE', changeNote: { startsWith: notePrefix } },
    orderBy: { version: 'desc' }, select: { changeNote: true },
  });
  const matchedSources = await Promise.all(pages.map((page) => db().knowledgeDocument.findFirst({
    where: { workspaceId, fileName: page.url, text: page.text, mimeType: 'text/html; source=website-intake' },
    select: { id: true, fileName: true },
  })));
  if (lastIntake?.changeNote === changeNote && matchedSources.every(Boolean)) {
    return {
      website: root.origin,
      sourceDocuments: matchedSources.flatMap((d) => d ? [{ id: d.id, url: d.fileName!, active: false }] : []),
      unchanged: true,
      reviewRequired: true,
      notice: 'Website content is unchanged. Existing review drafts were preserved; no new AI extraction or draft versions were created.',
    };
  }

  // Preserve source history. Exact URL/content repeats reuse their existing inactive source record.
  const documents: Array<{ id: string; url: string; text: string; title: string | null }> = [];
  for (const page of pages) {
    const existing = await db().knowledgeDocument.findFirst({ where: { workspaceId, fileName: page.url, text: page.text, mimeType: 'text/html; source=website-intake' }, select: { id: true, text: true } });
    const document = existing ?? await db().knowledgeDocument.create({ data: {
      workspaceId,
      title: (page.title || new URL(page.url).pathname || root.hostname).slice(0, 200),
      fileName: page.url,
      mimeType: 'text/html; source=website-intake',
      text: page.text,
      charCount: page.text.length,
      isActive: false,
      createdById: actor.userId ?? null,
    }, select: { id: true, text: true } });
    documents.push({ id: document.id, url: page.url, text: document.text, title: page.title });
  }

  const docsPrompt = documents.map((d) => `<document evidenceId="${d.id}" url="${neutralizeTags(d.url)}">\n${wrapUntrusted('web', d.text, MAX_PAGE_CHARS)}\n</document>`).join('\n');
  const extraction = (await runAi<FactExtraction>(workspaceId, 'FACT_EXTRACTION', {
    subject: `Extract only verifiable facts about the user's own company from its public website. Identify company description, audience, business model, and offered services. Keep the summary to two short sentences. Return at most eight non-duplicate claims, prioritizing distinct services, with concise statements and the shortest supporting quotes. Include only service names that have a corresponding service claim. Do not infer case-study results, pricing, client relationships, capabilities, or claims not explicitly stated. This intake creates review drafts only.`,
    documents: docsPrompt,
  }, { entity: { type: 'business_website_intake', id: workspaceId } })).data;
  const claims = supportedExtraction(extraction, documents);
  const serviceClaims = claims.filter((c) => SERVICE_CATEGORIES.has(c.category));

  const activeConfig = await db().aiConfigVersion.findFirst({ where: { workspaceId, kind: 'KNOWLEDGE', isActive: true }, orderBy: { version: 'desc' } });
  const parsed = KnowledgeSchema.safeParse(activeConfig?.data ?? {});
  const knowledge: Knowledge = parsed.success ? parsed.data : KnowledgeSchema.parse({});
  const existingServiceNames = new Set(knowledge.services.map((s) => s.name.toLowerCase()));
  const candidateServices = extraction.services
    .map((name) => name.trim())
    .filter((name) => name && serviceClaims.some((claim) => claim.text.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(claim.text.toLowerCase())))
    .filter((name, i, all) => all.findIndex((x) => x.toLowerCase() === name.toLowerCase()) === i);

  const nextKnowledge = KnowledgeSchema.parse({
    ...knowledge,
    website: knowledge.website || root.origin,
    description: claims.length && extraction.summary.trim() ? extraction.summary.slice(0, 5000) : knowledge.description,
    targetAudience: claims.some((claim) => claim.category === 'audience') && extraction.audience
      ? extraction.audience.slice(0, 3000) : knowledge.targetAudience,
    services: [...knowledge.services, ...candidateServices.filter((n) => !existingServiceNames.has(n.toLowerCase())).map((name) => ({ name, description: serviceClaims.find((c) => c.text.toLowerCase().includes(name.toLowerCase()))?.text ?? '' }))].slice(0, 50),
  });
  const createdServices: Array<{ id: string; versionId: string; name: string; proofId: string | null }> = [];
  const serviceModule = await import('./business-knowledge.js');
  for (const name of candidateServices) {
    const descriptionClaim = serviceClaims.find((c) => c.text.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(c.text.toLowerCase()));
    if (!descriptionClaim || name.length < 2 || name.length > 160 || descriptionClaim.text.trim().length < 5) continue;
    const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
    if (!slug) continue;
    const existing = await db().businessService.findFirst({
      where: { workspaceId, slug },
      include: { versions: { orderBy: { version: 'desc' }, take: 1, include: { proof: true } } },
    });
    if (existing?.isArchived) continue;
    const lastVersion = existing?.versions[0];
    const description = descriptionClaim.text.trim().slice(0, 5000);
    const source = documents.find((document) => document.id === descriptionClaim.evidenceId);
    if (!source || lastVersion?.proof.some((proof) => proof.knowledgeDocumentId === source.id && proof.claim === description.slice(0, 1000))) continue;
    if (lastVersion?.description === description && lastVersion.status !== 'DRAFT') continue;

    const changeNote = 'Extracted from website. Draft requires human review.';
    const created = existing ? null : await serviceModule.createService(workspaceId,
      serviceModule.ServiceCreateSchema.parse({ name, description, changeNote }), actor);
    const serviceId = existing?.id ?? created!.id;
    const version = created?.versions[0] ?? (lastVersion?.status === 'DRAFT' && lastVersion.description === description
      ? lastVersion
      : await serviceModule.createServiceVersion(workspaceId, serviceId,
        serviceModule.ServiceVersionInputSchema.parse({ ...lastVersion, description, changeNote }), actor));
    const proof = await serviceModule.addProof(workspaceId, {
      serviceVersionId: version.id, claim: description.slice(0, 1000),
      description: 'Automatically extracted from a public company website. Verify wording, service scope, and commercial availability before approval.',
      sourceUrl: source.url,
      sourceTitle: source.title?.slice(0, 300) ?? root.hostname,
      knowledgeDocumentId: source.id,
    }, actor);
    createdServices.push({ id: serviceId, versionId: version.id, name, proofId: proof.id });
  }

  const lastConfig = await db().aiConfigVersion.findFirst({ where: { workspaceId, kind: 'KNOWLEDGE' }, orderBy: { version: 'desc' }, select: { version: true } });
  const draftConfig = await db().aiConfigVersion.create({ data: {
    workspaceId, kind: 'KNOWLEDGE', version: (lastConfig?.version ?? 0) + 1,
    data: nextKnowledge as unknown as Prisma.InputJsonValue,
    isActive: false,
    changeNote,
    createdById: actor.userId ?? null,
  }, select: { id: true, version: true } });

  const extractedAt = new Date().toISOString();
  const supportedClaims = claims.map((claim) => {
    const source = documents.find((document) => document.id === claim.evidenceId)!;
    return { ...claim, sourceUrl: source.url, sourceTitle: source.title, extractedAt, approvalStatus: 'DRAFT' };
  });
  await audit(workspaceId, actor, 'business_website.intake_completed', { type: 'ai_config_draft', id: draftConfig.id }, {
    website: root.origin, sourceDocumentIds: documents.map((d) => d.id), claimCount: claims.length, supportedClaims,
    serviceDraftIds: createdServices.map((s) => s.versionId),
  });
  return {
    website: root.origin,
    sourceDocuments: documents.map(({ id, url }) => ({ id, url, active: false })),
    supportedClaims,
    draftKnowledge: { id: draftConfig.id, version: draftConfig.version, active: false, data: nextKnowledge },
    draftServices: createdServices,
    reviewRequired: true,
    notice: 'Website extraction is untrusted draft material. Review service scope and every proof claim. Nothing was approved or activated.',
  };
}

/** Weekly refresh only revisits known, same-origin website source records. Changed content creates
 * review drafts through the same intake path; it never activates knowledge or approves claims. */
export async function refreshBusinessWebsiteSources(onlyWorkspaceId?: string) {
  const roots = await db().knowledgeDocument.findMany({
    where: { mimeType: 'text/html; source=website-intake', ...(onlyWorkspaceId ? { workspaceId: onlyWorkspaceId } : {}) },
    select: { workspaceId: true, fileName: true }, orderBy: { createdAt: 'desc' }, take: 500,
  });
  const unique = new Map<string, { workspaceId: string; website: string }>();
  for (const source of roots) {
    if (!source.fileName) continue;
    try {
      const url = normalizeWebsiteUrl(source.fileName);
      if (url.pathname !== '/' || url.search) continue;
      unique.set(`${source.workspaceId}:${url.origin}`, { workspaceId: source.workspaceId, website: url.origin });
    } catch { /* Skip malformed legacy source URLs. */ }
  }
  let refreshed = 0; let unchanged = 0; let failed = 0;
  for (const item of [...unique.values()].slice(0, 100)) {
    try {
      const { orgIdOf } = await import('../core/tenant.js');
      const { tenantState } = await import('./entitlements.js');
      const state = await tenantState(await orgIdOf(item.workspaceId));
      if (!state.operational) continue;
      const result = await ingestBusinessWebsite(item.workspaceId, { website: item.website, urls: [] }, { type: 'SYSTEM' });
      if ('unchanged' in result && result.unchanged) unchanged++;
      else refreshed++;
    } catch { failed++; }
  }
  return { sites: Math.min(unique.size, 100), refreshed, unchanged, failed };
}

export const WebsiteRevisionSchema = z.object({
  draftId: z.uuid(),
  sourceIds: z.array(z.uuid()).min(1).max(MAX_PAGES),
  field: z.enum(['description', 'targetAudience', 'customerProfiles']),
  instruction: z.string().trim().min(1).max(1000),
});

export async function proposeWebsiteRevision(workspaceId: string, input: z.infer<typeof WebsiteRevisionSchema>, actor: Actor) {
  const sourceIds = [...new Set(input.sourceIds)];
  const [base, sources] = await Promise.all([
    db().aiConfigVersion.findFirst({ where: { id: input.draftId, workspaceId, kind: 'KNOWLEDGE' } }),
    db().knowledgeDocument.findMany({ where: { id: { in: sourceIds }, workspaceId, mimeType: 'text/html; source=website-intake' } }),
  ]);
  if (!base || sources.length !== sourceIds.length) throw new AppError('NOT_FOUND', 'The knowledge version or a source document is unavailable.', 404);
  const knowledge = KnowledgeSchema.parse(base.data);
  const documents = sources.map((source) => `<document evidenceId="${source.id}">\n${wrapUntrusted('web', source.text, MAX_PAGE_CHARS)}\n</document>`).join('\n');
  const extraction = (await runAi<FactExtraction>(workspaceId, 'FACT_EXTRACTION', {
    subject: `Propose one concise replacement for the business knowledge field ${input.field}. Put the replacement in one claim, with a quote from a supplied source that supports the entire replacement. Do not add prices, results or promises. Editor request for focus and wording: ${wrapUntrusted('editor', input.instruction, 1000)}`,
    documents,
  }, { entity: { type: 'ai_config_draft', id: base.id } })).data;
  const claim = extraction.claims.find((candidate) => {
    const source = sources.find((document) => document.id === candidate.evidenceId);
    return source && candidate.text.trim() && quoteIsSupported(candidate.quote, source.text);
  });
  if (!claim) throw new AppError('EVIDENCE_REQUIRED', 'The AI could not find supporting website text for this revision.', 422);
  const value = claim.text.trim().slice(0, 3000);
  const data = KnowledgeSchema.parse({ ...knowledge, [input.field]: value });
  const last = await db().aiConfigVersion.findFirst({ where: { workspaceId, kind: 'KNOWLEDGE' }, orderBy: { version: 'desc' }, select: { version: true } });
  const draft = await db().aiConfigVersion.create({ data: {
    workspaceId, kind: 'KNOWLEDGE', version: (last?.version ?? 0) + 1, data, isActive: false,
    changeNote: `AI proposal for ${input.field} from knowledge version ${base.version}. Review before activation.`,
    createdById: actor.userId ?? null,
  } });
  const source = sources.find((document) => document.id === claim.evidenceId)!;
  const proposal = { id: draft.id, version: draft.version, value, quote: claim.quote, sourceUrl: source.fileName, sourceTitle: source.title, confidence: claim.confidence, extractedAt: draft.createdAt, approvalStatus: 'DRAFT' };
  await audit(workspaceId, actor, 'business_website.revision_proposed', { type: 'ai_config_draft', id: draft.id }, { ...proposal, sourceId: source.id, baseVersionId: base.id });
  return proposal;
}
