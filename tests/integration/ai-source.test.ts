import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import { runAi } from '../../backend/src/services/ai.js';
import * as subs from '../../backend/src/services/ai-subscriptions.js';
import { SubscriptionError, type SubscriptionRunRequest, type SubscriptionRunner } from '../../integrations/src/ai/subscription/types.js';
import { installFakes, resetDb, createUserSession, addAiProvider, type Session } from '../helpers/harness.js';
import type { FakeAi } from '../helpers/fakes.js';

// "AI source": every AI feature runs on API keys or on a personal Claude / Codex subscription, chosen once per
// workspace (or per campaign). Subscriptions are faked; nothing real is contacted.
const TOKEN = `sk-ant-oat01-${'A1b2C3d4'.repeat(6)}`;
const OWNER = 'arjun@owner.test';
const CLASSIFY = { category: 'INTERESTED', confidence: 0.9, sentiment: 'positive', meetingInterest: true, objection: null, unsubscribeIntent: false, isAutoReply: false };

class FakeRunner implements SubscriptionRunner {
  calls: SubscriptionRunRequest[] = [];
  fail: Error | null = null;
  constructor(readonly provider: 'CLAUDE_SUBSCRIPTION' | 'CODEX_SUBSCRIPTION') {}
  async run(req: SubscriptionRunRequest) {
    this.calls.push(req);
    if (this.fail) throw this.fail;
    return { data: CLASSIFY, model: 'claude-test', usage: { inputTokens: 10, outputTokens: 5 }, durationMs: 1, rateLimit: null };
  }
}

let fakes: ReturnType<typeof installFakes>;
let claude: FakeRunner;
let s: Session;
const api = (p: string) => `/api/v1${p}`;
const ws = (p: string) => api(`/w/${s.workspaceId}${p}`);
const classify = () => runAi(s.workspaceId, 'REPLY_CLASSIFICATION', { reply: 'Sounds good, let us talk', thread: '' });

beforeAll(() => {
  process.env.AI_SUBSCRIPTION_OWNER_EMAILS = OWNER;
  process.env.AI_SUBSCRIPTION_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
  process.env.AI_SUBSCRIPTION_HOME = '/tmp/emn-test-ai-subs';
});
afterAll(() => { subs.resetSubscriptionDeps(); });
beforeEach(async () => {
  await resetDb();
  fakes = installFakes();
  subs.resetSubscriptionKeyringForTests();
  claude = new FakeRunner('CLAUDE_SUBSCRIPTION');
  subs.setSubscriptionDeps({ claudeRunner: () => claude, codexRunner: () => new FakeRunner('CODEX_SUBSCRIPTION') });
  s = await createUserSession(OWNER);
  await db().user.update({ where: { id: s.userId }, data: { platformRole: 'SUPER_ADMIN', mfaEnabled: true } });
});

async function connectClaude() {
  expect((await s.agent.post(api('/ai-subscriptions/claude/connect')).set('x-csrf-token', s.csrf).send({ token: TOKEN })).status).toBe(200);
  await s.agent.put(api('/ai-subscriptions/CLAUDE_SUBSCRIPTION/settings')).set('x-csrf-token', s.csrf).send({ delayMs: 0 });
  // The fake runner does not answer the connection self-test; mark it connected as a passing self-test would.
  await db().aiSubscriptionConnection.updateMany({ where: { provider: 'CLAUDE_SUBSCRIPTION' }, data: { status: 'CONNECTED', lastTestOk: true, lastError: null } });
  claude.calls = [];
}
const setSource = (mode: string, fallbackToApi = false) => s.agent.put(ws('/ai/source')).set('x-csrf-token', s.csrf).send({ mode, fallbackToApi });

describe('AI source', () => {
  it('defaults to API keys and only offers a subscription once it is connected', async () => {
    const r = await s.agent.get(ws('/ai/source'));
    expect(r.body.mode).toBe('api');
    expect(r.body.options.find((o: { mode: string }) => o.mode === 'claude_subscription')).toMatchObject({ available: false, reason: expect.stringMatching(/not connected/) });
    expect((await setSource('claude_subscription')).status).toBe(409);
    await connectClaude();
    const set = await setSource('claude_subscription');
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ mode: 'claude_subscription', ready: true, owner: { email: OWNER } });
  });

  it('every AI task runs on the subscription, with no API key needed and no API cost', async () => {
    await connectClaude();
    await setSource('claude_subscription');
    const r = await classify();
    expect(r.data).toMatchObject({ category: 'INTERESTED' });
    expect(claude.calls).toHaveLength(1);
    const exec = await db().aiExecution.findUniqueOrThrow({ where: { id: r.executionId } });
    expect(exec).toMatchObject({ status: 'SUCCEEDED', model: expect.stringMatching(/Claude subscription/) });
    expect(Number(exec.costUsd)).toBe(0);
    expect((await db().aiExecution.count({ where: { workspaceId: s.workspaceId } }))).toBe(1);
  });

  it('never falls back to paid API calls unless an admin allowed it', async () => {
    await addAiProvider(s.workspaceId);
    (fakes.anthropic as FakeAi).on('REPLY_CLASSIFICATION', () => CLASSIFY);
    await connectClaude();
    await setSource('claude_subscription');
    claude.fail = new SubscriptionError('USAGE_LIMIT', 'Claude usage limit reached');
    await expect(classify()).rejects.toMatchObject({ code: 'AI_SUBSCRIPTION_UNAVAILABLE' });
    expect((fakes.anthropic as FakeAi).calls).toHaveLength(0);
    await setSource('claude_subscription', true);
    const r = await classify();
    expect(r.provider).toBe('ANTHROPIC');
    expect((fakes.anthropic as FakeAi).calls).toHaveLength(1);
  });

  it('a campaign using AI is valid with only a subscription, and can choose its own source', async () => {
    const c = await s.agent.post(ws('/campaigns')).set('x-csrf-token', s.csrf).send({ name: 'AI campaign' });
    const steps = [{ delayDays: 0, personalizationMode: 'AI_FULL', variants: [{ label: 'A', subject: 'Hi {{firstName}}', body: 'Write a short note about their clinic.' }] }];
    expect((await s.agent.put(ws(`/campaigns/${c.body.id}/sequence`)).set('x-csrf-token', s.csrf).send({ steps })).status).toBe(200);
    const blocking = async () => (await s.agent.post(ws(`/campaigns/${c.body.id}/validate`)).set('x-csrf-token', s.csrf)).body.blocking.join(' ');
    expect(await blocking()).toMatch(/no API key is added/);
    await connectClaude();
    await setSource('claude_subscription');
    expect(await blocking()).not.toMatch(/AI source|API key/);
    // This campaign picks Codex, which is not connected: blocked with a clear reason.
    await db().campaign.update({ where: { id: c.body.id }, data: { aiOverrides: { aiSource: 'codex_subscription' } } });
    expect(await blocking()).toMatch(/Codex subscription.*not connected/i);
  });

  it('only someone allowed to use subscriptions can switch to one, and only admins can change the source', async () => {
    await connectClaude();
    const member = await createUserSession('member@x.test', 'MEMBER', s.workspaceId);
    expect((await member.agent.put(ws('/ai/source')).set('x-csrf-token', member.csrf).send({ mode: 'api' })).status).toBe(403);
    const admin = await createUserSession('admin@x.test', 'ADMIN', s.workspaceId);
    expect((await admin.agent.put(ws('/ai/source')).set('x-csrf-token', admin.csrf).send({ mode: 'claude_subscription' })).status).toBe(409); // not their subscription
    expect((await member.agent.get(ws('/ai/source'))).status).toBe(200);
  });
});
