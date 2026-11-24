import { describe, expect, it } from 'vitest';
import { checkServiceEligibility, StructuredExclusionRuleSchema } from '../../shared/src/service-eligibility.js';
import { verifyProspectIdentity } from '../../shared/src/identity.js';
import { PROSPECT_EVALUATION_DATASET, scoreProspectEvaluation } from '../../shared/src/evaluation-dataset.js';

describe('deterministic service eligibility', () => {
  const base = { serviceVersionId: 'svc-v1', name: 'Approved content service', status: 'APPROVED', targetIndustries: ['B2B software'], targetGeographies: ['US'], minEmployeeCount: 5, maxEmployeeCount: 100 };
  it('allows only an approved service when all structured constraints match', () => {
    expect(checkServiceEligibility(base, { industry: 'B2B software', country: 'US', employeeCount: 20 }).eligible).toBe(true);
  });
  it('fails closed for missing facts required by the service', () => {
    expect(checkServiceEligibility(base, { industry: null, country: 'US', employeeCount: 20 })).toMatchObject({ eligible: false, reasonCode: 'INDUSTRY_REQUIRED' });
    expect(checkServiceEligibility(base, { industry: 'B2B software', country: 'US', employeeCount: null })).toMatchObject({ eligible: false, reasonCode: 'EMPLOYEE_COUNT_REQUIRED' });
  });
  it('rejects excluded/unsupported industry, geography, size and unapproved versions', () => {
    expect(checkServiceEligibility({ ...base, excludedIndustries: ['B2B software'] }, { industry: 'B2B software', country: 'US', employeeCount: 20 }).eligible).toBe(false);
    expect(checkServiceEligibility(base, { industry: 'ecommerce', country: 'US', employeeCount: 20 }).eligible).toBe(false);
    expect(checkServiceEligibility(base, { industry: 'B2B software', country: 'GB', employeeCount: 20 }).eligible).toBe(false);
    expect(checkServiceEligibility(base, { industry: 'B2B software', country: 'US', employeeCount: 200 }).eligible).toBe(false);
    expect(checkServiceEligibility({ ...base, status: 'DRAFT' }, { industry: 'B2B software', country: 'US', employeeCount: 20 }).eligible).toBe(false);
  });
  it('applies structured role/company-type exclusions and holds missing required facts', () => {
    const rule = StructuredExclusionRuleSchema.parse({ code: 'EXCLUDE_RESELLERS', dimension: 'COMPANY_TYPE', operator: 'EQUALS_ANY', values: ['reseller'], missingBehavior: 'HOLD', explanation: 'Resellers are not eligible.' });
    const service = { ...base, targetIndustries: [], targetGeographies: [], minEmployeeCount: null, maxEmployeeCount: null, exclusionRules: [rule] };
    expect(checkServiceEligibility(service, { companyType: 'Reseller' })).toMatchObject({ status: 'EXCLUDED', reasonCode: 'EXCLUDE_RESELLERS' });
    expect(checkServiceEligibility(service, {})).toMatchObject({ status: 'INSUFFICIENT_INFORMATION', reasonCode: 'EXCLUDE_RESELLERS_FACT_MISSING' });
    expect(checkServiceEligibility({ ...service, exclusionRules: [] }, { companyType: 'Agency' }).eligible).toBe(true);
  });
  it('supports deterministic numeric exclusion boundaries', () => {
    const rule = StructuredExclusionRuleSchema.parse({ code: 'TOO_SMALL', dimension: 'EMPLOYEE_COUNT', operator: 'LT', values: [10], explanation: 'Company is too small.' });
    expect(checkServiceEligibility({ ...base, targetIndustries: [], targetGeographies: [], minEmployeeCount: null, maxEmployeeCount: null, exclusionRules: [rule] }, { employeeCount: 9 })).toMatchObject({ status: 'EXCLUDED', reasonCode: 'TOO_SMALL' });
  });
});

describe('professional identity verification', () => {
  const lead = { firstName: 'Asha', lastName: 'Raman', companyName: 'Synthetic Labs' };
  const claim = { id: 'identity-1', category: 'professional_identity', sourceType: 'WEBSITE', text: 'Asha Raman is the founder of Synthetic Labs.' };
  it('requires a verified decision and cited professional identity evidence matching name and company', () => {
    expect(verifyProspectIdentity(lead, 'VERIFIED', ['identity-1'], [claim]).verified).toBe(true);
    expect(verifyProspectIdentity(lead, 'VERIFIED', [], [claim]).verified).toBe(false);
    expect(verifyProspectIdentity(lead, 'VERIFIED', ['identity-1'], [{ ...claim, text: 'Asha Raman works at Another Company.' }]).verified).toBe(false);
    expect(verifyProspectIdentity(lead, 'AMBIGUOUS', ['identity-1'], [claim]).verified).toBe(false);
  });
  it('does not confirm identity from user-provided data or non-identity claims', () => {
    expect(verifyProspectIdentity(lead, 'VERIFIED', ['identity-1'], [{ ...claim, sourceType: 'USER_PROVIDED' }]).verified).toBe(false);
    expect(verifyProspectIdentity(lead, 'VERIFIED', ['identity-1'], [{ ...claim, category: 'industry' }]).verified).toBe(false);
  });
});

describe('synthetic prospect evaluation dataset', () => {
  it('has 72 cases with a held-out split and explicit no-email outcomes', () => {
    expect(PROSPECT_EVALUATION_DATASET).toHaveLength(72);
    expect(PROSPECT_EVALUATION_DATASET.filter((c) => c.partition === 'train')).toHaveLength(48);
    expect(PROSPECT_EVALUATION_DATASET.filter((c) => c.partition === 'held_out')).toHaveLength(24);
    expect(PROSPECT_EVALUATION_DATASET.every((c) => c.synthetic)).toBe(true);
    expect(PROSPECT_EVALUATION_DATASET.filter((c) => !c.expected.emailAllowed).every((c) => c.expected.decision !== 'QUALIFIED')).toBe(true);
  });
  it('scores decision, evidence and unsafe-email outcomes separately', () => {
    const predictions = Object.fromEntries(PROSPECT_EVALUATION_DATASET.map((c) => [c.id, { decision: c.expected.decision, usedEvidenceIds: c.expected.requiredEvidenceIds, emailGenerated: c.expected.emailAllowed, service: c.expected.service }]));
    expect(scoreProspectEvaluation(PROSPECT_EVALUATION_DATASET, predictions)).toMatchObject({ total: 72, evaluated: 72, decisionAccuracy: 1, falseQualificationRate: 0, invalidEvidencePredictions: 0, missingRequiredEvidencePredictions: 0, wrongServicePredictions: 0, unsafeEmailPredictions: 0 });
    const unsafe = { ...predictions, 'wrong_contact-01': { decision: 'QUALIFIED' as const, emailGenerated: true, usedEvidenceIds: ['invented-id'] } };
    expect(scoreProspectEvaluation(PROSPECT_EVALUATION_DATASET, unsafe)).toMatchObject({ falseQualificationRate: 1 / 72, invalidEvidencePredictions: 1, unsafeEmailPredictions: 1 });
  });
});
