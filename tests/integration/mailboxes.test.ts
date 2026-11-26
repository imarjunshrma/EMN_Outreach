import { sha256 } from '../../backend/src/core/crypto.js';
import { queue, QUEUES } from '../../backend/src/core/queues.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { db } from '../../backend/src/core/db.js';
import { ProviderError } from '../../integrations/src/http.js';
import { decryptSecret } from '../../backend/src/services/workspace.js';
import { getApp, resetDb, installFakes, createUserSession, addMailbox, addLead } from '../helpers/harness.js';

// Mailbox lifecycle through the API: OAuth connect (and its CSRF protection), settings and provider ceilings,
// pause/resume rules, connection tests, the self-addressed diagnostic, disconnect, and tenant/role boundaries.
// Providers are the test fakes: nothing reaches Google, Microsoft or an SMTP server.
let fakes: ReturnType<typeof installFakes>;
beforeEach(async () => { await resetDb(); fakes = installFakes(); process.env.APP_URL = 'http://app.test'; });

const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

describe('mailboxes', () => {
  it('OAuth: connects the mailbox, stores tokens encrypted, and the state works once', async () => {
    const s = await createUserSession('mb-owner@example.test');
    const start = await s.agent.post(`/api/v1/w/${s.workspaceId}/email-accounts/oauth/google`).set('x-csrf-token', s.csrf).send({});
    expect(start.status).toBe(200);
    const state = stateOf(start.body.url);
    const cb = await s.agent.get(`/api/v1/oauth/callback/google?code=c1&state=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe(`http://app.test/w/${s.workspaceId}/email-accounts?connected=sender%40ourco.com`);
    const acct = await db().emailAccount.findFirstOrThrow({ where: { workspaceId: s.workspaceId }, include: { credential: true } });
    expect(acct.status).toBe('CONNECTED');
    const encryptedRefreshToken = acct.credential?.encryptedRefreshToken;
    expect(encryptedRefreshToken).toMatch(/^v\d+:/);
    expect(decryptSecret(encryptedRefreshToken!)).toBe('rt');
    const list = await s.agent.get(`/api/v1/w/${s.workspaceId}/email-accounts`);
    expect(JSON.stringify(list.body)).not.toMatch(/encrypted|refreshToken|accessToken/i); // tokens never leave the server
    // Replaying the same state fails.
    const again = await s.agent.get(`/api/v1/oauth/callback/google?code=c1&state=${state}`);
    expect(again.headers.location).toMatch(/\/oauth-error\?message=OAuth%20session%20expired/);
  });

  it('OAuth: a consent link started by someone else cannot attach your mailbox to their workspace', async () => {
    const attacker = await createUserSession('mb-attacker@example.test');
    const victim = await createUserSession('mb-victim@example.test');
    const start = await attacker.agent.post(`/api/v1/w/${attacker.workspaceId}/email-accounts/oauth/google`).set('x-csrf-token', attacker.csrf).send({});
    const state = stateOf(start.body.url);
    // The victim opens the attacker's link, approves, and is redirected back while signed in as themselves.
    const cb = await victim.agent.get(`/api/v1/oauth/callback/google?code=c1&state=${state}`);
    expect(cb.headers.location).toMatch(/\/oauth-error\?message=Finish%20the%20connection/);
    expect(await db().emailAccount.count()).toBe(0);
    // Not signed in at all: also refused.
    const start2 = await attacker.agent.post(`/api/v1/w/${attacker.workspaceId}/email-accounts/oauth/google`).set('x-csrf-token', attacker.csrf).send({});
    const anon = await request(getApp()).get(`/api/v1/oauth/callback/google?code=c1&state=${stateOf(start2.body.url)}`);
    expect(anon.headers.location).toMatch(/oauth-error/);
    expect(await db().emailAccount.count()).toBe(0);
    // Wrong provider for the state.
    const start3 = await attacker.agent.post(`/api/v1/w/${attacker.workspaceId}/email-accounts/oauth/google`).set('x-csrf-token', attacker.csrf).send({});
    const wrong = await attacker.agent.get(`/api/v1/oauth/callback/microsoft?code=c1&state=${stateOf(start3.body.url)}`);
    expect(wrong.headers.location).toMatch(/Provider%20mismatch/);
  });

  it('settings: provider ceiling, readiness ramp, and sending window are validated', async () => {
    const s = await createUserSession('mb-owner@example.test');
    const a = await addMailbox(s.workspaceId);
    const url = `/api/v1/w/${s.workspaceId}/email-accounts/${a.id}`;
    expect((await s.agent.patch(url).set('x-csrf-token', s.csrf).send({ dailySendLimit: 5000 })).status).toBe(400); // above the schema maximum
    const ok = await s.agent.patch(url).set('x-csrf-token', s.csrf).send({ dailySendLimit: 40, displayName: 'Arjun', readiness: { enabled: true, initialDailyCap: 10, dailyIncrease: 5, reviewIntervalDays: 7 } });
    expect(ok.status).toBe(200);
    const row = await db().emailAccount.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.dailySendLimit).toBe(40);
    expect((row.connectionConfig as { readiness: { currentDailyCap: number; status: string } }).readiness).toMatchObject({ currentDailyCap: 10, status: 'OBSERVING' });
    expect((await s.agent.patch(url).set('x-csrf-token', s.csrf).send({ minSecondsBetweenSends: 5 })).status).toBe(400);
  });

  it('pause and resume follow the status rules, and a paused mailbox stays paused after a connection test', async () => {
    const s = await createUserSession('mb-owner@example.test');
    const a = await addMailbox(s.workspaceId);
    const base = `/api/v1/w/${s.workspaceId}/email-accounts/${a.id}`;
    expect((await s.agent.post(`${base}/resume`).set('x-csrf-token', s.csrf).send({})).status).toBe(409); // not paused
    expect((await s.agent.post(`${base}/pause`).set('x-csrf-token', s.csrf).send({})).body.status).toBe('PAUSED');
    const t = await s.agent.post(`${base}/test`).set('x-csrf-token', s.csrf).send({});
    expect(t.body.ok).toBe(true);
    expect((await db().emailAccount.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('PAUSED');
    expect((await s.agent.post(`${base}/resume`).set('x-csrf-token', s.csrf).send({})).body.status).toBe('CONNECTED');
  });

  it('allows an operator hold during an auth error, preserves it through reconnect, and resumes once', async () => {
    const s = await createUserSession('operator-hold@example.test');
    const mailbox = await addMailbox(s.workspaceId, 'sender@ourco.com', 'GMAIL', { status: 'NEEDS_REAUTH' });
    const auth = { 'x-csrf-token': s.csrf };
    const root = `/api/v1/w/${s.workspaceId}/email-accounts`;
    const base = `${root}/${mailbox.id}`;
    expect((await s.agent.post(`${base}/pause`).set(auth).send({})).body).toMatchObject({ operatorPaused: true, status: 'NEEDS_REAUTH' });
    expect((await s.agent.post(`${base}/test`).set(auth).send({})).body.ok).toBe(false);
    expect((await s.agent.post(`${base}/resume`).set(auth).send({})).status).toBe(409);
    const start = await s.agent.post(`${root}/oauth/google`).set(auth).send({});
    const callback = await s.agent.get(`/api/v1/oauth/callback/google?code=c1&state=${stateOf(start.body.url)}`);
    expect(callback.headers.location).toContain(`/w/${s.workspaceId}/email-accounts?connected=`);
    expect(await db().emailAccount.findUnique({ where: { id: mailbox.id } })).toMatchObject({ operatorPaused: true, status: 'PAUSED' });
    const results = await Promise.all([s.agent.post(`${base}/resume`).set(auth).send({}), s.agent.post(`${base}/resume`).set(auth).send({})]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await db().emailAccount.findUnique({ where: { id: mailbox.id } })).toMatchObject({ operatorPaused: false, status: 'CONNECTED' });
  });

  it('accepts verified Graph change notifications and coalesces their replay', async () => {
    const s = await createUserSession('graph-replay@fixture.example');
    const account = await addMailbox(s.workspaceId, 'graph@fixture.example', 'MICROSOFT', {
      subscriptionId: 'fixture-graph-subscription', subscriptionSecretHash: sha256('fixture-client-state'),
    });
    const hook = () => request(getApp()).post('/api/v1/webhooks/graph');
    expect((await hook().send({ value: [{ subscriptionId: 'fixture-graph-subscription', clientState: 'invalid' }] })).status).toBe(202);
    expect((await queue(QUEUES.sync).getJobs(['waiting'])).filter(job => job.data.accountId === account.id)).toHaveLength(0);
    const valid = { subscriptionId: 'fixture-graph-subscription', clientState: 'fixture-client-state' };
    const replays = await Promise.all([hook().send({ value: [valid, valid] }), hook().send({ value: [valid] })]);
    expect(replays.map(response => response.status)).toEqual([202, 202]);
    expect((await queue(QUEUES.sync).getJobs(['waiting'])).filter(job => job.data.accountId === account.id)).toHaveLength(1);
  });

  it('blocks resume during an automatic cooldown and checks connectivity afterwards', async () => {
    const s = await createUserSession('mailbox-cooldown@fixture.example');
    const account = await addMailbox(s.workspaceId, 'cooldown@fixture.example', 'GMAIL', { status: 'PAUSED', autoPauseUntil: new Date(Date.now() + 60_000) });
    const { setPaused } = await import('../../backend/src/services/accounts.js');
    await expect(setPaused(s.workspaceId, account.id, false, { type: 'SYSTEM' })).rejects.toMatchObject({ code: 'MAILBOX_COOLDOWN' });
    await db().emailAccount.update({ where: { id: account.id }, data: { autoPauseUntil: new Date(0) } });
    await expect(setPaused(s.workspaceId, account.id, false, { type: 'SYSTEM' })).resolves.toMatchObject({ status: 'CONNECTED', autoPauseUntil: null });
  });

  it('holds a mailbox after cooldown while its hard-bounce rate remains unsafe', async () => {
    const s = await createUserSession('mailbox-bounce-recovery@fixture.example');
    const account = await addMailbox(s.workspaceId, 'bounce@fixture.example', 'GMAIL', {
      status: 'PAUSED', autoPauseUntil: new Date(0),
      sendingWindow: { bouncePauseRatePct: 20, bounceMinimumSends: 5, bounceWindowDays: 7 },
    });
    await db().workspace.update({ where: { id: s.workspaceId }, data: { settings: { mailboxAutoPauseMinSends: 10 } } });
    const event = { workspaceId: s.workspaceId, emailAccountId: account.id };
    await db().emailEvent.createMany({ data: [
      ...Array.from({ length: 5 }, () => ({ ...event, type: 'SENT' as const })),
      { ...event, type: 'BOUNCED_HARD' },
    ] });
    const { setPaused } = await import('../../backend/src/services/accounts.js');
    await expect(setPaused(s.workspaceId, account.id, false, { type: 'SYSTEM' })).rejects.toMatchObject({ code: 'MAILBOX_REPUTATION_RISK' });
    expect((await db().emailAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe('PAUSED');
  });

  it('a revoked provider grant marks the mailbox for reconnection without leaking the provider error', async () => {
    const s = await createUserSession('mb-owner@example.test');
    const a = await addMailbox(s.workspaceId);
    vi.spyOn(fakes.gmail, 'testConnection').mockRejectedValueOnce(new ProviderError('gmail', 'invalid_grant: Token has been expired or revoked. secret-detail', 401));
    const t = await s.agent.post(`/api/v1/w/${s.workspaceId}/email-accounts/${a.id}/test`).set('x-csrf-token', s.csrf).send({});
    expect(t.body.ok).toBe(false);
    expect(t.body.error).not.toContain('secret-detail');
    expect((await db().emailAccount.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('NEEDS_REAUTH');
  });

  it('the delivery diagnostic is only ever addressed to the mailbox itself', async () => {
    const s = await createUserSession('mb-owner@example.test');
    const a = await addMailbox(s.workspaceId);
    const r = await s.agent.post(`/api/v1/w/${s.workspaceId}/email-accounts/${a.id}/delivery-diagnostic`).set('x-csrf-token', s.csrf).send({ to: 'someone-else@example.com' });
    expect(r.status).toBeLessThan(300);
    expect(fakes.gmail.sent).toHaveLength(1);
    expect(fakes.gmail.sent[0].to).toBe(a.emailAddress);
    expect(fakes.gmail.sent[0].headers['X-EMN-Mailbox-Diagnostic']).toBe('1');
  });

  it('disconnect deletes credentials and pauses active sequences that used the mailbox', async () => {
    const s = await createUserSession('mb-owner@example.test');
    const a = await addMailbox(s.workspaceId);
    const lead = await addLead(s.workspaceId, 'lead@prospect.test');
    const camp = await db().campaign.create({ data: { workspaceId: s.workspaceId, name: 'C', sendingWindow: {} } });
    await db().sequenceEnrollment.create({ data: { workspaceId: s.workspaceId, campaignId: camp.id, leadId: lead.id, emailAccountId: a.id, variantSeed: 1, status: 'ACTIVE' } });
    const r = await s.agent.delete(`/api/v1/w/${s.workspaceId}/email-accounts/${a.id}`).set('x-csrf-token', s.csrf);
    expect(r.status).toBeLessThan(300);
    expect(await db().providerCredential.count({ where: { emailAccountId: a.id } })).toBe(0);
    expect((await db().emailAccount.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('DISCONNECTED');
    expect((await db().sequenceEnrollment.findFirstOrThrow({ where: { emailAccountId: a.id } })).status).toBe('PAUSED');
  });

  it('other workspaces get 404 and members below admin cannot manage mailboxes', async () => {
    const s = await createUserSession('mb-owner@example.test');
    const o = await createUserSession('mb-other@example.test');
    const member = await createUserSession('mb-member@example.test', 'MEMBER', s.workspaceId);
    const a = await addMailbox(s.workspaceId);
    expect((await o.agent.post(`/api/v1/w/${o.workspaceId}/email-accounts/${a.id}/pause`).set('x-csrf-token', o.csrf).send({})).status).toBe(404);
    expect((await o.agent.delete(`/api/v1/w/${o.workspaceId}/email-accounts/${a.id}`).set('x-csrf-token', o.csrf)).status).toBe(404);
    expect((await member.agent.delete(`/api/v1/w/${s.workspaceId}/email-accounts/${a.id}`).set('x-csrf-token', member.csrf)).status).toBe(403);
    expect((await member.agent.post(`/api/v1/w/${s.workspaceId}/email-accounts/oauth/google`).set('x-csrf-token', member.csrf).send({})).status).toBe(403);
    expect((await db().emailAccount.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('CONNECTED');
  });
});
