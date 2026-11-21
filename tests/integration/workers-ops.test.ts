import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import { db } from '../../backend/src/core/db.js';
import { processorFor } from '../../worker/src/processors.js';
import { dispatch, createRule } from '../../backend/src/services/automation.js';
import { deliver, signWebhook } from '../../backend/src/services/webhooks.js';
import { encryptSecret } from '../../backend/src/services/workspace.js';
import { runDomainCheck, runRetention, processPrivacyRequest, createPrivacyRequest, handleBookingWebhook } from '../../backend/src/services/ops.js';
import { buildOpenApi } from '../../backend/src/http/openapi.js';
import { routes } from '../../backend/src/http/router.js';
import { hmac } from '../../backend/src/core/crypto.js';
import { resetDb, installFakes, createUserSession, addLead, addMailbox, getApp } from '../helpers/harness.js';
import { fakeDns } from '../helpers/fakes.js';

beforeEach(async () => { await resetDb(); installFakes(); });
const SYS = { type: 'SYSTEM' as const };
const job = (name: string, data: Record<string, unknown>) => ({ id: 'j1', name, data, attemptsMade: 0 }) as unknown as Job<Record<string, unknown>>;

describe('background workers', () => {
  it('runs mailbox sync through the registered BullMQ processor', async () => {
    const s = await createUserSession('sync-worker@example.test');
    const mailbox = await addMailbox(s.workspaceId);
    const result = await processorFor('mailbox-sync')(job('sync.account', { workspaceId: s.workspaceId, accountId: mailbox.id }));
    expect(result).toMatchObject({ inbound: 0, outbound: 0 });
    expect((await db().emailAccount.findUniqueOrThrow({ where: { id: mailbox.id } })).lastSyncedAt).toBeInstanceOf(Date);
    // sync.account is intentionally excluded from success JobRun rows because
    // it is a frequent polling job; lastSyncedAt proves the handler executed.
    expect(await db().jobRun.count({ where: { workspaceId: s.workspaceId, queue: 'mailbox-sync', status: 'FAILED' } })).toBe(0);
  });

  it('records successful and failed job runs and error logs', async () => {
    const s = await createUserSession('o@x.com');
    const domain = await db().domain.create({ data: { workspaceId: s.workspaceId, name: 'ourco.com', dkimSelectors: ['google'] } });
    fakeDns.records.set('ourco.com', [['v=spf1 include:_spf.google.com ~all']]);
    fakeDns.records.set('_dmarc.ourco.com', [['v=DMARC1; p=quarantine']]);
    fakeDns.records.set('google._domainkey.ourco.com', [['v=DKIM1; k=rsa; p=abc']]);
    fakeDns.mx.set('ourco.com', [{ exchange: 'aspmx.l.google.com', priority: 1 }]);
    await processorFor('domain-health')(job('domain.check', { workspaceId: s.workspaceId, domainId: domain.id }));
    expect((await db().domain.findUniqueOrThrow({ where: { id: domain.id } })).healthStatus).toBe('HEALTHY');
    expect(await db().jobRun.count({ where: { status: 'COMPLETED', queue: 'domain-health' } })).toBe(1);
    await expect(processorFor('import')(job('import.csv', { workspaceId: s.workspaceId, importId: '00000000-0000-0000-0000-000000000000' }))).resolves.toBeNull();
    await expect(processorFor('send')(job('nope', { workspaceId: s.workspaceId }))).rejects.toThrow(/No handler/);
    await expect(processorFor('privacy')(job('privacy.export', { workspaceId: 'not-a-uuid', requestId: 'x' }))).rejects.toThrow();
    expect(await db().jobRun.count({ where: { status: 'FAILED' } })).toBe(1);
    expect(await db().errorLog.count({ where: { source: 'worker' } })).toBe(1);
  });
});

describe('automation & webhooks', () => {
  it('runs rules once per event and executes actions', async () => {
    const s = await createUserSession('o@x.com');
    const lead = await addLead(s.workspaceId, 'hot@lead.com');
    const list = await db().leadList.create({ data: { workspaceId: s.workspaceId, name: 'Hot' } });
    await createRule(s.workspaceId, { name: 'Interested → task', isEnabled: true, trigger: 'reply.categorized', conditions: { categories: ['INTERESTED', 'WANTS_MEETING'] }, actions: [{ type: 'create_task', title: 'Call them', dueInDays: 0 }, { type: 'add_to_list', listId: list.id }, { type: 'create_opportunity', title: 'Deal', valueCents: 150000 }] }, SYS);
    await dispatch(s.workspaceId, 'reply.categorized', 'reply:1', { leadId: lead.id, category: 'NOT_INTERESTED' });
    expect(await db().task.count()).toBe(0);
    await dispatch(s.workspaceId, 'reply.categorized', 'reply:2', { leadId: lead.id, category: 'INTERESTED' });
    await dispatch(s.workspaceId, 'reply.categorized', 'reply:2', { leadId: lead.id, category: 'INTERESTED' }); // duplicate event
    expect(await db().task.count()).toBe(1);
    expect(await db().leadListMember.count({ where: { listId: list.id } })).toBe(1);
    expect(await db().opportunity.count()).toBe(1);
    expect((await db().automationRun.findFirstOrThrow()).status).toBe('COMPLETED');
  });

  it('delivers signed webhooks and records failures for retry', async () => {
    const s = await createUserSession('o@x.com');
    const hook = await db().webhook.create({ data: { workspaceId: s.workspaceId, name: 'crm', url: 'https://93.184.216.34/hook', encryptedSecret: encryptSecret('whsec_test'), events: ['email.sent'] } });
    const d = await db().webhookDelivery.create({ data: { workspaceId: s.workspaceId, webhookId: hook.id, event: 'email.sent', payload: { event: 'email.sent', data: { id: 1 } } } });
    let captured: { headers: Record<string, string>; body: string } | null = null;
    const ok = (async (_u: string, init: RequestInit) => { captured = { headers: init.headers as Record<string, string>, body: String(init.body) }; return new Response('ok'); }) as unknown as typeof fetch;
    await deliver(s.workspaceId, d.id, ok);
    expect((await db().webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('DELIVERED');
    const sig = captured!.headers['x-emn-signature'];
    const ts = sig.match(/t=(\d+)/)![1];
    expect(sig).toBe(signWebhook('whsec_test', ts, captured!.body));
    const d2 = await db().webhookDelivery.create({ data: { workspaceId: s.workspaceId, webhookId: hook.id, event: 'email.sent', payload: {} } });
    await expect(deliver(s.workspaceId, d2.id, (async () => new Response('no', { status: 500 })) as unknown as typeof fetch)).rejects.toThrow(/500/);
    expect((await db().webhook.findUniqueOrThrow({ where: { id: hook.id } })).failureCount).toBe(1);
  });

  it('rejects webhooks to private addresses', async () => {
    const s = await createUserSession('o@x.com');
    const r = await s.agent.post(`/api/v1/w/${s.workspaceId}/webhooks`).set('x-csrf-token', s.csrf).send({ name: 'x', url: 'http://127.0.0.1:9000/x', events: ['email.sent'] });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/private|port/);
    expect(await db().webhook.count()).toBe(0);
  });
});

describe('privacy, retention, booking', () => {
  it('exports and erases a data subject, keeping only a do-not-contact suppression', async () => {
    const s = await createUserSession('o@x.com');
    const lead = await addLead(s.workspaceId, 'subject@acme.io');
    await db().note.create({ data: { workspaceId: s.workspaceId, leadId: lead.id, body: 'personal note' } });
    const exp = await createPrivacyRequest(s.workspaceId, 'EXPORT', 'subject@acme.io', SYS);
    await processPrivacyRequest(s.workspaceId, exp.id);
    expect((await db().privacyRequest.findUniqueOrThrow({ where: { id: exp.id } })).resultStorageKey).toBeTruthy();
    const er = await createPrivacyRequest(s.workspaceId, 'ERASURE', 'subject@acme.io', SYS);
    await processPrivacyRequest(s.workspaceId, er.id);
    expect(await db().lead.count({ where: { emailNormalized: 'subject@acme.io' } })).toBe(0);
    expect(await db().note.count()).toBe(0);
    expect(await db().suppressionEntry.findFirst({ where: { value: 'subject@acme.io' } })).toMatchObject({ reason: 'DO_NOT_CONTACT_REQUEST' });
  });

  it('applies retention without touching recent data', async () => {
    const s = await createUserSession('o@x.com');
    await db().aiExecution.create({ data: { workspaceId: s.workspaceId, task: 'SUBJECT_LINES', provider: 'ANTHROPIC', model: 'm', status: 'SUCCEEDED', output: { a: 1 }, createdAt: new Date(Date.now() - 200 * 86400_000) } });
    await db().aiExecution.create({ data: { workspaceId: s.workspaceId, task: 'SUBJECT_LINES', provider: 'ANTHROPIC', model: 'm', status: 'SUCCEEDED', output: { a: 2 } } });
    const r = await runRetention();
    expect(r.aiOutputs).toBe(1);
    const kept = await db().aiExecution.findMany({ where: { workspaceId: s.workspaceId } });
    expect(kept.filter((k) => k.output !== null).map((k) => (k.output as { a: number }).a)).toEqual([2]);
  });

  it('keeps the audit log append-only except for retention pruning', async () => {
    const s = await createUserSession('audit@x.com');
    const old = await db().auditLog.create({ data: { workspaceId: s.workspaceId, actorType: 'SYSTEM', action: 'test.old', entityType: 'test', createdAt: new Date(Date.now() - 800 * 86400_000) } });
    const recent = await db().auditLog.create({ data: { workspaceId: s.workspaceId, actorType: 'SYSTEM', action: 'test.recent', entityType: 'test' } });
    await expect(db().auditLog.update({ where: { id: recent.id }, data: { action: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(db().auditLog.delete({ where: { id: recent.id } })).rejects.toThrow(/append-only/);
    const r = await runRetention();
    expect(r.auditLogs).toBeGreaterThanOrEqual(1);
    expect(await db().auditLog.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await db().auditLog.findUnique({ where: { id: recent.id } })).not.toBeNull();
    // the flag is transaction-local: a later plain delete is refused again
    await expect(db().auditLog.delete({ where: { id: recent.id } })).rejects.toThrow(/append-only/);
  });

  it('verifies booking webhook signatures and marks the lead MEETING_BOOKED', async () => {
    const s = await createUserSession('o@x.com');
    const lead = await addLead(s.workspaceId, 'meet@acme.io');
    await db().integration.create({ data: { workspaceId: s.workspaceId, type: 'booking', encryptedConfig: encryptSecret('booksecret') } });
    const body = JSON.stringify({ payload: { attendees: [{ email: 'meet@acme.io' }] } });
    await expect(handleBookingWebhook(s.workspaceId, body, 'bad')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await handleBookingWebhook(s.workspaceId, body, hmac('booksecret', body))).toEqual({ matched: 1 });
    expect((await db().lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('MEETING_BOOKED');
  });

  it('domain check reports issues for misconfigured DNS', async () => {
    const s = await createUserSession('o@x.com');
    const d = await db().domain.create({ data: { workspaceId: s.workspaceId, name: 'broken.io' } });
    const r = await runDomainCheck(s.workspaceId, d.id);
    expect(r?.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['SPF_MISSING', 'DMARC_MISSING', 'MX_MISSING']));
    expect((await db().domain.findUniqueOrThrow({ where: { id: d.id } })).healthStatus).toBe('CRITICAL');
  });
});

describe('API documentation', () => {
  it('documents every registered route in OpenAPI with auth, role and rate-limit info', () => {
    getApp();
    const doc = buildOpenApi(routes);
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p as Record<string, { summary: string; description: string }>));
    expect(ops.length).toBe(routes.length);
    expect(ops.every((o) => o.summary && /Authentication:/.test(o.description) && /Rate limit/.test(o.description))).toBe(true);
    expect(routes.length).toBeGreaterThan(120);
  });
});
