export type ExpectedOutreachDecision = 'QUALIFIED' | 'HOLD' | 'REJECTED' | 'INSUFFICIENT_RESEARCH' | 'NO_SUITABLE_SERVICE';
export type EvaluationCategory = 'STRONG_FIT' | 'WEAK_FIT' | 'WRONG_CONTACT' | 'INSUFFICIENT_RESEARCH' | 'AMBIGUOUS_SIGNAL' | 'NO_SUITABLE_SERVICE';
export interface ProspectEvaluationCase {
  id: string;
  category: EvaluationCategory;
  partition: 'train' | 'held_out';
  synthetic: true;
  prospect: { name: string; title: string; company: string; industry: string | null; country: string | null; evidence: Array<{ id: string; text: string; type: 'official_company' | 'professional_profile' | 'public_activity' }> };
  expected: { decision: ExpectedOutreachDecision; emailAllowed: boolean; service: string | null; requiredEvidenceIds: string[]; reason: string };
}

const roles = ['Founder', 'CEO', 'Head of Marketing', 'Marketing Director', 'Growth Lead', 'Managing Partner', 'VP of Marketing', 'Chief Operating Officer', 'Content Lead', 'Business Development Director', 'Owner', 'Commercial Director'];
const industries = ['B2B software', 'ecommerce', 'professional services', 'education technology', 'healthcare technology', 'consumer brands', 'business consulting', 'financial technology', 'manufacturing', 'media', 'logistics', 'hospitality'];
const countries = ['US', 'GB', 'AU', 'CA', 'IE', 'NZ', 'SG', 'DE', 'NL', 'FR', 'SE', 'AE'];
const decisions: Record<EvaluationCategory, { decision: ExpectedOutreachDecision; emailAllowed: boolean; service: string | null; reason: string }> = {
  STRONG_FIT: { decision: 'QUALIFIED', emailAllowed: true, service: 'content-strategy', reason: 'Verified company activity and relevant decision-maker meet the approved service criteria.' },
  WEAK_FIT: { decision: 'REJECTED', emailAllowed: false, service: null, reason: 'Explicit disqualifier or poor fit outweighs superficial similarity.' },
  WRONG_CONTACT: { decision: 'HOLD', emailAllowed: false, service: null, reason: 'The company may fit, but evidence contradicts the uploaded person identity or role.' },
  INSUFFICIENT_RESEARCH: { decision: 'INSUFFICIENT_RESEARCH', emailAllowed: false, service: null, reason: 'Evidence is missing, stale, or too weak to support a person-specific approach.' },
  AMBIGUOUS_SIGNAL: { decision: 'HOLD', emailAllowed: false, service: null, reason: 'A possible buying signal is ambiguous and must not be represented as a fact.' },
  NO_SUITABLE_SERVICE: { decision: 'NO_SUITABLE_SERVICE', emailAllowed: false, service: null, reason: 'The prospect is real and researched, but no approved service is eligible.' },
};

/** Synthetic decision-only evaluation cases; deliberately contains no generated email examples. */
export const PROSPECT_EVALUATION_DATASET: ProspectEvaluationCase[] = (Object.keys(decisions) as EvaluationCategory[]).flatMap((category) => Array.from({ length: 12 }, (_, i) => {
  const n = i + 1;
  const id = `${category.toLowerCase()}-${String(n).padStart(2, '0')}`;
  const person = `Synthetic Prospect ${category.replaceAll('_', ' ')} ${n}`;
  const evidenceId = `${id}-evidence-1`;
  const evidence = category === 'INSUFFICIENT_RESEARCH' ? [] : category === 'AMBIGUOUS_SIGNAL'
    ? [{ id: evidenceId, text: 'Public posting mentions a possible future initiative without a confirmed purchase or launch.', type: 'public_activity' as const }]
    : category === 'WRONG_CONTACT'
      ? [{ id: evidenceId, text: 'Public company profile lists a different person in the claimed decision-making role.', type: 'professional_profile' as const }]
      : [{ id: evidenceId, text: `Synthetic official company evidence for ${industries[(n - 1) % industries.length]}; category-specific case notes govern the expected decision.`, type: 'official_company' as const }];
  const expected = decisions[category];
  return {
    id, category, partition: n <= 8 ? 'train' as const : 'held_out' as const, synthetic: true as const,
    prospect: { name: person, title: roles[(n - 1) % roles.length], company: `Synthetic Company ${n}`, industry: category === 'INSUFFICIENT_RESEARCH' ? null : industries[(n - 1) % industries.length], country: countries[(n - 1) % countries.length], evidence },
    expected: { ...expected, requiredEvidenceIds: expected.emailAllowed ? [evidenceId] : [], reason: expected.reason },
  };
}));

export interface EvaluationPrediction { decision: ExpectedOutreachDecision; usedEvidenceIds?: string[]; emailGenerated?: boolean; service?: string | null }

export function scoreProspectEvaluation(cases: ProspectEvaluationCase[], predictions: Record<string, EvaluationPrediction>) {
  const labels = [...new Set(cases.map((c) => c.expected.decision))];
  const counts = new Map(labels.map((label) => [label, { tp: 0, fp: 0, fn: 0 }]));
  let matched = 0, falseQualified = 0, invalidEvidence = 0, missingRequiredEvidence = 0, unsafeEmail = 0, wrongService = 0, present = 0;
  for (const testCase of cases) {
    const prediction = predictions[testCase.id];
    if (!prediction) continue;
    present++;
    const expected = testCase.expected.decision;
    const actual = prediction.decision;
    if (actual === expected) matched++;
    for (const label of labels) {
      const n = counts.get(label)!;
      if (actual === label && expected === label) n.tp++;
      else if (actual === label) n.fp++;
      else if (expected === label) n.fn++;
    }
    if (actual === 'QUALIFIED' && expected !== 'QUALIFIED') falseQualified++;
    const available = new Set(testCase.prospect.evidence.map((e) => e.id));
    if ((prediction.usedEvidenceIds ?? []).some((id) => !available.has(id))) invalidEvidence++;
    if (testCase.expected.requiredEvidenceIds.some((id) => !(prediction.usedEvidenceIds ?? []).includes(id))) missingRequiredEvidence++;
    if (prediction.emailGenerated && !testCase.expected.emailAllowed) unsafeEmail++;
    if (testCase.expected.emailAllowed && prediction.service !== testCase.expected.service) wrongService++;
  }
  const f1 = [...counts.values()].map(({ tp, fp, fn }) => { const d = 2 * tp + fp + fn; return d ? 2 * tp / d : 0; });
  return { total: cases.length, evaluated: present, decisionAccuracy: present ? matched / present : 0, macroF1: f1.length ? f1.reduce((a, b) => a + b, 0) / f1.length : 0, falseQualificationRate: present ? falseQualified / present : 0, invalidEvidencePredictions: invalidEvidence, missingRequiredEvidencePredictions: missingRequiredEvidence, wrongServicePredictions: wrongService, unsafeEmailPredictions: unsafeEmail };
}
