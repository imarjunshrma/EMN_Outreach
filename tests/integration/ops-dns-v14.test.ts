/**
 * v1.4: DNS record list/edit/delete (MOCKED Cloudflare — no real DNS is changed), live-stream tenant gate,
 * operations console, Prometheus endpoint and job timeouts.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../../backend/src/core/db.js';
import { encryptSecret } from '../../backend/src/services/workspace.js';
import { hashPassword } from '../../backend/src/services/auth.js';
import { withTimeout, JobTimeoutError } from '../../worker/src/processors.js';
import { resetDb, installFakes, createUserSession, getApp } from '../helpers/harness.js';

let fakes: ReturnType<typeof installFakes>;
beforeEach(async () => { await resetDb(); fakes = installFakes(); });
afterEach(() => { delete process.env.METRICS_TOKEN; });

async function dnsSetup() {
  const s = await createUserSession('dns@x.com');
  await db().integration.create({ data: { workspaceId: s.workspaceId, type: 'cloudflare', encryptedConfig: encryptSecret('cf-token') } });
  const d = await db().domain.create({ data: { workspaceId: s.workspaceId, name: 'ourco.com' } });
  fakes.cloudflare.zones.set('ourco.com', 'z1');
  fakes.cloudflare.records.push(
    { id: 'ns1', zoneId: 'z1', type: 'NS', name: 'ourco.com', content: 'ns1.cloudflare.com', ttl: 1 },
    { id: 'spf', zoneId: 'z1', type: 'TXT', name: 'ourco.com', content: 'v=spf1 include:_spf.google.com ~all', ttl: 1 },
    { id: 'www', zoneId: 'z1', type: 'CNAME', name: 'www.ourco.com', content: 'ourco.com', ttl: 1 },
    { id: 'other', zoneId: 'z1', type: 'TXT', name: 'unrelated.example', content: 'x', ttl: 1 },
  );
  return { s, d, base: `/api/v1/w/${s.workspaceId}/domains/${d.id}/zone-records` };
}

describe('DNS record management (MOCKED provider)', () => {
  it('lists only the domain’s records, edits one record safely, and protects NS records', async () => {
    const { s, base } = await dnsSetup();
    const list = await s.agent.get(base);
    expect(list.status).toBe(200);
    expect(list.body.records.map((r: { id: string }) => r.id).sort()).toEqual(['ns1', 'spf', 'www']);
    expect(list.body.records.find((r: { id: string }) => r.id === 'ns1').editable).toBe(false);
    const h = { 'x-csrf-token': s.csrf };
    // stale edit refused: the record changed since it was loaded
    expect((await s.agent.put(`${base}/spf`).set(h).send({ content: 'v=spf1 ~all', expectedContent: 'v=spf1 -all' })).status).toBe(409);
    const ok = await s.agent.put(`${base}/spf`).set(h).send({ content: 'v=spf1 include:_spf.google.com include:sendgrid.net ~all', expectedContent: 'v=spf1 include:_spf.google.com ~all' });
    expect(ok.status).toBe(200);
    expect(fakes.cloudflare.records.find((r) => r.id === 'spf')!.content).toContain('sendgrid');
    expect(fakes.cloudflare.records.find((r) => r.id === 'www')!.content).toBe('ourco.com'); // untouched
    expect((await s.agent.put(`${base}/ns1`).set(h).send({ content: 'evil.ns', expectedContent: 'ns1.cloudflare.com' })).status).toBe(403);
    expect((await s.agent.put(`${base}/other`).set(h).send({ content: 'y', expectedContent: 'x' })).status).toBe(404); // outside the domain
    const audit = await db().auditLog.findFirstOrThrow({ where: { workspaceId: s.workspaceId, action: 'domain.dns_record_updated' } });
    expect(audit.metadata).toMatchObject({ before: 'v=spf1 include:_spf.google.com ~all' });
  });

  it('deletes only after the exact record name is typed; other tenants cannot reach the zone', async () => {
    const { s, base } = await dnsSetup();
    const h = { 'x-csrf-token': s.csrf };
    expect((await s.agent.delete(`${base}/www`).set(h).send({ confirmName: 'www', expectedContent: 'ourco.com' })).status).toBe(400);
    expect((await s.agent.delete(`${base}/www`).set(h).send({ confirmName: 'www.ourco.com', expectedContent: 'ourco.com' })).status).toBe(200);
    expect(fakes.cloudflare.records.map((r) => r.id).sort()).toEqual(['ns1', 'other', 'spf']);
    const other = await createUserSession('other@y.com');
    expect((await other.agent.get(base)).status).toBe(404);
    const viewer = await createUserSession('viewer@x.com', 'VIEWER', s.workspaceId);
    expect((await viewer.agent.get(base)).status).toBe(403);
  });
});

describe('concurrency', () => {
  it('leads from the same company created at the same moment all succeed (no duplicate company, no 409)', async () => {
    const s = await createUserSession('race@x.com');
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => s.agent.post(`/api/v1/w/${s.workspaceId}/leads`).set('x-csrf-token', s.csrf).send({ email: `p${i}@samecorp.example`, companyName: 'Same Corp' })));
    expect(rs.map((r) => r.status)).toEqual(Array(12).fill(201));
    expect(await db().company.count({ where: { workspaceId: s.workspaceId, domain: 'samecorp.example' } })).toBe(1);
  });
});

describe('operations', () => {
  it('live stream is closed for an organization being deleted', async () => {
    const s = await createUserSession('sse@x.com');
    await db().organization.update({ where: { id: s.organizationId }, data: { status: 'DELETION_PENDING' } });
    expect((await s.agent.get(`/api/v1/w/${s.workspaceId}/events`)).status).toBe(403);
  });

  it('Prometheus metrics are off without a token and need the exact bearer token', async () => {
    expect((await request(getApp()).get('/metrics')).status).toBe(404);
    process.env.METRICS_TOKEN = 'metrics-token-long-enough';
    expect((await request(getApp()).get('/metrics').set('authorization', 'Bearer wrong-token-long-enough')).status).toBe(404);
    const r = await request(getApp()).get('/metrics').set('authorization', 'Bearer metrics-token-long-enough');
    expect(r.status).toBe(200);
    expect(r.text).toContain('emn_database_up 1');
    expect(r.text).toMatch(/emn_queue_jobs\{queue="send",state="waiting"\} \d+/);
  });

  it('readiness never exposes internal error details', async () => {
    const r = await request(getApp()).get('/readyz');
    expect(r.body).toEqual({ ok: true, checks: { database: 'ok', redis: 'ok' } });
  });

  it('operations console is staff-only; retry needs a reason and lifecycle permission', async () => {
    const owner = await createUserSession('own@x.com');
    expect((await owner.agent.get('/api/v1/platform/operations')).status).toBe(404);
    const u = await db().user.create({ data: { email: 'fin@emn.test', name: 'Fin', passwordHash: await hashPassword('CorrectHorse123!'), platformRole: 'FINANCE' } });
    const agent = request.agent(getApp());
    const l = await agent.post('/api/v1/auth/login').send({ email: 'fin@emn.test', password: 'CorrectHorse123!' });
    await db().user.update({ where: { id: u.id }, data: { mfaEnabled: true } });
    const ops = await agent.get('/api/v1/platform/operations');
    expect(ops.status).toBe(200);
    expect(ops.body.queues.length).toBeGreaterThan(10);
    expect((await agent.post('/api/v1/platform/operations/retry').set('x-csrf-token', l.body.csrfToken).send({ queue: 'send', jobId: 'x', reason: 'try again' })).status).toBe(404); // FINANCE lacks lifecycle
  });

  it('a hung job is cut off by its timeout so the worker slot is freed', async () => {
    await expect(withTimeout(new Promise(() => undefined), 50, 'ai/ai.qualify')).rejects.toBeInstanceOf(JobTimeoutError);
    await expect(withTimeout(Promise.resolve(7), 50, 'x')).resolves.toBe(7);
  });
});
