import { z } from 'zod';

// AI Studio configuration: business knowledge, global writing rules, research rules, and the
// campaign-level overrides. Pure functions only (shared by API, worker and UI).
//
// Precedence (most specific wins for single-value settings):
//   1. Workspace defaults (AI Studio)
//   2. Prompt profile settings (chosen by the campaign)
//   3. Campaign overrides (incl. ICP-specific instructions)
//   4. Sequence step instructions, then A/B variant instructions
//   5. Prospect-specific instructions written by a user on the lead record
//   (Prospect DATA — research, CRM fields, web content — is never treated as instructions.)
// Restrictive lists (words to avoid, forbidden claims, must-not-infer topics, bad examples) are
// UNIONED across levels: a lower level can add restrictions but can never remove one.
// Free-text instructions are concatenated in order (workspace → profile → campaign → ICP → step → variant)
// and the model is told that later (more specific) sections win on conflict, except HARD RULES,
// which no level can override.

const str = (max: number) => z.string().max(max);
const list = (maxItems: number, maxLen = 500) => z.array(z.string().trim().min(1).max(maxLen)).max(maxItems);

export const CommercialOfferSchema = z.object({
  name: str(200),
  description: str(2000).default(''),
  price: str(200).default(''),
  externalId: str(200).optional(),
  currency: str(40).optional(),
  billingModel: str(200).optional(),
  deliverables: list(40).optional(),
  duration: str(200).optional(),
  conditions: str(1000).optional(),
  eligibility: str(1000).optional(),
  availability: str(500).optional(),
});

export const KnowledgeSchema = z.object({
  companyName: str(200).default(''),
  website: str(300).default(''),
  description: str(5000).default(''),
  services: z.array(z.object({ name: str(200), description: str(2000).default('') })).max(50).default([]),
  products: z.array(z.object({ name: str(200), description: str(2000).default('') })).max(50).default([]),
  usps: list(30).default([]),
  caseStudies: z.array(z.object({ title: str(200), summary: str(3000).default(''), result: str(1000).default(''), url: str(500).default(''), verified: z.boolean().default(false) })).max(50).default([]),
  achievements: z.array(z.object({ text: str(1000), source: str(500).default(''), verified: z.boolean().default(false) })).max(50).default([]),
  targetAudience: str(3000).default(''),
  competitors: z.array(z.object({ name: str(200), notes: str(1000).default('') })).max(30).default([]),
  customerProfiles: str(5000).default(''),
  offers: z.array(CommercialOfferSchema).max(30).default([]),
  pricingNotes: str(3000).default(''),
});
export type Knowledge = z.infer<typeof KnowledgeSchema>;

export const TONES = ['friendly', 'professional', 'direct', 'consultative', 'casual'] as const;
export const CTA_STYLES = ['soft_question', 'interest_check', 'meeting_request', 'resource_offer', 'booking_link'] as const;

export const WritingSchema = z.object({
  tone: z.enum(TONES).default('friendly'),
  style: str(1000).default('Plain, conversational, specific. No marketing fluff.'),
  minWords: z.number().int().min(10).max(500).default(40),
  maxWords: z.number().int().min(20).max(800).default(120),
  sentenceComplexity: z.enum(['simple', 'moderate', 'advanced']).default('simple'),
  personalizationIntensity: z.enum(['light', 'medium', 'deep']).default('medium'),
  ctaStyle: z.enum(CTA_STYLES).default('soft_question'),
  formality: z.enum(['informal', 'neutral', 'formal']).default('neutral'),
  language: str(60).default('English'),
  avoidPhrases: list(100, 200).default(['I hope this email finds you well', 'I came across your profile', 'synergy', 'game-changer']),
  forbiddenClaims: list(100).default(['guaranteed results', 'we are the best', 'number one agency']),
  goodExamples: list(10, 4000).default([]),
  badExamples: list(10, 4000).default([]),
  customInstructions: str(20000).default(''),
}).refine((w) => w.maxWords >= w.minWords, { message: 'maxWords must be ≥ minWords', path: ['maxWords'] });
export type Writing = z.infer<typeof WritingSchema>;

export const ResearchSchema = z.object({
  personTopics: list(30).default(['current role and responsibilities', 'public talks, podcasts or articles they authored or appeared in']),
  companyTopics: list(30).default(['what the company sells and to whom', 'recent public announcements, launches or hiring', 'content they publish']),
  permittedSources: z.object({
    companyWebsite: z.boolean().default(true),
    webSearch: z.boolean().default(true),
    newsAndArticles: z.boolean().default(true),
    podcastsAndInterviews: z.boolean().default(true),
    dataProvider: z.boolean().default(true),
    userProvided: z.boolean().default(true),
  }).default({ companyWebsite: true, webSearch: true, newsAndArticles: true, podcastsAndInterviews: true, dataProvider: true, userProvided: true }),
  signals: list(30).default(['new service or product launch', 'hiring for growth roles', 'publishing content regularly', 'expanding to new markets']),
  recentSignalDays: z.number().int().min(1).max(365).default(90),
  extendedSignalDays: z.number().int().min(1).max(730).default(365),
  minClaims: z.number().int().min(0).max(10).default(1),
  maxEvidenceAgeDays: z.number().int().min(1).max(3650).nullable().default(365),
  maxSearchQueriesPerRun: z.number().int().min(0).max(6).default(3),
  maxSearchesPerProspect: z.number().int().min(0).max(20).default(6),
  maxPagesPerRun: z.number().int().min(1).max(12).default(7),
  deepResearchScoreThreshold: z.number().int().min(0).max(100).default(65),
  mustNotInfer: list(50).default(['health', 'religion', 'politics', 'ethnicity', 'sexual orientation', 'family situation', 'personal finances', 'age']),
  onMissing: z.enum(['hold_for_research', 'use_role_and_company_only', 'skip_lead']).default('hold_for_research'),
  customInstructions: str(10000).default(''),
  importedRules: z.record(str(220), z.object({
    name: str(200),
    priorities: list(40).default([]),
    excludedSources: list(40).default([]),
    verificationRequirements: list(40).default([]),
    evidenceRequirements: str(5000).optional(),
    depth: str(500).optional(),
  })).optional(),
});
export type Research = z.infer<typeof ResearchSchema>;

// Overrides: every field optional (refine() on WritingSchema hides its shape, so it is declared explicitly).
export const WritingOverridesSchema = z.object({
  tone: z.enum(TONES).optional(),
  style: str(1000).optional(),
  minWords: z.number().int().min(10).max(500).optional(),
  maxWords: z.number().int().min(20).max(800).optional(),
  sentenceComplexity: z.enum(['simple', 'moderate', 'advanced']).optional(),
  personalizationIntensity: z.enum(['light', 'medium', 'deep']).optional(),
  ctaStyle: z.enum(CTA_STYLES).optional(),
  formality: z.enum(['informal', 'neutral', 'formal']).optional(),
  language: str(60).optional(),
  avoidPhrases: list(100, 200).optional(),
  forbiddenClaims: list(100).optional(),
  goodExamples: list(10, 4000).optional(),
  badExamples: list(10, 4000).optional(),
  customInstructions: str(20000).optional(),
});
export type WritingOverrides = z.infer<typeof WritingOverridesSchema>;

export const ResearchOverridesSchema = z.object({
  personTopics: list(30).optional(),
  companyTopics: list(30).optional(),
  signals: list(30).optional(),
  minClaims: z.number().int().min(0).max(10).optional(),
  maxEvidenceAgeDays: z.number().int().min(1).max(3650).nullable().optional(),
  mustNotInfer: list(50).optional(),
  onMissing: z.enum(['hold_for_research', 'use_role_and_company_only', 'skip_lead']).optional(),
  customInstructions: str(10000).optional(),
});

export const CampaignAiOverridesSchema = z.object({
  writing: WritingOverridesSchema.default({}),
  research: ResearchOverridesSchema.default({}),
  audienceContext: str(5000).default(''),
  offerContext: str(5000).default(''),
  objective: str(1000).optional(),
  targetGeography: list(30).optional(),
  targetIndustries: list(30).optional(),
  targetDecisionMaker: str(1000).optional(),
  desiredProspectOutcome: str(2000).optional(),
  outreachAngle: str(2000).optional(),
  buyingSignals: list(30).optional(),
  exclusions: list(50).optional(),
  customInstructions: str(20000).default(''),
  /** Where this campaign's AI runs: the workspace AI source, API keys, or a personal Claude / Codex subscription. */
  aiSource: z.enum(['workspace', 'api', 'claude_subscription', 'codex_subscription']).default('workspace'),
});
export type CampaignAiOverrides = z.infer<typeof CampaignAiOverridesSchema>;

export const DEFAULT_KNOWLEDGE: Knowledge = KnowledgeSchema.parse({});
export const DEFAULT_WRITING: Writing = WritingSchema.parse({});
export const DEFAULT_RESEARCH: Research = ResearchSchema.parse({});

// ------------------------------------------------------------------ resolution

export type Level = 'workspace' | 'profile' | 'campaign' | 'icp' | 'step' | 'variant' | 'prospect';
export interface InstructionBlock { level: Level; label: string; text: string }

export interface ResolvedConfig {
  writing: Writing;
  research: Research;
  /** Which level supplied each single-value writing setting. */
  writingSources: Record<string, Level>;
  blocks: InstructionBlock[];
  audienceContext: string;
  offerContext: string;
  campaignContext: string;
}

const UNION_WRITING = ['avoidPhrases', 'forbiddenClaims', 'goodExamples', 'badExamples'] as const;
const SCALAR_WRITING = ['tone', 'style', 'minWords', 'maxWords', 'sentenceComplexity', 'personalizationIntensity', 'ctaStyle', 'formality', 'language'] as const;

function uniq(xs: string[]) {
  const seen = new Set<string>();
  return xs.filter((x) => { const k = x.trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}

export interface ResolveInput {
  workspace: { writing: Writing; research: Research };
  profile?: { name: string; settings: WritingOverrides; instructions?: string } | null;
  campaign?: CampaignAiOverrides | null;
  icp?: { name: string; aiInstructions: string | null } | null;
  step?: { order: number; aiInstructions: string | null } | null;
  variant?: { label: string; aiInstructions: string | null } | null;
}

export function resolveConfig(input: ResolveInput): ResolvedConfig {
  const writing: Writing = { ...input.workspace.writing };
  const sources: Record<string, Level> = Object.fromEntries(SCALAR_WRITING.map((k) => [k, 'workspace' as Level]));
  const layers: Array<[Level, WritingOverrides | undefined]> = [
    ['profile', input.profile?.settings],
    ['campaign', input.campaign?.writing],
  ];
  for (const [level, o] of layers) {
    if (!o) continue;
    for (const k of SCALAR_WRITING) {
      const v = o[k];
      if (v !== undefined && v !== null && v !== '') { (writing as Record<string, unknown>)[k] = v; sources[k] = level; }
    }
    for (const k of UNION_WRITING) if (o[k]?.length) writing[k] = uniq([...writing[k], ...o[k]!]);
  }
  if (writing.maxWords < writing.minWords) writing.maxWords = writing.minWords;

  const research: Research = { ...input.workspace.research };
  const ro = input.campaign?.research;
  if (ro) {
    if (ro.personTopics?.length) research.personTopics = uniq([...research.personTopics, ...ro.personTopics]);
    if (ro.companyTopics?.length) research.companyTopics = uniq([...research.companyTopics, ...ro.companyTopics]);
    if (ro.signals?.length) research.signals = uniq([...research.signals, ...ro.signals]);
    if (ro.mustNotInfer?.length) research.mustNotInfer = uniq([...research.mustNotInfer, ...ro.mustNotInfer]);
    if (ro.minClaims !== undefined) research.minClaims = ro.minClaims;
    if (ro.maxEvidenceAgeDays !== undefined) research.maxEvidenceAgeDays = ro.maxEvidenceAgeDays;
    if (ro.onMissing) research.onMissing = ro.onMissing;
    if (ro.customInstructions?.trim()) research.customInstructions = [research.customInstructions, `Campaign: ${ro.customInstructions}`].filter(Boolean).join('\n');
  }

  const blocks: InstructionBlock[] = [];
  const push = (level: Level, label: string, text: string | null | undefined) => { if (text?.trim()) blocks.push({ level, label, text: text.trim() }); };
  push('workspace', 'Workspace writing instructions', input.workspace.writing.customInstructions);
  push('profile', `Prompt profile "${input.profile?.name ?? ''}"`, input.profile?.instructions);
  push('profile', `Prompt profile "${input.profile?.name ?? ''}" writing notes`, input.profile?.settings?.customInstructions);
  push('campaign', 'Campaign instructions', input.campaign?.customInstructions);
  push('campaign', 'Campaign writing notes', input.campaign?.writing?.customInstructions);
  push('icp', `ICP "${input.icp?.name ?? ''}" instructions`, input.icp?.aiInstructions);
  push('step', `Sequence step ${input.step?.order ?? ''} instructions`, input.step?.aiInstructions);
  push('variant', `Variant ${input.variant?.label ?? ''} instructions`, input.variant?.aiInstructions);

  const campaignContext = [
    input.campaign?.objective ? `Objective: ${input.campaign.objective}` : '',
    input.campaign?.targetGeography?.length ? `Target geography: ${input.campaign.targetGeography.join(', ')}` : '',
    input.campaign?.targetIndustries?.length ? `Target industries: ${input.campaign.targetIndustries.join(', ')}` : '',
    input.campaign?.targetDecisionMaker ? `Target decision-maker: ${input.campaign.targetDecisionMaker}` : '',
    input.campaign?.desiredProspectOutcome ? `Desired prospect outcome: ${input.campaign.desiredProspectOutcome}` : '',
    input.campaign?.outreachAngle ? `Outreach angle: ${input.campaign.outreachAngle}` : '',
    input.campaign?.buyingSignals?.length ? `Relevant buying signals: ${input.campaign.buyingSignals.join(', ')}` : '',
    input.campaign?.exclusions?.length ? `Campaign exclusions: ${input.campaign.exclusions.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  return { writing, research, writingSources: sources, blocks, audienceContext: input.campaign?.audienceContext ?? '', offerContext: input.campaign?.offerContext ?? '', campaignContext };
}

const LEVEL_ORDER: Level[] = ['workspace', 'profile', 'campaign', 'icp', 'step', 'variant', 'prospect'];

/** Human/AI-readable instruction text with the conflict rule spelled out. */
export function instructionText(r: ResolvedConfig): string {
  const w = r.writing;
  const lines = [
    'WRITING SETTINGS (resolved):',
    `- Language: ${w.language}. Tone: ${w.tone}. Formality: ${w.formality}. Sentence complexity: ${w.sentenceComplexity}.`,
    `- Style: ${w.style}`,
    `- Length: ${w.minWords}–${w.maxWords} words for the body (excluding signature and footer).`,
    `- Personalization intensity: ${w.personalizationIntensity} (${w.personalizationIntensity === 'deep' ? 'build the email around one specific, evidenced observation' : w.personalizationIntensity === 'medium' ? 'open with one specific, evidenced observation and connect it to the offer' : 'one light, evidenced reference is enough'}).`,
    `- Call to action style: ${w.ctaStyle.replace(/_/g, ' ')}. Exactly one call to action.`,
  ];
  if (w.avoidPhrases.length) lines.push(`- Never use these words or phrases: ${w.avoidPhrases.map((p) => `"${p}"`).join(', ')}.`);
  if (w.forbiddenClaims.length) lines.push(`- Never make these claims: ${w.forbiddenClaims.map((p) => `"${p}"`).join(', ')}.`);
  if (w.goodExamples.length) lines.push('WRITING EXAMPLES TO FOLLOW (style only — never copy facts from them):', ...w.goodExamples.map((e, i) => `<example n="${i + 1}">\n${e}\n</example>`));
  if (w.badExamples.length) lines.push('EXAMPLES OF UNACCEPTABLE WRITING (do not write like this):', ...w.badExamples.map((e, i) => `<bad_example n="${i + 1}">\n${e}\n</bad_example>`));
  if (r.audienceContext.trim()) lines.push(`TARGET AUDIENCE CONTEXT (campaign): ${r.audienceContext.trim()}`);
  if (r.offerContext.trim()) lines.push(`OFFER CONTEXT (campaign): ${r.offerContext.trim()}`);
  if (r.campaignContext.trim()) lines.push(`STRUCTURED CAMPAIGN OBJECTIVE AND TARGETING:\n${r.campaignContext}`);
  if (r.blocks.length) {
    lines.push('CUSTOM INSTRUCTIONS, from general to specific. If two sections conflict, follow the LATER (more specific) one — except the HARD RULES, which always apply:');
    const sorted = [...r.blocks].sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
    for (const b of sorted) lines.push(`### ${b.label} [${b.level}]\n${b.text}`);
  }
  return lines.join('\n');
}

export function researchFocusText(r: Research): string {
  return [
    `Person topics: ${r.personTopics.join('; ') || '(none)'}`,
    `Company topics: ${r.companyTopics.join('; ') || '(none)'}`,
    `Business signals that matter: ${r.signals.join('; ') || '(none)'}`,
    `Never infer or extract anything about: ${r.mustNotInfer.join(', ') || '(none)'}`,
    r.customInstructions.trim() ? `Additional research instructions: ${r.customInstructions.trim()}` : '',
  ].filter(Boolean).join('\n');
}

/** Trusted facts about OUR company. Unverified case studies and achievements are excluded. */
export function knowledgeText(k: Knowledge, documents: Array<{ title: string; text: string }> = [], maxDocChars = 12_000): string {
  const out: string[] = [];
  if (k.companyName) out.push(`Company: ${k.companyName}${k.website ? ` (${k.website})` : ''}`);
  if (k.description) out.push(`Description: ${k.description}`);
  if (k.services.length) out.push('Services:', ...k.services.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}`));
  if (k.products.length) out.push('Products:', ...k.products.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}`));
  if (k.usps.length) out.push('What makes us different:', ...k.usps.map((u) => `- ${u}`));
  // A stale `verified` flag must not turn an unfinished template into usable proof.
  // Require both a summary and result, and reject common editorial placeholders.
  const hasPlaceholder = (value: string) => /\[[^\]]+\]|\b(?:enter the exact|specify the exact|define precisely|add a supporting|pending human review|to be completed|insert here)\b/i.test(value);
  const cs = k.caseStudies.filter((c) => c.verified && c.summary.trim() && c.result.trim() && !hasPlaceholder(`${c.title}\n${c.summary}\n${c.result}`));
  if (cs.length) out.push('Verified case studies (may be referenced):', ...cs.map((c) => `- ${c.title}: ${c.summary}${c.result ? ` Result: ${c.result}` : ''}`));
  const ach = k.achievements.filter((a) => a.verified);
  if (ach.length) out.push('Verified achievements (may be referenced):', ...ach.map((a) => `- ${a.text}`));
  const unverified = k.caseStudies.length - cs.length + k.achievements.length - ach.length;
  if (unverified) out.push(`(${unverified} unverified case studies/achievements exist and must NOT be mentioned.)`);
  if (k.targetAudience) out.push(`Who we serve: ${k.targetAudience}`);
  if (k.customerProfiles) out.push(`Customer profiles: ${k.customerProfiles}`);
  if (k.offers.length) out.push('Offers:', ...k.offers.map((o) => [
    `- ${o.name}${o.description ? `: ${o.description}` : ''}${o.price ? ` (price: ${o.price}${o.currency ? ` ${o.currency}` : ''})` : ''}`,
    o.billingModel && `Billing: ${o.billingModel}`,
    o.deliverables?.length && `Deliverables: ${o.deliverables.join(', ')}`,
    o.duration && `Duration: ${o.duration}`, o.conditions && `Conditions: ${o.conditions}`,
    o.eligibility && `Eligibility: ${o.eligibility}`, o.availability && `Availability: ${o.availability}`,
  ].filter(Boolean).join(' | ')));
  if (k.pricingNotes) out.push(`Pricing notes: ${k.pricingNotes}`);
  if (k.competitors.length) out.push('Competitors (never disparage them by name):', ...k.competitors.map((c) => `- ${c.name}${c.notes ? `: ${c.notes}` : ''}`));
  let budget = maxDocChars;
  for (const d of documents) {
    if (budget <= 0) break;
    const t = d.text.slice(0, budget);
    budget -= t.length;
    out.push(`<reference_document title="${d.title.replace(/"/g, "'")}">\n${t}\n</reference_document>`);
  }
  return out.join('\n') || '(no business knowledge configured — do not make claims about our company beyond the offer context)';
}
