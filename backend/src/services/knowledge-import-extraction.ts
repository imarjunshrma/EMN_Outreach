import { z } from 'zod';
import { AppError } from '../core/errors.js';
import {
  captureAiTaskExecution, captureImportExtractionPrompt, runAi,
  type FrozenTaskExecution, type ImportExtractionPromptSnapshot,
} from './ai.js';
import { resolveAiSource, type ResolvedSource } from './ai-source.js';
import type { ParsedImportRow } from './knowledge-import-parser.js';
import { wrapUntrusted } from '../../../integrations/src/ai/guard.js';
import {
  IMPORT_ENTITIES, ImportExtractionOutput, importFieldsToPayload,
  validateImportPayload, type ImportEntityType, type ImportRelationship,
} from '../../../shared/src/knowledge-import.js';

const TASK = 'KNOWLEDGE_IMPORT_EXTRACTION' as const;
const CATALOG = Object.entries(IMPORT_ENTITIES).map(([type, { fields }]) => `${type}: name description externalId ${fields}`).join('\n');
const MAX_SOURCE_CHARS = 6_000;
const MAX_BATCH_ROWS = 4;
const MAX_BATCHES = 120;

export interface ImportExtractionSnapshot {
  prompt: ImportExtractionPromptSnapshot;
  route?: FrozenTaskExecution;
  source?: Pick<ResolvedSource, 'mode' | 'ownerUserId' | 'fallbackToApi'>;
}

export async function captureImportExtraction(workspaceId: string): Promise<ImportExtractionSnapshot> {
  const { mode, ownerUserId, fallbackToApi } = await resolveAiSource(workspaceId, null);
  const source = { mode, ownerUserId, fallbackToApi };
  const route = mode === 'api' ? await captureAiTaskExecution(workspaceId, TASK) : undefined;
  const prompt = route?.promptTemplateId && route.promptVersion != null
    ? { id: route.promptTemplateId, version: route.promptVersion, systemPrompt: route.systemPrompt, userPromptTemplate: route.userPromptTemplate }
    : await captureImportExtractionPrompt(workspaceId);
  return { prompt, route, source };
}

export interface ImportExtractedItem {
  entityType: ImportEntityType;
  payload: ReturnType<typeof importFieldsToPayload>;
  confidence: number;
  classification: z.infer<typeof ImportExtractionOutput>['items'][number]['classification'];
  verificationStatus: 'UNVERIFIED';
  relationships: ImportRelationship[];
  mappingExplanation: string;
  source: ParsedImportRow;
  executionId: string;
}

interface Fragment { source: ParsedImportRow; text: string }

function renderRow(row: ParsedImportRow) {
  return Object.entries(row.value).map(([field, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return field === 'content' ? text : `${field}: ${text}`;
  }).join('\n');
}

function fragmentText(text: string, maxChars: number): string[] {
  const fragments: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    const newline = remaining.lastIndexOf('\n', maxChars);
    const splitAt = newline > maxChars / 2 ? newline : maxChars;
    fragments.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) fragments.push(remaining);
  return fragments;
}

function buildBatches(rows: ParsedImportRow[], maxChars: number): Fragment[][] {
  const batches: Fragment[][] = [];
  let batch: Fragment[] = [];
  let size = 0;
  for (const source of rows) {
    for (const text of fragmentText(renderRow(source), maxChars - 160)) {
      const cost = text.length + 160;
      if (batch.length === MAX_BATCH_ROWS || size + cost > maxChars) {
        batches.push(batch);
        batch = [];
        size = 0;
      }
      batch.push({ source, text });
      size += cost;
    }
  }
  if (batch.length) batches.push(batch);
  if (batches.length > MAX_BATCHES) throw new AppError('VALIDATION_FAILED', 'File exceeds the extraction limit. Split it into smaller files.', 400);
  return batches;
}

const workbookRelationships: Record<string, ImportEntityType> = {
  relatedServiceIds: 'SERVICE', relatedOfferIds: 'COMMERCIAL_OFFER',
  relatedAudienceIds: 'TARGET_AUDIENCE', relatedPersonaIds: 'TARGET_PERSONA',
};

function importRelationships(fragment: Fragment, inferred: ImportRelationship[]) {
  const relationships = Object.entries(workbookRelationships).flatMap(([key, entityType]) => {
    const value = fragment.source.value[key];
    return typeof value === 'string' || typeof value === 'number'
      ? String(value).split(/[,\n]/).map(id => id.trim()).filter(Boolean).map(externalId => ({ entityType, externalId }))
      : [];
  });
  const unique = new Map<string, ImportRelationship>();
  for (const relationship of [...relationships, ...inferred]) {
    if (relationship.externalId.length > 200 || !fragment.text.includes(relationship.externalId)) continue;
    unique.set(`${relationship.entityType}:${relationship.externalId}`, relationship);
  }
  return [...unique.values()];
}

const normalizeQuote = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();

export function validateExtractedItems(result: unknown, fragments: Fragment[], executionId: string): ImportExtractedItem[] {
  return ImportExtractionOutput.parse(result).items.map(item => {
    const fragment = fragments[item.sourceIndex];
    if (!fragment || !normalizeQuote(fragment.text).includes(normalizeQuote(item.sourceExcerpt))) throw new Error('Extraction excerpt is unsupported by its cited source');
    if (fragment.source.entityType && item.entityType !== fragment.source.entityType) throw new Error('Extraction entity does not match its workbook worksheet');
    const payload = importFieldsToPayload(item.entityType, item.fields);
    const stableId = fragment.source.value.externalId ?? fragment.source.value.external_id;
    if (stableId != null) {
      if (typeof stableId !== 'string' && typeof stableId !== 'number') throw new Error('Invalid workbook identifier');
      payload.externalId = String(stableId).trim();
      validateImportPayload(item.entityType, payload);
    }
    if (typeof payload.externalId === 'string' && !fragment.text.includes(payload.externalId)) throw new Error('Extraction identifier is unsupported by its cited source');
    const sensitiveClassification = item.entityType === 'PROOF_CASE_STUDY' || item.entityType === 'COMMERCIAL_OFFER';
    return {
      entityType: item.entityType,
      payload,
      confidence: item.confidence,
      classification: sensitiveClassification && item.classification === 'EXPLICIT_FACT' ? 'CLAIM' : item.classification,
      verificationStatus: 'UNVERIFIED',
      relationships: importRelationships(fragment, item.relationships),
      mappingExplanation: item.mappingExplanation,
      source: { ...fragment.source, excerpt: item.sourceExcerpt },
      executionId,
    };
  });
}

export async function extractImportRows(workspaceId: string, rows: ParsedImportRow[], sessionId?: string, snapshot?: ImportExtractionSnapshot): Promise<ImportExtractedItem[]> {
  if (!rows.length) return [];
  const captured = snapshot ?? await captureImportExtraction(workspaceId);
  const maxChars = captured.route?.maxInputTokens ? Math.min(MAX_SOURCE_CHARS, captured.route.maxInputTokens * 4 - CATALOG.length - 500) : MAX_SOURCE_CHARS;
  if (maxChars < 500) throw new AppError('PROVIDER_NOT_CONFIGURED', 'The extraction route input limit is too low for the entity catalog', 400);
  const result: ImportExtractedItem[] = [];
  for (const batch of buildBatches(rows, maxChars)) {
    const content = batch.map(({ source, text }, index) => ({
      sourceIndex: index, locator: source.locator, worksheetEntityType: source.entityType, text,
    })).map(({ text, ...metadata }) => `${JSON.stringify(metadata)}\n${text}`).join('\n\n');
    const expectedWorksheet = batch.some(({ source }) => source.entityType)
      ? ' For template worksheets, only extract items matching the worksheetEntityType for that source.' : '';
    const vars = { catalog: CATALOG + expectedWorksheet, source: wrapUntrusted('knowledge_import', content) };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await runAi<unknown>(workspaceId, TASK, vars, {
        entity: sessionId ? { type: 'knowledge_import_session', id: sessionId } : undefined,
        importExtractionPrompt: captured.prompt,
        importExtractionRoute: captured.route,
        importExtractionSource: captured.source,
      });
      try {
        result.push(...validateExtractedItems(response.data, batch, response.executionId));
        break;
      } catch {
        if (attempt === 1) throw new AppError('AI_OUTPUT_INVALID', 'Extraction returned fields or evidence that did not match the source schema', 502);
        vars.catalog += ' Retry: use only allowed fields, cite an exact quotation from the given sourceIndex, keep supplied IDs verbatim, and respect the worksheet entity.';
      }
    }
  }
  return result;
}
