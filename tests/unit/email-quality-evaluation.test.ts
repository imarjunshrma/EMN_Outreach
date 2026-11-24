import { describe, expect, it } from 'vitest';
import {
  EMAIL_QUALITY_DATASET,
  EMAIL_QUALITY_DIMENSIONS,
  compareEmailQualityOnSameInputs,
  type EmailQualityAnnotation,
} from '../../shared/src/email-quality-evaluation.js';

function annotation(caseId: string, variantId: string, fingerprint: string): EmailQualityAnnotation {
  return {
    caseId, variantId, inputFingerprint: fingerprint, annotationMethod: 'HUMAN', reviewerId: 'reviewer-1', email: 'Synthetic evaluation email.',
    scores: Object.fromEntries(EMAIL_QUALITY_DIMENSIONS.map((key) => [key, 5])) as EmailQualityAnnotation['scores'],
    unsupportedClaim: false, genericContent: false, humanCorrectionRequired: false,
  };
}

describe('email quality evaluation benchmark', () => {
  it('keeps tuning and held-out synthetic contexts separate', () => {
    expect(EMAIL_QUALITY_DATASET).toHaveLength(36);
    expect(EMAIL_QUALITY_DATASET.filter((c) => c.partition === 'tuning')).toHaveLength(18);
    expect(EMAIL_QUALITY_DATASET.filter((c) => c.partition === 'held_out')).toHaveLength(18);
    expect(EMAIL_QUALITY_DATASET.every((c) => c.synthetic)).toBe(true);
    expect(new Set(EMAIL_QUALITY_DATASET.map((c) => c.id)).size).toBe(36);
  });

  it('reports quality, unsupported claims, generic content and correction rate per variant', () => {
    const rows = [
      annotation('case-a', 'model-a', 'a'.repeat(64)),
      { ...annotation('case-a', 'model-b', 'a'.repeat(64)), scores: { ...annotation('case-a', 'model-b', 'a'.repeat(64)).scores, naturalLanguage: 3 }, unsupportedClaim: true, genericContent: true, humanCorrectionRequired: true },
    ];
    const result = compareEmailQualityOnSameInputs(rows);
    expect(result.sameInputs).toBe(true);
    expect(result.variants[0].unsupportedClaimRate).toBe(0);
    expect(result.variants[1].unsupportedClaimRate).toBe(1);
    expect(result.variants[1].genericContentRate).toBe(1);
    expect(result.variants[1].humanCorrectionRate).toBe(1);
    expect(result.variants[0].meanQualityScore).toBeGreaterThan(result.variants[1].meanQualityScore);
  });

  it('detects comparisons that omit cases for one variant', () => {
    const result = compareEmailQualityOnSameInputs([
      annotation('case-a', 'model-a', 'a'.repeat(64)),
      annotation('case-a', 'model-b', 'a'.repeat(64)),
      annotation('case-b', 'model-a', 'b'.repeat(64)),
    ]);
    expect(result.sameInputs).toBe(false);
  });
});
