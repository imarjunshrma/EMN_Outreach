import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../../backend/src/core/db.js';
import * as engine from '../../backend/src/services/engine.js';
import { syncAccount } from '../../backend/src/services/accounts.js';
import { classifyMessage, heuristicClassify, sendReply } from '../../backend/src/services/inbox.js';
import { unsubscribeToken } from '../../backend/src/services/workspace.js';
import { parseRawMessage } from '../../integrations/src/email/mime.js';
import { getApp, resetDb, installFakes, createUserSession, addMailbox, addLead, addAiProvider, MONDAY_10_UTC } from '../helpers/harness.js';

let fakes: ReturnType<typeof installFakes>;
beforeEach(async () => { await resetDb(); fakes = installFakes(); });

async function sentCampaign(stopOnAutoReply = false) {
  const s = await createUserSession('owner@x.com');
  const mailbox = await addMailbox(s.workspaceId);
  const lead = await addLead(s.workspaceId, 'jane@acme.io');
  const list = await db().leadList.create({ data: { workspaceId: s.workspaceId, name: 'L', members: { create: { workspaceId: s.workspaceId, leadId: lead.id } } } });
  const c = await engine.createCampaign(s.workspaceId, engine.CampaignSettingsSchema.parse({ name: 'C', sendingWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' }, reviewMode: 'NONE', stopOnAutoReply }), { type: 'SYSTEM' });
  await engine.saveSequence(s.workspaceId, c.id, { steps: [
    { delayDays: 0, threadMode: 'NEW_THREAD', personalizationMode: 'TEMPLATE_ONLY', condition: 'ALWAYS', variants: [{ label: 'A', subject: 'Hello {{firstName}}', body: 'Hi {{firstName}}, a quick question about your site.', weight: 1 }] },
    { delayDays: 2, threadMode: 'REPLY_IN_THREAD', personalizationMode: 'TEMPLATE_ONLY', condition: 'ALWAYS', variants: [{ label: 'A', subject: '', body: 'Bump', weight: 1 }] },
  ] }, { type: 'SYSTEM' });
  await engine.setCampaignLists(s.workspaceId, c.id, [list.id], { type: 'SYSTEM' });
  await engine.setCampaignAccounts(s.workspaceId, c.id, [mailbox.id], { type: 'SYSTEM' });
  await engine.submitCampaign(s.workspaceId, c.id, { type: 'SYSTEM' });
  await engine.approveCampaign(s.workspaceId, c.id, { type: 'SYSTEM' });
  await engine.startCampaign(s.workspaceId, c.id, { type: 'SYSTEM' });
  await engine.tick(MONDAY_10_UTC);
  const o = await db().outboundEmail.findFirstOrThrow({ where: { campaignId: c.id } });
  await engine.prepareOutbound(s.workspaceId, o.id);
  expect((await engine.sendOutbound(s.workspaceId, o.id, MONDAY_10_UTC)).outcome).toBe('sent');
  return { s, mailbox, lead, campaignId: c.id, sentMsg: fakes.gmail.sent[0] };
}

const raw = (lines: string[]) => Buffer.from(lines.join('\r\n'));

describe('reply synchronization & stop rules', () => {
  it('threads a reply to the original email, stops the sequence and classifies it (AI)', async () => {
    const { s, mailbox, lead, campaignId, sentMsg } = await sentCampaign();
    await addAiProvider(s.workspaceId);
    fakes.anthropic.on('REPLY_CLASSIFICATION', () => ({ category: 'WANTS_PRICING', confidence: 0.92, sentiment: 'positive', meetingInterest: false, objection: null, unsubscribeIntent: false, isAutoReply: false }));
    fakes.gmail.inbox.push(await parseRawMessage(raw([`From: Jane <jane@acme.io>`, 'To: sender@ourco.com', 'Subject: Re: Hello Jane', 'Message-ID: <reply1@acme.io>', `In-Reply-To: ${sentMsg.messageId}`, `References: ${sentMsg.messageId}`, 'Date: Mon, 23 Nov 2026 12:00:00 +0000', '', 'What does this cost?', '']), { providerMessageId: 'in-1', providerThreadId: `thread-${sentMsg.messageId}` }));
    const stats = await syncAccount(mailbox.id);
    expect(stats).toMatchObject({ inbound: 1, replies: 1 });
    // Running sync again is idempotent
    fakes.gmail.inbox.push(fakes.gmail.inbox[0]);
    await db().emailAccount.update({ where: { id: mailbox.id }, data: { syncCursor: '0' } });
    await syncAccount(mailbox.id);
    expect(await db().emailMessage.count({ where: { direction: 'INBOUND' } })).toBe(1);

    const conv = await db().conversation.findFirstOrThrow({ where: { leadId: lead.id }, include: { messages: true } });
    expect(conv.messages.map((m) => m.direction).sort()).toEqual(['INBOUND', 'OUTBOUND']);
    const enr = await db().sequenceEnrollment.findFirstOrThrow({ where: { campaignId } });
    expect(enr.status).toBe('STOPPED_REPLIED');
    expect(await db().emailEvent.count({ where: { type: 'REPLIED', campaignId } })).toBe(1);

    const inbound = conv.messages.find((m) => m.direction === 'INBOUND')!;
    const r = await classifyMessage(s.workspaceId, inbound.id);
    expect(r?.category).toBe('WANTS_PRICING');
    expect((await db().lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('INTERESTED');
    // The prompt carried the reply only inside an untrusted block
    expect(fakes.anthropic.calls.at(-1)?.user).toMatch(/<untrusted_content source="email">[\s\S]*What does this cost\?[\s\S]*<\/untrusted_content>/);
    // No follow-up goes out after the reply
    await engine.tick(new Date('2026-11-26T10:00:00Z'));
    expect(await db().outboundEmail.count({ where: { campaignId } })).toBe(1);
  });

  it('serializes overlapping mailbox sync jobs and does not duplicate stored replies', async () => {
    const { mailbox, sentMsg } = await sentCampaign();
    fakes.gmail.inbox.push(await parseRawMessage(raw([
      'From: Jane <jane@acme.io>', 'To: sender@ourco.com', 'Subject: Re: Hello', 'Message-ID: <sync-lock-reply@acme.io>',
      `In-Reply-To: ${sentMsg.messageId}`, `References: ${sentMsg.messageId}`, '', 'Thanks for the details.',
    ]), { providerMessageId: 'sync-lock-reply' }));
    const results = await Promise.all([syncAccount(mailbox.id), syncAccount(mailbox.id)]);
    expect(results.filter((r) => 'inbound' in r && r.inbound === 1)).toHaveLength(1);
    expect(results.filter((r) => r.skipped === true)).toHaveLength(1);
    expect(await db().emailMessage.count({ where: { providerMessageId: 'sync-lock-reply' } })).toBe(1);
    expect(await db().conversation.count({ where: { emailAccountId: mailbox.id } })).toBe(1);
  });

  it('processes hard bounces: suppression, lead BOUNCED, sequence stopped', async () => {
    const { mailbox, lead, campaignId, sentMsg } = await sentCampaign();
    const outbound = await db().outboundEmail.findFirstOrThrow({ where: { campaignId } });
    fakes.gmail.inbox.push(await parseRawMessage(raw([
      'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'To: sender@ourco.com', 'Subject: Delivery Status Notification (Failure)', 'Message-ID: <dsn@google.com>',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="B"', '', '--B', 'Content-Type: message/delivery-status', '', 'Final-Recipient: rfc822; jane@acme.io', 'Status: 5.1.1', '--B',
      'Content-Type: text/rfc822-headers', '', `Message-ID: ${sentMsg.messageId}`, `X-EMN-Outbound-Id: ${outbound.id}`, '--B--', '',
    ]), { providerMessageId: 'dsn-1' }));
    await syncAccount(mailbox.id);
    expect((await db().lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('BOUNCED');
    expect(await db().suppressionEntry.count({ where: { value: 'jane@acme.io', reason: 'HARD_BOUNCE' } })).toBe(1);
    expect((await db().sequenceEnrollment.findFirstOrThrow({ where: { campaignId } })).status).toBe('STOPPED_BOUNCED');
    expect(await db().emailEvent.count({ where: { type: 'BOUNCED_HARD', outboundEmailId: outbound.id } })).toBe(1);
  });

  it('auto-replies do not stop the sequence unless configured', async () => {
    const { mailbox, campaignId, sentMsg } = await sentCampaign(false);
    fakes.gmail.inbox.push(await parseRawMessage(raw(['From: jane@acme.io', 'To: sender@ourco.com', 'Subject: Automatic reply: Hello', 'Auto-Submitted: auto-replied', 'Message-ID: <ooo@acme.io>', `In-Reply-To: ${sentMsg.messageId}`, '', 'I am out of office', '']), { providerMessageId: 'ooo-1' }));
    await syncAccount(mailbox.id);
    expect((await db().sequenceEnrollment.findFirstOrThrow({ where: { campaignId } })).status).toBe('ACTIVE');
    expect(await db().emailEvent.count({ where: { type: 'AUTO_REPLIED' } })).toBe(1);
  });

  it('honours opt-outs in replies even without an AI provider (keyword fallback)', async () => {
    const { s, mailbox, lead } = await sentCampaign();
    fakes.gmail.inbox.push(await parseRawMessage(raw(['From: jane@acme.io', 'To: sender@ourco.com', 'Subject: Re: Hello', 'Message-ID: <stop@acme.io>', '', 'Please remove me from your list.', '']), { providerMessageId: 'stop-1' }));
    await syncAccount(mailbox.id);
    const msg = await db().emailMessage.findFirstOrThrow({ where: { providerMessageId: 'stop-1' } });
    const r = await classifyMessage(s.workspaceId, msg.id);
    expect(r?.category).toBe('UNSUBSCRIBE');
    expect(await db().suppressionEntry.count({ where: { value: 'jane@acme.io', reason: 'UNSUBSCRIBED' } })).toBe(1);
    expect((await db().lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('UNSUBSCRIBED');
    expect(heuristicClassify('This is spam, reporting you').category).toBe('COMPLAINT');
  });

  it('sends manual replies from the original mailbox, in thread', async () => {
    const { s, lead, sentMsg } = await sentCampaign();
    fakes.gmail.inbox.push(await parseRawMessage(raw(['From: jane@acme.io', 'To: sender@ourco.com', 'Subject: Re: Hello Jane', 'Message-ID: <q@acme.io>', `In-Reply-To: ${sentMsg.messageId}`, `References: ${sentMsg.messageId}`, '', 'Tell me more', '']), { providerMessageId: 'q-1' }));
    const mailbox = await db().emailAccount.findFirstOrThrow({ where: { workspaceId: s.workspaceId } });
    await syncAccount(mailbox.id);
    const conv = await db().conversation.findFirstOrThrow({ where: { leadId: lead.id } });
    await sendReply(s.workspaceId, conv.id, 'Happy to share details.', s.userId);
    const out = fakes.gmail.sent.at(-1)!;
    expect(out.from.address).toBe('sender@ourco.com');
    expect(out.to).toBe('jane@acme.io');
    expect(out.inReplyTo).toBe('<q@acme.io>');
    expect(out.references).toEqual([sentMsg.messageId, '<q@acme.io>']);
  });
});

describe('unsubscribe', () => {
  it('one-click POST suppresses, stops sequences, is idempotent and rejects forged tokens', async () => {
    const { s, lead, campaignId } = await sentCampaign();
    const token = unsubscribeToken(s.workspaceId, lead.emailNormalized, lead.id);
    const app = getApp();
    expect((await request(app).post(`/api/v1/public/unsubscribe/${token}`).type('form').send('List-Unsubscribe=One-Click')).status).toBe(200);
    expect((await request(app).post(`/api/v1/public/unsubscribe/${token}`)).status).toBe(200);
    expect(await db().suppressionEntry.count({ where: { value: lead.emailNormalized } })).toBe(1);
    expect((await db().sequenceEnrollment.findFirstOrThrow({ where: { campaignId } })).status).toBe('STOPPED_UNSUBSCRIBED');
    expect(await db().emailEvent.count({ where: { type: 'UNSUBSCRIBED', leadId: lead.id } })).toBe(1);
    expect((await request(app).post(`/api/v1/public/unsubscribe/${token.slice(0, -3)}abc`)).status).toBe(400);
  });

  it('requires a documented reason to remove an opt-out', async () => {
    const s = await createUserSession('owner@x.com');
    const e = await db().suppressionEntry.create({ data: { workspaceId: s.workspaceId, type: 'EMAIL', value: 'x@y.com', reason: 'UNSUBSCRIBED' } });
    const r = await s.agent.delete(`/api/v1/w/${s.workspaceId}/suppressions/${e.id}?reason=oops`).set('x-csrf-token', s.csrf);
    expect(r.status).toBe(400);
    const ok = await s.agent.delete(`/api/v1/w/${s.workspaceId}/suppressions/${e.id}?reason=${encodeURIComponent('Re-subscribed in writing on 2026-11-20')}`).set('x-csrf-token', s.csrf);
    expect(ok.status).toBe(200);
  });
});
