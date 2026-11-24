import { describe, expect, it } from 'vitest';
import type { AiProviderAdapter } from '../../integrations/src/ai/types.js';
import { EMAIL_QUALITY_DATASET } from '../../shared/src/email-quality-evaluation.js';
import { emailQualityUserInput, generateEmailQualityCases } from '../../scripts/lib/email-quality-generation.js';

function validResult() {
  return { subject: null, subjectAlternatives: [], openingLine: null, body: '', cta: null, usedClaimIds: [], personalizationBasis: 'Insufficient research for safe outreach.', insufficientContext: true, opportunityAnalysis: { qualification: 'INSUFFICIENT_INFORMATION' as const, businessModel: { statement: null, basis: 'UNKNOWN' as const, claimIds: [] }, facts: [], inferences: [], unknowns: ['No contactable evidence'], opportunity: null, serviceFit: null, serviceVersionId: null, serviceMatchClaimIds: [], confidence: 0, missingInformation: [], recommendedApproach: null } };
}
function fakeAdapter(responses: unknown[]): AiProviderAdapter {
  let index = 0;
  return { name: 'OPENAI', async generateStructured() { return { data: responses[index++], usage: { inputTokens: 10, outputTokens: 8, cachedTokens: 0 }, latencyMs: 1, generationMode: 'structured' as const }; }, async testConnection() { return { ok: true as const }; } };
}

describe('synthetic email quality model generation harness', () => {
  it('constructs the same benchmark input for all variants', () => {
    const c = EMAIL_QUALITY_DATASET.find((row) => row.partition === 'held_out')!;
    expect(emailQualityUserInput(c)).toBe(emailQualityUserInput(c));
    expect(c.synthetic).toBe(true);
  });
  it('validates provider output and repairs one malformed response', async () => {
    const c = EMAIL_QUALITY_DATASET.find((row) => row.partition === 'held_out')!;
    const output = await generateEmailQualityCases({ cases: [c], variantId: 'fake-v1', provider: 'OPENAI', model: 'mock-model', apiKey: 'test-only', adapter: fakeAdapter([{ body: ['wrong shape'] }, validResult()]) });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ caseId: c.id, variantId: 'fake-v1', generationMode: 'structured', email: '' });
    expect(JSON.stringify(output)).not.toContain('test-only');
  });
  it('fails closed after a second invalid structure', async () => {
    const c = EMAIL_QUALITY_DATASET.find((row) => row.partition === 'held_out')!;
    await expect(generateEmailQualityCases({ cases: [c], variantId: 'fake-v1', provider: 'OPENAI', model: 'mock-model', apiKey: 'test-only', adapter: fakeAdapter([{}, []]) })).rejects.toThrow('after one repair attempt');
  });
});
