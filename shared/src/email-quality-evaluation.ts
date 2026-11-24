/**
 * Human-annotated email-quality benchmark, kept separate from qualification cases.
 * Inputs are synthetic; no provider is invoked and no generated email is approved.
 */
export type EvaluationPartition = 'tuning' | 'held_out';
export type EmailQualityDimension =
  | 'researchAccuracy'
  | 'identityCorrectness'
  | 'opportunityRelevance'
  | 'serviceMatch'
  | 'openingSpecificity'
  | 'naturalLanguage'
  | 'businessRelevance'
  | 'ctaRelevance';

export interface EmailQualityCase {
  id: string;
  partition: EvaluationPartition;
  synthetic: true;
  input: {
    prospect: { name: string; title: string; company: string; industry: string; country: string };
    evidence: Array<{ id: string; text: string; url: string }>;
    approvedServices: Array<{ id: string; name: string; eligibleProblem: string; deliverable: string; verifiedProof: string[] }>;
    campaignGoal: string;
    writingRules: string[];
  };
}

const scenarios = [
  { key: 'specific-signal', evidence: 'The company announced a named product launch for its B2B platform this quarter.', problem: 'Explain a new product clearly to a defined buyer audience.', service: 'Product-led content strategy' },
  { key: 'weak-signal', evidence: 'The company website lists its services but contains no recent growth or launch signal.', problem: 'Make service positioning easier for buyers to understand.', service: 'Positioning and content strategy' },
  { key: 'ambiguous-signal', evidence: 'A social post asks followers what topics they want to see, without describing a commercial initiative.', problem: 'Develop a consistent educational content plan.', service: 'Editorial planning' },
  { key: 'identity-sensitive', evidence: 'The official team page lists the prospect as an operations manager, not a marketing decision-maker.', problem: 'Improve the clarity of product information for internal teams.', service: 'B2B content strategy' },
  { key: 'proof-boundary', evidence: 'The company publishes a case study, but no independently verified performance result is available.', problem: 'Present product value with evidence and clear boundaries.', service: 'Evidence-led content development' },
  { key: 'exclusion', evidence: 'The company primarily sells to consumers and has no business-to-business offering.', problem: 'Acquire qualified business buyers.', service: 'B2B demand content' },
] as const;

/** 36 synthetic benchmark contexts: 18 tuning and 18 held-out, with no email examples. */
export const EMAIL_QUALITY_DATASET: EmailQualityCase[] = scenarios.flatMap((scenario, i) =>
  Array.from({ length: 6 }, (_, n) => {
    const ordinal = n + 1;
    const id = `emailq-${scenario.key}-${ordinal}`;
    const evidenceId = `${id}-e1`;
    return {
      id,
      partition: ordinal <= 3 ? 'tuning' as const : 'held_out' as const,
      synthetic: true as const,
      input: {
        prospect: {
          name: `Synthetic Person ${i + 1}-${ordinal}`,
          title: scenario.key === 'identity-sensitive' ? 'Operations Manager' : 'VP of Marketing',
          company: `Synthetic Business ${i + 1}-${ordinal}`,
          industry: scenario.key === 'exclusion' ? 'consumer retail' : 'B2B software',
          country: ['US', 'GB', 'AU'][(i + ordinal) % 3],
        },
        evidence: [{ id: evidenceId, text: scenario.evidence, url: `https://example.invalid/${id}` }],
        approvedServices: scenario.key === 'exclusion' ? [] : [{
          id: `svc-${scenario.key}`,
          name: scenario.service,
          eligibleProblem: scenario.problem,
          deliverable: 'A scoped content plan and one sample asset',
          verifiedProof: scenario.key === 'proof-boundary' ? [] : ['Synthetic approved proof only; no numeric performance claim is authorized.'],
        }],
        campaignGoal: 'Offer one relevant next step if the evidence supports contacting this person.',
        writingRules: ['Use only supplied evidence.', 'Do not imply unsupported results.', 'Use one natural, low-pressure CTA.', 'Hold when identity, relevance, or service eligibility is not established.'],
      },
    };
  }),
);

export const EMAIL_QUALITY_DIMENSIONS: EmailQualityDimension[] = [
  'researchAccuracy', 'identityCorrectness', 'opportunityRelevance', 'serviceMatch',
  'openingSpecificity', 'naturalLanguage', 'businessRelevance', 'ctaRelevance',
];

export interface EmailQualityAnnotation {
  caseId: string;
  inputFingerprint: string;
  variantId: string;
  annotationMethod: 'HUMAN';
  reviewerId: string;
  email: string;
  scores: Record<EmailQualityDimension, number>;
  unsupportedClaim: boolean;
  genericContent: boolean;
  humanCorrectionRequired: boolean;
}

/** Aggregate independent reviewer annotations; no automated judge substitutes for human review. */
export function scoreEmailQuality(annotations: EmailQualityAnnotation[]) {
  const variants = [...new Set(annotations.map((a) => a.variantId))].sort();
  return variants.map((variantId) => {
    const rows = annotations.filter((a) => a.variantId === variantId);
    const dimensionMeans = Object.fromEntries(EMAIL_QUALITY_DIMENSIONS.map((dimension) => [
      dimension,
      rows.length ? rows.reduce((sum, row) => sum + row.scores[dimension], 0) / rows.length : 0,
    ])) as Record<EmailQualityDimension, number>;
    const rate = (predicate: (row: EmailQualityAnnotation) => boolean) => rows.length ? rows.filter(predicate).length / rows.length : 0;
    return {
      variantId,
      evaluated: rows.length,
      meanDimensionScores: dimensionMeans,
      meanQualityScore: rows.length ? EMAIL_QUALITY_DIMENSIONS.reduce((sum, d) => sum + dimensionMeans[d] / 5, 0) / EMAIL_QUALITY_DIMENSIONS.length : 0,
      unsupportedClaimRate: rate((r) => r.unsupportedClaim),
      genericContentRate: rate((r) => r.genericContent),
      humanCorrectionRate: rate((r) => r.humanCorrectionRequired),
    };
  });
}

export function compareEmailQualityOnSameInputs(annotations: EmailQualityAnnotation[]) {
  const byVariant = scoreEmailQuality(annotations);
  const inputSets = byVariant.map(({ variantId }) => new Set(annotations.filter((a) => a.variantId === variantId).map((a) => `${a.caseId}:${a.inputFingerprint}`)));
  const sameInputs = inputSets.length < 2 || inputSets.every((set) => set.size === inputSets[0].size && [...set].every((id) => inputSets[0].has(id)));
  return { sameInputs, variants: byVariant };
}
