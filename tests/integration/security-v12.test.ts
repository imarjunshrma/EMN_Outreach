import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../../backend/src/core/db.js';
import { setSystemMailerForTests, type SystemMail } from '../../backend/src/core/mailer.js';
import { hotp, verifyTotp, base32Decode, base32Encode } from '../../backend/src/core/totp.js';
import { resetDb, installFakes, createUserSession, getApp } from '../helpers/harness.js';

const outbox: SystemMail[] = [];
beforeEach(async () => { await resetDb(); installFakes(); outbox.length = 0; setSystemMailerForTests({ configured: true, send: async (m) => { outbox.push(m); } }); });
const totpNow = (secret: string, offset = 0) => hotp(secret, Math.floor(Date.now() / 30_000) + offset);

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC 6238 SHA-1 test vectors and base32 round-trips', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    // RFC 6238 Appendix B, T=59s → 94287082 (8 digits); 6-digit truncation = 287082
    expect(hotp(secret, Math.floor(59 / 30))).toBe('287082');
    expect(hotp(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(verifyTotp(secret, '287082', 59_000)).toBe(1);
    expect(verifyTotp(secret, '000000', 59_000)).toBeNull();
  });
});

describe('two-factor login', () => {
  it('requires the second factor, blocks replay, supports single-use recovery codes and disabling', async () => {
    const s = await createUserSession('mfa@x.com');
    const h = { 'x-csrf-token': s.csrf };
    const setup = await s.agent.post('/api/v1/auth/mfa/setup').set(h);
    expect(setup.status).toBe(200);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect((await s.agent.post('/api/v1/auth/mfa/enable').set(h).send({ code: '000000' })).body.error.code).toBe('INVALID_CODE');
    const en = await s.agent.post('/api/v1/auth/mfa/enable').set(h).send({ code: totpNow(setup.body.secret) });
    expect(en.status).toBe(200);
    expect(en.body.recoveryCodes).toHaveLength(10);
    const stored = await db().user.findUniqueOrThrow({ where: { email: 'mfa@x.com' } });
    expect(stored.mfaSecretEnc).not.toContain(setup.body.secret); // encrypted at rest
    // Password alone no longer creates a session
    const app = request(getApp());
    const l1 = await app.post('/api/v1/auth/login').send({ email: 'mfa@x.com', password: 'CorrectHorse123!' });
    expect(l1.body.mfaRequired).toBe(true);
    expect(l1.headers['set-cookie']).toBeUndefined();
    expect((await app.post('/api/v1/auth/mfa/verify').send({ challenge: l1.body.challenge, code: '123456' })).status).toBe(401);
    // Recovery code works once
    const rc = en.body.recoveryCodes[0];
    const ok = await app.post('/api/v1/auth/mfa/verify').send({ challenge: l1.body.challenge, code: rc });
    expect(ok.status).toBe(200);
    expect(String(ok.headers['set-cookie'])).toMatch(/emn_session=/);
    const l2 = await app.post('/api/v1/auth/login').send({ email: 'mfa@x.com', password: 'CorrectHorse123!' });
    expect((await app.post('/api/v1/auth/mfa/verify').send({ challenge: l2.body.challenge, code: rc })).status).toBe(401);
    // The challenge cannot be reused after success
    expect((await app.post('/api/v1/auth/mfa/verify').send({ challenge: l1.body.challenge, code: en.body.recoveryCodes[1] })).status).toBe(401);
    // Disable needs password + factor
    const d = await s.agent.post('/api/v1/auth/mfa/disable').set(h).send({ password: 'CorrectHorse123!', code: en.body.recoveryCodes[2] });
    expect(d.body.enabled).toBe(false);
    expect(outbox.map((m) => m.subject)).toEqual(expect.arrayContaining(['Two-factor authentication enabled', 'Two-factor authentication disabled']));
  });

  it('enforces a workspace MFA policy', async () => {
    const s = await createUserSession('o@x.com');
    const ws = await db().workspace.findUniqueOrThrow({ where: { id: s.workspaceId } });
    await db().workspace.update({ where: { id: s.workspaceId }, data: { settings: { ...(ws.settings as object), requireMfa: true } } });
    const r = await s.agent.get(`/api/v1/w/${s.workspaceId}/leads`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MFA_REQUIRED');
    expect((await s.agent.get('/api/v1/auth/mfa')).status).toBe(200); // account pages still reachable
  });
});

describe('password reset by email', () => {
  it('sends a single-use link, does not reveal unknown accounts, and signs out all sessions', async () => {
    const s = await createUserSession('reset@x.com');
    const app = request(getApp());
    const unknown = await app.post('/api/v1/auth/password/forgot').send({ email: 'nobody@x.com' });
    const known = await app.post('/api/v1/auth/password/forgot').send({ email: 'reset@x.com' });
    expect(unknown.body.message).toBe(known.body.message);
    expect(outbox).toHaveLength(1);
    const token = /reset-password\/([A-Za-z0-9_-]+)/.exec(outbox[0].text)![1];
    expect((await app.post('/api/v1/auth/password/reset').send({ token, password: 'short' })).status).toBe(400);
    expect((await app.post('/api/v1/auth/password/reset').send({ token, password: 'A-brand-new-passphrase-9' })).status).toBe(200);
    expect((await app.post('/api/v1/auth/password/reset').send({ token, password: 'Another-passphrase-123' })).body.error.code).toBe('INVALID_TOKEN');
    expect((await s.agent.get('/api/v1/auth/me')).status).toBe(401); // old session revoked
    expect((await app.post('/api/v1/auth/login').send({ email: 'reset@x.com', password: 'A-brand-new-passphrase-9' })).status).toBe(200);
  });
});

describe('API key scopes', () => {
  it('limits a scoped key to its tags and read/write level', async () => {
    const s = await createUserSession('k@x.com');
    const h = { 'x-csrf-token': s.csrf };
    const k = await s.agent.post(`/api/v1/w/${s.workspaceId}/api-keys`).set(h).send({ name: 'ro', role: 'MEMBER', scopes: ['leads:read'] });
    expect(k.status).toBe(201);
    const app = request(getApp());
    const auth = { authorization: `Bearer ${k.body.key ?? k.body.token ?? k.body.apiKey}` };
    expect((await app.get(`/api/v1/w/${s.workspaceId}/leads`).set(auth)).status).toBe(200);
    expect((await app.post(`/api/v1/w/${s.workspaceId}/leads`).set(auth).send({ email: 'a@b.com' })).status).toBe(403);
    expect((await app.get(`/api/v1/w/${s.workspaceId}/campaigns`).set(auth)).status).toBe(403);
  });
});
