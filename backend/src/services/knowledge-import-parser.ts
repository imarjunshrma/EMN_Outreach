import { inflateRawSync } from 'node:zlib';
import { parse } from 'csv-parse/sync';
import sanitizeHtml from 'sanitize-html';
import JSZip from 'jszip';
import readXlsxFile, { readSheetNames } from 'read-excel-file/node';
import { writeWorkbook, type TemplateSheet } from './knowledge-import-xlsx.js';
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { IMPORT_ENTITIES, importFieldKind, type ImportEntityType } from '../../../shared/src/knowledge-import.js';

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 2500;
const MAX_PAGES = 200;
const MAX_UNCOMPRESSED_BYTES = 80 * 1024 * 1024;

export interface ParsedImportRow {
  value: Record<string, unknown>;
  locator: string;
  excerpt: string;
  sheet?: string;
  row?: number;
  page?: number;
  paragraph?: number;
  entityType?: ImportEntityType;
  warnings?: string[];
}

const MIME_TYPES: Record<string, string[]> = {
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
  pdf: ['application/pdf'],
  csv: ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
  json: ['application/json', 'text/json', 'text/plain'],
  txt: ['text/plain'],
  md: ['text/markdown', 'text/x-markdown', 'text/plain'],
  markdown: ['text/markdown', 'text/x-markdown', 'text/plain'],
  html: ['text/html', 'application/xhtml+xml', 'text/plain'],
};

function invalid(message: string): AppError {
  return new AppError('VALIDATION_FAILED', message, 400);
}

function validateZip(buffer: Buffer, requiredEntry: string, verifyInflated: boolean) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > buffer.length || end + 22 + buffer.readUInt16LE(end + 20) !== buffer.length) throw invalid('Malformed Office archive');
  const entries = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  let offset = buffer.readUInt32LE(end + 16);
  if (!entries || entries > 2000 || offset + size !== end || buffer.readUInt32LE(end + 4) !== 0) throw invalid('Unsupported Office archive structure');
  const dataEnd = offset;
  const names = new Set<string>();
  let required = false;
  let totalBytes = 0;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) throw invalid('Malformed Office archive directory');
    const nameLength = buffer.readUInt16LE(offset + 28);
    const next = offset + 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
    if (next > end) throw invalid('Malformed Office archive entry');
    const local = buffer.readUInt32LE(offset + 42);
    if (local + 30 > dataEnd || buffer.readUInt32LE(local) !== 0x04034b50) throw invalid('Malformed Office archive entry');
    const flags = buffer.readUInt16LE(offset + 8);
    const compression = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameStart = local + 30;
    const nameEnd = nameStart + buffer.readUInt16LE(local + 26);
    const entryStart = nameEnd + buffer.readUInt16LE(local + 28);
    const entryEnd = entryStart + compressed;
    if (flags & 1 || entryEnd > dataEnd || buffer.readUInt16LE(local + 6) !== flags || buffer.readUInt16LE(local + 8) !== compression || !buffer.subarray(nameStart, nameEnd).equals(buffer.subarray(offset + 46, offset + 46 + nameLength))) throw invalid('Malformed Office archive entry');
    const name = buffer.toString('utf8', nameStart, nameEnd);
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || names.has(name)) throw invalid('Invalid Office archive entry name');
    names.add(name);
    if (!(flags & 8) && (buffer.readUInt32LE(local + 18) !== compressed || buffer.readUInt32LE(local + 22) !== uncompressed)) throw invalid('Inconsistent Office archive entry');
    totalBytes += uncompressed;
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw invalid('The expanded Office file exceeds the size limit');
    if (compression === 0 && compressed !== uncompressed || ![0, 8].includes(compression)) throw invalid('Unsupported Office archive compression');
    if (verifyInflated && compression === 8) {
      const expanded = inflateRawSync(buffer.subarray(entryStart, entryEnd), { maxOutputLength: uncompressed || 1 });
      if (expanded.length !== uncompressed) throw invalid('Inconsistent Office archive entry size');
    }
    if (name === requiredEntry) required = true;
    offset = next;
  }
  if (offset !== end || !required) throw invalid('The contents do not match the Office file extension');
}

export function validateImportUpload(buffer: Buffer, name: string, mime?: string, verifyInflated = false) {
  const extension = name.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  if (!extension || !Object.hasOwn(MIME_TYPES, extension)) throw invalid('Supported formats are XLSX, CSV, PDF, DOCX, TXT, Markdown, JSON and HTML');
  if (!buffer.length || buffer.length > MAX_IMPORT_BYTES) throw invalid('Files must contain between one byte and 20 MB');
  const mediaType = mime?.split(';')[0].trim().toLowerCase();
  if (mediaType && mediaType !== 'application/octet-stream' && !MIME_TYPES[extension].includes(mediaType)) throw invalid('File type does not match its extension');
  if (extension === 'pdf' && !buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw invalid('Invalid PDF header');
  if (extension === 'xlsx' || extension === 'docx') validateZip(buffer, extension === 'xlsx' ? 'xl/workbook.xml' : 'word/document.xml', verifyInflated);
  return extension;
}

export const TEMPLATE_VERSION = 'outvexa-brain-v3';
const entries = Object.entries(IMPORT_ENTITIES) as [ImportEntityType, (typeof IMPORT_ENTITIES)[ImportEntityType]][];
export const TEMPLATE_SHEETS = [...entries.map(([, item]) => item.sheet), 'Instructions'];
const commonHeaders = ['externalId', 'name', 'description'];
const relationshipHeaders = ['relatedServiceIds', 'relatedOfferIds', 'relatedAudienceIds', 'relatedPersonaIds'];
const examples: Record<ImportEntityType, string> = {
  COMPANY_PROFILE: 'Example Analytics', PRODUCT: 'Inventory dashboard', SERVICE: 'Revenue reporting', COMMERCIAL_OFFER: 'Reporting starter package',
  TARGET_AUDIENCE: 'Mid-market retailers', TARGET_PERSONA: 'Head of Analytics', ICP_CRITERIA: 'Has a data warehouse',
  BUSINESS_OPPORTUNITY: 'Multi-store forecasting', COMPETITOR: 'Example Reporting Co',
  PROMPT_PROFILE: 'Consultative onboarding',
  TRAINING_EXAMPLE: 'Concise opening example',
  RESEARCH_SETTINGS: 'Workspace research defaults', WRITING_SETTINGS: 'Workspace writing defaults',
  RESEARCH_RULE: 'Verify warehouse usage', OUTREACH_RULE: 'Use concise subject lines', EXCLUSION: 'Exclude public sector',
  ACHIEVEMENT: 'Published annual report',
  PROOF_CASE_STUDY: 'Inventory reporting rollout', CAMPAIGN_PREFERENCE: 'Analytics discovery campaign',
};

const fieldExamples: Record<string, string> = {
  titles: 'Director of Analytics', seniorities: 'director', countries: 'GB', employeeMin: '50', employeeMax: '200',
  keywords: 'inventory reporting', aiInstructions: 'Check whether the company has multiple stores.', isActive: 'true',
  style: 'Plain and specific', minWords: '40', maxWords: '100', sentenceComplexity: 'simple',
  personalizationIntensity: 'medium', ctaStyle: 'soft_question', formality: 'neutral', language: 'English',
  avoidPhrases: 'Just reaching out', forbiddenClaims: 'Guaranteed results',
  personTopics: 'Public talks and published interviews', companyTopics: 'Recent product announcements',
  maxEvidenceAgeDays: '365', minClaims: '2', maxSearchQueriesPerRun: '3', maxSearchesPerProspect: '6', maxPagesPerRun: '7',
  recentSignalDays: '90', extendedSignalDays: '365', deepResearchScoreThreshold: '65',
  onMissing: 'hold_for_research', companyWebsite: 'true', webSearch: 'true', newsAndArticles: 'true',
  podcastsAndInterviews: 'false', dataProvider: 'false', userProvided: 'true', priority: 'PREFERRED',
  content: 'Is weekly stock reporting a priority for your operations team?', polarity: 'POSITIVE',
  positioning: 'Reporting for independent retailers', mission: 'Make sales trends easier to understand',
  valueProposition: 'Consolidate store reports into one weekly view', industries: 'Retail',
  geography: 'United Kingdom', businessModel: 'Software subscription', differentiators: 'Works with existing point-of-sale exports',
  legalEntity: 'Example Analytics Ltd', companySize: '51–200 employees',
  customerProblems: 'Manual consolidation of store reports', targetCustomerProfiles: 'Multi-site retailers',
  deliverables: 'One dashboard and user guide', methodology: 'Validate source data, then build and test the report',
  desiredOutcomes: 'Identify inventory trends sooner', targetIndustries: 'Specialty retail', targetGeographies: 'United Kingdom',
  exclusions: 'Custom point-of-sale integrations', eligibilityCriteria: 'Access to a monthly point-of-sale export',
  commercialBoundaries: 'On-site consulting billed separately', availability: 'Available in Q2',
  supportingEvidence: 'https://example.com/services/reporting', billingModel: 'One-time',
  duration: 'Four weeks', conditions: 'Includes one revision', eligibility: 'At least three stores',
  characteristics: 'Central operations team', challenges: 'Fragmented reporting', buyingTriggers: 'Opening new stores',
  qualificationNotes: 'Confirm the team can export transactions', sourceEvidence: 'https://example.com/about',
  jobTitles: 'Head of Analytics', seniority: 'Head of function', responsibilities: 'Oversee sales reporting',
  goals: 'Reduce time spent collecting reports', motivations: 'Give store managers timely sales data',
  objections: 'Existing spreadsheet workflow is familiar', buyingAuthority: 'Recommends vendor to CFO',
  requiredConditions: 'Exports transactions to CSV', optionalConditions: 'Has a data analyst',
  negativeConditions: 'Prohibits third-party reporting vendors', qualificationSignals: 'Hiring a retail analyst',
  disqualificationSignals: 'Uses a point-of-sale system with no export option', scoringRules: 'Central operations team: 10',
  weight: '10', threshold: '60', category: 'Data accessibility',
  evidenceRequirements: 'Cite the public documentation describing exports',
  marketProblem: 'New stores lack consistent forecasting', marketSignals: 'Recent expansion announcement',
  businessPotential: 'Multi-location pilots', evidence: 'https://example.com/news/store-opening',
  status: 'Exploratory', disqualifyingConditions: 'Forecasting project already underway',
  services: 'Store reporting', marketSegment: 'Independent retailers', observations: 'Offers weekly dashboard exports',
  sources: 'Company website and annual report', priorities: 'Verify operating geography',
  verificationRequirements: 'Confirm the detail in a source dated within one year', excludedSources: 'Anonymous forum posts',
  depth: 'Review the latest annual report and company news', recencyRequirement: 'Within the last 12 months',
  confidenceRequirements: 'Confirm important claims with a primary source', tone: 'Plain and direct',
  personalizationRules: 'Use public company announcements relevant to the offer',
  messagingRestrictions: 'Avoid claims about the prospect’s revenue', ctaPreferences: 'Ask whether reporting is a current priority',
  followUpPolicies: 'Send up to two follow-ups', prohibitedLanguage: 'Guaranteed ROI', channels: 'Email',
  wordLimits: '100', companyTypes: 'Public agencies', personas: 'Student interns',
  suppressionConditions: 'Prospect previously opted out', reason: 'Outside current market',
  scope: 'All outbound campaigns', activeStatus: 'Active', client: 'Example Retail Ltd',
  startingSituation: 'Weekly reports were compiled manually', workPerformed: 'Built a consolidated dashboard',
  results: 'Managers received one consolidated report each week', metrics: 'Three report templates consolidated into one',
  timePeriod: 'January through March', publicationPermission: 'Internal use only',
  objective: 'Qualify interest in a reporting pilot', targetSegments: 'Independent retailers with three or more stores',
  messagingPreferences: 'Lead with weekly reporting use case', volumeConstraints: '50',
  qualificationRequirements: 'Uses a point-of-sale system that exports CSV',
};

function describeField(key: string) {
  if (key === 'scoringRules') return 'Enter one criterion and numeric weight per line. Example: Central operations team: 10.';
  if (key === 'externalId') return 'Stable identifier for re-imports and links across sheets. Use letters, digits, hyphens or underscores.';
  if (key === 'name') return 'Record label. Required before application.';
  if (key === 'description') return 'Short factual summary in plain text.';
  if (relationshipHeaders.includes(key)) return 'Comma-separated externalId values from the corresponding sheet.';
  if (key === 'website') return 'Public website URL, starting with https://.';
  if (key === 'currency') return 'Three-letter ISO currency code.';
  if (key === 'price') return 'Numeric amount without a currency symbol, or clearly state custom pricing.';
  if (['companyWebsite', 'webSearch', 'newsAndArticles', 'podcastsAndInterviews', 'dataProvider', 'userProvided', 'isActive'].includes(key)) return 'Enter true or false.';
  if (key === 'exclusionRules') return 'Optional JSON array of structured service exclusions. Use the service exclusion fields and operators.';
  if (key === 'maxEvidenceAgeDays') return 'Enter the maximum age in days, or null to remove the age limit.';
  const label = key.replace(/[A-Z]/g, character => ` ${character.toLowerCase()}`);
  if (importFieldKind(key) === 'numeric') return `Enter ${label} as a number when available.`;
  if (importFieldKind(key) === 'list') return `Enter ${label} in plain text. Separate multiple entries with line breaks.`;
  return `Enter ${label} in plain text.`;
}

function exampleField(key: string, type: ImportEntityType) {
  if (key === 'name') return examples[type];
  if (key === 'category' && type === 'TRAINING_EXAMPLE') return 'EMAIL';
  if (key === 'category' && type === 'OUTREACH_RULE') return 'PERSONALIZATION';
  if (key === 'status' && type === 'OUTREACH_RULE') return 'ACTIVE';
  if (key === 'instructions' && type === 'PROMPT_PROFILE') return 'Write a concise message based on verified business context.';
  if (key === 'tone' && (type === 'WRITING_SETTINGS' || type === 'PROMPT_PROFILE')) return 'consultative';
  if (key === 'externalId') return `${type.toLowerCase().replaceAll('_', '-')}-01`;
  if (key === 'website') return 'https://example.com';
  if (key === 'currency') return 'USD';
  if (key === 'price') return '500';
  const relatedExamples: Record<string, string> = {
    relatedServiceIds: 'service-01', relatedOfferIds: 'commercial-offer-01',
    relatedAudienceIds: 'target-audience-01', relatedPersonaIds: 'target-persona-01',
  };
  if (relationshipHeaders.includes(key)) return relatedExamples[key];
  if (key === 'description') return `Overview of ${examples[type]}`;
  return fieldExamples[key] ?? '';
}

export async function templateWorkbook() {
  const instructions: TemplateSheet['rows'] = [
    ['Outvexa Outreach Brain Template', 'v3'],
    ['Guidance', 'Enter records below the field headers. Leave unused sheets and optional fields empty. Examples are for reference.'],
    ['Relationships', 'Use stable externalId values to link records. Use a comma between multiple identifiers.'],
    ['Evidence', 'Include sources for claims and results. Uploaded source statements require review.'],
    [],
    ['Worksheet', 'Field', 'Required', 'Description and validation', 'Example'],
  ];
  const sheets: TemplateSheet[] = [];
  for (const [type, item] of entries) {
    const headers = [...commonHeaders, ...item.fields.split(' ').filter(Boolean), ...relationshipHeaders];
    const notes = headers.map((key) => {
      const required = key === 'name' || (type === 'SERVICE' && key === 'description') ||
        (type === 'TRAINING_EXAMPLE' && ['content', 'category', 'polarity'].includes(key));
      const description = describeField(key);
      const example = exampleField(key, type);
      instructions.push([item.sheet, key, required ? 'Yes' : 'Optional', description, example]);
      return `${required ? 'Required' : 'Optional'}. ${description} Example: ${example}`;
    });
    sheets.push({ name: item.sheet, rows: [headers], widths: headers.map(key => Math.max(key.length + 2, 18)), headerNotes: notes });
  }
  sheets.push({ name: 'Instructions', rows: instructions, widths: [24, 26, 10, 70, 40] });
  return writeWorkbook(sheets);
}

const v1NameColumns: Record<ImportEntityType, string> = {
  COMPANY_PROFILE: 'company_name', PRODUCT: 'product_name', SERVICE: 'service_name', COMMERCIAL_OFFER: 'offer_name',
  TARGET_AUDIENCE: 'audience_name', TARGET_PERSONA: 'persona', ICP_CRITERIA: 'criterion',
  BUSINESS_OPPORTUNITY: 'opportunity', COMPETITOR: 'competitor_name', RESEARCH_SETTINGS: 'name', WRITING_SETTINGS: 'name', TRAINING_EXAMPLE: 'name', PROMPT_PROFILE: 'name', RESEARCH_RULE: 'research_objective',
  OUTREACH_RULE: 'communication_style', EXCLUSION: 'name_or_condition', ACHIEVEMENT: 'name', PROOF_CASE_STUDY: 'case_study',
  CAMPAIGN_PREFERENCE: 'campaign_type',
};

type Cell = string | number | boolean | Date | null;
// read-excel-file pads every sheet from A1, so grid index + 1 is the physical worksheet row. Formulas are never
// evaluated: a formula cell yields its stored value and text such as "=1+1" stays plain text.
const cellValue = (cell: Cell) => cell instanceof Date ? cell.toISOString().slice(0, 10) : cell;
const columnLetters = (index: number): string => (index >= 26 ? columnLetters(Math.floor(index / 26) - 1) : '') + String.fromCharCode(65 + (index % 26));

/**
 * Rewrites inline-string cells into the one layout read-excel-file supports (`<c t="inlineStr"><is><t>text</t></is></c>`).
 * The OOXML standard also allows, and common writers produce, an empty inline string (openpyxl writes a styled empty
 * string as `<c s="1" t="inlineStr"></c>`), rich text split into runs (`<is><r><t>a</t></r><r><t>b</t></r></is>`) and
 * whitespace between elements. read-excel-file throws on all of these. Empty cells become blank cells; runs are joined
 * into one text (phonetic guides are dropped, as spreadsheet applications do when displaying the value). The text stays
 * XML-escaped exactly as written, and nothing else in the package changes.
 */
const INLINE_STRING_CELL = /<((?:[A-Za-z_][\w.-]*:)?)c\b([^>]*?)\s+t="inlineStr"([^>]*?)(?:\/>|>([\s\S]*?)<\/\1c>)/g;
const CANONICAL_INLINE = /^<((?:[A-Za-z_][\w.-]*:)?)is><\1t(?:\s[^>]*)?>[^<]*<\/\1t><\/\1is>$/;
export function normalizeInlineStringCells(xml: string) {
  let changed = false;
  const result = xml.replace(INLINE_STRING_CELL, (cell, prefix: string, before: string, after: string, content: string | undefined) => {
    const attributes = `${before}${after}`.replace(/\s+$/, '');
    if (content !== undefined && CANONICAL_INLINE.test(content)) return cell;
    changed = true;
    const runs = (content ?? '').replace(new RegExp(`<${prefix}rPh\\b[\\s\\S]*?<\\/${prefix}rPh>`, 'g'), '');
    const texts = [...runs.matchAll(new RegExp(`<${prefix}t\\b[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/${prefix}t>)`, 'g'))].map(match => match[1] ?? '');
    if (!texts.length) return `<${prefix}c${attributes}/>`;
    return `<${prefix}c${attributes} t="inlineStr"><${prefix}is><${prefix}t xml:space="preserve">${texts.join('')}</${prefix}t></${prefix}is></${prefix}c>`;
  });
  return { xml: result, changed };
}

async function normalizedWorkbook(buffer: Buffer) {
  const archive = await JSZip.loadAsync(buffer);
  let changed = false;
  for (const entry of Object.values(archive.files)) {
    if (entry.dir || !/^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name)) continue;
    const xml = await entry.async('string');
    if (!xml.includes('inlineStr')) continue;
    const normalized = normalizeInlineStringCells(xml);
    if (!normalized.changed) continue;
    archive.file(entry.name, normalized.xml);
    changed = true;
  }
  return changed ? archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) : buffer;
}

/** A spreadsheet library error, reduced to text that names no imported content (its messages can quote cell XML). */
function readerReason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const cell = /\br="([A-Z]{1,3}\d{1,7})"/.exec(message)?.[1];
  const reason = message.split(':')[0].replace(/\s+/g, ' ').trim().slice(0, 120) || 'unreadable content';
  return { cell, reason };
}

function logParseFailure(extension: string, error: unknown, context: Record<string, unknown> = {}) {
  const failure = error instanceof Error ? error : new Error(String(error));
  // The stack and error class, without the message text: parser messages can contain imported business data.
  logger.warn({ extension, errorName: failure.name, errorCode: (failure as { code?: unknown }).code, stack: failure.stack?.split('\n').slice(1, 12).join('\n'), ...context }, 'knowledge import: file could not be parsed');
}

/** An official Outvexa template with no records filled in: valid, but nothing to import yet. */
export interface EmptyTemplate { version: string; sheets: number }
export const EMPTY_TEMPLATE_NOTICE = 'This is an unfilled Outvexa template: no records yet. Add rows below the headers on the worksheets you need, then upload it again.';

async function workbookRows(original: Buffer): Promise<{ rows: ParsedImportRow[]; emptyTemplate?: EmptyTemplate }> {
  let buffer: Buffer;
  let sheetNames: string[];
  try {
    buffer = await normalizedWorkbook(original);
    sheetNames = await readSheetNames(buffer);
  } catch (error) {
    logParseFailure('xlsx', error, { step: 'workbook structure' });
    throw invalid('The XLSX file is not a readable workbook: its package or workbook structure is damaged');
  }
  if (sheetNames.length > 60) throw invalid('The workbook has too many worksheets');
  const readSheet = async (sheet: string) => {
    let grid: Cell[][];
    try {
      grid = await readXlsxFile(buffer, { sheet, trim: false }) as Cell[][];
    } catch (error) {
      const { cell, reason } = readerReason(error);
      logParseFailure('xlsx', error, { step: 'worksheet', sheet, cell });
      throw invalid(`Worksheet "${sheet}" could not be read${cell ? ` (cell ${cell})` : ''}: ${reason}`);
    }
    // A formula error (#DIV/0!, #REF!, #N/A ...) is not a value: refuse it rather than import its error text as a fact.
    grid.forEach((row, rowIndex) => row.forEach((cell, column) => {
      const code = typeof cell === 'string' ? /^#ERROR_(#[A-Z0-9/!?.]+)$/.exec(cell)?.[1] : undefined;
      if (code) throw invalid(`Worksheet "${sheet}" cell ${columnLetters(column)}${rowIndex + 1} contains the spreadsheet error ${code}. Correct the formula or clear the cell, then upload the file again.`);
    }));
    return grid.map(row => row.map(cellValue));
  };
  const instructions = sheetNames.includes('Instructions') ? await readSheet('Instructions') : [];
  const version = instructions[0]?.[0] === 'Outvexa Outreach Brain Template' ? instructions[0]?.[1] : undefined;
  if (version != null && !['v1', 'v2', 'v3'].includes(String(version))) throw invalid('Unsupported workbook template version');
  const result: ParsedImportRow[] = [];
  // Tracks whether the workbook still matches the template contract: every sheet a template sheet, every header known.
  let templateSheets = 0;
  let matchesTemplate = version != null;
  for (const sheet of sheetNames) {
    if (sheet === 'Instructions') continue;
    const grid = await readSheet(sheet);
    const first = grid.findIndex(row => row.some(cell => cell != null && String(cell).trim()));
    if (first < 0) { matchesTemplate = false; continue; }
    if (grid.length - first > MAX_ROWS + 1 || grid.some(row => row.length > 150)) throw invalid('A worksheet exceeds the row or column limit');
    const headerIndex = first;
    const headers = grid[headerIndex].map(cell => String(cell ?? '').trim());
    const lower = headers.filter(Boolean).map(header => header.toLowerCase());
    if (new Set(lower).size !== lower.length) throw invalid('Duplicate worksheet header');
    if (lower.some(header => ['__proto__', 'prototype', 'constructor'].includes(header))) throw invalid('Invalid worksheet header');
    const entry = entries.find(([, item]) => item.sheet.toLowerCase() === sheet.toLowerCase());
    const known = entry ? new Set([...commonHeaders, ...entry[1].fields.split(' ').filter(Boolean), ...relationshipHeaders].map(field => field.toLowerCase())) : null;
    const unknownHeaders = ['v2', 'v3'].includes(String(version)) && known ? headers.filter(header => header && !known.has(header.toLowerCase())) : [];
    if (!known || headers.some(header => header && !known.has(header.toLowerCase())) || !lower.includes('name')) matchesTemplate = false;
    else templateSheets++;
    for (let index = headerIndex + 1; index < grid.length; index++) {
      const cells = grid[index];
      const populated = (cell: unknown) => cell != null && String(cell).trim() !== '';
      if (!cells.some(populated)) continue;
      if (cells.some((cell, column) => populated(cell) && !headers[column])) throw invalid('A populated worksheet column has no header');
      const value = Object.fromEntries(headers.flatMap((header, column) => populated(cells[column]) ? [[header, cells[column]]] : []));
      const row = index + 1;
      const warnings = unknownHeaders.length ? [`Additional columns require review: ${unknownHeaders.join(', ')}`] : [];
      if (!entry) warnings.push('This worksheet has no template mapping');
      else if (version) {
        if (!value.name && !value[v1NameColumns[entry[0]]]) warnings.push('Name is required before application');
        if (entry[0] === 'SERVICE' && !value.description) warnings.push('Description is required before applying a service');
      }
      result.push({ value, locator: `${sheet}:row-${row}`, excerpt: JSON.stringify(value).slice(0, 2000), sheet, row, entityType: entry?.[0], warnings });
    }
  }
  if (!result.length && matchesTemplate && templateSheets > 0) return { rows: result, emptyTemplate: { version: String(version), sheets: templateSheets } };
  return { rows: result };
}

function contentRow(text: string, locator: string, provenance: Pick<ParsedImportRow, 'page' | 'paragraph'> = {}): ParsedImportRow {
  return { value: { content: text }, excerpt: text.slice(0, 2000), locator, ...provenance };
}

async function pdfRows(buffer: Buffer) {
  const pdf = (await import('pdf-parse/lib/pdf-parse.js')).default;
  const rows: ParsedImportRow[] = [];
  let page = 0;
  let failed = false;
  const document = await pdf({ data: Uint8Array.from(buffer), isEvalSupported: false, stopAtErrors: true }, { max: MAX_PAGES, pagerender: async source => {
    const pageNumber = ++page;
    try {
      const content = await source.getTextContent();
      let lastY: number | undefined;
      let text = '';
      for (const item of content.items) {
        const y = item.transform[5];
        text += `${lastY === undefined || y === lastY ? ' ' : '\n'}${item.str}`;
        lastY = y;
      }
      if (text.trim()) rows.push(contentRow(text.trim(), `page-${pageNumber}`, { page: pageNumber }));
    } catch { failed = true; }
    return '';
  } });
  if (document.numpages > MAX_PAGES) throw invalid('PDF exceeds the 200-page limit');
  if (failed || page !== document.numpages) throw invalid('A PDF page could not be read');
  return rows;
}

/** A short, content-free description of why a file could not be parsed, for the person who uploaded it. */
function parseFailureDetail(extension: string, error: unknown) {
  const code = String((error as { code?: unknown })?.code ?? '');
  if (extension === 'json' && error instanceof SyntaxError) return ': the JSON is not valid';
  if (error instanceof TypeError && /decode|encoded data/i.test(error.message)) return ': the text is not valid UTF-8';
  if (code.startsWith('CSV_')) return `: CSV structure error (${code})`;
  if (extension === 'docx') return ': the Word document structure could not be read';
  if (extension === 'pdf') return ': the PDF structure could not be read';
  return '';
}

/** Parses an upload. Empty files are rejected, except an unfilled official template, which is reported as such. */
export async function parseImportFileDetailed(buffer: Buffer, name: string, mime?: string): Promise<{ rows: ParsedImportRow[]; emptyTemplate?: EmptyTemplate }> {
  const extension = validateImportUpload(buffer, name, mime);
  let result: ParsedImportRow[];
  let emptyTemplate: EmptyTemplate | undefined;
  try {
    if (extension === 'xlsx' || extension === 'docx') validateImportUpload(buffer, name, mime, true);
    if (extension === 'xlsx') ({ rows: result, emptyTemplate } = await workbookRows(buffer));
    else if (extension === 'pdf') result = await pdfRows(buffer);
    else if (extension === 'docx') {
      const mammoth = await import('mammoth');
      const document = await mammoth.extractRawText({ buffer });
      result = document.value.split(/\n\n/).flatMap((text, index) => text.trim() ? [contentRow(text.trim(), `paragraph-${index + 1}`, { paragraph: index + 1 })] : []);
    } else {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).trim();
      if (text.includes('\u0000')) throw invalid('Text files must contain valid UTF-8 text');
      if (extension === 'csv') {
        const records = parse(text, {
          columns: (headers: string[]) => {
            const normalized = headers.map(header => header.trim());
            if (normalized.some(header => !header || ['__proto__', 'prototype', 'constructor'].includes(header)) || new Set(normalized).size !== normalized.length) throw invalid('CSV contains invalid headers');
            return normalized;
          },
          info: true, skip_empty_lines: true, bom: true, max_record_size: 200_000,
        }) as { record: Record<string, unknown>; info: { lines: number } }[];
        result = records.filter(({ record }) => Object.values(record).some(value => String(value).trim())).map(({ record, info }) => ({ value: record, excerpt: JSON.stringify(record).slice(0, 2000), locator: `csv:row-${info.lines}`, row: info.lines }));
      } else if (extension === 'json') {
        const value: unknown = JSON.parse(text);
        result = (Array.isArray(value) ? value : [value]).flatMap((item, index) => {
          if (item == null || (typeof item === 'string' && !item.trim()) || (typeof item === 'object' && !Object.keys(item).length)) return [];
          return [{
            value: typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : { content: item },
            excerpt: JSON.stringify(item).slice(0, 2000),
            locator: `document:item-${index + 1}`,
          }];
        });
      } else {
        const content = extension === 'html' ? sanitizeHtml(text.replace(/<\/(?:p|div|section|li|h[1-6])\s*>|<br\s*\/?\s*>/gi, '\n'), { allowedTags: [], allowedAttributes: {} }).trim() : text;
        result = content ? [contentRow(content, 'document:1')] : [];
      }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Keep the cause diagnosable: log the exception and stack, and tell the user what kind of problem it is.
    logParseFailure(extension, error, { step: 'file' });
    throw invalid(`Malformed or unreadable ${extension.toUpperCase()} file${parseFailureDetail(extension, error)}`);
  }
  if (emptyTemplate) return { rows: [], emptyTemplate };
  if (!result.length) throw invalid('The file contains no importable rows or text');
  if (result.length > MAX_ROWS) throw invalid('The file exceeds the import row limit');
  return { rows: result };
}

export async function parseImportFile(buffer: Buffer, name: string, mime?: string): Promise<ParsedImportRow[]> {
  return (await parseImportFileDetailed(buffer, name, mime)).rows;
}
