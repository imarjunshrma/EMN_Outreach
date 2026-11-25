import { describe, expect, it } from 'vitest';
import { WritingSchema } from '../../shared/src/ai-studio.js';
import { runQualityChecks, type QualityInput } from '../../shared/src/quality.js';

const writing = WritingSchema.parse({ minWords: 10, maxWords: 80, personalizationIntensity: 'light' });
const supported = [{ id: 'claim-1', text: 'The firm publishes a weekly advisory podcast.' }];
const factCheck = [{ text: 'The firm publishes a weekly advisory podcast.', verdict: 'SUPPORTED' as const, claimId: 'claim-1', reason: 'Supported by the supplied research.' }];

function input(overrides: Partial<QualityInput> = {}): QualityInput {
  return {
    subject: 'A question about your advisory podcast',
    openingLine: 'Your weekly advisory podcast covers succession planning for founders.',
    body: 'Your weekly advisory podcast covers succession planning for founders. We help teams repurpose interviews into short videos. Would a sample outline be useful?',
    stepOrder: 1,
    newThread: true,
    writing,
    usedClaims: supported,
    invalidClaimIds: [],
    availableClaimCount: 1,
    previousEmails: [],
    otherLeadOpenings: [],
    factCheck,
    factCheckRequired: true,
    postalAddressConfigured: true,
    ...overrides,
  };
}

describe('campaign email quality gates', () => {
  it('passes a specific email tied to a supplied evidence claim', () => {
    expect(runQualityChecks(input()).passed).toBe(true);
  });

  it('holds when the independent evaluator returns no sentences', () => {
    const report = runQualityChecks(input({ factCheck: [] }));
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.id === 'fact_check')?.status).toBe('fail');
  });

  it('blocks personalization when no evidence is available', () => {
    const report = runQualityChecks(input({ usedClaims: [], availableClaimCount: 0, factCheck: [] }));
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.id === 'evidence')?.status).toBe('fail');
  });

  it('blocks generic opening even when light personalization is configured', () => {
    const report = runQualityChecks(input({ openingLine: 'I noticed you are a founder.', body: 'I noticed you are a founder. We help with short videos. Would a sample be useful?' }));
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.id === 'generic_opening')?.status).toBe('fail');
  });

  it('blocks insufficient context and invalid claim references', () => {
    const report = runQualityChecks(input({ insufficientContext: true, invalidClaimIds: ['made-up-claim'] }));
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.id === 'context')?.status).toBe('fail');
    expect(report.checks.find((c) => c.id === 'evidence')?.status).toBe('fail');
  });

  it('blocks a weak personalization score instead of treating it as informational', () => {
    const report = runQualityChecks(input({ usedClaims: [], availableClaimCount: 0, factCheck: [] }));
    expect(report.checks.find((c) => c.id === 'specificity_score')?.status).toBe('fail');
    expect(report.passed).toBe(false);
  });
});
