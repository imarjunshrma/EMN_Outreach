import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Resolver } from 'node:dns/promises';
import { db } from '../../backend/src/core/db.js';
import { processFirstPartyVerification } from '../../backend/src/services/first-party-verification.js';
import { csvSafe, chooseEmailColumn, processVerificationCsvBatch } from '../../backend/src/services/verification-csv.js';
import { resetDb, installFakes, createUserSession } from '../helpers/harness.js';

// End-to-end first-party verification through the API: single address, JSON list, CSV upload → import →
// checks → results → export, batch controls, workspace dictionaries and tenant boundaries.
// DNS is stubbed on the Resolver prototype, so no lookup leaves the machine; SMTP probing stays disabled.
const MX: Record<string, Array<{ exchange: string; priority: number }>> = {
  'good.test': [{ exchange: 'mx.good.test', priority: 10 }],
  'nullmx.test': [{ exchange: '.', priority: 0 }],
};
function stubDns() {
  const nx = () => Object.assign(new Error('queryMx ENOTFOUND'), { code: 'ENOTFOUND' });
  vi.spyOn(Resolver.prototype, 'resolveMx').mockImplementation(async (d: string) => { if (MX[d]) return MX[d]; throw nx(); });
  vi.spyOn(Resolver.prototype, 'resolve4').mockImplementation((async (h: string) => { if (h.endsWith('good.test')) return ['93.184.216.34']; throw nx(); }) as never);
  vi.spyOn(Resolver.prototype, 'resolve6').mockImplementation((async () => { throw nx(); }) as never);
}

async function drain(workspaceId: string, batchId?: string) {
  const rows = await db().emailVerification.findMany({ where: { workspaceId, provider: 'first-party-dns', rawResult: 'queued', ...(batchId ? { batchId } : {}) } });
  for (const r of rows) await processFirstPartyVerification(workspaceId, r.id);
  return rows.length;
}

beforeEach(async () => { await resetDb(); installFakes(); stubDns(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('first-party email verification', () => {
  it('verifies one address: queued, checked against DNS, cached for the freshness window', async () => {
    const s = await createUserSession('v-owner@example.test');
    const base = `/api/v1/w/${s.workspaceId}/email-verification`;
    const q = await s.agent.post(`${base}/verify`).set('x-csrf-token', s.csrf).send({ email: ' Jane.Doe@Good.test ' });
    expect(q.status).toBe(202);
    expect(q.body.cached).toBe(false);
    expect(await drain(s.workspaceId)).toBe(1);
    const r = await s.agent.get(`${base}/${q.body.id}`);
    expect(r.status).toBe(200);
    expect(r.body.email).toBe('jane.doe@good.test');
    expect(r.body.details.dns.status).toBe('MX');
    expect(r.body.details.smtp.classification).toBe('DISABLED'); // no SMTP probing unless explicitly enabled
    expect(r.body.expiresAt).toBeTruthy();
    // Second request inside the freshness window reuses the result instead of queueing work.
    const again = await s.agent.post(`${base}/verify`).set('x-csrf-token', s.csrf).send({ email: 'jane.doe@good.test' });
    expect(again.body.cached).toBe(true);
    expect(again.body.id).toBe(q.body.id);
    // History search is tenant-scoped.
    const h = await s.agent.get(`${base}/history?email=jane`);
    expect(h.body.total).toBe(1);
  });

  it('classifies null-MX, unknown domains and bad syntax as not deliverable', async () => {
    const s = await createUserSession('v-owner@example.test');
    const base = `/api/v1/w/${s.workspaceId}/email-verification`;
    const b = await s.agent.post(`${base}/bulk`).set('x-csrf-token', s.csrf).send({ emails: ['a@nullmx.test', 'b@nowhere.test', 'not-an-email', 'A@nullmx.test'] });
    expect(b.status).toBe(202);
    expect(b.body.total).toBe(3); // case-insensitive de-duplication
    await drain(s.workspaceId, b.body.batchId);
    const res = await s.agent.get(`${base}/batches/${b.body.batchId}`);
    const by = Object.fromEntries(res.body.verifications.map((v: { email: string; result: string; details: { dns?: { status?: string } } }) => [v.email, v]));
    expect(by['a@nullmx.test'].result).toBe('INVALID');
    expect(by['a@nullmx.test'].details.dns.status).toBe('NULL_MX');
    expect(by['not-an-email'].result).toBe('INVALID');
    expect(by['b@nowhere.test'].result).not.toBe('VALID');
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.processed).toBe(3);
  });

  it('CSV upload: detects the email column, de-duplicates, verifies, and exports with formula protection', async () => {
    const s = await createUserSession('v-owner@example.test');
    const base = `/api/v1/w/${s.workspaceId}/email-verification`;
    const csv = 'Name,Email,Note\nAda,ada@good.test,"=HYPERLINK(""http://x"")"\nBen,ben@good.test,ok\nAda again,ADA@good.test,dup\nBad,nope,x\n';
    const up = await s.agent.post(`${base}/bulk.csv`).set('x-csrf-token', s.csrf).field('hasHeader', 'true').attach('file', Buffer.from(csv), { filename: 'list.csv', contentType: 'text/csv' });
    expect(up.status).toBe(202);
    expect(up.body.status).toBe('INGESTING');
    await processVerificationCsvBatch(s.workspaceId, up.body.batchId);
    const mid = await s.agent.get(`${base}/batches/${up.body.batchId}`);
    expect(mid.body.total).toBe(3); // ada (first occurrence kept), ben, nope
    expect(mid.body.csvHeaders).toEqual(['Name', 'Email', 'Note']);
    await drain(s.workspaceId, up.body.batchId);
    const done = await s.agent.get(`${base}/batches/${up.body.batchId}`);
    expect(done.body.processed).toBe(3);
    expect(done.body.status).toMatch(/^COMPLETED/);
    const list = await s.agent.get(`${base}/batches`);
    expect(list.body.data[0]).not.toHaveProperty('storageKey'); // internal storage path never leaves the API
    const exp = await s.agent.get(`${base}/batches/${up.body.batchId}/export.csv`).buffer(true).parse((res, cb) => { let t = ''; res.on('data', (c: Buffer) => { t += c.toString(); }); res.on('end', () => cb(null, t)); });
    expect(exp.status).toBe(200);
    expect(exp.headers['content-type']).toContain('text/csv');
    const text = exp.body as string;
    expect(text.split('\n')[0]).toContain('primary_status');
    expect(text).toContain(`'=HYPERLINK`); // a cell starting with = is neutralised for spreadsheets
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
    // Each row keeps the customer's own columns first, aligned under the original header.
    const lines = text.trim().split('\n');
    const header = lines[0].split(',');
    const ada = lines.find((l) => l.startsWith('Ada,'))!;
    expect(ada).toBeTruthy();
    expect(ada).toMatch(/^Ada,ada@good\.test,"?'=HYPERLINK/); // first occurrence kept, formula neutralised
    expect(lines.find((l) => l.startsWith('Ben,'))!.split(',')[header.indexOf('dns_status')]).toBe('MX');
  });

  it('a malformed CSV fails the import cleanly instead of half-importing', async () => {
    const s = await createUserSession('v-owner@example.test');
    const base = `/api/v1/w/${s.workspaceId}/email-verification`;
    const up = await s.agent.post(`${base}/bulk.csv`).set('x-csrf-token', s.csrf).attach('file', Buffer.from('Email,Note\na@good.test,=X("bad")\n'), 'bad.csv');
    expect(up.status).toBe(202);
    await expect(processVerificationCsvBatch(s.workspaceId, up.body.batchId)).rejects.toThrow();
    const noCol = await s.agent.post(`${base}/bulk.csv`).set('x-csrf-token', s.csrf).attach('file', Buffer.from('Name,Phone\nA,1\n'), 'nocol.csv');
    await expect(processVerificationCsvBatch(s.workspaceId, noCol.body.batchId)).rejects.toThrow(/email column/);
    const notCsv = await s.agent.post(`${base}/bulk.csv`).set('x-csrf-token', s.csrf).attach('file', Buffer.from('x'), 'list.xlsx');
    expect(notCsv.status).toBe(400);
  });

  it('pause, resume, cancel and retry follow the batch state rules', async () => {
    const s = await createUserSession('v-owner@example.test');
    const base = `/api/v1/w/${s.workspaceId}/email-verification`;
    const send = (p: string) => s.agent.post(`${base}/batches/${p}`).set('x-csrf-token', s.csrf).send({});
    const b = await s.agent.post(`${base}/bulk`).set('x-csrf-token', s.csrf).send({ emails: ['p1@good.test', 'p2@good.test', 'p3@good.test'] });
    const id = b.body.batchId;
    expect((await send(`${id}/resume`)).status).toBe(409); // not paused
    expect((await send(`${id}/pause`)).status).toBe(201);
    // A paused batch is not processed.
    const row = await db().emailVerification.findFirstOrThrow({ where: { batchId: id } });
    expect(await processFirstPartyVerification(s.workspaceId, row.id)).toEqual({ skipped: 'batch paused' });
    expect((await send(`${id}/resume`)).status).toBe(202);
    await processFirstPartyVerification(s.workspaceId, row.id);
    // Mark one row failed, retry puts it back in the queue.
    const other = await db().emailVerification.findFirstOrThrow({ where: { batchId: id, rawResult: 'queued' } });
    await db().emailVerification.update({ where: { id: other.id }, data: { rawResult: 'failed', details: { state: 'FAILED', originalRow: ['Pat', 'p@good.test'], sourceRow: 7 } } });
    const retry = await send(`${id}/retry`);
    expect(retry.status).toBe(202);
    expect(retry.body.retried).toBe(1);
    const retried = await db().emailVerification.findUniqueOrThrow({ where: { id: other.id } });
    expect(retried.rawResult).toBe('queued');
    expect(retried.details).toMatchObject({ state: 'QUEUED', originalRow: ['Pat', 'p@good.test'], sourceRow: 7 }); // CSV row survives a retry
    await processFirstPartyVerification(s.workspaceId, other.id);
    expect((await db().emailVerification.findUniqueOrThrow({ where: { id: other.id } })).details).toMatchObject({ state: 'COMPLETE', originalRow: ['Pat', 'p@good.test'] });
    expect((await send(`${id}/cancel`)).status).toBe(201);
    expect(await db().emailVerification.count({ where: { batchId: id, rawResult: 'queued' } })).toBe(0);
    expect((await send(`${id}/cancel`)).status).toBe(409);
    expect((await send(`${id}/pause`)).status).toBe(409);
  });

  it('workspace dictionaries: disposable overrides and role patterns apply to this workspace only', async () => {
    const s = await createUserSession('v-owner@example.test');
    const o = await createUserSession('v-other@example.test');
    const base = `/api/v1/w/${s.workspaceId}/email-verification`;
    MX['burner.test'] = [{ exchange: 'mx.good.test', priority: 10 }];
    const ov = await s.agent.post(`${base}/domain-overrides`).set('x-csrf-token', s.csrf).send({ domain: 'Burner.test', disposable: true });
    expect(ov.status).toBeLessThan(300);
    const rp = await s.agent.post(`${base}/role-patterns`).set('x-csrf-token', s.csrf).send({ localPart: 'deals', enabled: true });
    expect(rp.status).toBeLessThan(300);
    const ds = await s.agent.get(`${base}/datasets`);
    expect(JSON.stringify(ds.body)).toContain('burner.test');

    const mine = await s.agent.post(`${base}/bulk`).set('x-csrf-token', s.csrf).send({ emails: ['x@burner.test', 'deals@good.test'] });
    await drain(s.workspaceId, mine.body.batchId);
    const r = await s.agent.get(`${base}/batches/${mine.body.batchId}`);
    const by = Object.fromEntries(r.body.verifications.map((v: { email: string; details: { attributes: Record<string, boolean> } }) => [v.email, v.details.attributes]));
    expect(by['x@burner.test'].disposable).toBe(true);
    expect(by['deals@good.test'].roleBased).toBe(true);

    const theirs = await o.agent.post(`/api/v1/w/${o.workspaceId}/email-verification/bulk`).set('x-csrf-token', o.csrf).send({ emails: ['x@burner.test'] });
    await drain(o.workspaceId, theirs.body.batchId);
    const t = await o.agent.get(`/api/v1/w/${o.workspaceId}/email-verification/batches/${theirs.body.batchId}`);
    expect(t.body.verifications[0].details.attributes.disposable).toBe(false); // another workspace's override does not leak

    const overrideId = (await db().emailVerificationDomainOverride.findFirstOrThrow({ where: { workspaceId: s.workspaceId } })).id;
    expect((await o.agent.delete(`/api/v1/w/${o.workspaceId}/email-verification/domain-overrides/${overrideId}`).set('x-csrf-token', o.csrf)).status).toBe(404);
    expect((await s.agent.delete(`${base}/domain-overrides/${overrideId}`).set('x-csrf-token', s.csrf)).status).toBeLessThan(300);
    delete MX['burner.test'];
  });

  it('tenant boundaries and roles: other workspaces get 404, viewers cannot upload', async () => {
    const s = await createUserSession('v-owner@example.test');
    const o = await createUserSession('v-other@example.test');
    const viewer = await createUserSession('v-viewer@example.test', 'VIEWER', s.workspaceId);
    const b = await s.agent.post(`/api/v1/w/${s.workspaceId}/email-verification/bulk`).set('x-csrf-token', s.csrf).send({ emails: ['t@good.test'] });
    const v = await db().emailVerification.findFirstOrThrow({ where: { batchId: b.body.batchId } });
    const ob = `/api/v1/w/${o.workspaceId}/email-verification`;
    expect((await o.agent.get(`${ob}/${v.id}`)).status).toBe(404);
    expect((await o.agent.get(`${ob}/batches/${b.body.batchId}/export.csv`)).status).toBe(404);
    expect((await o.agent.post(`${ob}/batches/${b.body.batchId}/cancel`).set('x-csrf-token', o.csrf).send({})).status).toBe(404);
    expect((await o.agent.get(`/api/v1/w/${s.workspaceId}/email-verification/${v.id}`)).status).toBe(404); // not a member
    const up = await viewer.agent.post(`/api/v1/w/${s.workspaceId}/email-verification/bulk.csv`).set('x-csrf-token', viewer.csrf).attach('file', Buffer.from('email\na@good.test\n'), 'x.csv');
    expect(up.status).toBe(403);
    expect((await viewer.agent.get(`/api/v1/w/${s.workspaceId}/email-verification/${v.id}`)).status).toBe(200); // viewers may read
  });
});

describe('CSV helpers', () => {
  it('neutralises spreadsheet formulas and finds the email column', () => {
    expect(csvSafe('=1+1')).toBe(`'=1+1`);
    expect(csvSafe(' @SUM(A1)')).toBe(`' @SUM(A1)`);
    expect(csvSafe('plain')).toBe('plain');
    expect(csvSafe(['a', 'b'])).toBe('a; b');
    expect(csvSafe(null)).toBe('');
    expect(chooseEmailColumn(['Name', 'E-mail'])).toBe(1);
    expect(chooseEmailColumn(['a', 'b', 'c'], '2')).toBe(2);
    expect(chooseEmailColumn(['Name', 'Work'], 'work')).toBe(1);
    expect(() => chooseEmailColumn(['Name', 'Phone'])).toThrow(/Could not detect/);
    expect(() => chooseEmailColumn(['Name'], 'missing')).toThrow(/not found/);
  });
});
