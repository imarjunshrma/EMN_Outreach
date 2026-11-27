/**
 * XLSX compatibility and validation for the Knowledge Importer.
 *
 * Fixtures (tests/fixtures/knowledge-import):
 * - outvexa-outreach-brain-template-v2.xlsx: the template exactly as downloaded from Outvexa (v2 contract: 13 entity
 *   sheets plus Instructions), untouched.
 * - openpyxl-agency-workbook.xlsx / xlsxwriter-agency-workbook.xlsx: fictional data on every entity sheet, written by
 *   openpyxl (inline strings, a styled empty string, rich text) and xlsxwriter (shared strings, rich shared string). See
 *   generate-writer-fixtures.py.
 * Malformed variants are built from the untouched template in memory. No file leaves the machine.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import XLSX from 'xlsx';
import { readSheetNames } from 'read-excel-file/node';
import { describe, expect, it } from 'vitest';
import { EMPTY_TEMPLATE_NOTICE, normalizeInlineStringCells, parseImportFile, parseImportFileDetailed } from '../../backend/src/services/knowledge-import-parser.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'knowledge-import');
const fixture = (name: string) => readFile(join(FIXTURES, name));
const V2_ENTITY_SHEETS = ['Company_Profile', 'Services', 'Commercial_Offers', 'Target_Audiences', 'Target_Personas', 'ICP_Criteria',
  'Business_Opportunities', 'Competitors', 'Research_Rules', 'Outreach_Rules', 'Exclusions', 'Proof_Case_Studies', 'Campaign_Preferences'];
const INLINE = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;

/** Edits the untouched template's package: `edit` receives each worksheet's XML by sheet name. */
async function editTemplate(edit: (sheet: string, xml: string) => string | null, extra?: (zip: JSZip) => void) {
  const zip = await JSZip.loadAsync(await fixture('outvexa-outreach-brain-template-v2.xlsx'));
  const workbookXml = await zip.file('xl/workbook.xml')!.async('string');
  const names = [...workbookXml.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map(match => match[1]);
  for (const [index, name] of names.entries()) {
    const path = `xl/worksheets/sheet${index + 1}.xml`;
    const next = edit(name, await zip.file(path)!.async('string'));
    if (next != null) zip.file(path, next);
  }
  extra?.(zip);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const appendRow = (xml: string, row: number, cells: string) => xml.replace('</sheetData>', `<row r="${row}">${cells}</row></sheetData>`);
const bySheet = (rows: Array<{ sheet?: string }>) => rows.reduce<Record<string, number>>((counts, row) => ({ ...counts, [row.sheet!]: (counts[row.sheet!] ?? 0) + 1 }), {});

describe('untouched official template', () => {
  it('has all 14 worksheets, the v2 Instructions metadata and the required name header on every entity sheet', async () => {
    const buffer = await fixture('outvexa-outreach-brain-template-v2.xlsx');
    expect(await readSheetNames(buffer)).toEqual([...V2_ENTITY_SHEETS, 'Instructions']);
    const workbook = XLSX.read(buffer);
    expect([workbook.Sheets.Instructions.A1.v, workbook.Sheets.Instructions.B1.v]).toEqual(['Outvexa Outreach Brain Template', 'v2']);
    for (const sheet of V2_ENTITY_SHEETS) {
      const [headers, ...rows] = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[sheet], { header: 1 });
      expect(headers.slice(0, 2), sheet).toEqual(['externalId', 'name']);
      expect(rows, sheet).toEqual([]);
    }
  });

  it('parses as an unfilled template with no records instead of failing', async () => {
    const parsed = await parseImportFileDetailed(await fixture('outvexa-outreach-brain-template-v2.xlsx'), 'outvexa-outreach-brain-template-v2.xlsx');
    expect(parsed).toEqual({ rows: [], emptyTemplate: { version: 'v2', sheets: 13 } });
    await expect(parseImportFile(await fixture('outvexa-outreach-brain-template-v2.xlsx'), 'template.xlsx')).resolves.toEqual([]);
    expect(EMPTY_TEMPLATE_NOTICE).toMatch(/unfilled Outvexa template/);
  });

  it('parses records once rows are filled in, keeping the template contract', async () => {
    const buffer = await editTemplate((sheet, xml) => sheet === 'Services' ? appendRow(xml, 2, INLINE('A2', 'svc-1') + INLINE('B2', 'Meta Ads management') + INLINE('C2', 'Paid social for clinics')) : null);
    const rows = await parseImportFile(buffer, 'filled.xlsx');
    expect(rows).toEqual([expect.objectContaining({ sheet: 'Services', row: 2, entityType: 'SERVICE', locator: 'Services:row-2',
      value: { externalId: 'svc-1', name: 'Meta Ads management', description: 'Paid social for clinics' }, warnings: [] })]);
  });
});

describe('workbooks written by common spreadsheet libraries', () => {
  const expected = { Company_Profile: 1, Services: 2, Commercial_Offers: 1, Target_Audiences: 1, Target_Personas: 1, ICP_Criteria: 1,
    Business_Opportunities: 1, Competitors: 1, Research_Rules: 1, Outreach_Rules: 1, Exclusions: 1, Proof_Case_Studies: 1, Campaign_Preferences: 1 };

  for (const name of ['openpyxl-agency-workbook.xlsx', 'xlsxwriter-agency-workbook.xlsx']) {
    it(`reads every entity sheet of ${name} with correct values`, async () => {
      const rows = await parseImportFile(await fixture(name), name);
      expect(bySheet(rows)).toEqual(expected);
      const row = (sheet: string, index = 0) => rows.filter(entry => entry.sheet === sheet)[index].value;
      expect(row('Services').description).toBe('Full-funnel Meta Ads management for local service brands.');
      expect(row('Competitors')).toEqual({ externalId: 'comp-northstar', name: 'Northstar Media', description: 'Regional performance agency.', website: 'https://northstar.example', services: 'Paid search, Paid social' });
      expect(row('Commercial_Offers').price).toBe(1500);
      expect(row('ICP_Criteria')).toMatchObject({ weight: 0.6, threshold: 70 });
      expect(row('Exclusions').activeStatus).toBe(true);
      expect(row('Proof_Case_Studies')).toMatchObject({ publicationPermission: false, timePeriod: '2026-03-31' });
      expect(rows.every(entry => entry.entityType && (entry.warnings ?? []).length === 0)).toBe(true);
    });
  }

  it('reads a workbook written by SheetJS', async () => {
    const document = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(document, XLSX.utils.aoa_to_sheet([['externalId', 'name', 'description'], ['aud-1', 'Clinic owners', 'Founders who approve spend']]), 'Target_Audiences');
    XLSX.utils.book_append_sheet(document, XLSX.utils.aoa_to_sheet([['Outvexa Outreach Brain Template', 'v2']]), 'Instructions');
    const rows = await parseImportFile(XLSX.write(document, { bookType: 'xlsx', type: 'buffer' }), 'sheetjs.xlsx');
    expect(rows.map(entry => entry.value)).toEqual([{ externalId: 'aud-1', name: 'Clinic owners', description: 'Founders who approve spend' }]);
  });
});

describe('inline string normalization', () => {
  it('leaves the supported layout untouched', () => {
    const xml = '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c></row></sheetData>';
    expect(normalizeInlineStringCells(xml)).toEqual({ xml, changed: false });
  });

  it.each([
    ['an empty styled cell (openpyxl)', '<c r="D2" s="1" t="inlineStr"></c>', '<c r="D2" s="1"/>'],
    ['a self-closing empty cell', '<c r="D2" t="inlineStr"/>', '<c r="D2"/>'],
    ['an empty string element', '<c r="D2" t="inlineStr"><is><t/></is></c>', '<c r="D2" t="inlineStr"><is><t xml:space="preserve"></t></is></c>'],
    ['rich text runs', '<c r="C1" t="inlineStr"><is><r><t xml:space="preserve">Plain </t></r><r><rPr><b val="1"/></rPr><t>bold &amp; more</t></r></is></c>',
      '<c r="C1" t="inlineStr"><is><t xml:space="preserve">Plain bold &amp; more</t></is></c>'],
    ['phonetic guides', '<c r="E1" t="inlineStr"><is><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></is></c>', '<c r="E1" t="inlineStr"><is><t xml:space="preserve">東京</t></is></c>'],
    ['pretty-printed XML', '<c r="F1" t="inlineStr">\n  <is>\n    <t>Indented</t>\n  </is>\n</c>', '<c r="F1" t="inlineStr"><is><t xml:space="preserve">Indented</t></is></c>'],
    ['a namespace prefix', '<x:c r="G1" t="inlineStr"><x:is><x:r><x:t>A</x:t></x:r><x:r><x:t>B</x:t></x:r></x:is></x:c>', '<x:c r="G1" t="inlineStr"><x:is><x:t xml:space="preserve">AB</x:t></x:is></x:c>'],
  ])('rewrites %s', (_label, cell, expectedCell) => {
    expect(normalizeInlineStringCells(`<row r="1">${cell}<c r="Z1"><v>1</v></c></row>`)).toEqual({ xml: `<row r="1">${expectedCell}<c r="Z1"><v>1</v></c></row>`, changed: true });
  });

  it('parses a workbook containing each of those shapes', async () => {
    const buffer = await editTemplate((sheet, xml) => sheet !== 'Competitors' ? null : appendRow(xml, 2,
      INLINE('A2', 'comp-1') + '<c r="B2" t="inlineStr"><is><r><t>North</t></r><r><t>star</t></r></is></c>' + '<c r="C2" s="1" t="inlineStr"></c>' + '<c r="D2" t="inlineStr">\n<is>\n<t>https://northstar.example</t>\n</is>\n</c>'));
    const rows = await parseImportFile(buffer, 'shapes.xlsx');
    expect(rows.map(entry => entry.value)).toEqual([{ externalId: 'comp-1', name: 'Northstar', website: 'https://northstar.example' }]);
  });
});

describe('malformed and invalid workbooks', () => {
  it('rejects bytes that are not an XLSX package', async () => {
    await expect(parseImportFile(Buffer.from('not a spreadsheet'), 'bad.xlsx')).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a package without a workbook part at admission', async () => {
    const buffer = await editTemplate(() => null, (zip) => { zip.remove('xl/workbook.xml'); });
    await expect(parseImportFile(buffer, 'no-workbook.xlsx')).rejects.toThrow('The contents do not match the Office file extension');
  });

  it('rejects a damaged workbook structure without calling it a generic malformed file', async () => {
    const buffer = await editTemplate(() => null, (zip) => { zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="Services" r:id="missing"'); });
    await expect(parseImportFile(buffer, 'damaged.xlsx')).rejects.toThrow('The XLSX file is not a readable workbook: its package or workbook structure is damaged');
  });

  it('names the worksheet and cell of an unreadable cell, without quoting its content', async () => {
    const buffer = await editTemplate((sheet, xml) => sheet === 'Services' ? appendRow(xml, 2, INLINE('A2', 'svc-1') + '<c r="B2" t="x"><v>secret-business-text</v></c>') : null);
    const failure = parseImportFile(buffer, 'bad-cell.xlsx');
    await expect(failure).rejects.toThrow('Worksheet "Services" could not be read: Cell type not supported');
    await expect(failure).rejects.not.toThrow(/secret-business-text|Malformed/);
  });

  it('rejects an invalid boolean cell value with its location', async () => {
    const buffer = await editTemplate((sheet, xml) => sheet === 'Exclusions' ? appendRow(xml, 2, INLINE('A2', 'ex-1') + INLINE('B2', 'Agencies') + '<c r="L2" t="b"><v>2</v></c>') : null);
    await expect(parseImportFile(buffer, 'bad-boolean.xlsx')).rejects.toThrow(/Worksheet "Exclusions" could not be read.*Unsupported "boolean" cell value/);
  });

  it('rejects a spreadsheet formula error instead of importing its error text', async () => {
    const buffer = await editTemplate((sheet, xml) => sheet === 'Services' ? appendRow(xml, 2, INLINE('A2', 'svc-1') + INLINE('B2', 'Ads') + '<c r="C2" t="e"><v>#DIV/0!</v></c>') : null);
    await expect(parseImportFile(buffer, 'error-cell.xlsx')).rejects.toThrow('Worksheet "Services" cell C2 contains the spreadsheet error #DIV/0!');
  });

  it('accepts missing worksheets: unused sheets may be removed', async () => {
    const document = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(document, XLSX.utils.aoa_to_sheet([['externalId', 'name'], ['co-1', 'Brightline']]), 'Company_Profile');
    XLSX.utils.book_append_sheet(document, XLSX.utils.aoa_to_sheet([['Outvexa Outreach Brain Template', 'v2']]), 'Instructions');
    expect(bySheet(await parseImportFile(XLSX.write(document, { bookType: 'xlsx', type: 'buffer' }), 'one-sheet.xlsx'))).toEqual({ Company_Profile: 1 });
  });

  it('rejects a populated column without a header, and flags a record without the required name', async () => {
    const unheaded = await editTemplate((sheet, xml) => sheet === 'Target_Audiences' ? appendRow(xml, 2, INLINE('A2', 'aud-1') + INLINE('B2', 'Clinics') + INLINE('Z2', 'stray value')) : null);
    await expect(parseImportFile(unheaded, 'no-header.xlsx')).rejects.toThrow('A populated worksheet column has no header');
    const nameless = await editTemplate((sheet, xml) => sheet === 'Target_Audiences' ? appendRow(xml, 2, INLINE('A2', 'aud-1') + INLINE('C2', 'Clinic owners')) : null);
    expect((await parseImportFile(nameless, 'no-name.xlsx'))[0].warnings).toEqual(['Name is required before application']);
  });

  it('rejects duplicate headers', async () => {
    const buffer = await editTemplate((sheet, xml) => sheet === 'Services' ? xml.replace(/<c r="C1"[\s\S]*?<\/c>/, INLINE('C1', 'name')) : null);
    await expect(parseImportFile(buffer, 'duplicate.xlsx')).rejects.toThrow('Duplicate worksheet header');
  });

  it('flags unexpected columns for review, and does not treat a changed template as an unfilled one', async () => {
    const extra = (xml: string) => xml.replace('</row>', `${INLINE('T1', 'favouriteColour')}</row>`);
    const filled = await editTemplate((sheet, xml) => sheet === 'Services' ? appendRow(extra(xml), 2, INLINE('A2', 'svc-1') + INLINE('B2', 'Ads') + INLINE('C2', 'Paid social') + INLINE('T2', 'Teal')) : null);
    expect((await parseImportFile(filled, 'extra.xlsx'))[0].warnings).toEqual(['Additional columns require review: favouriteColour']);
    const emptyChanged = await editTemplate((sheet, xml) => sheet === 'Services' ? extra(xml) : null);
    await expect(parseImportFile(emptyChanged, 'extra-empty.xlsx')).rejects.toThrow('The file contains no importable rows or text');
  });

  it('skips an empty worksheet in a filled workbook, but an empty sheet means the workbook is not an unfilled template', async () => {
    const emptySheet = (xml: string) => xml.replace(/<sheetData>[\s\S]*<\/sheetData>/, '<sheetData/>');
    const filled = await editTemplate((sheet, xml) => sheet === 'Competitors' ? emptySheet(xml) : sheet === 'Services' ? appendRow(xml, 2, INLINE('A2', 'svc-1') + INLINE('B2', 'Ads') + INLINE('C2', 'Paid social')) : null);
    expect(bySheet(await parseImportFile(filled, 'empty-sheet.xlsx'))).toEqual({ Services: 1 });
    const blank = await editTemplate((sheet, xml) => sheet === 'Competitors' ? emptySheet(xml) : null);
    await expect(parseImportFile(blank, 'blank-sheet.xlsx')).rejects.toThrow('The file contains no importable rows or text');
  });

  it('still rejects empty workbooks that are not an official template', async () => {
    const document = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(document, XLSX.utils.aoa_to_sheet([['Contact', 'Phone']]), 'Sheet1');
    await expect(parseImportFile(XLSX.write(document, { bookType: 'xlsx', type: 'buffer' }), 'empty.xlsx')).rejects.toThrow('The file contains no importable rows or text');
    const unversioned = await editTemplate((sheet, xml) => sheet === 'Instructions' ? xml.replace(/<c r="B1"[\s\S]*?<\/c>/, '') : null);
    await expect(parseImportFile(unversioned, 'no-version.xlsx')).rejects.toThrow('The file contains no importable rows or text');
  });

  it('rejects an unsupported template version', async () => {
    const buffer = await editTemplate((sheet, xml) => sheet === 'Instructions' ? xml.replace(/(<c r="B1"[^>]*><is><t[^>]*>)v2(<\/t>)/, '$1v99$2') : null);
    await expect(parseImportFile(buffer, 'v99.xlsx')).rejects.toThrow('Unsupported workbook template version');
  });
});
