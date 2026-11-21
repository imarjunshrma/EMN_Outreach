import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import { queue, QUEUES } from '../../backend/src/core/queues.js';
import { setSystemMailerForTests, type SystemMail } from '../../backend/src/core/mailer.js';
import { notifyWorkspace } from '../../backend/src/core/audit.js';
import * as insights from '../../backend/src/services/insights.js';
import * as inbox from '../../backend/src/services/inbox.js';
import { resetDb, installFakes, createUserSession, addLead, addMailbox } from '../helpers/harness.js';

const outbox: SystemMail[] = [];
let fakes: ReturnType<typeof installFakes>;
beforeEach(async () => { await resetDb(); fakes = installFakes(); outbox.length = 0; setSystemMailerForTests({ configured: true, send: async (m) => { outbox.push(m); } }); });
afterEach(() => { setSystemMailerForTests(null); insights.setSlackFetchForTests(null); });
const ACTOR = { type: 'SYSTEM' as const };

describe('CRM forecast & exports', () => {
  it('weights open deals by stage probability, groups won revenue by month and exports CSV safely', async () => {
    const s = await createUserSession('o@x.com');
    const l = await addLead(s.workspaceId, 'a@b.co');
    const mk = (stage: string, valueCents: number, extra: Record<string, unknown> = {}) => db().opportunity.create({ data: { workspaceId: s.workspaceId, leadId: l.id, title: `=HYPERLINK("x") ${stage}`, stage: stage as never, valueCents, ...extra } });
    await mk('NEW', 100_000, { expectedCloseAt: new Date('2026-12-15') });
    await mk('PROPOSAL', 200_000, { expectedCloseAt: new Date('2026-12-20') });
    await mk('WON', 50_000, { closedAt: new Date('2026-10-03') });
    await mk('LOST', 70_000, { closedAt: new Date('2026-10-04') });
    const f = await insights.forecast(s.workspaceId);
    expect(f.weightedPipelineCents).toBe(10_000 + 120_000);
    expect(f.expectedByMonth).toEqual([{ month: '2026-12', weightedCents: 130_000 }]);
    expect(f.wonByMonth).toEqual([{ month: '2026-10', cents: 50_000 }]);
    expect(f.winRate).toBe(0.5);
    // custom stage probabilities from settings
    const ws = await db().workspace.findUniqueOrThrow({ where: { id: s.workspaceId } });
    await db().workspace.update({ where: { id: s.workspaceId }, data: { settings: { ...(ws.settings as object), stageProbabilities: { PROPOSAL: 0.9 } } } });
    expect((await insights.forecast(s.workspaceId)).weightedPipelineCents).toBe(10_000 + 180_000);
    const res = await s.agent.get(`/api/v1/w/${s.workspaceId}/crm/opportunities/export`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain(`'=HYPERLINK`); // formula neutralised
    const camp = await s.agent.get(`/api/v1/w/${s.workspaceId}/analytics/campaigns/export`);
    expect(camp.status).toBe(200);
  });

  it('saved filters are private unless shared; campaign folders/tags do not touch approval', async () => {
    const s = await createUserSession('o@x.com');
    const m = await createUserSession('m@x.com', 'MEMBER', s.workspaceId);
    await insights.createSavedFilter(s.workspaceId, s.userId, { entity: 'leads', name: 'Mine', query: { status: 'NEW' }, isShared: false });
    const shared = await insights.createSavedFilter(s.workspaceId, s.userId, { entity: 'leads', name: 'Team', query: { country: 'IN' }, isShared: true });
    expect((await insights.listSavedFilters(s.workspaceId, m.userId)).map((f) => f.name)).toEqual(['Team']);
    await expect(insights.deleteSavedFilter(s.workspaceId, m.userId, shared.id, false)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const other = await createUserSession('p@y.com');
    expect(await insights.listSavedFilters(other.workspaceId, other.userId)).toHaveLength(0);

    const c = await db().campaign.create({ data: { workspaceId: s.workspaceId, name: 'C', sendingWindow: {}, status: 'APPROVED', approvedContentHash: 'h' } });
    const r = await m.agent.patch(`/api/v1/w/${s.workspaceId}/campaigns/${c.id}/organize`).set('x-csrf-token', m.csrf).send({ folder: 'Q4 US', tags: ['doctors', 'doctors', 'us'] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ folder: 'Q4 US', tags: ['doctors', 'us'], status: 'APPROVED' });
    expect((await db().campaign.findUniqueOrThrow({ where: { id: c.id } })).approvedContentHash).toBe('h');
  });
});

describe('scheduled reports & notification channels', () => {
  it('reports go only to workspace members, weekly ones on Mondays, and record delivery state', async () => {
    const s = await createUserSession('o@x.com');
    await expect(insights.saveReport(s.workspaceId, null, { name: 'P', kind: 'pipeline', frequency: 'DAILY', recipients: ['stranger@evil.com'], isActive: true }, ACTOR)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await insights.saveReport(s.workspaceId, null, { name: 'Pipeline', kind: 'pipeline', frequency: 'DAILY', recipients: ['o@x.com'], isActive: true }, ACTOR);
    await insights.saveReport(s.workspaceId, null, { name: 'Weekly AI', kind: 'ai_cost', frequency: 'WEEKLY', recipients: ['o@x.com'], isActive: true }, ACTOR);
    const tuesday = new Date('2026-11-24T07:30:00Z');
    expect((await insights.runScheduledReports(tuesday)).sent).toBe(1);
    expect(outbox[0]).toMatchObject({ to: 'o@x.com', subject: '[EMN] Pipeline' });
    expect(outbox[0].text).toContain('Weighted open pipeline');
    expect((await insights.runScheduledReports(new Date(tuesday.getTime() + 3600_000))).sent).toBe(0); // not twice a day
    expect((await insights.runScheduledReports(new Date('2026-11-30T07:30:00Z'))).sent).toBe(2); // Monday: daily + weekly
    setSystemMailerForTests({ configured: false, send: async () => { throw new Error('not configured'); } });
    await insights.runScheduledReports(new Date('2026-12-01T07:30:00Z'));
    expect((await db().scheduledReport.findFirstOrThrow({ where: { name: 'Pipeline' } })).lastError).toMatch(/not configured/);
  });

  it('Slack channel: URL validated, stored encrypted, never returned, events filtered, failures recorded', async () => {
    const s = await createUserSession('o@x.com');
    expect(insights.ChannelSchema.safeParse({ type: 'SLACK', name: 'x', webhookUrl: 'https://evil.com/hook', events: ['*'] }).success).toBe(false);
    const posts: Array<{ url: string; body: string }> = [];
    let status = 200;
    insights.setSlackFetchForTests((async (url: string, init: RequestInit) => { posts.push({ url, body: String(init.body) }); return new Response('ok', { status }); }) as never);
    const url = 'https://hooks.slack.com/services/T000/B000/XXXX';
    await insights.createChannel(s.workspaceId, { type: 'SLACK', name: 'sales', webhookUrl: url, events: ['reply.*', 'billing.payment_failed'], isActive: true }, ACTOR);
    const row = await db().notificationChannel.findFirstOrThrow();
    expect(row.encryptedConfig).not.toContain('hooks.slack.com');
    expect(JSON.stringify(await insights.listChannels(s.workspaceId))).not.toContain('hooks.slack.com');
    expect((await insights.deliverToChannels(s.workspaceId, { type: 'campaign.paused', title: 'x' })).delivered).toBe(0);
    expect((await insights.deliverToChannels(s.workspaceId, { type: 'reply.positive', title: 'Priya replied', link: '/inbox' })).delivered).toBe(1);
    expect(posts[0].url).toBe(url);
    expect(JSON.parse(posts[0].body).text).toContain('Priya replied');
    status = 500;
    await insights.deliverToChannels(s.workspaceId, { type: 'reply.positive', title: 'again' });
    expect((await db().notificationChannel.findFirstOrThrow()).lastError).toMatch(/500/);
    // notifyWorkspace fans out through the queue
    await notifyWorkspace(s.workspaceId, 'MEMBER', { type: 'reply.positive', title: 'q' });
    expect((await queue(QUEUES.webhooks).getJobs(['waiting'])).some((j) => j.name === 'channel.notify')).toBe(true);
  });
});

describe('inbox star / archive / forward', () => {
  it('filters starred and archived conversations and forwards from the original mailbox, refusing suppressed addresses', async () => {
    const s = await createUserSession('o@x.com');
    const mb = await addMailbox(s.workspaceId, 'me@ourco.com');
    const lead = await addLead(s.workspaceId, 'p@client.com');
    const conv = await db().conversation.create({ data: { workspaceId: s.workspaceId, emailAccountId: mb.id, leadId: lead.id, providerThreadId: 't1', subject: 'Idea', lastMessageAt: new Date() } });
    await db().emailMessage.create({ data: { workspaceId: s.workspaceId, conversationId: conv.id, emailAccountId: mb.id, direction: 'INBOUND', providerMessageId: 'pm1', references: [], fromAddress: 'p@client.com', toAddresses: ['me@ourco.com'], ccAddresses: [], subject: 'Re: Idea', bodyText: 'Interested', snippet: 'Interested', sentAt: new Date() } });
    await inbox.updateConversation(s.workspaceId, conv.id, { isStarred: true }, ACTOR);
    expect((await inbox.listConversations(s.workspaceId, { page: 1, pageSize: 30, starred: 'true' })).total).toBe(1);
    await inbox.updateConversation(s.workspaceId, conv.id, { isArchived: true }, ACTOR);
    expect((await inbox.listConversations(s.workspaceId, { page: 1, pageSize: 30 })).total).toBe(0);
    expect((await inbox.listConversations(s.workspaceId, { page: 1, pageSize: 30, archived: 'true' })).total).toBe(1);

    const r = await s.agent.post(`/api/v1/w/${s.workspaceId}/conversations/${conv.id}/forward`).set('x-csrf-token', s.csrf).send({ to: 'colleague@ourco.com', note: 'FYI' });
    expect(r.status).toBe(202);
    await inbox.sendForward(s.workspaceId, conv.id, 'colleague@ourco.com', 'FYI', s.userId);
    const sent = fakes.gmail.sent.at(-1)!;
    expect(sent).toMatchObject({ to: 'colleague@ourco.com', subject: 'Fwd: Idea' });
    expect(sent.from.address).toBe('me@ourco.com');
    expect(sent.text).toContain('Interested');
    await db().suppressionEntry.create({ data: { workspaceId: s.workspaceId, value: 'blocked.com', type: 'DOMAIN', reason: 'MANUAL' } as never });
    expect((await s.agent.post(`/api/v1/w/${s.workspaceId}/conversations/${conv.id}/forward`).set('x-csrf-token', s.csrf).send({ to: 'x@blocked.com' })).status).toBe(409);
  });
});
