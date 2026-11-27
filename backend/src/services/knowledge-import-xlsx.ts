import JSZip from 'jszip';

/**
 * Minimal XLSX writer for the import template. Replaces the `xlsx` (SheetJS 0.18.5) package, whose last npm release
 * has unpatched prototype-pollution and ReDoS advisories (GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9). It writes only
 * what the template needs: text cells, column widths and a hover note per header cell.
 */
export interface TemplateSheet {
  name: string;
  rows: Array<Array<string | number | null>>;
  widths?: number[];
  /** Notes shown when hovering a cell in row 1, by column index. */
  headerNotes?: string[];
}

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
  // XML 1.0 forbids most control characters; drop them rather than emit an unreadable file.
  .split('').filter((c) => { const code = c.charCodeAt(0); return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d; }).join('');

export function columnName(index: number) {
  let n = index + 1;
  let name = '';
  while (n > 0) { const r = (n - 1) % 26; name = String.fromCharCode(65 + r) + name; n = Math.floor((n - 1) / 26); }
  return name;
}

function sheetXml(sheet: TemplateSheet, hasNotes: boolean) {
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.max(w, 4), 120)}" customWidth="1"/>`).join('')}</cols>` : '';
  const rows = sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
    if (value == null || value === '') return '';
    const ref = `${columnName(c)}${r + 1}`;
    return typeof value === 'number' && Number.isFinite(value)
      ? `<c r="${ref}"><v>${value}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(value))}</t></is></c>`;
  }).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${cols}<sheetData>${rows}</sheetData>${hasNotes ? '<legacyDrawing r:id="rId2"/>' : ''}</worksheet>`;
}

function commentsXml(notes: string[]) {
  const list = notes.map((note, c) => note ? `<comment ref="${columnName(c)}1" authorId="0"><text><r><t xml:space="preserve">${esc(note)}</t></r></text></comment>` : '').join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Outvexa</author></authors><commentList>${list}</commentList></comments>`;
}

// Excel shows notes through a legacy VML drawing; each note needs a shape anchored to its cell.
function vmlXml(notes: string[]) {
  const shapes = notes.map((note, c) => note ? `<v:shape id="_x0000_s${1025 + c}" type="#_x0000_t202" style="position:absolute;margin-left:80pt;margin-top:2pt;width:220pt;height:90pt;z-index:${c + 1};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${c + 1}, 15, 0, 2, ${c + 4}, 15, 4, 16</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>0</x:Row><x:Column>${c}</x:Column></x:ClientData></v:shape>` : '').join('');
  return `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>${shapes}</xml>`;
}

export async function writeWorkbook(sheets: TemplateSheet[]): Promise<Buffer> {
  const names = new Set<string>();
  for (const sheet of sheets) {
    if (!sheet.name || sheet.name.length > 31 || /[\\/?*[\]:]/.test(sheet.name) || names.has(sheet.name.toLowerCase())) throw new Error(`Invalid worksheet name: ${sheet.name}`);
    names.add(sheet.name.toLowerCase());
  }
  const zip = new JSZip();
  const withNotes = sheets.map((sheet) => !!sheet.headerNotes?.some(Boolean));
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${withNotes[i] ? `<Override PartName="/xl/comments${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>` : ''}`).join('')}</Types>`);
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
  sheets.forEach((sheet, i) => {
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet, withNotes[i]));
    if (!withNotes[i]) return;
    zip.file(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments${i + 1}.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing${i + 1}.vml"/></Relationships>`);
    zip.file(`xl/comments${i + 1}.xml`, commentsXml(sheet.headerNotes!));
    zip.file(`xl/drawings/vmlDrawing${i + 1}.vml`, vmlXml(sheet.headerNotes!));
  });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
