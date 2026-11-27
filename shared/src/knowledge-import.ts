import { z } from 'zod';

export const IMPORT_ENTITIES = {
  COMPANY_PROFILE: { sheet: 'Company_Profile', fields: 'website positioning mission valueProposition industries geography businessModel differentiators legalEntity companySize targetAudience customerProfiles pricingNotes' },
  PRODUCT: { sheet: 'Products', fields: '' },
  SERVICE: { sheet: 'Services', fields: 'customerProblems targetCustomerProfiles deliverables methodology desiredOutcomes targetIndustries excludedIndustries targetGeographies excludedGeographies minEmployeeCount maxEmployeeCount exclusionRules exclusions eligibilityCriteria commercialBoundaries availability supportingEvidence' },
  COMMERCIAL_OFFER: { sheet: 'Commercial_Offers', fields: 'price currency billingModel deliverables duration conditions eligibility availability' },
  TARGET_AUDIENCE: { sheet: 'Target_Audiences', fields: 'industries companySize geography businessModel characteristics challenges buyingTriggers qualificationNotes sourceEvidence' },
  TARGET_PERSONA: { sheet: 'Target_Personas', fields: 'jobTitles seniority responsibilities goals challenges motivations objections buyingTriggers buyingAuthority' },
  ICP_CRITERIA: { sheet: 'ICP_Criteria', fields: 'titles seniorities industries countries employeeMin employeeMax keywords aiInstructions isActive requiredConditions optionalConditions negativeConditions characteristics qualificationSignals disqualificationSignals scoringRules weight threshold category evidenceRequirements' },
  BUSINESS_OPPORTUNITY: { sheet: 'Business_Opportunities', fields: 'marketProblem marketSignals businessPotential evidence status disqualifyingConditions' },
  COMPETITOR: { sheet: 'Competitors', fields: 'website positioning services marketSegment industries differentiators observations sourceEvidence' },
  RESEARCH_SETTINGS: { sheet: 'Research_Settings', fields: 'personTopics companyTopics signals recentSignalDays extendedSignalDays minClaims maxEvidenceAgeDays maxSearchQueriesPerRun maxSearchesPerProspect maxPagesPerRun deepResearchScoreThreshold mustNotInfer onMissing customInstructions companyWebsite webSearch newsAndArticles podcastsAndInterviews dataProvider userProvided' },
  WRITING_SETTINGS: { sheet: 'Writing_Settings', fields: 'tone style minWords maxWords sentenceComplexity personalizationIntensity ctaStyle formality language avoidPhrases forbiddenClaims goodExamples badExamples customInstructions' },
  RESEARCH_RULE: { sheet: 'Research_Rules', fields: 'sources priorities verificationRequirements excludedSources depth evidenceRequirements recencyRequirement confidenceRequirements' },
  PROMPT_PROFILE: { sheet: 'Prompt_Profiles', fields: 'instructions tone style minWords maxWords sentenceComplexity personalizationIntensity ctaStyle formality language avoidPhrases forbiddenClaims goodExamples badExamples customInstructions' },
  TRAINING_EXAMPLE: { sheet: 'Training_Examples', fields: 'content correctedContent category polarity explanation tags isActive' },
  OUTREACH_RULE: { sheet: 'Outreach_Rules', fields: 'tone personalizationRules messagingRestrictions ctaPreferences followUpPolicies prohibitedLanguage channels wordLimits category priority condition status triggerTerms' },
  EXCLUSION: { sheet: 'Exclusions', fields: 'industries companyTypes personas geography disqualifyingSignals suppressionConditions reason scope activeStatus' },
  ACHIEVEMENT: { sheet: 'Achievements', fields: 'sourceEvidence' },
  PROOF_CASE_STUDY: { sheet: 'Proof_Case_Studies', fields: 'client industries startingSituation workPerformed results metrics timePeriod evidence publicationPermission' },
  CAMPAIGN_PREFERENCE: { sheet: 'Campaign_Preferences', fields: 'objective targetSegments channels messagingPreferences volumeConstraints qualificationRequirements titles seniorities countries keywords personTopics companyTopics signals mustNotInfer avoidPhrases forbiddenClaims goodExamples badExamples triggerTerms tags excludedIndustries excludedGeographies' },
} as const;

export type ImportEntityType = keyof typeof IMPORT_ENTITIES;
export const ImportEntityTypeSchema = z.enum(Object.keys(IMPORT_ENTITIES) as [ImportEntityType, ...ImportEntityType[]]);
export const ImportClassificationSchema = z.enum(['EXPLICIT_FACT', 'CLAIM', 'INFERENCE', 'RECOMMENDATION', 'UNKNOWN']);

export const ImportExtractionOutput = z.strictObject({
  items: z.array(z.strictObject({
    sourceIndex: z.number().int().nonnegative(),
    entityType: ImportEntityTypeSchema,
    fields: z.array(z.strictObject({
      key: z.string().max(60),
      values: z.array(z.string().trim().min(1).max(10000)).min(1).max(40),
    })).min(1).max(35),
    confidence: z.number().min(0).max(1),
    classification: ImportClassificationSchema,
    sourceExcerpt: z.string().trim().min(1).max(2000),
    relationships: z.array(z.strictObject({
      entityType: ImportEntityTypeSchema,
      externalId: z.string().trim().min(1).max(200),
    })).max(40),
    mappingExplanation: z.string().trim().min(1).max(2000),
  })).max(32),
});
export type ImportRelationship = z.infer<typeof ImportExtractionOutput>['items'][number]['relationships'][number];

const LIST_FIELDS = new Set((
  'industries geography differentiators customerProblems targetCustomerProfiles deliverables desiredOutcomes targetIndustries targetGeographies exclusions eligibilityCriteria commercialBoundaries characteristics challenges buyingTriggers jobTitles responsibilities goals motivations objections requiredConditions optionalConditions negativeConditions qualificationSignals disqualificationSignals scoringRules marketSignals disqualifyingConditions services observations sources priorities verificationRequirements excludedSources personalizationRules messagingRestrictions ctaPreferences followUpPolicies prohibitedLanguage channels companyTypes personas disqualifyingSignals suppressionConditions metrics targetSegments qualificationRequirements titles seniorities countries keywords personTopics companyTopics signals mustNotInfer avoidPhrases forbiddenClaims goodExamples badExamples'
).split(' '));
const NUMERIC_FIELDS = new Set(['price', 'weight', 'threshold', 'wordLimits', 'volumeConstraints', 'minWords', 'maxWords', 'recentSignalDays', 'extendedSignalDays', 'minClaims', 'maxEvidenceAgeDays', 'maxSearchQueriesPerRun', 'maxSearchesPerProspect', 'maxPagesPerRun', 'deepResearchScoreThreshold', 'employeeMin', 'employeeMax', 'minEmployeeCount', 'maxEmployeeCount']);

export function importFieldKind(key: string) {
  if (LIST_FIELDS.has(key)) return 'list';
  if (NUMERIC_FIELDS.has(key)) return 'numeric';
  return 'text';
}

export function importFieldNames(entityType: string) {
  if (!Object.hasOwn(IMPORT_ENTITIES, entityType)) return [];
  return ['name', 'description', 'externalId', ...IMPORT_ENTITIES[entityType as ImportEntityType].fields.split(' ').filter(Boolean)];
}

export function importPayloadSchema(entityType: ImportEntityType) {
  const entries = importFieldNames(entityType).map(key => {
    const kind = importFieldKind(key);
    const field = kind === 'list' ? z.array(z.string().trim().min(1).max(10000)).min(1).max(40)
      : kind === 'numeric' ? z.union([z.number().finite().nonnegative(), z.string().trim().min(1).max(200)])
        : z.string().trim().min(1).max(key === 'externalId' || key === 'name' ? 200 : 10000);
    return [key, field.optional()] as const;
  });
  return z.strictObject(Object.fromEntries(entries));
}

export function validateImportPayload(entityType: ImportEntityType, value: unknown) {
  return importPayloadSchema(entityType).parse(value) as Record<string, string | string[] | number>;
}

export function importFieldsToPayload(entityType: ImportEntityType, fields: { key: string; values: string[] }[]) {
  const data = new Map<string, string | string[]>();
  for (const { key, values } of fields) {
    if (data.has(key)) throw new Error('Duplicate extraction field');
    if (!LIST_FIELDS.has(key) && values.length !== 1) throw new Error('Expected a single field value');
    data.set(key, LIST_FIELDS.has(key) ? values : values[0]);
  }
  return validateImportPayload(entityType, Object.fromEntries(data));
}
