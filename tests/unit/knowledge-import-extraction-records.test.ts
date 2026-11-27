/**
 * Extraction is judged record by record. Harmless formatting differences in model output are brought into the template's
 * shape; records that fail evidence or schema checks are left out and named (sheet and row, never their content), and only
 * a batch where nothing is valid fails. The AI call is mocked at the runAi boundary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractImportRowsDetailed, normalizeExtractedFields, validateExtractedItems, validateExtractedItemsSeparately, type ImportExtractionSnapshot,
} from '../../backend/src/services/knowledge-import-extraction.js';

const { runAi } = vi.hoisted(() => ({ runAi: vi.fn() }));
vi.mock('../../backend/src/services/ai.js', () => ({ runAi }));
beforeEach(() => { runAi.mockReset(); });

const snapshot: ImportExtractionSnapshot = { prompt: { id: 'prompt-id', version: 1, systemPrompt: 'Pinned', userPromptTemplate: '{{catalog}}\n{{source}}' } };
const persona = {
  value: { externalId: 'persona-owner', name: 'Agency owner', seniority: 'Founder, Director', jobTitles: 'Founder, CEO' },
  locator: 'Target_Personas:row-2', excerpt: '', sheet: 'Target_Personas', row: 2, entityType: 'TARGET_PERSONA' as const,
};
const outreach = {
  value: { externalId: 'outreach-tone', name: 'Plain and specific', tone: 'Friendly, direct', wordLimits: 90 },
  locator: 'Outreach_Rules:row-3', excerpt: '', sheet: 'Outreach_Rules', row: 3, entityType: 'OUTREACH_RULE' as const,
};
const text = (row: { value: Record<string, unknown> }) => Object.entries(row.value).map(([key, value]) => `${key}: ${value}`).join('\n');
const record = (sourceIndex: number, entityType: string, name: string, excerpt: string, fields: Array<{ key: string; values: string[] }> = []) => ({
  sourceIndex, entityType, fields: [{ key: 'name', values: [name] }, ...fields], confidence: 0.9, classification: 'EXPLICIT_FACT',
  sourceExcerpt: excerpt, relationships: [], mappingExplanation: 'Worksheet row.',
});

describe('model field formatting', () => {
  it('joins a split single-value field, merges a repeated field and ignores fields the template does not have', () => {
    expect(normalizeExtractedFields('TARGET_PERSONA', [
      { key: 'name', values: ['Agency owner'] },
      { key: 'seniority', values: ['Founder', 'Director'] },
      { key: 'jobTitles', values: ['Founder'] },
      { key: 'jobTitles', values: ['CEO', 'Founder'] },
      { key: 'contactEmail', values: ['owner@example.com'] },
    ])).toEqual({
      fields: [{ key: 'name', values: ['Agency owner'] }, { key: 'seniority', values: ['Founder, Director'] }, { key: 'jobTitles', values: ['Founder', 'CEO'] }],
      ignored: ['contactEmail'],
    });
  });

  it('accepts those records, keeps the source evidence check and tells the reviewer which fields were ignored', () => {
    const fragment = { source: persona, text: text(persona) };
    const [accepted] = validateExtractedItems({ items: [record(0, 'TARGET_PERSONA', 'Agency owner', 'name: Agency owner', [
      { key: 'seniority', values: ['Founder', 'Director'] }, { key: 'contactEmail', values: ['owner@example.com'] },
    ])] }, [fragment], 'execution');
    expect(accepted.payload).toMatchObject({ name: 'Agency owner', seniority: 'Founder, Director', externalId: 'persona-owner' });
    expect(accepted.payload).not.toHaveProperty('contactEmail');
    expect(accepted.mappingExplanation).toContain('Ignored fields that are not part of the template: contactEmail.');
    expect(() => validateExtractedItems({ items: [record(0, 'TARGET_PERSONA', 'Agency owner', 'A paraphrase of the row')] }, [fragment], 'e')).toThrow(/unsupported/);
  });

  it('still rejects a numeric field with several different values', () => {
    const fragment = { source: outreach, text: text(outreach) };
    expect(() => validateExtractedItems({ items: [record(0, 'OUTREACH_RULE', 'Plain and specific', 'name: Plain and specific', [{ key: 'wordLimits', values: ['90', '120'] }])] }, [fragment], 'e')).toThrow();
  });
});

describe('record-by-record validation', () => {
  const fragments = [{ source: persona, text: text(persona) }, { source: outreach, text: text(outreach) }];

  it('keeps valid records and names the rejected ones by row and reason, without their content', () => {
    const { items, rejected } = validateExtractedItemsSeparately({ items: [
      record(0, 'TARGET_PERSONA', 'Agency owner', 'name: Agency owner'),
      record(1, 'OUTREACH_RULE', 'Plain and specific', 'Always write plainly...'),
    ] }, fragments, 'execution');
    expect(items.map(entry => entry.payload.name)).toEqual(['Agency owner']);
    expect(rejected).toEqual([{ locator: 'Outreach_Rules:row-3', reason: 'the quoted evidence was not found in that row', sourceIndex: 1 }]);
  });

  it('retries with the specific problems, then leaves out only the record that is still invalid', async () => {
    const bad = record(1, 'TARGET_PERSONA', 'Plain and specific', 'name: Plain and specific');
    runAi.mockResolvedValueOnce({ data: { items: [record(0, 'TARGET_PERSONA', 'Agency owner', 'name: Agency owner'), bad] }, executionId: 'first' });
    runAi.mockResolvedValueOnce({ data: { items: [record(0, 'TARGET_PERSONA', 'Agency owner', 'name: Agency owner'), bad] }, executionId: 'second' });
    const { items, rejected } = await extractImportRowsDetailed('workspace', [persona, outreach], 'session', snapshot);
    expect(items.map(entry => entry.payload.name)).toEqual(['Agency owner']);
    expect(rejected).toEqual([{ locator: 'Outreach_Rules:row-3', reason: 'the record type did not match its worksheet' }]);
    expect(runAi).toHaveBeenCalledTimes(2);
    expect(runAi.mock.calls[0][2].catalog).toContain('Every other field takes exactly one value');
    expect(runAi.mock.calls[1][2].catalog).toContain('sourceIndex 1: the record type did not match its worksheet');
    expect(runAi.mock.calls[1][2].catalog).not.toContain('Plain and specific');
  });

  it('uses the corrected retry when it fixes the problem', async () => {
    runAi.mockResolvedValueOnce({ data: { items: [record(1, 'OUTREACH_RULE', 'Plain and specific', 'made up evidence')] }, executionId: 'first' });
    runAi.mockResolvedValueOnce({ data: { items: [record(1, 'OUTREACH_RULE', 'Plain and specific', 'tone: Friendly, direct')] }, executionId: 'second' });
    const { items, rejected } = await extractImportRowsDetailed('workspace', [persona, outreach], 'session', snapshot);
    expect(items.map(entry => entry.executionId)).toEqual(['second']);
    expect(rejected).toEqual([]);
  });

  it('fails only when no record is valid, naming the rows and reasons', async () => {
    runAi.mockResolvedValue({ data: { items: [record(0, 'TARGET_PERSONA', 'Agency owner', 'invented quote')] }, executionId: 'x' });
    await expect(extractImportRowsDetailed('workspace', [persona], 'session', snapshot)).rejects.toMatchObject({
      code: 'AI_OUTPUT_INVALID',
      message: 'Extraction returned records that did not match the source or the template: Target_Personas row 2: the quoted evidence was not found in that row',
    });
  });
});
