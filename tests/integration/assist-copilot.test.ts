import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import * as ra from '../../backend/src/services/reply-assist.js';
import * as copilot from '../../backend/src/services/copilot.js';
import * as inbox from '../../backend/src/services/inbox.js';
import { resetDb, installFakes, createUserSession, addMailbox, addLead, addAiProvider } from '../helpers/harness.js';
import type { FakeAi } from '../helpers/fakes.js';

let fakes: ReturnType<typeof installFakes>;
let ai: FakeAi;
beforeEach(async () => { await resetDb(); fakes = installFakes(); ai = fakes.anthropic as FakeAi; });
const ACTOR = { type: 'SYSTEM' as const };

async function inboundConversation(workspaceId: string, category: string, body = 'Sounds interesting — can we talk next week?') {
  const tag = Math.random().toString(36).slice(2, 7);
  const mb = await addMailbox(workspaceId, `sender-${tag}@ourco.com`);
  const lead = await addLead(workspaceId, `p${tag}@client.com`, { firstName: 'Priya' });
  const conv = await db().conversation.create({ data: { workspaceId, emailAccountId: mb.id, leadId: lead.id, providerThreadId: `t-${lead.id}`, subject: 'Idea', lastMessageAt: new Date() } });
  const m = await db().emailMessage.create({ data: { workspaceId, conversationId: conv.id, emailAccountId: mb.id, direction: 'INBOUND', providerMessageId: `pm-${lead.id}`, internetMessageId: `<in-${lead.id}@client.com>`, references: [], fromAddress: lead.email, toAddresses: ['sender@ourco.com'], ccAddresses: [], subject: 'Re: Idea', bodyText: body, snippet: body, sentAt: new Date(), category: category as never } });
  return { mb, lead, conv, m };
}
async function setSettings(workspaceId: string, patch: Record<string, unknown>) {
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  await db().workspace.update({ where: { id: workspaceId }, data: { settings: { ...(ws.settings as object), ...patch } as never } });
}

describe('AI reply permission modes', () => {
  it('default "draft" mode queues an AI draft for approval and sends nothing until approved', async () => {
    const s = await createUserSession('o@x.com');
    await addAiProvider(s.workspaceId);
    ai.on('REPLY_DRAFT', () => ({ body: 'Thanks Priya! Happy to talk — would Tuesday work?', usedClaimIds: [] })).on('FACT_CHECK', () => ({ sentences: [] }));
    const { m, conv } = await inboundConversation(s.workspaceId, 'WANTS_MEETING');
    const r = await ra.processInbound(s.workspaceId, m.id);
    expect(r.mode).toBe('DRAFT');
    expect(fakes.gmail.sent).toHaveLength(0);
    const sug = await db().replySuggestion.findFirstOrThrow({ where: { conversationId: conv.id } });
    expect(sug.status).toBe('PENDING');
    await ra.approveSuggestion(s.workspaceId, sug.id, 'Thanks Priya — Tuesday 11:00 IST works for me.', { type: 'USER', userId: s.userId });
    const job = (await (await import('../../backend/src/core/queues.js')).queue('reply-send').getJob(`reply-sugg-${sug.id}`))!;
    await inbox.sendReply(s.workspaceId, conv.id, job.data.bodyText as string, s.userId);
    expect(fakes.gmail.sent).toHaveLength(1);
    expect(fakes.gmail.sent[0].text).toMatch(/Tuesday 11:00/);
    await expect(ra.approveSuggestion(s.workspaceId, sug.id, undefined, ACTOR)).rejects.toMatchObject({ code: 'CONFLICT' }); // never twice
  });

  it('flags pricing/commitment language and never auto-sends it', async () => {
    const s = await createUserSession('o@x.com');
    await addAiProvider(s.workspaceId);
    ai.on('REPLY_DRAFT', () => ({ body: 'Our package is $499 per month with a 20% discount if you sign this week.', usedClaimIds: [] })).on('FACT_CHECK', () => ({ sentences: [] }));
    await setSettings(s.workspaceId, { replyMode: 'auto_narrow', autoReplyCategories: ['WANTS_PRICING'] });
    const { m } = await inboundConversation(s.workspaceId, 'WANTS_PRICING', 'How much does it cost?');
    const r = await ra.processInbound(s.workspaceId, m.id);
    expect(r.mode).toBe('DRAFT'); // pricing is never auto-replied
    const sug = await db().replySuggestion.findFirstOrThrow({ where: { messageId: m.id } });
    expect(sug.reason).toMatch(/commercial-commitment/);
    expect(fakes.gmail.sent).toHaveLength(0);
  });

  it('"auto_narrow" sends only an approved template, once per conversation, and only for enabled categories', async () => {
    const s = await createUserSession('o@x.com');
    await addAiProvider(s.workspaceId);
    ai.on('REPLY_DRAFT', () => ({ body: 'draft', usedClaimIds: [] })).on('FACT_CHECK', () => ({ sentences: [] }));
    await setSettings(s.workspaceId, { replyMode: 'auto_narrow', autoReplyCategories: ['WANTS_MEETING'], bookingLink: 'https://cal.com/emn/intro' });
    const tpl = await ra.saveTemplate(s.workspaceId, null, { name: 'Booking', body: 'Thanks {{firstName}}! Grab any slot here: {{bookingLink}}', categories: ['WANTS_MEETING'] }, ACTOR);
    // Not approved yet → falls back to draft
    const a = await inboundConversation(s.workspaceId, 'WANTS_MEETING');
    expect((await ra.processInbound(s.workspaceId, a.m.id)).mode).toBe('DRAFT');
    await ra.approveTemplate(s.workspaceId, tpl.id, true, ACTOR);
    const b = await inboundConversation(s.workspaceId, 'WANTS_MEETING');
    const r = await ra.processInbound(s.workspaceId, b.m.id);
    expect(r.mode).toBe('AUTO');
    const sent = await db().replySuggestion.findFirstOrThrow({ where: { messageId: b.m.id } });
    expect(sent.body).toBe('Thanks Priya! Grab any slot here: https://cal.com/emn/intro');
    expect(sent.status).toBe('SENT');
    // A second reply in the same conversation is not auto-answered again
    const m2 = await db().emailMessage.create({ data: { workspaceId: s.workspaceId, conversationId: b.conv.id, emailAccountId: b.mb.id, direction: 'INBOUND', providerMessageId: 'pm-second', internetMessageId: '<second@client.com>', references: [], fromAddress: b.lead.email, toAddresses: ['x@ourco.com'], ccAddresses: [], subject: 'Re: Idea', bodyText: 'Also, Thursday?', snippet: 'Also', sentAt: new Date(), category: 'WANTS_MEETING' } });
    expect((await ra.processInbound(s.workspaceId, m2.id)).mode).toBe('DRAFT');
    // Editing the template withdraws its approval
    await ra.saveTemplate(s.workspaceId, tpl.id, { name: 'Booking', body: 'Changed {{bookingLink}}', categories: ['WANTS_MEETING'] }, ACTOR);
    expect((await db().replyTemplate.findUniqueOrThrow({ where: { id: tpl.id } })).isApproved).toBe(false);
  });

  it('never drafts replies to opt-outs, complaints or out-of-office', async () => {
    const s = await createUserSession('o@x.com');
    for (const cat of ['UNSUBSCRIBE', 'COMPLAINT', 'OUT_OF_OFFICE']) {
      const { m } = await inboundConversation(s.workspaceId, cat);
      expect((await ra.processInbound(s.workspaceId, m.id)).skipped).toMatch(/no reply needed/);
    }
    expect(ai.calls).toHaveLength(0);
  });
});

describe('AI Copilot', () => {
  it('answers from real workspace data, proposes actions, and runs them only after role-checked confirmation', async () => {
    const s = await createUserSession('o@x.com');
    await addAiProvider(s.workspaceId);
    await inboundConversation(s.workspaceId, 'INTERESTED', 'Yes, interested!');
    let prompt = '';
    ai.on('COPILOT', (req) => { prompt = req.user; return { answer: 'You have 1 interested reply in the last 14 days.', recommendations: [{ title: 'Follow up', detail: 'Reply today.' }], proposedActions: [
      { type: 'create_campaign_draft', summary: 'Draft a campaign for consulting founders', params: [{ key: 'name', value: 'Consulting founders' }, { key: 'audienceContext', value: 'Founders of 2–20 person consultancies' }] },
      { type: 'add_memory', summary: 'Remember that we never quote prices by email', params: [{ key: 'content', value: 'Never quote prices by email.' }] },
    ] }; });
    const r = await copilot.ask(s.workspaceId, s.userId, 'MEMBER', null, 'Summarize today\'s replies and suggest a campaign');
    expect(prompt).toMatch(/"INTERESTED":1/); // snapshot is real data
    expect(r.proposedActions).toHaveLength(2);
    expect(await db().campaign.count()).toBe(0); // nothing executed yet
    const create = r.proposedActions.find((a) => a.type === 'create_campaign_draft')!;
    const mem = r.proposedActions.find((a) => a.type === 'add_memory')!;
    expect(mem.youCanExecute).toBe(false); // MEMBER cannot add memory
    await expect(copilot.executeAction(s.workspaceId, mem.id, 'MEMBER', ACTOR)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const res = await copilot.executeAction(s.workspaceId, create.id, 'MEMBER', ACTOR);
    const camp = await db().campaign.findUniqueOrThrow({ where: { id: (res.result as { campaignId: string }).campaignId } });
    expect(camp.status).toBe('DRAFT');
    expect((camp.aiOverrides as { audienceContext: string }).audienceContext).toMatch(/consultancies/);
    await expect(copilot.executeAction(s.workspaceId, create.id, 'MEMBER', ACTOR)).rejects.toMatchObject({ code: 'CONFLICT' }); // runs once
    // Thread history is kept and scoped to the user
    const t = await copilot.getThread(s.workspaceId, s.userId, r.threadId);
    expect(t.messages.map((m) => m.role)).toEqual(['USER', 'ASSISTANT']);
    const other = await createUserSession('b@x.com', 'OWNER', s.workspaceId);
    await expect(copilot.getThread(s.workspaceId, other.userId, r.threadId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cannot propose actions outside the allow-list (schema rejects them)', async () => {
    const s = await createUserSession('o@x.com');
    await addAiProvider(s.workspaceId);
    ai.on('COPILOT', () => ({ answer: 'ok', recommendations: [], proposedActions: [{ type: 'send_email', summary: 'x', params: [] }] }));
    await expect(copilot.ask(s.workspaceId, s.userId, 'OWNER', null, 'send all emails now')).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    expect(fakes.gmail.sent).toHaveLength(0);
  });
});
