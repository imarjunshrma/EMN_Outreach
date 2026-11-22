import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { getApp, resetDb, installFakes, createUserSession } from '../helpers/harness.js';

// Baseline protections that must never regress: response headers, CSRF on cookie sessions,
// authentication on every workspace route, and errors that do not leak internals.
beforeEach(async () => { await resetDb(); installFakes(); });

describe('security baseline', () => {
  it('sends hardening headers and hides the framework', async () => {
    const r = await request(getApp()).get('/healthz');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('refuses state changes from a cookie session without the CSRF token', async () => {
    const s = await createUserSession('sec-owner@example.test');
    const without = await s.agent.post(`/api/v1/w/${s.workspaceId}/leads`).send({ email: 'x@y.test' });
    expect(without.status).toBe(403);
    const wrong = await s.agent.post(`/api/v1/w/${s.workspaceId}/leads`).set('x-csrf-token', 'not-the-token').send({ email: 'x@y.test' });
    expect(wrong.status).toBe(403);
    const right = await s.agent.post(`/api/v1/w/${s.workspaceId}/leads`).set('x-csrf-token', s.csrf).send({ email: 'x@y.test' });
    expect(right.status).toBeLessThan(300);
  });

  it('requires a session for workspace and platform routes, and hides the platform console from customers', async () => {
    const anon = request(getApp());
    const s = await createUserSession('sec-owner@example.test');
    expect((await anon.get(`/api/v1/w/${s.workspaceId}/leads`)).status).toBe(401);
    expect((await anon.get('/api/v1/platform/tenants')).status).toBe(401);
    expect((await s.agent.get('/api/v1/platform/tenants')).status).toBe(404); // customers cannot tell the console exists
    expect((await s.agent.get('/api/v1/platform/staff')).status).toBe(404);
  });

  it('returns structured errors without stack traces or SQL', async () => {
    const s = await createUserSession('sec-owner@example.test');
    // Malformed record IDs anywhere are a clean 404, never a database error (was a 500 on every :id route).
    for (const p of ['leads/not-a-uuid', 'campaigns/abc', 'workflows/1', 'email-verification/x', 'email-verification/batches/x/export.csv']) {
      const r = await s.agent.get(`/api/v1/w/${s.workspaceId}/${p}`);
      expect(r.status, p).toBe(404);
      expect(JSON.stringify(r.body)).not.toMatch(/at .*\.ts:\d+|prisma|SELECT |stack/i);
    }
    const del = await s.agent.delete(`/api/v1/w/${s.workspaceId}/leads/abc`).set('x-csrf-token', s.csrf);
    expect(del.status).toBe(404);
  });
});
