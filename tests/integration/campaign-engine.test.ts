import { beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../../backend/src/services/workspace.js';
import { db } from '../../backend/src/core/db.js';
import { bulkAction, BulkActionSchema } from '../../backend/src/services/leads.js';
import * as engine from '../../backend/src/services/engine.js';
import * as business from '../../backend/src/services/business-knowledge.js';
import * as personalization from '../../backend/src/services/personalization.js';
import { sha256 } from '../../backend/src/core/crypto.js';
import { ProviderError } from '../../integrations/src/http.js';
import { resetDb, installFakes, createUserSession, addMailbox, addLead, addAiProvider, MONDAY_10_UTC, type Session } from '../helpers/harness.js';
import type { FakeEmailProvider, FakeAi } from '../helpers/fakes.js';

let fakes: ReturnType<typeof installFakes>;
beforeEach(async () => { await resetDb(); fakes = installFakes(); });

const ALWAYS = { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' };

async function setupCampaign(s: Session, opts: { leads?: number; steps?: unknown[]; settings?: Record<string, unknown> } = {}) {
  const h = { 'x-csrf-token': s.csrf };
  const mailbox = await addMailbox(s.workspaceId);
  const list = await db().leadList.create({ data: { workspaceId: s.workspaceId, name: 'Targets' } });
  const leads = [];
  for (let i = 0; i < (opts.leads ?? 1); i++) {
    const l = await addLead(s.workspaceId, `lead${i}@client${i}.com`, { firstName: `Lead${i}`, timezone: 'UTC' });
    await db().leadListMember.create({ data: { workspaceId: s.workspaceId, listId: list.id, leadId: l.id } });
    leads.push(l);
  }
  const c = await s.agent.post(`/api/v1/w/${s.workspaceId}/campaigns`).set(h).send({ name: 'Podcast founders', sendingWindow: ALWAYS, reviewMode: 'NONE', ...(opts.settings ?? {}) });
  expect(c.status).toBe(201);
  const steps = opts.steps ?? [
    { delayDays: 0, variants: [{ label: 'A', subject: 'Idea for {{company.name|your show}}', body: 'Hi {{firstName}},\n\nQuick idea.\n\n{{sender.name}}' }, { label: 'B', subject: 'Question, {{firstName}}', body: 'Hi {{firstName}}, a question.' }] },
    { delayDays: 3, threadMode: 'REPLY_IN_THREAD', variants: [{ label: 'A', subject: '', body: 'Following up, {{firstName}}.' }] },
  ];
  expect((await s.agent.put(`/api/v1/w/${s.workspaceId}/campaigns/${c.body.id}/sequence`).set(h).send({ steps })).status).toBe(200);
  expect((await s.agent.put(`/api/v1/w/${s.workspaceId}/campaigns/${c.body.id}/lists`).set(h).send({ listIds: [list.id] })).status).toBe(200);
  expect((await s.agent.put(`/api/v1/w/${s.workspaceId}/campaigns/${c.body.id}/accounts`).set(h).send({ accountIds: [mailbox.id] })).status).toBe(200);
  return { campaignId: c.body.id as string, mailbox, list, leads, h };
}

async function approveAndStart(s: Session, campaignId: string) {
  const h = { 'x-csrf-token': s.csrf };
  const sub = await s.agent.post(`/api/v1/w/${s.workspaceId}/campaigns/${campaignId}/submit`).set(h);
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  expect((await s.agent.post(`/api/v1/w/${s.workspaceId}/campaigns/${campaignId}/approve`).set(h)).status).toBe(200);
  expect((await s.agent.post(`/api/v1/w/${s.workspaceId}/campaigns/${campaignId}/start`).set(h)).status).toBe(200);
}

/** Runs scheduler + prepare + send for everything due at `now`. */
async function runPipeline(now: Date) {
  await engine.tick(now);
  for (const o of await db().outboundEmail.findMany({ where: { status: 'PENDING' } })) await engine.prepareOutbound(o.workspaceId, o.id);
  const results = [];
  for (const o of await db().outboundEmail.findMany({ where: { status: 'QUEUED' } })) results.push(await engine.sendOutbound(o.workspaceId, o.id, now));
  return results;
}

describe('campaign lifecycle & approval', () => {
  it('blocks submission while required setup is missing', async () => {
    const s = await createUserSession('owner@x.com');
    await db().workspace.update({ where: { id: s.workspaceId }, data: { postalAddress: null } });
    const c = await s.agent.post(`/api/v1/w/${s.workspaceId}/campaigns`).set('x-csrf-token', s.csrf).send({ name: 'C' });
    const v = await s.agent.post(`/api/v1/w/${s.workspaceId}/campaigns/${c.body.id}/validate`).set('x-csrf-token', s.csrf);
    expect(v.body.blocking.join(' ')).toMatch(/lead list/);
    expect(v.body.blocking.join(' ')).toMatch(/mailbox/);
    expect(v.body.blocking.join(' ')).toMatch(/postal address/);
    const sub = await s.agent.post(`/api/v1/w/${s.workspaceId}/campaigns/${c.body.id}/submit`).set('x-csrf-token', s.csrf);
    expect(sub.body.error.code).toBe('CAMPAIGN_INVALID');
  });

  it('never sends an unapproved campaign; editing after approval stops sending until re-approved', async () => {
    const s = await createUserSession('owner@x.com');
    const { campaignId, h } = await setupCampaign(s);
    // Cannot start without approval
    expect((await s.agent.post(`/api/v1/w/${s.workspaceId}/campaigns/${campaignId}/start`).set(h)).status).toBe(409);
    await approveAndStart(s, campaignId);
    // Edit after approval → back to PENDING_APPROVAL, scheduler does nothing
    await s.agent.patch(`/api/v1/w/${s.workspaceId}/campaigns/${campaignId}`).set(h).send({ dailySendLimit: 99 });
    const c = await db().campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(c.status).toBe('PENDING_APPROVAL');
    await runPipeline(MONDAY_10_UTC);
    expect(fakes.gmail.sent).toHaveLength(0);
  });

  it('pauses automatically when content is changed behind the approval (hash mismatch)', async () => {
    const s = await createUserSession('owner@x.com');
    const { campaignId } = await setupCampaign(s);
    await approveAndStart(s, campaignId);
    await db().sequenceStepVariant.updateMany({ where: { workspaceId: s.workspaceId }, data: { body: 'tampered {{firstName}}' } });
    await engine.tick(MONDAY_10_UTC);
    const c = await db().campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(c.status).toBe('PAUSED');
    expect(c.pauseReason).toMatch(/content changed/);
    expect(fakes.gmail.sent).toHaveLength(0);
  });
});

describe('sending engine', () => {
  it('enrolls, renders, sends with compliance headers, threads follow-ups and schedules by delay', async () => {
    const s = await createUserSession('owner@x.com');
    const { campaignId, mailbox } = await setupCampaign(s);
    await approveAndStart(s, campaignId);
    const r = await runPipeline(MONDAY_10_UTC);
    expect(r.map((x) => x.outcome)).toEqual(['sent']);
    const sent = (fakes.gmail as FakeEmailProvider).sent[0];
    expect(sent.from.address).toBe(mailbox.emailAddress);
    expect(sent.to).toBe('lead0@client0.com');
    expect(sent.headers['List-Unsubscribe']).toMatch(/\/api\/v1\/public\/unsubscribe\//);
    expect(sent.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(sent.text).toMatch(/unsubscribe here: http:\/\/localhost:3000\/u\//);
    expect(sent.text).toContain('1 Test Street, Jaipur, India');
    expect(sent.text).not.toMatch(/\{\{/);
    const enr = await db().sequenceEnrollment.findFirstOrThrow({ where: { campaignId } });
    expect(enr.currentStepOrder).toBe(1);
    expect(enr.emailAccountId).toBe(mailbox.id);
    expect(enr.nextActionAt?.toISOString()).toBe('2026-11-26T10:00:00.000Z'); // +3 days
    expect((await db().lead.findUniqueOrThrow({ where: { id: enr.leadId } })).status).toBe('CONTACTED');
    expect(await db().emailEvent.count({ where: { type: 'SENT', campaignId } })).toBe(1);

    // Nothing more before the delay
    await runPipeline(new Date('2026-11-24T10:00:00Z'));
    expect(fakes.gmail.sent).toHaveLength(1);
    // Follow-up in the same thread, same fixed sender
    await runPipeline(new Date('2026-11-26T10:00:00Z'));
    expect(fakes.gmail.sent).toHaveLength(2);
    const fu = fakes.gmail.sent[1];
    expect(fu.inReplyTo).toBe(sent.messageId);
    expect(fu.references).toEqual([sent.messageId]);
    expect(fu.subject).toMatch(/^Re: /);
    expect(fu.from.address).toBe(mailbox.emailAddress);
    expect((await db().sequenceEnrollment.findFirstOrThrow({ where: { campaignId } })).status).toBe('COMPLETED');
  });

  it('respects recipient time zone windows, daily mailbox limits and campaign limits', async () => {
    const s = await createUserSession('owner@x.com');
    const { campaignId, mailbox } = await setupCampaign(s, { leads: 3, settings: { sendingWindow: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' } } });
    await db().emailAccount.update({ where: { id: mailbox.id }, data: { dailySendLimit: 2 } });
    await db().lead.updateMany({ where: { workspaceId: s.workspaceId }, data: { timezone: 'America/New_York' } });
    await approveAndStart(s, campaignId);
    // 10:00 UTC = 05:00 New York → enrolled, but first step is scheduled for 09:00 New York
    await runPipeline(MONDAY_10_UTC);
    expect(fakes.gmail.sent).toHaveLength(0);
    const enr = await db().sequenceEnrollment.findFirstOrThrow({ where: { campaignId } });
    expect(enr.nextActionAt?.toISOString()).toBe('2026-11-23T14:00:00.000Z');
    // A queued email outside the window is deferred, not sent
    // 15:00 UTC = 10:00 New York → only 2 (mailbox daily limit)
    const ok = new Date('2026-11-23T15:00:00Z');
    const results = await runPipeline(ok);
    expect(results.map((r) => r.outcome).sort()).toEqual(['deferred', 'sent', 'sent']);
    expect(fakes.gmail.sent).toHaveLength(2);
    const third = await db().outboundEmail.findFirstOrThrow({ where: { status: 'QUEUED' } });
    expect(third.lastError).toMatch(/daily limit/);
  });

  it('reserves mailbox spacing and the rolling hourly cap across queued sends', async () => {
    const s = await createUserSession('mailbox-slot@x.com');
    const { campaignId, mailbox } = await setupCampaign(s);
    await db().emailAccount.update({
      where: { id: mailbox.id },
      data: { minSecondsBetweenSends: 30, sendingWindow: { ...ALWAYS, enabled: false, timezone: 'UTC', hourlySendLimit: 1, maxSecondsBetweenSends: 75 } },
    });
    const secondCampaign = await engine.duplicateCampaign(s.workspaceId, campaignId, 'Second campaign', { type: 'SYSTEM' });
    const lead = await addLead(s.workspaceId, 'second-slot@client.com', { timezone: 'UTC' });
    const list = await db().leadList.create({
      data: { workspaceId: s.workspaceId, name: 'Second targets', members: { create: { workspaceId: s.workspaceId, leadId: lead.id } } },
    });
    await engine.setCampaignLists(s.workspaceId, secondCampaign.id, [list.id], { type: 'SYSTEM' });
    await approveAndStart(s, campaignId);
    await approveAndStart(s, secondCampaign.id);
    const now = MONDAY_10_UTC;
    await engine.tick(now);
    const rows = await db().outboundEmail.findMany({ where: { campaignId: { in: [campaignId, secondCampaign.id] }, status: 'PENDING' } });
    expect(new Set(rows.map(row => row.campaignId)).size).toBe(2);
    expect(rows).toHaveLength(2);
    for (const row of rows) await engine.prepareOutbound(s.workspaceId, row.id);
    await engine.sendOutbound(s.workspaceId, rows[0].id, now);
    expect(await engine.sendOutbound(s.workspaceId, rows[1].id, now)).toMatchObject({ outcome: 'deferred', detail: 'mailbox spacing between sends' });
    const held = await db().outboundEmail.findUniqueOrThrow({ where: { id: rows[1].id } });
    const gapMs = held.scheduledFor.getTime() - now.getTime();
    expect(gapMs).toBeGreaterThanOrEqual(30_000);
    expect(gapMs).toBeLessThanOrEqual(75_000);
    expect(await engine.sendOutbound(s.workspaceId, rows[1].id, held.scheduledFor)).toMatchObject({ outcome: 'deferred', detail: 'mailbox rolling hourly limit reached' });
    expect(fakes.gmail.sent).toHaveLength(1);
    expect(await engine.sendOutbound(s.workspaceId, rows[1].id, new Date(now.getTime() + 3600_001))).toMatchObject({ outcome: 'sent' });
    expect(fakes.gmail.sent).toHaveLength(2);
  });

  it('enforces the optional workspace-wide daily campaign send cap', async () => {
    const s = await createUserSession('workspace-cap@x.com');
    const { campaignId } = await setupCampaign(s, { leads: 3 });
    await db().workspace.update({ where: { id: s.workspaceId }, data: { settings: { dailyEmailSendLimit: 1 } } });
    await approveAndStart(s, campaignId);
    const results = await runPipeline(MONDAY_10_UTC);
    expect(results.map((r) => r.outcome).sort()).toEqual(['deferred', 'deferred', 'sent']);
    expect(fakes.gmail.sent).toHaveLength(1);
    expect(await db().outboundEmail.count({ where: { workspaceId: s.workspaceId, status: 'SENT' } })).toBe(1);
    expect(await db().outboundEmail.count({ where: { workspaceId: s.workspaceId, lastError: { contains: 'workspace daily send limit' } } })).toBe(2);
  });

  it('skips ineligible recipients (unverified, suppressed, blocked country) at enrollment and at send time', async () => {
    const s = await createUserSession('owner@x.com');
    const { campaignId, leads } = await setupCampaign(s, { leads: 4 });
    await db().lead.update({ where: { id: leads[0].id }, data: { emailVerificationStatus: 'UNVERIFIED' } });
    await db().lead.update({ where: { id: leads[1].id }, data: { country: 'CA' } }); // restricted by default
    await db().suppressionEntry.create({ data: { workspaceId: s.workspaceId, type: 'DOMAIN', value: 'client2.com', reason: 'MANUAL' } });
    await approveAndStart(s, campaignId);
    await engine.tick(MONDAY_10_UTC);
    const enrolled = await db().sequenceEnrollment.findMany({ where: { campaignId } });
    expect(enrolled.map((e) => e.leadId)).toEqual([leads[3].id]);
    // Suppressed after scheduling but before send → cancelled, not sent
    await engine.tick(MONDAY_10_UTC);
    for (const o of await db().outboundEmail.findMany({ where: { status: 'PENDING' } })) await engine.prepareOutbound(o.workspaceId, o.id);
    await db().suppressionEntry.create({ data: { workspaceId: s.workspaceId, type: 'EMAIL', value: leads[3].emailNormalized, reason: 'UNSUBSCRIBED' } });
    const o = await db().outboundEmail.findFirstOrThrow({ where: { status: 'QUEUED' } });
    expect((await engine.sendOutbound(o.workspaceId, o.id, MONDAY_10_UTC)).outcome).toBe('cancelled');
    expect(fakes.gmail.sent).toHaveLength(0);
  });

  it('auto-pauses a campaign when bounce rate exceeds its threshold', async () => {
    const s = await createUserSession('owner@x.com');
    const { campaignId } = await setupCampaign(s);
    await approveAndStart(s, campaignId);
    for (let i = 0; i < 20; i++) await db().emailEvent.create({ data: { workspaceId: s.workspaceId, type: 'SENT', campaignId, dedupeKey: `s${i}` } });
    for (let i = 0; i < 3; i++) await db().emailEvent.create({ data: { workspaceId: s.workspaceId, type: 'BOUNCED_HARD', campaignId, dedupeKey: `b${i}` } });
    await engine.tick(MONDAY_10_UTC);
    const c = await db().campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(c.status).toBe('PAUSED');
    expect(c.pauseReason).toMatch(/Bounce rate/);
  });

  it('assigns deterministic A/B variants by weight', () => {
    const v = [{ label: 'B', weight: 1 }, { label: 'A', weight: 3 }];
    const picks = [0, 1, 2, 3, 4, 5, 6, 7].map((seed) => engine.pickVariant(v, seed).label);
    expect(picks).toEqual(['A', 'A', 'A', 'B', 'A', 'A', 'A', 'B']);
  });
});

describe('duplicate-send prevention & crash recovery', () => {
  it('concurrent workers send exactly one email', async () => {
    const s = await createUserSession('owner@x.com');
    const { campaignId } = await setupCampaign(s);
    await approveAndStart(s, campaignId);
    await engine.tick(MONDAY_10_UTC);
    const p = await db().outboundEmail.findFirstOrThrow({ where: { status: 'PENDING' } });
    await engine.prepareOutbound(p.workspaceId, p.id);
    fakes.gmail.sendDelayMs = 50;
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => engine.sendOutbound(p.workspaceId, p.id, MONDAY_10_UTC)));
    expect(results.filter((r) => r.outcome === 'sent')).toHaveLength(1);
    expect(fakes.gmail.sent).toHaveLength(1);
    // A second scheduler pass does not create a second email for the same step
    await engine.tick(MONDAY_10_UTC);
    expect(await db().outboundEmail.count({ where: { campaignId } })).toBe(1);
  });

  it('reconciles a send that succeeded at the provider but failed before we recorded it', async () => {
    const s = await createUserSession('owner@x.com');
    const { campaignId } = await setupCampaign(s);
    await approveAndStart(s, campaignId);
    await engine.tick(MONDAY_10_UTC);
    const p = await db().outboundEmail.findFirstOrThrow({ where: { status: 'PENDING' } });
    await engine.prepareOutbound(p.workspaceId, p.id);
    fakes.gmail.failAfterAccept = true; // provider accepted, then the connection dropped
    await expect(engine.sendOutbound(p.workspaceId, p.id, MONDAY_10_UTC)).rejects.toThrow(/network/);
    expect((await db().outboundEmail.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('UNCERTAIN');
    // Retry (BullMQ) → reconciliation finds the sent copy instead of resending
    const retry = await engine.sendOutbound(p.workspaceId, p.id, new Date(MONDAY_10_UTC.getTime() + 60_000));
    expect(retry.outcome).toBe('reconciled');
    expect(fakes.gmail.sent).toHaveLength(1);
    const final = await db().outboundEmail.findUniqueOrThrow({ where: { id: p.id } });
    expect(final.status).toBe('SENT');
    expect(await db().emailEvent.count({ where: { type: 'SENT', outboundEmailId: p.id } })).toBe(1);
  });

  it('fails safe (no resend) when an interrupted SMTP send cannot be found in Sent', async () => {
    const s = await createUserSession('owner@x.com');
    const { campaignId } = await setupCampaign(s);
    await approveAndStart(s, campaignId);
    await engine.tick(MONDAY_10_UTC);
    const p = await db().outboundEmail.findFirstOrThrow({ where: { status: 'PENDING' } });
    await engine.prepareOutbound(p.workspaceId, p.id);
    fakes.gmail.failAfterAccept = true;
    await expect(engine.sendOutbound(p.workspaceId, p.id, MONDAY_10_UTC)).rejects.toThrow(/network/);
    // Same situation on an SMTP mailbox whose server kept no Sent copy
    await db().emailAccount.update({ where: { id: p.emailAccountId }, data: { provider: 'SMTP_IMAP', connectionConfig: { smtpHost: 'smtp.example.com', smtpPort: 587, imapHost: 'imap.example.com', imapPort: 993, username: 'u' }, credential: { update: { encryptedPassword: encryptSecret('pw') } } } });
    const before = fakes.smtp.sent.length;
    const retry = await engine.sendOutbound(p.workspaceId, p.id, new Date(MONDAY_10_UTC.getTime() + 180_000));
    expect(retry.outcome).toBe('cancelled');
    expect(fakes.smtp.sent.length).toBe(before);
    const final = await db().outboundEmail.findUniqueOrThrow({ where: { id: p.id } });
    expect(final.status).toBe('UNCERTAIN');
    expect(final.lastError).toMatch(/not retried to avoid a duplicate/);
  });

  it('never resubmits when Gmail submission is ambiguous and Sent lookup is empty', async () => {
    const s = await createUserSession('owner@x.com');
    const { campaignId } = await setupCampaign(s);
    await approveAndStart(s, campaignId);
    await engine.tick(MONDAY_10_UTC);
    const outbound = await db().outboundEmail.findFirstOrThrow({ where: { campaignId } });
    await engine.prepareOutbound(s.workspaceId, outbound.id);
    fakes.gmail.failBeforeSend = new ProviderError('gmail', 'Ambiguous gateway response', 503, true);
    await expect(engine.sendOutbound(s.workspaceId, outbound.id, MONDAY_10_UTC)).rejects.toThrow('Ambiguous gateway response');
    const later = new Date(MONDAY_10_UTC.getTime() + 180_000);
    await Promise.all([
      engine.sendOutbound(s.workspaceId, outbound.id, later),
      engine.sendOutbound(s.workspaceId, outbound.id, later),
    ]);
    expect(fakes.gmail.sent).toHaveLength(0);
    expect(await db().outboundEmail.findUniqueOrThrow({ where: { id: outbound.id } })).toMatchObject({ status: 'UNCERTAIN', attempts: 1 });
  });

  it('restricts uncertain decisions to workspace admins and never requeues a reviewed submission', async () => {
    const s = await createUserSession('reconcile-owner@fixture.example');
    const { campaignId } = await setupCampaign(s);
    await approveAndStart(s, campaignId);
    await engine.tick(MONDAY_10_UTC);
    const attempt = await db().outboundEmail.findFirstOrThrow({ where: { campaignId } });
    await engine.prepareOutbound(s.workspaceId, attempt.id);
    fakes.gmail.failBeforeSend = new ProviderError('gmail', 'Ambiguous gateway response', 503, true);
    await expect(engine.sendOutbound(s.workspaceId, attempt.id, MONDAY_10_UTC)).rejects.toThrow();
    const path = `/api/v1/w/${s.workspaceId}/outbound-reconciliation`;
    const review = (session: typeof s, decision: string, evidence?: string) => session.agent
      .post(`/api/v1/w/${session.workspaceId}/outbound-reconciliation/${attempt.id}`).set('x-csrf-token', session.csrf)
      .send({ decision, evidence, reason: 'Checked the provider submission history', confirmed: true });
    expect((await s.agent.get(path)).body.data[0]).toMatchObject({ id: attempt.id, attempts: 1 });
    const member = await createUserSession('reconcile-member@fixture.example', 'MEMBER', s.workspaceId);
    const outsider = await createUserSession('reconcile-outsider@fixture.example');
    expect((await review(member, 'MANUALLY_CLOSED')).status).toBe(403);
    expect((await review(outsider, 'MANUALLY_CLOSED')).status).toBe(404);
    expect((await review(s, 'CONFIRMED_ACCEPTED')).status).toBe(400);
    expect((await review(s, 'STILL_UNCERTAIN')).status).toBe(200);
    expect((await s.agent.get(path)).body.total).toBe(1);
    const concurrent = await Promise.all([
      review(s, 'CONFIRMED_NOT_SUBMITTED', 'Provider ticket TEST-123'),
      review(s, 'CONFIRMED_NOT_SUBMITTED', 'Provider ticket TEST-123'),
    ]);
    expect(concurrent.map(result => result.status).sort()).toEqual([200, 409]);
    expect((await s.agent.get(`${path}?resolved=true`)).body.data[0].reconciliation).toMatchObject({ reviewedBy: s.userId, decision: 'CONFIRMED_NOT_SUBMITTED' });
    expect((await engine.sendOutbound(s.workspaceId, attempt.id)).outcome).toBe('skipped');
    expect((await db().sequenceEnrollment.findUniqueOrThrow({ where: { id: attempt.enrollmentId } })).status).toBe('FAILED');
    expect(await db().emailEvent.count({ where: { outboundEmailId: attempt.id, type: 'SENT' } })).toBe(0);
    expect(fakes.gmail.sent).toHaveLength(0);
  });

  it('suppresses a confirmed nonexistent SMTP recipient without trying another mailbox', async () => {
    const s = await createUserSession('owner@x.com');
    const { campaignId } = await setupCampaign(s);
    await approveAndStart(s, campaignId);
    await engine.tick(MONDAY_10_UTC);
    const outbound = await db().outboundEmail.findFirstOrThrow({ where: { campaignId } });
    await engine.prepareOutbound(s.workspaceId, outbound.id);
    await db().emailAccount.update({ where: { id: outbound.emailAccountId }, data: {
      provider: 'SMTP_IMAP',
      connectionConfig: { smtpHost: 'smtp.example.com', smtpPort: 587, imapHost: 'imap.example.com', imapPort: 993, username: 'u' },
      credential: { update: { encryptedPassword: encryptSecret('pw') } },
    } });
    fakes.smtp.failBeforeSend = new ProviderError('smtp', 'SMTP rejected the recipient as nonexistent', 400, false, undefined, 'RECIPIENT_NOT_FOUND', 'PROVIDER_REJECTED');
    expect((await engine.sendOutbound(s.workspaceId, outbound.id, MONDAY_10_UTC)).outcome).toBe('failed');
    expect(await db().suppressionEntry.findFirst({ where: { workspaceId: s.workspaceId, value: outbound.toAddress } })).toMatchObject({ reason: 'HARD_BOUNCE' });
    expect(await db().sequenceEnrollment.findUniqueOrThrow({ where: { id: outbound.enrollmentId } })).toMatchObject({ status: 'STOPPED_BOUNCED' });
    expect(fakes.smtp.sent).toHaveLength(0);
    expect(fakes.gmail.sent).toHaveLength(0);
  });

  it('caps proven non-submission retries and keeps them in the mailbox health threshold', async () => {
    const s = await createUserSession('owner@x.com');
    const { campaignId } = await setupCampaign(s);
    await approveAndStart(s, campaignId);
    await engine.tick(MONDAY_10_UTC);
    const outbound = await db().outboundEmail.findFirstOrThrow({ where: { campaignId } });
    await engine.prepareOutbound(s.workspaceId, outbound.id);
    await db().outboundEmail.update({ where: { id: outbound.id }, data: { attempts: 4 } });
    fakes.gmail.failBeforeSend = new ProviderError('gmail', 'Synthetic failure before submission', 503, true, undefined, undefined, 'DEFINITELY_NOT_SENT');
    expect((await engine.sendOutbound(s.workspaceId, outbound.id, MONDAY_10_UTC)).outcome).toBe('failed');
    expect(await db().outboundEmail.findUniqueOrThrow({ where: { id: outbound.id } })).toMatchObject({ status: 'FAILED', attempts: 5 });
    expect(await db().emailAccount.findUniqueOrThrow({ where: { id: outbound.emailAccountId } })).toMatchObject({ status: 'PAUSED' });
    expect(fakes.gmail.sent).toHaveLength(0);
  });

  it('honors Retry-After and records submission decisions without provider payloads', async () => {
    const s = await createUserSession('owner@x.com');
    const { campaignId } = await setupCampaign(s);
    await approveAndStart(s, campaignId);
    await engine.tick(MONDAY_10_UTC);
    const outbound = await db().outboundEmail.findFirstOrThrow({ where: { campaignId } });
    await engine.prepareOutbound(s.workspaceId, outbound.id);
    fakes.gmail.failBeforeSend = new ProviderError('gmail', 'fixture payload marker', 429, true, 120_000);
    await expect(engine.sendOutbound(s.workspaceId, outbound.id, MONDAY_10_UTC)).rejects.toThrow();
    const decision = await db().auditLog.findFirstOrThrow({
      where: { workspaceId: s.workspaceId, entityId: outbound.id, action: 'outbound.submission_decision' },
    });
    expect(JSON.stringify(decision)).not.toContain('fixture payload marker');
    expect(decision.metadata).toMatchObject({ provider: 'GMAIL', campaignId, attempt: 1, submission: 'PROVIDER_REJECTED', retryDecision: 'SAME_MAILBOX', failoverDecision: 'DISABLED' });
    expect((await engine.sendOutbound(s.workspaceId, outbound.id, new Date(MONDAY_10_UTC.getTime() + 60_000))).outcome).toBe('deferred');
    expect(fakes.gmail.sent).toHaveLength(0);
    expect((await engine.sendOutbound(s.workspaceId, outbound.id, new Date(MONDAY_10_UTC.getTime() + 120_000))).outcome).toBe('sent');
  });

  it('resends after a failure that never reached the provider, and fails permanently on 4xx', async () => {
    const s = await createUserSession('owner@x.com');
    const { campaignId } = await setupCampaign(s, { leads: 2 });
    await approveAndStart(s, campaignId);
    await engine.tick(MONDAY_10_UTC);
    for (const o of await db().outboundEmail.findMany({ where: { status: 'PENDING' } })) await engine.prepareOutbound(o.workspaceId, o.id);
    const [a, b] = await db().outboundEmail.findMany({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' } });
    fakes.gmail.failBeforeSend = new ProviderError('gmail', 'Synthetic failure before submission', 503, true, undefined, undefined, 'DEFINITELY_NOT_SENT');
    await expect(engine.sendOutbound(a.workspaceId, a.id, MONDAY_10_UTC)).rejects.toThrow();
    expect((await engine.sendOutbound(a.workspaceId, a.id, new Date(MONDAY_10_UTC.getTime() + 60_000))).outcome).toBe('sent');
    fakes.gmail.failBeforeSend = new ProviderError('gmail', 'HTTP 400 invalid recipient', 400, false);
    expect((await engine.sendOutbound(b.workspaceId, b.id, new Date(MONDAY_10_UTC.getTime() + 120_000))).outcome).toBe('failed');
    expect(fakes.gmail.sent).toHaveLength(1);
  });
});

const fixtureActor = { type: 'SYSTEM' as const };
const supportedSignal = 'The company launched a weekly podcast about design.';

async function seedCampaignEvidence(workspaceId: string, campaignId: string, leads: Awaited<ReturnType<typeof setupCampaign>>['leads']) {
  const service = await business.createService(workspaceId, business.ServiceCreateSchema.parse({
    name: 'Content distribution', description: 'Turn original shows into short videos and distribute them.',
  }), fixtureActor);
  const version = service.versions[0];
  await expect(business.setCampaignServices(workspaceId, campaignId, [{ serviceVersionId: version.id }], fixtureActor)).rejects.toThrow();
  await business.approveServiceVersion(workspaceId, version.id, fixtureActor);
  await business.setCampaignServices(workspaceId, campaignId, [{ serviceVersionId: version.id }], fixtureActor);
  const icp = await db().idealCustomerProfile.create({ data: { workspaceId, name: 'Fixture ICP', criteria: {} } });
  const ids = [];
  for (const lead of leads) {
    const company = await db().company.create({ data: { workspaceId, name: `Fixture Studio ${lead.firstName}` } });
    await db().lead.update({ where: { id: lead.id }, data: { companyId: company.id, lastName: 'Example' } });
    const identity = `${lead.firstName} Example works at ${company.name}.`;
    const content = `${identity} ${supportedSignal}`;
    const report = await db().researchReport.create({ data: { workspaceId, leadId: lead.id, status: 'COMPLETED', completedAt: new Date() } });
    const source = await db().researchEvidence.create({ data: { workspaceId, reportId: report.id, sourceType: 'WEBSITE', url: 'https://fixture.example', content, contentHash: sha256(content) } });
    const identityClaim = await db().researchClaim.create({ data: { workspaceId, reportId: report.id, evidenceId: source.id, category: 'professional_identity', status: 'SUPPORTED', text: identity, quote: identity, confidence: 0.99 } });
    const claim = await db().researchClaim.create({ data: { workspaceId, reportId: report.id, evidenceId: source.id, category: 'signal', status: 'SUPPORTED', text: supportedSignal, quote: supportedSignal, confidence: 0.99 } });
    await db().leadScore.create({ data: { workspaceId, leadId: lead.id, icpId: icp.id, score: 90, tier: 'A', qualified: true, reasons: [{ criterion: 'professional_identity', met: true, identityStatus: 'VERIFIED', claimIds: [identityClaim.id] }] } });
    ids.push(claim.id);
  }
  return { serviceVersionId: version.id, claimIds: ids };
}

function writerFixture(serviceVersionId: string, claimId: string, body: string) {
  return {
    subject: 'An idea for your podcast', subjectAlternatives: [], openingLine: supportedSignal,
    body, cta: 'Would a short outline help?', usedClaimIds: [claimId], personalizationBasis: supportedSignal, insufficientContext: false,
    opportunityAnalysis: {
      qualification: 'POSSIBLE_FIT', businessModel: { statement: null, basis: 'UNKNOWN', claimIds: [] },
      facts: [{ statement: supportedSignal, claimId }], inferences: [], unknowns: [],
      opportunity: 'Repurpose existing episodes', serviceFit: 'Distribute short clips', serviceVersionId, serviceMatchClaimIds: [claimId],
      confidence: 0.9, missingInformation: [], recommendedApproach: 'Offer a short outline.',
    },
  };
}

describe('manual qualification review', () => {
  it('requires evidence and a current human review before a campaign with an ICP can enroll', async () => {
    const s = await createUserSession('qualification-review@fixture.example');
    const { campaignId, leads } = await setupCampaign(s);
    const review = BulkActionSchema.parse({ action: 'review_qualification', ids: [leads[0].id], review: 'QUALIFIED', reviewReason: 'Reviewed evidence against criteria.' });
    await expect(bulkAction(s.workspaceId, review, fixtureActor)).rejects.toMatchObject({ code: 'QUALIFICATION_REQUIRED' });
    await seedCampaignEvidence(s.workspaceId, campaignId, leads);
    const icp = await db().idealCustomerProfile.findFirstOrThrow({ where: { workspaceId: s.workspaceId } });
    await engine.updateCampaignAi(s.workspaceId, campaignId, { icpId: icp.id }, fixtureActor);
    expect((await engine.validateCampaign(s.workspaceId, campaignId)).recipients.eligible).toBe(0);
    await bulkAction(s.workspaceId, review, fixtureActor);
    expect((await engine.validateCampaign(s.workspaceId, campaignId)).recipients.eligible).toBe(1);
    await db().idealCustomerProfile.update({ where: { id: icp.id }, data: { updatedAt: new Date(Date.now() + 60_000), criteria: { mustHave: ['Changed criteria'] } } });
    expect((await engine.validateCampaign(s.workspaceId, campaignId)).recipients.eligible).toBe(0);
    await bulkAction(s.workspaceId, { ...review, review: 'DISQUALIFIED' }, fixtureActor);
    expect(await db().auditLog.count({ where: { workspaceId: s.workspaceId, action: 'lead.qualification_reviewed', entityId: leads[0].id } })).toBe(2);
    expect((await db().lead.findUniqueOrThrow({ where: { id: leads[0].id } })).qualificationReview).toBe('DISQUALIFIED');
  });
});

describe('AI personalization in the send pipeline', () => {
  it('requires review for AI content and blocks approval when the fact-check fails', async () => {
    const s = await createUserSession('owner@x.com');
    await addAiProvider(s.workspaceId);
    const ai = fakes.anthropic as FakeAi;
    const { campaignId, leads } = await setupCampaign(s, {
      steps: [{ delayDays: 0, personalizationMode: 'AI_FULL', variants: [{ label: 'A', subject: 'Hi {{firstName}}', body: 'Write a short and grounded introduction.' }] }],
      settings: { reviewMode: 'AI_CONTENT_ONLY', usePregeneratedAi: true },
    });
    expect((await engine.validateCampaign(s.workspaceId, campaignId)).blocking.join(' ')).toMatch(/approved EMN service/);
    await expect(engine.startCampaign(s.workspaceId, campaignId, fixtureActor)).rejects.toThrow();
    const { serviceVersionId, claimIds } = await seedCampaignEvidence(s.workspaceId, campaignId, leads);
    const [step] = (await engine.getCampaign(s.workspaceId, campaignId)).sequence!.steps;
    const unsafe = 'Hi there, Congrats on winning an award last month. Would a short outline help?';
    ai.on('PERSONALIZATION', () => writerFixture(serviceVersionId, claimIds[0], unsafe));
    ai.on('FACT_CHECK', req => {
      const unsupported = req.user.split('</untrusted_content>')[0].includes('winning an award');
      return { sentences: [{ text: unsupported ? 'Congrats on winning an award last month.' : supportedSignal, verdict: unsupported ? 'UNSUPPORTED' : 'SUPPORTED', claimId: unsupported ? null : claimIds[0], reason: unsupported ? 'Not in the source' : 'Backed by the source' }] };
    });
    const generated = await personalization.generateForLead(s.workspaceId, campaignId, leads[0].id, step.id);
    expect(generated.status).toBe('BLOCKED');
    await expect(personalization.approvePersonalizations(s.workspaceId, [generated.id!], fixtureActor)).rejects.toMatchObject({ code: 'QUALITY_CHECK_FAILED' });
    await approveAndStart(s, campaignId);
    await engine.tick(MONDAY_10_UTC);
    const outbound = await db().outboundEmail.findFirstOrThrow({ where: { campaignId } });
    await engine.prepareOutbound(s.workspaceId, outbound.id);
    expect(await db().outboundEmail.findUniqueOrThrow({ where: { id: outbound.id } })).toMatchObject({ status: 'AWAITING_APPROVAL' });
    expect((await engine.sendOutbound(s.workspaceId, outbound.id, MONDAY_10_UTC)).outcome).toBe('skipped');
    expect(fakes.gmail.sent).toHaveLength(0);

    const edited = await personalization.editPersonalization(s.workspaceId, generated.id!, {
      body: `Hi there,\n\n${supportedSignal} We help teams repurpose episodes into short videos and distribute them. Would a short outline help?`,
      rerunFactCheck: true, feedbackScope: 'CAMPAIGN',
    }, fixtureActor);
    expect(edited.status).toBe('GENERATED');
    expect((await personalization.approvePersonalizations(s.workspaceId, [generated.id!], fixtureActor)).approved).toBe(1);
    await engine.prepareOutbound(s.workspaceId, outbound.id);
    expect((await engine.sendOutbound(s.workspaceId, outbound.id, MONDAY_10_UTC)).outcome).toBe('sent');
    expect(fakes.gmail.sent[0].text).not.toMatch(/award/);
  });
});

describe('never sends an email without a message (the "Hi Test, … Best" incident)', () => {
  it('a new campaign cannot be submitted until step 1 is written', async () => {
    const s = await createUserSession('owner@x.com');
    const c = await s.agent.post(`/api/v1/w/${s.workspaceId}/campaigns`).set('x-csrf-token', s.csrf).send({ name: 'Starter' });
    const v = await s.agent.post(`/api/v1/w/${s.workspaceId}/campaigns/${c.body.id}/validate`).set('x-csrf-token', s.csrf);
    expect(v.body.blocking.join(' ')).toMatch(/Step 1 variant A: .*placeholder/);
    expect(v.body.blocking.join(' ')).not.toMatch(/Step [234] /); // the follow-up starters are real text
  });

  it('an empty or placeholder AI email fails instead of sending the template', async () => {
    const s = await createUserSession('owner@x.com');
    await addAiProvider(s.workspaceId);
    const ai = fakes.anthropic as FakeAi;
    const { campaignId, leads } = await setupCampaign(s, { leads: 2, steps: [
      { delayDays: 0, personalizationMode: 'AI_FULL', variants: [{ label: 'A', subject: 'Hi {{firstName}}', body: 'Write a grounded message.' }] },
    ], settings: { reviewMode: 'AI_CONTENT_ONLY', usePregeneratedAi: true } });
    const { serviceVersionId, claimIds } = await seedCampaignEvidence(s.workspaceId, campaignId, leads);
    const [step] = (await engine.getCampaign(s.workspaceId, campaignId)).sequence!.steps;
    ai.on('FACT_CHECK', () => ({ sentences: [] }));
    await approveAndStart(s, campaignId);
    await engine.tick(MONDAY_10_UTC);
    for (const [index, body] of ['', 'Hi Lead1,\n\n…\n\nBest,\nArjun'].entries()) {
      ai.on('PERSONALIZATION', () => writerFixture(serviceVersionId, claimIds[index], body));
      const generated = await personalization.generateForLead(s.workspaceId, campaignId, leads[index].id, step.id);
      expect(['FAILED', 'BLOCKED']).toContain(generated.status);
      await expect(personalization.approvePersonalizations(s.workspaceId, [generated.id!], fixtureActor)).rejects.toMatchObject({ code: 'QUALITY_CHECK_FAILED' });
      const outbound = await db().outboundEmail.findFirstOrThrow({ where: { campaignId, enrollment: { leadId: leads[index].id } } });
      await engine.prepareOutbound(s.workspaceId, outbound.id);
      expect(await db().outboundEmail.findUniqueOrThrow({ where: { id: outbound.id } })).toMatchObject({ status: 'AWAITING_APPROVAL' });
      expect((await engine.sendOutbound(s.workspaceId, outbound.id, MONDAY_10_UTC)).outcome).toBe('skipped');
    }
    expect(fakes.gmail.sent).toHaveLength(0);
  });
});
