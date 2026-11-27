import { inflateRawSync } from 'node:zlib';
import { parse } from 'csv-parse/sync';
import sanitizeHtml from 'sanitize-html';
import XLSX from 'xlsx';
import { AppError } from '../core/errors.js';
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

export const TEMPLATE_VERSION = 'outvexa-brain-v2';
const entries = Object.entries(IMPORT_ENTITIES) as [ImportEntityType, (typeof IMPORT_ENTITIES)[ImportEntityType]][];
export const TEMPLATE_SHEETS = [...entries.map(([, item]) => item.sheet), 'Instructions'];
const commonHeaders = ['externalId', 'name', 'description'];
const relationshipHeaders = ['relatedServiceIds', 'relatedOfferIds', 'relatedAudienceIds', 'relatedPersonaIds'];
const examples: Record<ImportEntityType, string> = {
  COMPANY_PROFILE: 'Example Analytics', SERVICE: 'Revenue reporting', COMMERCIAL_OFFER: 'Reporting starter package',
  TARGET_AUDIENCE: 'Mid-market retailers', TARGET_PERSONA: 'Head of Analytics', ICP_CRITERIA: 'Has a data warehouse',
  BUSINESS_OPPORTUNITY: 'Multi-store forecasting', COMPETITOR: 'Example Reporting Co',
  RESEARCH_RULE: 'Verify warehouse usage', OUTREACH_RULE: 'Use concise subject lines', EXCLUSION: 'Exclude public sector',
  PROOF_CASE_STUDY: 'Inventory reporting rollout', CAMPAIGN_PREFERENCE: 'Analytics discovery campaign',
};

const fieldExamples: Record<string, string> = {
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
  disqualificationSignals: 'Uses a point-of-sale system with no export option', scoringRules: 'Add 10 for a central operations team',
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
  if (key === 'externalId') return 'Stable identifier for re-imports and links across sheets. Use letters, digits, hyphens or underscores.';
  if (key === 'name') return 'Record label. Required before application.';
  if (key === 'description') return 'Short factual summary in plain text.';
  if (relationshipHeaders.includes(key)) return 'Comma-separated externalId values from the corresponding sheet.';
  if (key === 'website') return 'Public website URL, starting with https://.';
  if (key === 'currency') return 'Three-letter ISO currency code.';
  if (key === 'price') return 'Numeric amount without a currency symbol, or clearly state custom pricing.';
  const label = key.replace(/[A-Z]/g, character => ` ${character.toLowerCase()}`);
  if (importFieldKind(key) === 'numeric') return `Enter ${label} as a number when available.`;
  if (importFieldKind(key) === 'list') return `Enter ${label} in plain text. Separate multiple entries with line breaks.`;
  return `Enter ${label} in plain text.`;
}

function exampleField(key: string, type: ImportEntityType) {
  if (key === 'name') return examples[type];
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

export function templateWorkbook() {
  const workbook = XLSX.utils.book_new();
  const instructions: unknown[][] = [
    ['Outvexa Outreach Brain Template', 'v2'],
    ['Guidance', 'Enter records below the field headers. Leave unused sheets and optional fields empty. Examples are for reference.'],
    ['Relationships', 'Use stable externalId values to link records. Use a comma between multiple identifiers.'],
    ['Evidence', 'Include sources for claims and results. Uploaded source statements require review.'],
    [],
    ['Worksheet', 'Field', 'Required', 'Description and validation', 'Example'],
  ];
  for (const [type, item] of entries) {
    const headers = [...commonHeaders, ...item.fields.split(' '), ...relationshipHeaders];
    const sheet = XLSX.utils.aoa_to_sheet([headers]);
    sheet['!cols'] = headers.map(key => ({ wch: Math.max(key.length + 2, 18) }));
    for (const [column, key] of headers.entries()) {
      const required = key === 'name' || (type === 'SERVICE' && key === 'description');
      const description = describeField(key);
      const example = exampleField(key, type);
      sheet[XLSX.utils.encode_cell({ r: 0, c: column })].c = [{ a: 'Outvexa', t: `${required ? 'Required' : 'Optional'}. ${description} Example: ${example}` }];
      instructions.push([item.sheet, key, required ? 'Yes' : 'Optional', description, example]);
    }
    XLSX.utils.book_append_sheet(workbook, sheet, item.sheet);
  }
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(instructions), 'Instructions');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const v1NameColumns: Record<ImportEntityType, string> = {
  COMPANY_PROFILE: 'company_name', SERVICE: 'service_name', COMMERCIAL_OFFER: 'offer_name',
  TARGET_AUDIENCE: 'audience_name', TARGET_PERSONA: 'persona', ICP_CRITERIA: 'criterion',
  BUSINESS_OPPORTUNITY: 'opportunity', COMPETITOR: 'competitor_name', RESEARCH_RULE: 'research_objective',
  OUTREACH_RULE: 'communication_style', EXCLUSION: 'name_or_condition', PROOF_CASE_STUDY: 'case_study',
  CAMPAIGN_PREFERENCE: 'campaign_type',
};

function workbookRows(buffer: Buffer): ParsedImportRow[] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false, cellNF: false, cellStyles: false });
  const instructions = workbook.Sheets.Instructions;
  const version = instructions?.A1?.v === 'Outvexa Outreach Brain Template' ? instructions.B1?.v : undefined;
  if (version != null && version !== 'v1' && version !== 'v2') throw invalid('Unsupported workbook template version');
  const result: ParsedImportRow[] = [];
  for (const sheet of workbook.SheetNames) {
    if (sheet === 'Instructions') continue;
    const source = workbook.Sheets[sheet];
    if (!source['!ref']) continue;
    const range = XLSX.utils.decode_range(source['!ref']);
    if (range.e.r - range.s.r > MAX_ROWS || range.e.c - range.s.c >= 150) throw invalid('A worksheet exceeds the row or column limit');
    const grid = XLSX.utils.sheet_to_json<unknown[]>(source, { header: 1, blankrows: true, raw: true, defval: null });
    const headerIndex = grid.findIndex(row => row.some(cell => cell != null && String(cell).trim()));
    if (headerIndex < 0) continue;
    const headers = grid[headerIndex].map(cell => String(cell ?? '').trim());
    const lower = headers.filter(Boolean).map(header => header.toLowerCase());
    if (new Set(lower).size !== lower.length) throw invalid('Duplicate worksheet header');
    if (lower.some(header => ['__proto__', 'prototype', 'constructor'].includes(header))) throw invalid('Invalid worksheet header');
    const entry = entries.find(([, item]) => item.sheet.toLowerCase() === sheet.toLowerCase());
    const known = entry ? new Set([...commonHeaders, ...entry[1].fields.split(' '), ...relationshipHeaders].map(field => field.toLowerCase())) : null;
    const unknownHeaders = version === 'v2' && known ? headers.filter(header => header && !known.has(header.toLowerCase())) : [];
    for (let index = headerIndex + 1; index < grid.length; index++) {
      const cells = grid[index];
      const populated = (cell: unknown) => cell != null && String(cell).trim() !== '';
      if (!cells.some(populated)) continue;
      if (cells.some((cell, column) => populated(cell) && !headers[column])) throw invalid('A populated worksheet column has no header');
      const value = Object.fromEntries(headers.flatMap((header, column) => populated(cells[column]) ? [[header, cells[column]]] : []));
      const row = range.s.r + index + 1;
      const warnings = unknownHeaders.length ? [`Additional columns require review: ${unknownHeaders.join(', ')}`] : [];
      if (!entry) warnings.push('This worksheet has no template mapping');
      else if (version) {
        if (!value.name && !value[v1NameColumns[entry[0]]]) warnings.push('Name is required before application');
        if (entry[0] === 'SERVICE' && !value.description) warnings.push('Description is required before applying a service');
      }
      result.push({ value, locator: `${sheet}:row-${row}`, excerpt: JSON.stringify(value).slice(0, 2000), sheet, row, entityType: entry?.[0], warnings });
    }
  }
  return result;
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

export async function parseImportFile(buffer: Buffer, name: string, mime?: string): Promise<ParsedImportRow[]> {
  const extension = validateImportUpload(buffer, name, mime);
  let result: ParsedImportRow[];
  try {
    if (extension === 'xlsx' || extension === 'docx') validateImportUpload(buffer, name, mime, true);
    if (extension === 'xlsx') result = workbookRows(buffer);
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
    throw invalid(`Malformed or unreadable ${extension.toUpperCase()} file`);
  }
  if (!result.length) throw invalid('The file contains no importable rows or text');
  if (result.length > MAX_ROWS) throw invalid('The file exceeds the import row limit');
  return result;
}
