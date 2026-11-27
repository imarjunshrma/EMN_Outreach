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
  IMPORT_ENTITIES, ImportExtractionOutput, importFieldKind, importFieldNames, importFieldsToPayload,
  validateImportPayload, type ImportEntityType, type ImportRelationship,
} from '../../../shared/src/knowledge-import.js';

const TASK = 'KNOWLEDGE_IMPORT_EXTRACTION' as const;
const CATALOG = Object.entries(IMPORT_ENTITIES).map(([type, { fields }]) => `${type}: name description externalId ${fields}`).join('\n');
const LIST_FIELD_NAMES = [...new Set(Object.values(IMPORT_ENTITIES).flatMap(({ fields }) => fields.split(' ').filter(Boolean)))].filter(key => importFieldKind(key) === 'list').sort();
/** Tells the model which fields take several values; models otherwise split ordinary text such as "Friendly, direct". */
const FIELD_FORMAT = `\nFields that accept several values (give each as a separate value): ${LIST_FIELD_NAMES.join(', ')}. Every other field takes exactly one value: keep its commas and line breaks inside that one value.`;
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

/** A record the model returned that failed validation, described without quoting imported content. */
export interface RejectedExtraction { locator: string; reason: string }
/** Prefix of the file note that lists records left out of review; later stages keep a note that starts with it. */
export const LEFT_OUT_PREFIX = 'Some records could not be extracted and were left out';

type ExtractionField = { key: string; values: string[] };

/**
 * Brings harmless differences in how a model formats fields into the template's shape, without adding content: several
 * values for a single-value text field are joined back into one value, a field returned twice is merged, and fields the
 * template does not have are ignored (and named, so the reviewer can see them). Evidence, entity and ID checks are not
 * affected, and a numeric field with several different values still fails.
 */
export function normalizeExtractedFields(entityType: ImportEntityType, fields: ExtractionField[]) {
  const allowed = new Set(['name', 'description', 'externalId', ...importFieldNames(entityType)]);
  const merged = new Map<string, string[]>();
  const ignored: string[] = [];
  for (const { key, values } of fields) {
    if (!allowed.has(key)) { if (!ignored.includes(key)) ignored.push(key); continue; }
    merged.set(key, [...(merged.get(key) ?? []), ...values]);
  }
  const normalized = [...merged].map(([key, values]) => {
    const kind = importFieldKind(key);
    if (kind === 'list') return { key, values: [...new Set(values)] };
    const distinct = [...new Set(values)];
    return { key, values: kind === 'text' && distinct.length > 1 ? [distinct.join(', ')] : distinct };
  });
  return { fields: normalized, ignored };
}

function rejectionReason(error: unknown) {
  if (error instanceof z.ZodError) {
    const paths = [...new Set(error.issues.map(issue => issue.path.filter(part => typeof part === 'string').join('.')).filter(Boolean))];
    return paths.length ? `invalid value for ${paths.slice(0, 5).join(', ')}` : 'the record did not follow the template format';
  }
  const message = error instanceof Error ? error.message : '';
  if (/excerpt is unsupported/.test(message)) return 'the quoted evidence was not found in that row';
  if (/does not match its workbook worksheet/.test(message)) return 'the record type did not match its worksheet';
  if (/identifier is unsupported|Invalid workbook identifier/.test(message)) return 'the record ID did not match that row';
  if (/single field value/.test(message)) return 'a single-value field had several different values';
  return 'the record did not follow the template format';
}

/** Validates each returned record on its own, so one bad record does not discard the rest. */
export function validateExtractedItemsSeparately(result: unknown, fragments: Fragment[], executionId: string) {
  const items: ImportExtractedItem[] = [];
  const rejected: Array<RejectedExtraction & { sourceIndex: number | null }> = [];
  const envelope = z.object({ items: z.array(z.unknown()) }).safeParse(result);
  if (!envelope.success) return { items, rejected: [{ locator: 'response', reason: 'the response did not follow the extraction format', sourceIndex: null }] };
  for (const raw of envelope.data.items) {
    const sourceIndex = typeof (raw as { sourceIndex?: unknown })?.sourceIndex === 'number' ? (raw as { sourceIndex: number }).sourceIndex : null;
    try {
      items.push(...validateExtractedItems({ items: [raw] }, fragments, executionId));
    } catch (error) {
      rejected.push({ locator: (sourceIndex != null ? fragments[sourceIndex]?.source.locator : undefined) ?? 'unknown source', reason: rejectionReason(error), sourceIndex });
    }
  }
  return { items, rejected };
}

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

const nativeWorkbookSettings = new Set<ImportEntityType>(['WRITING_SETTINGS', 'RESEARCH_SETTINGS', 'ICP_CRITERIA', 'PROMPT_PROFILE', 'TRAINING_EXAMPLE', 'OUTREACH_RULE', 'SERVICE', 'PRODUCT']);

function explicitWorkbookFields(row: ParsedImportRow) {
  if (!row.sheet || !row.entityType || !nativeWorkbookSettings.has(row.entityType)) return {};
  return Object.fromEntries(importFieldNames(row.entityType).flatMap<[string, string | string[] | number]>(key => {
    const raw = row.value[key];
    if (raw === undefined || raw === null || raw === '') return [];
    const kind = importFieldKind(key);
    if (kind === 'list') return [[key, String(raw).split(/\r?\n/).map(part => part.trim()).filter(Boolean)]];
    return [[key, typeof raw === 'number' && kind === 'numeric' ? raw : String(raw).trim()]];
  }));
}

const normalizeQuote = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();

export function validateExtractedItems(result: unknown, fragments: Fragment[], executionId: string): ImportExtractedItem[] {
  return ImportExtractionOutput.parse(result).items.map(item => {
    const fragment = fragments[item.sourceIndex];
    if (!fragment || !normalizeQuote(fragment.text).includes(normalizeQuote(item.sourceExcerpt))) throw new Error('Extraction excerpt is unsupported by its cited source');
    if (fragment.source.entityType && item.entityType !== fragment.source.entityType) throw new Error('Extraction entity does not match its workbook worksheet');
    const { fields, ignored } = normalizeExtractedFields(item.entityType, item.fields);
    const payload = validateImportPayload(item.entityType, {
      ...importFieldsToPayload(item.entityType, fields),
      ...explicitWorkbookFields(fragment.source),
    });
    const stableId = fragment.source.value.externalId ?? fragment.source.value.external_id;
    if (stableId != null) {
      if (typeof stableId !== 'string' && typeof stableId !== 'number') throw new Error('Invalid workbook identifier');
      payload.externalId = String(stableId).trim();
      validateImportPayload(item.entityType, payload);
    }
    if (typeof payload.externalId === 'string' && !fragment.text.includes(payload.externalId)) throw new Error('Extraction identifier is unsupported by its cited source');
    const sensitiveClassification = ['PROOF_CASE_STUDY', 'COMMERCIAL_OFFER', 'ACHIEVEMENT'].includes(item.entityType);
    return {
      entityType: item.entityType,
      payload,
      confidence: item.confidence,
      classification: sensitiveClassification && item.classification === 'EXPLICIT_FACT' ? 'CLAIM' : item.classification,
      verificationStatus: 'UNVERIFIED',
      relationships: importRelationships(fragment, item.relationships),
      mappingExplanation: ignored.length ? `${item.mappingExplanation} Ignored fields that are not part of the template: ${ignored.join(', ')}.`.slice(0, 2000) : item.mappingExplanation,
      source: { ...fragment.source, excerpt: item.sourceExcerpt },
      executionId,
    };
  });
}

/** Extracts records and reports the ones left out because they failed validation (described without their content). */
export async function extractImportRowsDetailed(workspaceId: string, rows: ParsedImportRow[], sessionId?: string, snapshot?: ImportExtractionSnapshot): Promise<{ items: ImportExtractedItem[]; rejected: RejectedExtraction[] }> {
  if (!rows.length) return { items: [], rejected: [] };
  const captured = snapshot ?? await captureImportExtraction(workspaceId);
  const maxChars = captured.route?.maxInputTokens ? Math.min(MAX_SOURCE_CHARS, captured.route.maxInputTokens * 4 - CATALOG.length - FIELD_FORMAT.length - 500) : MAX_SOURCE_CHARS;
  if (maxChars < 500) throw new AppError('PROVIDER_NOT_CONFIGURED', 'The extraction route input limit is too low for the entity catalog', 400);
  const result: ImportExtractedItem[] = [];
  const leftOut: RejectedExtraction[] = [];
  for (const batch of buildBatches(rows, maxChars)) {
    const content = batch.map(({ source, text }, index) => ({
      sourceIndex: index, locator: source.locator, worksheetEntityType: source.entityType, text,
    })).map(({ text, ...metadata }) => `${JSON.stringify(metadata)}\n${text}`).join('\n\n');
    const expectedWorksheet = batch.some(({ source }) => source.entityType)
      ? ' For template worksheets, only extract items matching the worksheetEntityType for that source.' : '';
    const vars = { catalog: CATALOG + FIELD_FORMAT + expectedWorksheet, source: wrapUntrusted('knowledge_import', content) };
    let best: ReturnType<typeof validateExtractedItemsSeparately> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await runAi<unknown>(workspaceId, TASK, vars, {
        entity: sessionId ? { type: 'knowledge_import_session', id: sessionId } : undefined,
        importExtractionPrompt: captured.prompt,
        importExtractionRoute: captured.route,
        importExtractionSource: captured.source,
      });
      const checked = validateExtractedItemsSeparately(response.data, batch, response.executionId);
      if (!best || checked.rejected.length < best.rejected.length || (checked.rejected.length === best.rejected.length && checked.items.length > best.items.length)) best = checked;
      if (!checked.rejected.length) break;
      if (attempt === 0) {
        // Say what was wrong (by source index and check, never by content) so the retry can correct it.
        const problems = checked.rejected.map(({ sourceIndex, reason }) => `${sourceIndex == null ? 'response' : `sourceIndex ${sourceIndex}`}: ${reason}`);
        vars.catalog += ` Retry: your previous answer had these problems: ${problems.slice(0, 12).join('; ')}. Use only allowed fields, cite an exact quotation from the given sourceIndex, keep supplied IDs verbatim, and respect the worksheet entity.`;
      }
    }
    result.push(...best!.items);
    leftOut.push(...best!.rejected.map(({ locator, reason }) => ({ locator, reason })));
  }
  if (!result.length && leftOut.length) {
    throw new AppError('AI_OUTPUT_INVALID', `Extraction returned records that did not match the source or the template: ${describeLeftOut(leftOut)}`, 502);
  }
  return { items: result, rejected: leftOut };
}

/** "Services row 4: the quoted evidence was not found in that row; ..." (at most eight, then a count). */
export function describeLeftOut(rejected: RejectedExtraction[]) {
  const label = (locator: string) => locator.replace(/^(.+):row-(\d+)$/, '$1 row $2');
  const shown = rejected.slice(0, 8).map(({ locator, reason }) => `${label(locator)}: ${reason}`);
  return `${shown.join('; ')}${rejected.length > 8 ? `; and ${rejected.length - 8} more` : ''}`.slice(0, 900);
}

export async function extractImportRows(workspaceId: string, rows: ParsedImportRow[], sessionId?: string, snapshot?: ImportExtractionSnapshot): Promise<ImportExtractedItem[]> {
  return (await extractImportRowsDetailed(workspaceId, rows, sessionId, snapshot)).items;
}
