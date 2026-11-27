import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { AppError, Forbidden, NotFound } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { ImportEntityTypeSchema, validateImportPayload, type ImportEntityType, type ImportRelationship } from '../../../shared/src/knowledge-import.js';
import { similarity } from '../../../shared/src/quality.js';
import { IcpCriteriaSchema } from '../../../shared/src/ai-schemas.js';
import { CommercialOfferSchema, KnowledgeSchema, ResearchSchema, WritingOverridesSchema, WritingSchema } from '../../../shared/src/ai-studio.js';
import { neutralizeTags } from '../../../integrations/src/ai/guard.js';
import { createProfile, createProfileVersion, getConfig, ProfileCreateSchema, saveConfig } from './ai-studio.js';
import { IcpSchema, saveIcpVersion } from './icp-versions.js';
import { addProof, createService, createServiceVersion, ServiceCreateSchema, slugFor } from './business-knowledge.js';
import { createExample, createRule, ExampleInputSchema, RuleInputSchema, updateExample, updateRule } from './outreach-brain.js';
import { indexMemoryItems, searchMemory } from './intelligence-memory.js';

const destinations = {
  COMPANY_PROFILE: 'AI_CONFIG_KNOWLEDGE',
  SERVICE: 'BUSINESS_SERVICE',
  PRODUCT: 'AI_CONFIG_KNOWLEDGE',
  COMMERCIAL_OFFER: 'COMMERCIAL_OFFER',
  TARGET_AUDIENCE: 'TARGET_AUDIENCE',
  TARGET_PERSONA: 'TARGET_PERSONA',
  ICP_CRITERIA: 'ICP',
  BUSINESS_OPPORTUNITY: 'BUSINESS_OPPORTUNITY',
  COMPETITOR: 'COMPETITOR_INTELLIGENCE',
  RESEARCH_SETTINGS: 'RESEARCH_CONFIGURATION',
  WRITING_SETTINGS: 'WRITING_CONFIGURATION',
  RESEARCH_RULE: 'RESEARCH_CONFIGURATION',
  OUTREACH_RULE: 'OUTREACH_CONFIGURATION',
  TRAINING_EXAMPLE: 'OUTREACH_TRAINING',
  PROMPT_PROFILE: 'PROMPT_PROFILE',
  EXCLUSION: 'EXCLUSION',
  PROOF_CASE_STUDY: 'APPROVED_EVIDENCE',
  ACHIEVEMENT: 'AI_CONFIG_KNOWLEDGE',
  CAMPAIGN_PREFERENCE: 'CAMPAIGN_PREFERENCE',
} satisfies Record<ImportEntityType, string>;

export function destinationFor(entityType: ImportEntityType) {
  return destinations[entityType];
}

type Payload = Record<string, unknown>;
type Existing = { id: string; version: string | number | null; data: Payload };
type Candidate = { id: string; name: string; reason: string };
type Inspection = {
  stableKey: string;
  existingValue: Existing | null;
  duplicateCandidates: Candidate[];
  conflictReason: string | null;
  status: 'CREATE' | 'SKIP' | 'CONFLICT' | 'NEEDS_REVIEW';
};
type Proposal = { entityType: string; destination: string; payload: unknown; stableKey?: string | null; classification?: string | null };
type ApplicableItem = Proposal & {
  id: string;
  workspaceId: string;
  status: string;
  sessionId: string;
  fileId: string | null;
  proposedValue?: unknown;
  existingValue?: unknown;
  sourceLocator?: string | null;
  relationships?: unknown;
  verificationStatus?: string | null;
};
type ApplicationResult = {
  destinationEntityId: string;
  destinationDocumentId: string | null;
  applicationResult: 'CREATED' | 'UPDATED' | 'UNCHANGED';
};

const fold = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const parts = (p: Payload, field: string): string[] => {
  const value = p[field];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && !!item.trim());
  return typeof value === 'string' && value.trim() ? [value.trim()] : typeof value === 'number' ? [String(value)] : [];
};
const field = (p: Payload, key: string) => parts(p, key).join('\n');
const optional = (p: Payload, key: string) => field(p, key) || undefined;
function domainFor(website: string) {
  if (!website) return null;
  try {
    const url = new URL(website.includes('://') ? website : `https://${website}`);
    return /^(https?):$/.test(url.protocol) && !url.username && !url.password && url.hostname.includes('.') ? url.hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch { return null; }
}

export function importStableKey(entity: ImportEntityType, data: Payload) {
  if (['COMPANY_PROFILE', 'WRITING_SETTINGS', 'RESEARCH_SETTINGS'].includes(entity)) return `${entity}:workspace-profile`;
  const external = field(data, 'externalId').normalize('NFKC').toLowerCase();
  const name = fold(field(data, 'name'));
  return external ? `${entity}:external:${external}` : `${entity}:name:${name}`;
}

function serviceData(data: Payload, previous?: Payload) {
  const lists = ['customerProblems', 'desiredOutcomes', 'deliverables', 'targetCustomerProfiles', 'targetIndustries',
    'excludedIndustries', 'targetGeographies', 'excludedGeographies', 'exclusions', 'eligibilityCriteria', 'commercialBoundaries'];
  const description = ['description', 'methodology', 'availability', 'supportingEvidence'].flatMap(key =>
    field(data, key) ? [key === 'description' ? field(data, key) : `${key}: ${field(data, key)}`] : []);
  if (!data.description && previous?.description && description.length) description.unshift(String(previous.description));
  return ServiceCreateSchema.parse({
    ...previous,
    name: field(data, 'name'),
    description: description.join('\n') || previous?.description,
    ...Object.fromEntries(lists.filter(key => Object.hasOwn(data, key)).map(key => [key, parts(data, key)])),
    ...Object.fromEntries(['minEmployeeCount', 'maxEmployeeCount'].filter(key => Object.hasOwn(data, key))
      .map(key => [key, data[key] === 'null' ? null : Number(data[key])])),
    ...(data.exclusionRules ? { exclusionRules: JSON.parse(String(data.exclusionRules)) } : {}),
  });
}

function offerPatch(data: Payload) {
  return CommercialOfferSchema.partial().parse({
    ...Object.fromEntries(['name', 'description', 'price', 'externalId', 'currency', 'billingModel', 'duration', 'conditions', 'eligibility', 'availability']
      .flatMap(key => field(data, key) ? [[key, field(data, key)]] : [])),
    ...(parts(data, 'deliverables').length ? { deliverables: parts(data, 'deliverables') } : {}),
  });
}

function profilePatch(data: Payload) {
  const website = optional(data, 'website');
  if (website && !domainFor(website)) throw new Error('Company website must be a valid website address');
  const description = ['description', 'positioning', 'mission', 'valueProposition', 'industries', 'geography', 'businessModel', 'legalEntity', 'companySize']
    .flatMap(key => field(data, key) ? [key === 'description' ? field(data, key) : `${key}: ${field(data, key)}`] : []).join('\n');
  return {
    companyName: field(data, 'name'),
    ...Object.fromEntries(['targetAudience', 'customerProfiles', 'pricingNotes'].flatMap(key => field(data, key) ? [[key, field(data, key)]] : [])),
    ...(website ? { website } : {}),
    ...(description ? { description } : {}),
    ...(parts(data, 'differentiators').length ? { usps: parts(data, 'differentiators') } : {}),
  };
}

function icpWeights(data: Payload) {
  const weights = parts(data, 'scoringRules').map(rule => {
    const match = /^(.+?):\s*(\d+(?:\.\d+)?)$/.exec(rule);
    if (!match) throw new Error('Format each scoring rule as “Criterion: weight”');
    return { criterion: match[1]!.trim(), weight: z.number().positive().max(100).parse(Number(match[2])) };
  });
  const single = field(data, 'weight');
  if (single) {
    const criteria = [...parts(data, 'requiredConditions'), ...parts(data, 'optionalConditions')];
    weights.push({ criterion: criteria.length === 1 ? criteria[0]! : field(data, 'name'), weight: z.number().positive().max(100).parse(Number(single)) });
  }
  if (new Set(weights.map(rule => fold(rule.criterion))).size !== weights.length) throw new Error('Use one weight per scoring criterion');
  return weights;
}

const researchSources = ['companyWebsite', 'webSearch', 'newsAndArticles', 'podcastsAndInterviews', 'dataProvider', 'userProvided'] as const;
const numericSettings = new Set(['minWords', 'maxWords', 'recentSignalDays', 'extendedSignalDays', 'minClaims', 'maxEvidenceAgeDays', 'maxSearchQueriesPerRun', 'maxSearchesPerProspect', 'maxPagesPerRun', 'deepResearchScoreThreshold']);
function booleanSetting(value: unknown) {
  return z.enum(['true', 'false']).parse(String(value).toLowerCase()) === 'true';
}
function configPatch(data: Payload) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !['externalId', 'name', 'description', ...researchSources].includes(key))
    .map(([key, value]) => [key, key === 'maxEvidenceAgeDays' && value === 'null' ? null : numericSettings.has(key) ? Number(value) : value]));
}

function icpData(data: Payload, previous?: Payload) {
  icpWeights(data);
  const criteria = IcpCriteriaSchema.parse(previous?.criteria ?? {});
  const lists = { titles: ['titles'], seniorities: ['seniorities'], industries: ['industries'], countries: ['countries'],
    mustHave: ['requiredConditions'], disqualifiers: ['negativeConditions', 'disqualificationSignals'],
    keywords: ['keywords', 'optionalConditions', 'qualificationSignals', 'characteristics'] } as const;
  for (const [key, inputs] of Object.entries(lists) as [keyof typeof lists, readonly string[]][]) {
    if (inputs.some(input => Object.hasOwn(data, input))) criteria[key] = inputs.flatMap(input => parts(data, input));
  }
  for (const fieldName of ['employeeMin', 'employeeMax'] as const) {
    if (Object.hasOwn(data, fieldName)) criteria[fieldName] = z.number().int().nonnegative().parse(Number(data[fieldName]));
  }
  if (criteria.employeeMin !== null && criteria.employeeMax !== null && criteria.employeeMin > criteria.employeeMax) {
    throw new Error('Minimum employee count cannot exceed maximum employee count');
  }
  return IcpSchema.parse({
    name: field(data, 'name'),
    description: data.description ?? previous?.description ?? null,
    minScore: data.threshold === undefined ? previous?.minScore : Number(data.threshold),
    aiInstructions: data.aiInstructions ?? previous?.aiInstructions ?? null,
    isActive: data.isActive === undefined ? previous?.isActive : booleanSetting(data.isActive),
    criteria,
  });
}

function outreachData(data: Payload, existing?: Payload) {
  const description = ['description', 'tone', 'personalizationRules', 'messagingRestrictions', 'ctaPreferences', 'followUpPolicies', 'prohibitedLanguage', 'channels', 'wordLimits']
    .flatMap(key => field(data, key) ? [key === 'description' ? field(data, key) : `${key}: ${field(data, key)}`] : []).join('\n');
  return RuleInputSchema.parse({
    title: field(data, 'name'), description: description || existing?.description,
    category: optional(data, 'category')?.toUpperCase() ?? existing?.category ?? 'PERSONALIZATION',
    priority: optional(data, 'priority')?.toUpperCase() ?? existing?.priority ?? 'PREFERRED',
    status: optional(data, 'status')?.toUpperCase() ?? existing?.status ?? 'ACTIVE',
    condition: optional(data, 'condition') ?? existing?.condition ?? null,
    triggerTerms: Object.hasOwn(data, 'triggerTerms') ? parts(data, 'triggerTerms') : existing?.triggerTerms,
  });
}

function promptProfileData(data: Payload, previous?: Payload) {
  const patch = configPatch(Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'instructions')));
  return ProfileCreateSchema.parse({
    name: field(data, 'name'), description: data.description ?? previous?.description ?? undefined,
    instructions: data.instructions ?? previous?.instructions,
    settings: WritingOverridesSchema.parse({ ...(previous?.settings as Payload ?? {}), ...patch }),
  });
}

function trainingData(data: Payload, existing?: Payload) {
  return ExampleInputSchema.parse({
    name: field(data, 'name'), content: data.content ?? existing?.content,
    correctedContent: data.correctedContent ?? existing?.correctedContent ?? null,
    category: optional(data, 'category')?.toUpperCase() ?? existing?.category,
    polarity: optional(data, 'polarity')?.toUpperCase() ?? existing?.polarity,
    explanation: data.explanation ?? existing?.explanation ?? null,
    tags: data.tags ?? existing?.tags,
    isActive: data.isActive === undefined ? existing?.isActive : booleanSetting(data.isActive),
  });
}

function relevantFields(data: Payload) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'externalId'));
}

function differences(previous: Payload, proposed: Payload) {
  return Object.keys(proposed).filter(key => key !== 'externalId' && !isDeepStrictEqual(previous[key], proposed[key]));
}

const nativeTypes = new Set<ImportEntityType>(['COMPANY_PROFILE', 'SERVICE', 'COMMERCIAL_OFFER', 'ICP_CRITERIA', 'OUTREACH_RULE', 'PRODUCT', 'RESEARCH_SETTINGS', 'WRITING_SETTINGS', 'TRAINING_EXAMPLE', 'PROMPT_PROFILE']);

async function recordedMatches(client: Prisma.TransactionClient, workspaceId: string, entityType: ImportEntityType, data: Payload, key: string) {
  const name = fold(field(data, 'name'));
  const domain = domainFor(field(data, 'website'));
  const rows = await client.businessKnowledgeRecord.findMany({ where: { workspaceId, kind: entityType }, include: { revisions: { orderBy: { version: 'desc' }, take: 1 } } });
  const ranked = rows.flatMap(row => {
    const reason = row.stableKey === key ? 'Stable identifier matches' : fold(row.name) === name ? 'Normalized name matches' : domain && row.domain === domain ? 'Website domain matches' : null;
    return reason ? [{ id: row.id, name: row.name, reason, existing: { id: row.id, version: row.version, data: row.revisions[0]?.data as Payload ?? {} } }] : [];
  });
  const exact = ranked.find(candidate => candidate.reason === 'Stable identifier matches');
  if (ranked.length) return { candidates: ranked.map(({ existing: _existing, ...candidate }) => candidate), existing: exact?.existing ?? (ranked.length === 1 ? ranked[0]!.existing : null) };
  const description = field(data, 'description');
  const similar = description.length > 60 ? rows.flatMap(row => {
    const old = field(row.revisions[0]?.data as Payload ?? {}, 'description');
    if (old.length <= 60 || similarity(description, old) < 0.7) return [];
    return [{ id: row.id, name: row.name, reason: 'Similar description. Confirm whether this is a distinct record.' }];
  }).slice(0, 5) : [];
  return { candidates: similar, existing: null };
}

async function nativeMatches(client: Prisma.TransactionClient, workspaceId: string, entity: ImportEntityType, data: Payload, stableKey: string): Promise<{ existing: Existing | null; candidates: Candidate[]; proposed: Payload }> {
  const name = field(data, 'name');
  const prior = stableKey.startsWith(`${entity}:external:`) ? await client.knowledgeImportItem.findFirst({
    where: { workspaceId, entityType: entity, stableKey, status: 'APPLIED', destinationEntityId: { not: null } },
    orderBy: { appliedAt: 'desc' },
    select: { destinationEntityId: true },
  }) : null;
  if (entity === 'WRITING_SETTINGS' || entity === 'RESEARCH_SETTINGS') {
    const patch = configPatch(data);
    if (entity === 'WRITING_SETTINGS') {
      const config = await getConfig(workspaceId, 'WRITING', client);
      const validated = WritingSchema.parse({ ...config.data, ...patch });
      return { existing: config.versionId ? { id: config.versionId, version: config.version, data: config.data } : null, candidates: [], proposed: validated };
    }
    const config = await getConfig(workspaceId, 'RESEARCH', client);
    const permittedSources = { ...config.data.permittedSources };
    for (const source of researchSources) if (Object.hasOwn(data, source)) permittedSources[source] = booleanSetting(data[source]);
    const validated = ResearchSchema.parse({ ...config.data, ...patch, permittedSources });
    return { existing: config.versionId ? { id: config.versionId, version: config.version, data: config.data } : null, candidates: [], proposed: validated };
  }
  if (entity === 'COMPANY_PROFILE') {
    const config = await getConfig(workspaceId, 'KNOWLEDGE', client);
    const proposed = profilePatch(data);
    KnowledgeSchema.parse({ ...config.data, ...proposed });
    return { existing: config.versionId ? { id: config.versionId, version: config.version, data: config.data } : null, candidates: [], proposed };
  }
  if (entity === 'PRODUCT') {
    const config = await getConfig(workspaceId, 'KNOWLEDGE', client);
    const externalId = optional(data, 'externalId');
    const products = config.data.products.filter(product => fold(product.name) === fold(name) || (!!externalId && !!product.externalId && fold(product.externalId) === fold(externalId)));
    const proposed = KnowledgeSchema.shape.products.unwrap().element.parse({
      name, externalId: externalId ?? products[0]?.externalId, description: optional(data, 'description') ?? (products.length === 1 ? products[0].description : undefined),
    });
    KnowledgeSchema.shape.products.parse(products.length ? config.data.products : [...config.data.products, proposed]);
    return { existing: products.length === 1 ? { id: importStableKey('PRODUCT', products[0]), version: null, data: products[0] } : null,
      candidates: products.map(product => ({ id: importStableKey('PRODUCT', product), name: product.name, reason: 'Normalized product name matches' })), proposed };
  }
  if (entity === 'COMMERCIAL_OFFER') {
    const config = await getConfig(workspaceId, 'KNOWLEDGE', client);
    const proposed = offerPatch(data);
    const offers = config.data.offers.filter(offer => (proposed.externalId && offer.externalId && fold(offer.externalId) === fold(proposed.externalId)) || fold(offer.name) === fold(name));
    const offerKey = (offer: { name: string; externalId?: string }) => importStableKey('COMMERCIAL_OFFER', offer);
    const existing = offers.length === 1 ? { id: offerKey(offers[0]!), version: null, data: offers[0]! } : null;
    return { existing, candidates: offers.map(offer => ({ id: offerKey(offer), name: offer.name, reason: 'Stable identifier or normalized offer name matches' })), proposed };
  }
  if (entity === 'SERVICE') {
    const slug = slugFor(name);
    if (!slug) throw new Error('Service name must contain letters or numbers');
    const services = await client.businessService.findMany({ where: { workspaceId, OR: [{ slug }, ...(prior?.destinationEntityId ? [{ id: prior.destinationEntityId }] : [])] }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
    const service = services.length === 1 ? services[0] : undefined;
    const latest = service?.versions[0];
    const proposed = serviceData(data, latest);
    const existing = service && latest ? { id: service.id, version: `${latest.id}:${latest.status}:${service.isArchived}`, data: { ...latest, name: service.name, isArchived: service.isArchived } } : null;
    return { existing, candidates: services.map(row => ({ id: row.id, name: row.name, reason: row.id === prior?.destinationEntityId ? 'Stable identifier matches' : 'Normalized service name matches' })), proposed };
  }
  if (entity === 'ICP_CRITERIA') {
    const rows = await client.idealCustomerProfile.findMany({ where: { workspaceId } });
    const matches = rows.filter(row => fold(row.name) === fold(name) || row.id === prior?.destinationEntityId);
    const match = matches.length === 1 ? matches[0] : undefined;
    const proposed = icpData(data, match);
    return { existing: match ? { id: match.id, version: match.updatedAt.toISOString(), data: { name: match.name, description: match.description, minScore: match.minScore, criteria: match.criteria, isActive: match.isActive, aiInstructions: match.aiInstructions } } : null, candidates: matches.map(row => ({ id: row.id, name: row.name, reason: 'ICP identity matches' })), proposed };
  }
  if (entity === 'PROMPT_PROFILE') {
    const rows = await client.promptProfile.findMany({ where: { workspaceId } });
    const matches = rows.filter(row => fold(row.name) === fold(name) || row.id === prior?.destinationEntityId);
    const match = matches.length === 1 ? matches[0] : undefined;
    const current = match?.activeVersionId ? await client.promptProfileVersion.findFirst({ where: { workspaceId, profileId: match.id, id: match.activeVersionId } }) : null;
    const values = match ? { name: match.name, description: match.description ?? undefined, instructions: current?.instructions, settings: current?.settings, isArchived: match.isArchived } : undefined;
    return { existing: match && values ? { id: match.id, version: `${match.updatedAt.toISOString()}:${match.activeVersionId}`, data: values } : null,
      candidates: matches.map(row => ({ id: row.id, name: row.name, reason: 'Prompt profile identity matches' })), proposed: promptProfileData(data, values) };
  }
  if (entity === 'TRAINING_EXAMPLE') {
    const rows = await client.outreachExample.findMany({ where: { workspaceId } });
    const matches = rows.filter(row => fold(row.name) === fold(name) || row.id === prior?.destinationEntityId);
    const match = matches.length === 1 ? matches[0] : undefined;
    const proposed = trainingData(data, match);
    return { existing: match ? { id: match.id, version: match.updatedAt.toISOString(), data: match } : null,
      candidates: matches.map(row => ({ id: row.id, name: row.name, reason: 'Training example identity matches' })), proposed };
  }
  const rows = await client.outreachRule.findMany({ where: { workspaceId } });
  const matches = rows.filter(row => fold(row.title) === fold(name) || row.id === prior?.destinationEntityId);
  const match = matches.length === 1 ? matches[0] : undefined;
  const proposed = outreachData(data, match);
  return { existing: match ? { id: match.id, version: match.updatedAt.toISOString(), data: { ...match, updatedAt: match.updatedAt.toISOString(), createdAt: match.createdAt.toISOString() } } : null, candidates: matches.map(row => ({ id: row.id, name: row.title, reason: 'Outreach rule identity matches' })), proposed };
}

export async function inspectImportItem(client: Prisma.TransactionClient, workspaceId: string, item: Proposal): Promise<Inspection> {
  const type = ImportEntityTypeSchema.safeParse(item.entityType);
  if (!type.success || item.destination !== destinationFor(type.data)) return { status: 'NEEDS_REVIEW', stableKey: '', existingValue: null, duplicateCandidates: [], conflictReason: 'Destination does not match a supported entity type' };
  let data: Payload;
  let stableKey = item.stableKey ?? '';
  try {
    data = validateImportPayload(type.data, item.payload);
    if (!field(data, 'name')) throw new Error('A record name is required');
    if (type.data === 'COMPETITOR' && field(data, 'website') && !domainFor(field(data, 'website'))) throw new Error('Competitor website must be a valid website address');
    if (Object.values(data).flat().some(value => typeof value === 'string' && /<\/?(?:untrusted_content|system|assistant|developer)\b|\b(?:ignore|override|disregard)\b.{0,40}\b(?:previous|prior|system)\b.{0,20}\binstructions\b/i.test(value))) {
      throw new Error('Remove text aimed at changing model instructions');
    }
    stableKey ||= importStableKey(type.data, data);
  } catch (error) {
    return { status: 'NEEDS_REVIEW', stableKey, existingValue: null, duplicateCandidates: [], conflictReason: validationReason(error) };
  }
  let match: { existing: Existing | null; candidates: Candidate[]; proposed: Payload };
  try {
    match = nativeTypes.has(type.data)
      ? await nativeMatches(client, workspaceId, type.data, data, stableKey)
      : { ...await recordedMatches(client, workspaceId, type.data, data, stableKey), proposed: relevantFields(data) };
  } catch (error) {
    // An unavailable destination database must retry; it must not become a review issue.
    if (error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Prisma.PrismaClientUnknownRequestError || error instanceof Prisma.PrismaClientInitializationError) throw error;
    return { status: 'NEEDS_REVIEW', stableKey, existingValue: null, duplicateCandidates: [], conflictReason: validationReason(error) };
  }
  const { existing, candidates, proposed } = match;
  const changed = existing ? differences(existing.data, proposed) : [];
  const requiresHumanCheck = ['CLAIM', 'INFERENCE', 'UNKNOWN'].includes(item.classification ?? '');
  const conflictReason = candidates.length > 1 ? 'Multiple destination records may match this proposal'
    : candidates.length && !existing ? 'A potentially related record exists. Confirm that the proposal is distinct.'
    : existing?.data.isArchived === true ? 'The matching service is archived'
    : changed.length ? `Existing destination values differ: ${changed.join(', ')}`
    : requiresHumanCheck && !existing ? 'The source contains unverified information. Check provenance during review.' : null;
  return {
    status: (existing && changed.length === 0 && candidates.length <= 1 && existing.data.isArchived !== true) ? 'SKIP'
      : existing || candidates.length ? 'CONFLICT' : requiresHumanCheck ? 'NEEDS_REVIEW' : 'CREATE',
    stableKey,
    existingValue: existing ? JSON.parse(JSON.stringify(existing)) as Existing : null,
    duplicateCandidates: candidates,
    conflictReason,
  };
}

function validationReason(error: unknown) {
  if (error instanceof z.ZodError) return `Invalid destination fields: ${error.issues.map(issue => issue.path.join('.') || 'record').join(', ')}`.slice(0, 500);
  return error instanceof Error ? error.message.slice(0, 500) : 'The destination could not validate this record';
}

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

const relationshipSchema = z.array(z.object({ entityType: ImportEntityTypeSchema, externalId: z.string().min(1).max(200) })).max(40);

async function relationExists(tx: Prisma.TransactionClient, workspaceId: string, entityType: ImportEntityType, id: string) {
  if (!z.uuid().safeParse(id).success) return false;
  const where = { workspaceId, id };
  if (entityType === 'SERVICE') return !!await tx.businessService.findFirst({ where: { ...where, isArchived: false } });
  if (entityType === 'ICP_CRITERIA') return !!await tx.idealCustomerProfile.findFirst({ where });
  if (entityType === 'OUTREACH_RULE') return !!await tx.outreachRule.findFirst({ where });
  if (entityType === 'COMPANY_PROFILE' || entityType === 'COMMERCIAL_OFFER') return !!await tx.aiConfigVersion.findFirst({ where: { ...where, kind: 'KNOWLEDGE' } });
  if (entityType === 'PROOF_CASE_STUDY' && await tx.businessProof.findFirst({ where })) return true;
  return !!await tx.businessKnowledgeRecord.findFirst({ where: { ...where, kind: entityType } });
}

async function resolveRelationships(tx: Prisma.TransactionClient, workspaceId: string, sessionId: string, input: unknown) {
  const refs: ImportRelationship[] = relationshipSchema.parse(input ?? []);
  return Promise.all(refs.map(async (ref) => {
    const stableKey = importStableKey(ref.entityType, { externalId: ref.externalId });
    const applied = await tx.knowledgeImportItem.findFirst({
      where: { workspaceId, entityType: ref.entityType, stableKey, status: 'APPLIED', destinationEntityId: { not: null } },
      orderBy: { appliedAt: 'desc' },
      select: { destinationEntityId: true },
    });
    let destinationEntityId = applied?.destinationEntityId;
    if (!destinationEntityId) {
      const unchanged = await tx.knowledgeImportItem.findFirst({
        where: { workspaceId, sessionId, entityType: ref.entityType, stableKey, status: 'SKIP' },
      });
      const verified = unchanged && await inspectImportItem(tx, workspaceId, { ...unchanged, payload: unchanged.proposedValue ?? unchanged.payload });
      const matchedId = verified && verified.status === 'SKIP' ? verified.existingValue?.id : undefined;
      destinationEntityId = matchedId;
      if (matchedId && ref.entityType === 'COMMERCIAL_OFFER') {
        const config = await getConfig(workspaceId, 'KNOWLEDGE', tx);
        destinationEntityId = config.versionId;
      }
    }
    if (!destinationEntityId || !await relationExists(tx, workspaceId, ref.entityType, destinationEntityId)) {
      throw new AppError('VALIDATION_FAILED', `Apply the referenced ${ref.entityType} “${ref.externalId}” in this workspace first`, 400);
    }
    return { ...ref, destinationEntityId };
  }));
}

async function writeRecord(tx: Prisma.TransactionClient, workspaceId: string, type: ImportEntityType, stableKey: string, data: Payload, item: ApplicableItem, actor: Actor, existing: Existing | null, relationships: Awaited<ReturnType<typeof resolveRelationships>>) {
  const fields = { name: field(data, 'name'), domain: domainFor(field(data, 'website')) };
  const record = existing
    ? await tx.businessKnowledgeRecord.update({ where: { workspaceId_id: { workspaceId, id: existing.id } }, data: { ...fields, version: { increment: 1 } } })
    : await tx.businessKnowledgeRecord.create({ data: { workspaceId, kind: type, stableKey, ...fields } });
  await tx.businessKnowledgeRevision.create({ data: {
    workspaceId, recordId: record.id, version: record.version, data: json(data),
    provenance: json({ itemId: item.id, importSessionId: item.sessionId, fileId: item.fileId, locator: item.sourceLocator, classification: item.classification, verificationStatus: item.verificationStatus, relationships }),
    createdById: actor.userId ?? null,
  } });
  return record.id;
}

const outboundDocuments = new Set<ImportEntityType>(['COMPANY_PROFILE', 'COMMERCIAL_OFFER', 'PRODUCT']);
const retrievalDocuments = new Set<ImportEntityType>(['COMPANY_PROFILE', 'COMMERCIAL_OFFER', 'TARGET_AUDIENCE', 'TARGET_PERSONA', 'ICP_CRITERIA', 'BUSINESS_OPPORTUNITY', 'COMPETITOR', 'RESEARCH_RULE', 'OUTREACH_RULE', 'EXCLUSION', 'CAMPAIGN_PREFERENCE']);
const recordForUse = (type: ImportEntityType, classification: string | null | undefined) =>
  classification === 'EXPLICIT_FACT' || (type === 'COMMERCIAL_OFFER' && classification === 'CLAIM')
  || (!outboundDocuments.has(type) && classification === 'RECOMMENDATION');

async function writeDocument(tx: Prisma.TransactionClient, workspaceId: string, type: ImportEntityType, item: ApplicableItem, stableKey: string, data: Payload, actor: Actor) {
  if (!retrievalDocuments.has(type)) return null;
  const previous = await tx.knowledgeImportItem.findMany({
    where: { workspaceId, entityType: type, stableKey, destinationDocumentId: { not: null } },
    select: { destinationDocumentId: true },
  });
  await tx.knowledgeDocument.updateMany({
    where: { workspaceId, id: { in: previous.flatMap(row => row.destinationDocumentId ? [row.destinationDocumentId] : []) } },
    data: { isActive: false },
  });
  if (!recordForUse(type, item.classification)) return null;
  const source = item.fileId ? await tx.knowledgeImportFile.findFirst({ where: { workspaceId, sessionId: item.sessionId, id: item.fileId }, select: { fileName: true } }) : null;
  const text = [
    `Workspace-approved ${type.toLowerCase().replaceAll('_', ' ')}.`,
    `Provenance: import item ${item.id}${source ? `, ${source.fileName}` : ''}${item.sourceLocator ? `, ${item.sourceLocator}` : ''}.`,
    ...Object.entries(relevantFields(data)).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join('; ') : String(value)}`),
  ].join('\n').slice(0, 100_000);
  const document = await tx.knowledgeDocument.create({ data: {
    workspaceId, title: field(data, 'name').slice(0, 200), fileName: source?.fileName ?? null,
    mimeType: 'text/plain', text, charCount: text.length, createdById: actor.userId ?? null,
  } });
  return document.id;
}

async function showUnverifiedEvidence(tx: Prisma.TransactionClient, workspaceId: string, type: 'PROOF_CASE_STUDY' | 'ACHIEVEMENT', data: Payload, note: string, actor: Actor) {
  const current = await getConfig(workspaceId, 'KNOWLEDGE', tx);
  const name = field(data, 'name');
  if (type === 'ACHIEVEMENT') {
    const text = field(data, 'description') || name;
    if (current.data.achievements.some(entry => fold(entry.text) === fold(text))) return;
    await saveConfig(workspaceId, 'KNOWLEDGE', {
      ...current.data, achievements: [...current.data.achievements, { text, source: field(data, 'sourceEvidence'), verified: false }],
    }, note, actor, tx);
    return;
  }
  if (current.data.caseStudies.some(entry => fold(entry.title) === fold(name))) return;
  const evidence = field(data, 'evidence');
  await saveConfig(workspaceId, 'KNOWLEDGE', {
    ...current.data, caseStudies: [...current.data.caseStudies, {
      title: name, summary: field(data, 'description'), result: field(data, 'results'),
      url: domainFor(evidence) ? evidence : '', verified: false,
    }],
  }, note, actor, tx);
}

export async function applyImportItem(tx: Prisma.TransactionClient, workspaceId: string, item: ApplicableItem, actor: Actor): Promise<ApplicationResult> {
  if (item.workspaceId !== workspaceId) throw NotFound('Import item');
  if (item.status !== 'APPROVED') throw Forbidden('Approve this import item before applying it');
  const type = ImportEntityTypeSchema.parse(item.entityType);
  const data = validateImportPayload(type, item.proposedValue ?? item.payload);
  const inspection = await inspectImportItem(tx, workspaceId, { ...item, payload: data });
  if (!inspection.stableKey || (inspection.status === 'NEEDS_REVIEW' && inspection.conflictReason && !inspection.conflictReason.startsWith('The source contains unverified'))) {
    throw new AppError('VALIDATION_FAILED', inspection.conflictReason ?? 'Invalid import destination', 400);
  }
  const existing = inspection.existingValue;
  if ((item.existingValue != null || existing != null) && !isDeepStrictEqual(item.existingValue ?? null, existing == null ? null : json(existing))) {
    throw new AppError('CONFLICT', 'The destination changed after review. Review the current values before applying.', 409);
  }
  if (inspection.duplicateCandidates.length > 1 || existing?.data.isArchived === true) {
    throw new AppError('CONFLICT', inspection.conflictReason ?? 'Resolve the destination conflict before applying', 409);
  }
  const relationships = await resolveRelationships(tx, workspaceId, item.sessionId, item.relationships);
  if (inspection.status === 'SKIP' && existing) {
    const matching = await tx.knowledgeImportItem.findFirst({ where: {
      workspaceId, entityType: type, stableKey: inspection.stableKey, status: 'APPLIED', destinationEntityId: { not: null },
    }, orderBy: { appliedAt: 'desc' }, select: { destinationEntityId: true, destinationDocumentId: true } });
    const entityId = type === 'COMMERCIAL_OFFER' || type === 'PRODUCT'
      ? (await getConfig(workspaceId, 'KNOWLEDGE', tx)).versionId ?? existing.id
      : matching?.destinationEntityId ?? existing.id;
    return { destinationEntityId: entityId, destinationDocumentId: matching?.destinationDocumentId ?? null, applicationResult: 'UNCHANGED' };
  }
  if (outboundDocuments.has(type) && !recordForUse(type, item.classification)) {
    throw new AppError('VALIDATION_FAILED', 'Company facts and commercial terms require explicit source facts or reviewed commercial terms before entering active business knowledge', 400);
  }
  if (outboundDocuments.has(type) && /\b(?:guarantee[sd]?|testimonial|(?:client|customer) results?|(?:generated|increased|grew|achieved).{0,35}(?:revenue|profit|\d+%))\b/i.test(Object.values(data).flat().join(' '))) {
    throw new AppError('VALIDATION_FAILED', 'Remove performance claims, guarantees and testimonials from business facts and commercial terms and submit them through evidence review', 400);
  }
  if ((['ICP_CRITERIA', 'OUTREACH_RULE', 'WRITING_SETTINGS', 'RESEARCH_SETTINGS'].includes(type)) && !recordForUse(type, item.classification)) {
    throw new AppError('VALIDATION_FAILED', 'Resolve the source classification before activating a qualification or outreach rule', 400);
  }

  let entityId: string;
  const note = `Knowledge import ${item.sessionId}`;
  if (type === 'WRITING_SETTINGS') {
    const current = await getConfig(workspaceId, 'WRITING', tx);
    entityId = (await saveConfig(workspaceId, 'WRITING', { ...current.data, ...configPatch(data) }, note, actor, tx)).versionId;
  } else if (type === 'RESEARCH_SETTINGS') {
    const current = await getConfig(workspaceId, 'RESEARCH', tx);
    const permittedSources = { ...current.data.permittedSources };
    for (const source of researchSources) if (Object.hasOwn(data, source)) permittedSources[source] = booleanSetting(data[source]);
    entityId = (await saveConfig(workspaceId, 'RESEARCH', { ...current.data, ...configPatch(data), permittedSources }, note, actor, tx)).versionId;
  } else if (type === 'COMPANY_PROFILE') {
    const current = await getConfig(workspaceId, 'KNOWLEDGE', tx);
    const saved = await saveConfig(workspaceId, 'KNOWLEDGE', { ...current.data, ...profilePatch(data) }, note, actor, tx);
    entityId = saved.versionId;
  } else if (type === 'PRODUCT') {
    const current = await getConfig(workspaceId, 'KNOWLEDGE', tx);
    const product = KnowledgeSchema.shape.products.unwrap().element.parse({ name: field(data, 'name'), externalId: optional(data, 'externalId') ?? existing?.data.externalId, description: optional(data, 'description') ?? existing?.data.description });
    const products = existing ? current.data.products.map(entry => importStableKey('PRODUCT', entry) === existing.id ? product : entry) : [...current.data.products, product];
    entityId = (await saveConfig(workspaceId, 'KNOWLEDGE', { ...current.data, products }, note, actor, tx)).versionId;
  } else if (type === 'COMMERCIAL_OFFER') {
    const current = await getConfig(workspaceId, 'KNOWLEDGE', tx);
    const offer = CommercialOfferSchema.parse({ ...existing?.data, ...offerPatch(data) });
    const offers = existing
      ? current.data.offers.map(entry => importStableKey('COMMERCIAL_OFFER', entry) === existing.id ? offer : entry)
      : [...current.data.offers, offer];
    const saved = await saveConfig(workspaceId, 'KNOWLEDGE', { ...current.data, offers }, note, actor, tx);
    entityId = saved.versionId;
  } else if (type === 'SERVICE') {
    const service = serviceData(data, existing?.data);
    if (existing && existing.data.name !== service.name) throw new AppError('VALIDATION_FAILED', 'Rename the existing service in Business Knowledge before applying a version under the new name', 400);
    if (existing) {
      await createServiceVersion(workspaceId, existing.id, { ...service, changeNote: note }, actor, tx);
      entityId = existing.id;
    } else entityId = (await createService(workspaceId, { ...service, changeNote: note }, actor, tx)).id;
  } else if (type === 'ICP_CRITERIA') {
    const profile = icpData(data, existing?.data);
    entityId = (await saveIcpVersion(workspaceId, existing?.id ?? null, {
      ...profile,
    }, actor, tx, json({ importItemId: item.id, fileId: item.fileId, sourceLocator: item.sourceLocator, relationships, data, weights: icpWeights(data) }))).id;
  } else if (type === 'OUTREACH_RULE') {
    const values = outreachData(data, existing?.data);
    entityId = existing
      ? (await updateRule(workspaceId, existing.id, values, actor, tx)).rule.id
      : (await createRule(workspaceId, values, actor, tx)).rule.id;
  } else if (type === 'PROMPT_PROFILE') {
    const profile = promptProfileData(data, existing?.data);
    if (existing) {
      if (profile.name !== existing.data.name || profile.description !== existing.data.description) {
        await tx.promptProfile.update({ where: { id: existing.id, workspaceId }, data: { name: profile.name, description: profile.description ?? null } });
      }
      await createProfileVersion(workspaceId, existing.id, { instructions: profile.instructions, settings: profile.settings, changeNote: note, activate: true }, actor, tx);
      entityId = existing.id;
    } else entityId = (await createProfile(workspaceId, profile, actor, tx)).id;
  } else if (type === 'TRAINING_EXAMPLE') {
    const values = trainingData(data, existing?.data);
    entityId = existing ? (await updateExample(workspaceId, existing.id, values, actor, tx)).id
      : (await createExample(workspaceId, values, actor, tx)).id;
  } else if (type === 'PROOF_CASE_STUDY' && relationships.some(ref => ref.entityType === 'SERVICE')) {
    const linked = relationships.find(ref => ref.entityType === 'SERVICE')!;
    const version = await tx.businessServiceVersion.findFirst({ where: { workspaceId, serviceId: linked.destinationEntityId, status: 'DRAFT' }, orderBy: { version: 'desc' } });
    if (!version) throw new AppError('VALIDATION_FAILED', 'Create a draft version of the related service before importing proof', 400);
    const evidence = field(data, 'evidence');
    const sourceUrl = /^https?:\/\/[^\s]+$/i.test(evidence) ? evidence : null;
    entityId = (await addProof(workspaceId, {
      serviceVersionId: version.id, claim: field(data, 'results') || field(data, 'name'),
      description: ['description', 'client', 'startingSituation', 'workPerformed', 'metrics', 'timePeriod', 'evidence', 'publicationPermission'].flatMap(key => field(data, key) ? [`${key}: ${field(data, key)}`] : []).join('\n').slice(0, 3000),
      sourceUrl, sourceTitle: field(data, 'name'),
    }, actor, tx)).id;
    await writeRecord(tx, workspaceId, type, inspection.stableKey, data, item, actor, existing, relationships);
  } else {
    entityId = await writeRecord(tx, workspaceId, type, inspection.stableKey, { ...existing?.data, ...data }, item, actor, existing, relationships);
    if (type === 'RESEARCH_RULE' && recordForUse(type, item.classification)) {
      const current = await getConfig(workspaceId, 'RESEARCH', tx);
      const stableRuleKey = existing && typeof existing.data.externalId === 'string' ? importStableKey(type, existing.data) : inspection.stableKey;
      const importedRules = { ...current.data.importedRules, [stableRuleKey]: {
        name: field(data, 'name'), priorities: parts(data, 'priorities'), excludedSources: parts(data, 'excludedSources'),
        verificationRequirements: parts(data, 'verificationRequirements'), evidenceRequirements: optional(data, 'evidenceRequirements'), depth: optional(data, 'depth'),
      } };
      const updated = ResearchSchema.parse({ ...current.data, importedRules });
      if (!isDeepStrictEqual(updated, current.data)) await saveConfig(workspaceId, 'RESEARCH', updated, note, actor, tx);
    }
  }

  if (type === 'COMPETITOR' && item.classification === 'EXPLICIT_FACT') {
    const current = await getConfig(workspaceId, 'KNOWLEDGE', tx);
    const name = field(data, 'name');
    const notes = ['description', 'positioning', 'observations', 'differentiators'].flatMap(key => parts(data, key)).join('\n');
    if (!current.data.competitors.some(entry => fold(entry.name) === fold(name))) {
      await saveConfig(workspaceId, 'KNOWLEDGE', { ...current.data, competitors: [...current.data.competitors, { name, notes }] }, note, actor, tx);
    }
  }
  if (type === 'ACHIEVEMENT' || type === 'PROOF_CASE_STUDY') await showUnverifiedEvidence(tx, workspaceId, type, data, note, actor);
  const documentData = nativeTypes.has(type) ? data : { ...existing?.data, ...data };
  const documentId = await writeDocument(tx, workspaceId, type, item, inspection.stableKey, documentData, actor);
  await audit(workspaceId, actor, 'knowledge_import.destination_applied', { type: item.destination.toLowerCase(), id: entityId }, {
    itemId: item.id, sessionId: item.sessionId, documentId, relationships, previous: existing?.version ?? null,
  }, tx);
  return { destinationEntityId: entityId, destinationDocumentId: documentId, applicationResult: existing ? 'UPDATED' : 'CREATED' };
}

export async function syncImportRetrieval(workspaceId: string, itemId: string) {
  const item = await db().knowledgeImportItem.findFirst({ where: { workspaceId, id: itemId, status: 'APPLIED' } });
  if (!item?.destinationDocumentId) return { indexed: 0, skipped: 0, disabled: true };
  const document = await db().knowledgeDocument.findFirst({ where: { workspaceId, id: item.destinationDocumentId, isActive: true } });
  if (!document) return { indexed: 0, skipped: 0, disabled: true };
  return indexMemoryItems(workspaceId, [{
    entityType: 'KNOWLEDGE_DOCUMENT', entityId: document.id, content: `${document.title}\n${document.text}`,
    metadata: { kind: item.entityType, importItemId: item.id, importSessionId: item.sessionId, fileId: item.fileId, sourceLocator: item.sourceLocator, verificationStatus: item.verificationStatus },
  }]);
}

export async function getImportExclusions(workspaceId: string, subject: {
  industry?: string | null;
  companyType?: string | null;
  title?: string | null;
  geography?: string | null;
}) {
  const rows = await db().businessKnowledgeRecord.findMany({
    where: { workspaceId, kind: 'EXCLUSION' },
    include: { revisions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  return rows.flatMap(row => {
    const revision = row.revisions[0];
    if (!revision) return [];
    const data = revision.data as Payload;
    const provenance = revision.provenance as Payload;
    if (!recordForUse('EXCLUSION', typeof provenance.classification === 'string' ? provenance.classification : null)) return [];
    if (['inactive', 'false', 'disabled', 'no'].includes(fold(field(data, 'activeStatus')))) return [];
    const configured = (key: string, value?: string | null) => {
      const wanted = fold(value ?? '');
      return !!wanted && parts(data, key).some(entry => fold(entry) === wanted);
    };
    const match = configured('industries', subject.industry) || configured('companyTypes', subject.companyType)
      || configured('personas', subject.title) || configured('geography', subject.geography);
    const conditions = [...parts(data, 'disqualifyingSignals'), ...parts(data, 'suppressionConditions')];
    return [{ id: row.id, version: row.version, name: row.name, match, conditions }];
  });
}

/** Query the applied, active document allowlist before using shared memory or lexical fallback. */
export async function retrieveImportedKnowledge(workspaceId: string, query: string, types?: ImportEntityType[], limit = 8) {
  const rows = await db().knowledgeImportItem.findMany({
    where: {
      workspaceId, status: 'APPLIED', destinationDocumentId: { not: null }, applicationResult: { not: 'UNCHANGED' },
      ...(types ? { entityType: { in: types } } : {}),
    }, orderBy: { appliedAt: 'desc' }, take: 300,
    select: { id: true, sessionId: true, entityType: true, destinationDocumentId: true, sourceLocator: true, classification: true, verificationStatus: true, proposedValue: true, payload: true },
  });
  const config = rows.some(row => row.entityType === 'COMPANY_PROFILE' || row.entityType === 'COMMERCIAL_OFFER')
    ? await getConfig(workspaceId, 'KNOWLEDGE')
    : null;
  const eligibleRows = rows.filter(row => {
    const data = (row.proposedValue ?? row.payload) as Payload;
    if (row.entityType === 'COMPANY_PROFILE') return !!config && differences(config.data, profilePatch(data)).length === 0;
    if (row.entityType === 'COMMERCIAL_OFFER') {
      const proposed = offerPatch(data);
      return !!config?.data.offers.some(offer => fold(offer.name) === fold(field(data, 'name')) && differences(offer, proposed).length === 0);
    }
    return true;
  });
  const lookup = new Map(eligibleRows.flatMap(row => row.destinationDocumentId ? [[row.destinationDocumentId, row] as const] : []));
  if (!lookup.size) return [];
  const documents = await db().knowledgeDocument.findMany({
    where: { workspaceId, isActive: true, id: { in: [...lookup.keys()] } },
    select: { id: true, title: true, text: true, fileName: true },
  });
  if (!documents.length) return [];
  const vector = query.trim() ? await searchMemory(workspaceId, query, { KNOWLEDGE_DOCUMENT: documents.map(doc => doc.id) }, limit).catch(() => []) : [];
  const ranks = new Map(vector.map((hit, index) => [hit.entityId, vector.length - index]));
  const terms = [...new Set(fold(query).split(' ').filter(word => word.length >= 3))];
  const scored = documents.map(doc => {
    const title = fold(doc.title);
    const content = fold(doc.text);
    return { doc, score: (ranks.get(doc.id) ?? 0) + terms.reduce((n, word) => n + (title.includes(word) ? 3 : content.includes(word) ? 1 : 0), 0) };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(({ doc }) => {
    const item = lookup.get(doc.id)!;
    return { ...doc, title: neutralizeTags(doc.title), text: neutralizeTags(doc.text.slice(0, 1800)), fileName: doc.fileName && neutralizeTags(doc.fileName), entityType: item.entityType, importItemId: item.id, importSessionId: item.sessionId, sourceLocator: item.sourceLocator, classification: item.classification, verificationStatus: item.verificationStatus };
  });
}

export async function listKnowledgeRecords(workspaceId: string, kind?: ImportEntityType, limit = 100, offset = 0) {
  return db().businessKnowledgeRecord.findMany({
    where: { workspaceId, ...(kind ? { kind } : {}) },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: limit, skip: offset,
    include: { revisions: { orderBy: { version: 'desc' }, take: 1 } },
  });
}

export async function getKnowledgeRecord(workspaceId: string, id: string) {
  const record = await db().businessKnowledgeRecord.findFirst({
    where: { workspaceId, id },
    include: { revisions: { orderBy: { version: 'desc' }, take: 100 } },
  });
  if (!record) throw NotFound('Business knowledge record');
  return record;
}
