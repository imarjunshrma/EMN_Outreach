import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import { db, Prisma } from '../core/db.js';
import { store, assertKeyBelongsTo } from '../core/storage.js';
import { enqueue, QUEUES } from '../core/queues.js';
import { validateEmailSyntax } from '../../../integrations/src/email-verification.js';

type CsvRow = { email: string; row: string[]; sourceRow: number };
const CHUNK_SIZE = 250;
const MAX_ROWS = 500_000;

export function csvSafe(value: unknown) {
  const text = Array.isArray(value) ? value.join('; ') : value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
}

export function chooseEmailColumn(headers: string[], requested?: string | null) {
  if (requested?.trim()) {
    const value = requested.trim();
    if (/^\d+$/.test(value)) return Number(value);
    const found = headers.findIndex((h) => h.trim().toLowerCase() === value.toLowerCase());
    if (found >= 0) return found;
    throw new Error('The selected email column was not found in the CSV header');
  }
  const match = headers.findIndex((h) => /^(e-?mail|email address|e-mail address|primary email|contact email)$/i.test(h.trim()));
  if (match < 0) throw new Error('Could not detect an email column; upload again and provide the column name or zero-based index');
  return match;
}

export async function processVerificationCsvBatch(workspaceId: string, batchId: string) {
  const batch = await db().emailVerificationBatch.findFirst({ where: { id: batchId, workspaceId } });
  if (!batch || !batch.storageKey) throw new Error('CSV verification batch or stored file was not found');
  assertKeyBelongsTo(batch.storageKey, workspaceId);
  const parser = parse({ bom: true, skip_empty_lines: true, relax_column_count: true, max_record_size: 256 * 1024 });
  const stream = store().stream(batch.storageKey).pipe(parser);
  let headers: string[] = [];
  let emailIndex = -1;
  let rowNumber = 0;
  let records = 0;
  let initialRow = true;
  let chunk: CsvRow[] = [];

  const flush = async () => {
    if (!chunk.length) return;
    const unique = [...new Map(chunk.map((r) => {
      const syntax = validateEmailSyntax(r.email);
      const email = (syntax.valid ? syntax.normalizedEmail : r.email.trim().normalize('NFC')).toLowerCase();
      return [email, { ...r, email }];
    })).values()];
    const emails = unique.map((r) => r.email);
    const priorBatch = await db().emailVerification.findMany({ where: { workspaceId, batchId, email: { in: emails } }, select: { email: true } });
    const seen = new Set(priorBatch.map((x) => x.email));
    const fresh = unique.filter((r) => !seen.has(r.email));
    if (fresh.length) {
      const cachedRows = await db().emailVerification.findMany({ where: { workspaceId, email: { in: fresh.map((r) => r.email) }, provider: 'first-party-dns', batchId: null, leadId: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
      const cached = new Map<string, typeof cachedRows[number]>();
      for (const r of cachedRows) if (!cached.has(r.email)) cached.set(r.email, r);
      const data = fresh.map((r) => {
        const previous = cached.get(r.email);
        const details = previous ? { ...(previous.details as Record<string, unknown>), originalRow: r.row, sourceRow: r.sourceRow } : { state: 'QUEUED', originalRow: r.row, sourceRow: r.sourceRow };
        return { workspaceId, batchId, email: r.email, provider: 'first-party-dns', result: previous?.result ?? 'UNKNOWN', rawResult: previous?.rawResult ?? 'queued', details: details as Prisma.InputJsonValue, expiresAt: previous?.expiresAt ?? null };
      });
      const inserted = await db().emailVerification.createMany({ data, skipDuplicates: true });
      const cacheHits = fresh.filter((r) => cached.has(r.email)).length;
      await db().emailVerificationBatch.update({ where: { id: batchId }, data: { total: { increment: inserted.count }, processed: { increment: Math.min(inserted.count, cacheHits) }, status: 'INGESTING', emailColumn: String(emailIndex), csvHeaders: headers as unknown as Prisma.InputJsonValue } });
      const current = await db().emailVerification.findMany({ where: { workspaceId, batchId, email: { in: fresh.map((r) => r.email) }, rawResult: 'queued' }, select: { id: true } });
      await Promise.all(current.map((v) => enqueue(QUEUES.verify, 'verify.address', { workspaceId, verificationId: v.id }, { jobId: `fpv-${v.id}`, attempts: 4, backoff: { type: 'emnVerify' } })));
    }
    chunk = [];
  };

  try {
    for await (const raw of stream as AsyncIterable<string[]>) {
      rowNumber++;
      const row = raw.map((v) => String(v ?? ''));
      if (initialRow) {
        initialRow = false;
        if (batch.hasHeader) {
          headers = row;
          emailIndex = chooseEmailColumn(headers, batch.emailColumn);
          continue;
        }
        headers = row.map((_, i) => `column_${i + 1}`);
        emailIndex = batch.emailColumn ? chooseEmailColumn(headers, batch.emailColumn) : 0;
      }
      if (emailIndex < 0 || emailIndex >= row.length) throw new Error(`Selected email column is missing at CSV row ${rowNumber}`);
      const email = row[emailIndex]?.trim();
      if (!email) continue;
      records++;
      if (records > MAX_ROWS) throw new Error(`CSV exceeds the ${MAX_ROWS.toLocaleString()} non-empty row limit; no rows were silently truncated`);
      chunk.push({ email, row, sourceRow: rowNumber });
      if (chunk.length >= CHUNK_SIZE) await flush();
    }
    await flush();
    const finalBatch = await db().emailVerificationBatch.update({ where: { id: batchId }, data: { status: 'PROCESSING', emailColumn: String(emailIndex), csvHeaders: headers as unknown as Prisma.InputJsonValue } });
    if (finalBatch.processed >= finalBatch.total) await db().emailVerificationBatch.update({ where: { id: batchId }, data: { status: 'COMPLETED', completedAt: new Date() } });
    return { batchId, total: finalBatch.total, processed: finalBatch.processed, acceptedRows: records, emailColumn: emailIndex };
  } catch (e) {
    stream.destroy(e as Error);
    throw e;
  }
}

export async function markCsvImportFailed(workspaceId: string, batchId: string, error: string) {
  const message = error.replace(/[\r\n\t]+/g, ' ').slice(0, 200);
  await db().emailVerificationBatch.updateMany({ where: { id: batchId, workspaceId, status: 'INGESTING' }, data: { status: 'FAILED_IMPORT', error: message, completedAt: new Date() } });
}

export async function streamVerificationBatchCsv(workspaceId: string, batchId: string, response: Response) {
  const batch = await db().emailVerificationBatch.findFirst({ where: { id: batchId, workspaceId }, select: { id: true, csvHeaders: true, emailColumn: true } });
  if (!batch) throw new Error('Verification batch was not found');
  const originals = Array.isArray(batch.csvHeaders) ? batch.csvHeaders.map((x) => String(x)) : [];
  const extra = ['original_email','normalized_email','primary_status','dns_status','mx_summary','smtp_status','catch_all_status','disposable','free_provider','role_based','risk_score','risk_signals','failure_reason','verified_at'];
  const columns = [...originals.map(csvSafe), ...extra];
  async function* rows() {
    yield columns;
    let afterId: string | undefined;
    while (true) {
      const page = await db().emailVerification.findMany({ where: { workspaceId, batchId, ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: 'asc' }, take: 500 });
      if (!page.length) break;
      for (const item of page) {
        const details = item.details as Record<string, any>;
        const original = Array.isArray(details.originalRow) ? details.originalRow : [];
        const emailColumn = Number(batch.emailColumn ?? -1);
        const originalEmail = typeof original[emailColumn] === 'string' ? original[emailColumn] : item.email;
        const mx = (details.dns?.mx ?? []).map((m: any) => `${m.priority} ${m.exchange}`).join('; ');
        const attrs = details.attributes ?? {};
        yield [...original.map(csvSafe), ...[
          originalEmail, item.email, item.result, details.dns?.status, mx, details.smtp?.classification,
          details.catchAll?.status, attrs.disposable, attrs.freeProvider, attrs.roleBased,
          details.risk?.score, details.risk?.signals, details.error ?? details.syntax?.reason ?? details.dns?.error,
          details.checkedAt,
        ].map(csvSafe)];
      }
      afterId = page[page.length - 1].id;
      if (page.length < 500) break;
    }
  }
  response.status(200).setHeader('content-type', 'text/csv; charset=utf-8');
  response.setHeader('content-disposition', `attachment; filename="email-verification-${batch.id}.csv"`);
  response.setHeader('cache-control', 'no-store');
  await pipeline(Readable.from(rows()), stringify(), response);
}
