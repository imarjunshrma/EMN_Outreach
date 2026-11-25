import { unzipSync, zipSync } from 'fflate';
import { readSheet, type SheetData } from 'read-excel-file/browser';

const MAX_CSV_BYTES = 20 * 1024 * 1024;
const MAX_WORKBOOK_XML_BYTES = 40 * 1024 * 1024;
const WORKER_THRESHOLD = 512 * 1024;
const xmlEntry = (name: string) => /\.(xml|rels)$/i.test(name);

function prepareWorkbook(bytes: Uint8Array<ArrayBuffer>): ArrayBuffer {
  let xmlBytes = 0;
  let useStoredEntries = false;
  unzipSync(bytes, { filter: (entry) => {
    if (xmlEntry(entry.name)) {
      xmlBytes += entry.originalSize;
      if (xmlBytes > MAX_WORKBOOK_XML_BYTES) throw new Error('Expanded workbook is too large');
      useStoredEntries ||= entry.compression === 8 && entry.originalSize >= WORKER_THRESHOLD && entry.size <= 0.8 * entry.originalSize;
    }
    return false;
  } });
  if (!useStoredEntries) return bytes.buffer;
  // The XLSX reader launches Blob workers for large deflated entries. Store the bounded XML
  // entries so it can read them under the application's existing browser policy.
  const xml = unzipSync(bytes, { filter: (entry) => xmlEntry(entry.name) });
  return new Uint8Array(zipSync(xml, { level: 0 })).buffer;
}

export async function workbookToCsv(file: File): Promise<File> {
  let rows: SheetData;
  try {
    const workbook = prepareWorkbook(new Uint8Array(await file.arrayBuffer()));
    rows = await readSheet(workbook, 1);
  } catch (error) {
    if (error instanceof Error && error.message === 'Expanded workbook is too large') throw new Error('Choose a workbook with less than 40 MB of expanded spreadsheet data.');
    throw new Error('The first worksheet could not be read. Check that the file is an Excel .xlsx workbook.');
  }
  if (!rows.length) throw new Error('The first worksheet is empty.');

  const lines: string[] = [];
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const row of rows) {
    const line = row.map((cell) => {
      const value = cell instanceof Date ? cell.toISOString() : String(cell ?? '');
      return `"${value.replaceAll('"', '""')}"`;
    }).join(',');
    bytes += encoder.encode(line).byteLength + (lines.length ? 2 : 0);
    if (bytes > MAX_CSV_BYTES) throw new Error('The first worksheet exceeds the 20 MB import limit once converted to CSV.');
    lines.push(line);
  }
  return new File([lines.join('\r\n')], file.name, { type: 'text/csv' });
}
