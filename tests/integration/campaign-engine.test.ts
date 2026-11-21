import { beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../../backend/src/services/workspace.js';
import { db } from '../../backend/src/core/db.js';
import * as engine from '../../backend/src/services/engine.js';
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
    expect((await db().outboundEmail.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('SENDING');
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
    expect(final.status).toBe('FAILED');
    expect(final.lastError).toMatch(/not retried to avoid a duplicate/);
  });

  it('resends after a failure that never reached the provider, and fails permanently on 4xx', async () => {
    const s = await createUserSession('owner@x.com');
    const { campaignId } = await setupCampaign(s, { leads: 2 });
    await approveAndStart(s, campaignId);
    await engine.tick(MONDAY_10_UTC);
    for (const o of await db().outboundEmail.findMany({ where: { status: 'PENDING' } })) await engine.prepareOutbound(o.workspaceId, o.id);
    const [a, b] = await db().outboundEmail.findMany({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' } });
    fakes.gmail.failBeforeSend = new ProviderError('gmail', 'HTTP 503', 503, true);
    await expect(engine.sendOutbound(a.workspaceId, a.id, MONDAY_10_UTC)).rejects.toThrow();
    expect((await engine.sendOutbound(a.workspaceId, a.id, new Date(MONDAY_10_UTC.getTime() + 60_000))).outcome).toBe('sent');
    fakes.gmail.failBeforeSend = new ProviderError('gmail', 'HTTP 400 invalid recipient', 400, false);
    expect((await engine.sendOutbound(b.workspaceId, b.id, new Date(MONDAY_10_UTC.getTime() + 120_000))).outcome).toBe('failed');
    expect(fakes.gmail.sent).toHaveLength(1);
  });
});

describe('AI personalization in the send pipeline', () => {
  it('requires review for AI content and blocks approval when the fact-check fails', async () => {
    const s = await createUserSession('owner@x.com');
    await addAiProvider(s.workspaceId);
    const ai = fakes.anthropic as FakeAi;
    ai.on('EMAIL_WRITING', () => ({ subject: null, firstLine: 'Loved your recent award-winning episode.', body: null, usedClaimIds: [] }));
    ai.on('FACT_CHECK', (req) => ({ sentences: [{ text: 'Loved your recent award-winning episode.', verdict: req.user.includes('award') ? 'UNSUPPORTED' : 'GENERIC', claimId: null, reason: 'no claim supports an award' }] }));
    const { campaignId, h } = await setupCampaign(s, { steps: [{ delayDays: 0, personalizationMode: 'AI_FIRST_LINE', variants: [{ label: 'A', subject: 'Hi {{firstName}}', body: '{{aiFirstLine}}\n\nQuick idea for you.' }] }], settings: { reviewMode: 'AI_CONTENT_ONLY', usePregeneratedAi: false } });
    await approveAndStart(s, campaignId);
    await engine.tick(MONDAY_10_UTC);
    const p = await db().outboundEmail.findFirstOrThrow({ where: { status: 'PENDING' } });
    await engine.prepareOutbound(p.workspaceId, p.id);
    const prepared = await db().outboundEmail.findUniqueOrThrow({ where: { id: p.id } });
    expect(prepared.status).toBe('AWAITING_APPROVAL');
    expect(prepared.factCheckStatus).toBe('FAILED');
    // Approving unchanged content is refused
    const r1 = await s.agent.post(`/api/v1/w/${s.workspaceId}/outbound/${p.id}/review`).set(h).send({ decision: 'approve' });
    expect(r1.body.error.code).toBe('FACT_CHECK_FAILED');
    // Human removes the unverifiable claim → re-check passes → queued and sent
    const r2 = await s.agent.post(`/api/v1/w/${s.workspaceId}/outbound/${p.id}/review`).set(h).send({ decision: 'approve', bodyText: prepared.bodyText!.replace('Loved your recent award-winning episode.', 'Hope your week is going well.') });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect((await engine.sendOutbound(p.workspaceId, p.id, MONDAY_10_UTC)).outcome).toBe('sent');
    expect(fakes.gmail.sent[0].text).not.toMatch(/award/);
  });
});
