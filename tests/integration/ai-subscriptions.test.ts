import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import { queue, QUEUES, type QueueName } from '../../backend/src/core/queues.js';
import { HANDLERS } from '../../worker/src/processors.js';
import { installFakes, resetDb, createUserSession, addLead, addAiProvider, type Session } from '../helpers/harness.js';
import * as subs from '../../backend/src/services/ai-subscriptions.js';
import * as runs from '../../backend/src/services/ai-workflow-runs.js';
import { SubscriptionError, type SubscriptionRunRequest, type SubscriptionRunner } from '../../integrations/src/ai/subscription/types.js';
import type { CodexCli, DeviceLoginUpdate } from '../../integrations/src/ai/subscription/codex.js';

// Personal AI subscriptions: owner gate, connections, workflows, playbook, runs, limits, queue, recovery.
// Claude and Codex are replaced by fake runners (no real subscription is contacted in tests).

const TOKEN = `sk-ant-oat01-${'A1b2C3d4'.repeat(6)}`;
const OWNER = 'arjun@owner.test';

type Script = (req: SubscriptionRunRequest, n: number) => unknown;
class FakeRunner implements SubscriptionRunner {
  calls: SubscriptionRunRequest[] = [];
  constructor(readonly provider: 'CLAUDE_SUBSCRIPTION' | 'CODEX_SUBSCRIPTION', public script: Script = defaultScript(provider)) {}
  async run(req: SubscriptionRunRequest) {
    this.calls.push(req);
    const data = this.script(req, this.calls.length);
    return { data, model: this.provider === 'CLAUDE_SUBSCRIPTION' ? 'claude-test' : 'codex-test', usage: { inputTokens: 100, outputTokens: 50 }, durationMs: 5, rateLimit: null };
  }
}
const kindOf = (req: SubscriptionRunRequest) => {
  const p = (req.jsonSchema as { properties: Record<string, unknown> }).properties;
  return p.ok ? 'test' : p.prospect_summary ? 'research' : p.checks ? 'quality' : p.variants ? 'variants' : p.angles ? 'angles' : 'text';
};
function variantsFor(tag: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({ subject: `${tag} subject ${i + 1}`, body: `Hi Jane,\nI noticed your clinic added pediatric care (${tag} angle ${i + 1}).\nWould more family enquiries help?`, pain_point: 'few enquiries from new families', angle: `angle ${i + 1}`, reasoning: 'r' }));
}
function countFrom(req: SubscriptionRunRequest) { return Number(req.system.match(/exactly (\d+)/)?.[1] ?? 3); }
function defaultScript(provider: string): Script {
  const tag = provider === 'CLAUDE_SUBSCRIPTION' ? 'claude' : 'codex';
  return (req) => {
    switch (kindOf(req)) {
      case 'test': return { ok: true };
      case 'research': return { prospect_summary: 'Family clinic', business_model: 'Clinic', observations: [{ text: 'Added pediatric care', verified: true, source: 'https://clinic.example/pediatrics' }, { text: 'Busy', verified: true, source: '' }], assumptions: [], pain_point: 'few enquiries', business_opportunity: 'family campaigns', personalization_angle: 'pediatric care', research_sources: ['https://clinic.example/pediatrics'] };
      case 'quality': { const n = countFrom(req); return { variants: variantsFor(`${tag}-final`, n), checks: Array.from({ length: n }, (_, i) => ({ variant: i + 1, genuine_observation: true, relevant_pain_point: true, sounds_human: true, concise: true, sendable: true, invented_personalization: false, soft_question_ending: true, follows_playbook: true, issues: [] })), notes: '' }; }
      case 'variants': return { variants: variantsFor(tag, countFrom(req)), notes: '' };
      default: return { text: 'ok' };
    }
  };
}

class FakeCodexCli implements CodexCli {
  method: string | null = 'ChatGPT';
  loggedIn = true;
  loggedOut = 0;
  async status() { return { loggedIn: this.loggedIn, method: this.loggedIn ? this.method : null, raw: '' }; }
  async logout() { this.loggedOut++; this.loggedIn = false; }
  startDeviceLogin(onUpdate: (u: DeviceLoginUpdate) => void) {
    setTimeout(() => onUpdate({ state: 'PENDING', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345', expiresAt: new Date(Date.now() + 900_000) }), 5);
    setTimeout(() => { this.loggedIn = true; onUpdate({ state: 'SUCCEEDED' }); }, 30);
    return { cancel: () => undefined };
  }
}

let fakes: ReturnType<typeof installFakes>;
let claude: FakeRunner;
let codex: FakeRunner;
let cli: FakeCodexCli;
let s: Session;
const api = (path: string) => `/api/v1${path}`;
const ws = (path: string) => api(`/w/${s.workspaceId}${path}`);

async function makeOwner(sess: Session) {
  await db().user.update({ where: { id: sess.userId }, data: { platformRole: 'SUPER_ADMIN', mfaEnabled: true } });
}

/** Run queued AI jobs exactly like the worker does (real BullMQ queues, real handlers). */
async function drain(max = 60) {
  const names: QueueName[] = [QUEUES.aiClaude, QUEUES.aiCodex, QUEUES.aiApi];
  for (let i = 0; i < max; i++) {
    let jobs = [] as Awaited<ReturnType<ReturnType<typeof queue>['getJobs']>>;
    for (const n of names) jobs = jobs.concat(await queue(n).getJobs(['waiting', 'delayed', 'prioritized']));
    if (!jobs.length) return;
    for (const job of jobs) {
      if ((await job.getState()) === 'delayed' && job.opts.delay && job.opts.delay > 30_000) continue; // long provider spacing: leave it
      await job.remove();
      await HANDLERS[job.queueName as QueueName][job.name](job as never); // the worker's own handler
    }
  }
}

async function connectBoth() {
  const r1 = await s.agent.post(api('/ai-subscriptions/claude/connect')).set('x-csrf-token', s.csrf).send({ token: TOKEN });
  expect(r1.status).toBe(200);
  const r2 = await s.agent.post(api('/ai-subscriptions/codex/login')).set('x-csrf-token', s.csrf).send({});
  expect(r2.status).toBe(200);
  await new Promise((r) => setTimeout(r, 80));
  for (const p of ['CLAUDE_SUBSCRIPTION', 'CODEX_SUBSCRIPTION']) await s.agent.put(api(`/ai-subscriptions/${p}/settings`)).set('x-csrf-token', s.csrf).send({ delayMs: 0 });
}

async function presetId(key: string) {
  const r = await s.agent.get(api('/ai-workflows'));
  return r.body.workflows.find((w: { presetKey: string }) => w.presetKey === key).id as string;
}

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
  codex = new FakeRunner('CODEX_SUBSCRIPTION');
  cli = new FakeCodexCli();
  cli.loggedIn = false;
  subs.setSubscriptionDeps({ claudeRunner: () => claude, codexRunner: () => codex, codexCli: () => cli });
  for (const n of [QUEUES.aiClaude, QUEUES.aiCodex, QUEUES.aiApi]) { await queue(n).resume(); await queue(n).obliterate({ force: true }); }
  s = await createUserSession(OWNER);
  await makeOwner(s);
});

describe('owner-only access (server-side)', () => {
  it('hides every subscription route from non-owners, API keys and owners without 2FA', async () => {
    const other = await createUserSession('member@other.test');
    const admin = await createUserSession('staff@other.test');
    await db().user.update({ where: { id: admin.userId }, data: { platformRole: 'SUPER_ADMIN', mfaEnabled: true } }); // staff, but not the listed owner
    for (const sess of [other, admin]) {
      expect((await sess.agent.get(api('/ai-subscriptions/access'))).body.allowed).toBe(false);
      for (const [m, p] of [['get', '/ai-subscriptions/connections'], ['get', '/ai-workflows'], ['get', '/ai-playbook'], ['get', `/w/${sess.workspaceId}/ai-queue`], ['post', '/ai-subscriptions/claude/connect']] as const) {
        const r = m === 'get' ? await sess.agent.get(api(p)) : await sess.agent.post(api(p)).set('x-csrf-token', sess.csrf).send({ token: TOKEN });
        expect(r.status, `${m} ${p}`).toBe(404);
      }
    }
    expect((await s.agent.get(api('/ai-subscriptions/access'))).body.allowed).toBe(true);
    // Owner without two-factor sign-in is refused too.
    await db().user.update({ where: { id: s.userId }, data: { mfaEnabled: false } });
    expect((await s.agent.get(api('/ai-subscriptions/connections'))).status).toBe(404);
    // Feature off when no owner is configured.
    await db().user.update({ where: { id: s.userId }, data: { mfaEnabled: true } });
    process.env.AI_SUBSCRIPTION_OWNER_EMAILS = '';
    expect((await s.agent.get(api('/ai-subscriptions/connections'))).status).toBe(404);
    process.env.AI_SUBSCRIPTION_OWNER_EMAILS = OWNER;
  });

  it('instance-wide mode: every account gets its own subscriptions, but never while sign-up is open', async () => {
    process.env.AI_SUBSCRIPTION_ACCESS = 'all';
    process.env.REGISTRATION_OPEN = 'false';
    try {
      const second = await createUserSession('second-account@other.test'); // no staff role, no 2FA
      expect((await second.agent.get(api('/ai-subscriptions/access'))).body.allowed).toBe(true);
      const c = await second.agent.post(api('/ai-subscriptions/claude/connect')).set('x-csrf-token', second.csrf).send({ token: TOKEN });
      expect(c.body.connection.status).toBe('CONNECTED');
      // Connections are per account: the first account still has none.
      const mine = await s.agent.get(api('/ai-subscriptions/connections'));
      expect(mine.body.connections.find((x: { provider: string }) => x.provider === 'CLAUDE_SUBSCRIPTION').status).toBe('DISCONNECTED');
      expect((await second.agent.get(api('/ai-workflows'))).body.workflows).toHaveLength(6);
      process.env.REGISTRATION_OPEN = 'true'; // public sign-up → the feature switches itself off
      expect((await second.agent.get(api('/ai-subscriptions/connections'))).status).toBe(404);
    } finally {
      delete process.env.AI_SUBSCRIPTION_ACCESS;
      delete process.env.REGISTRATION_OPEN;
    }
  });

  it('refuses API keys even when created by the owner', async () => {
    const k = await s.agent.post(ws('/api-keys')).set('x-csrf-token', s.csrf).send({ name: 'k', role: 'ADMIN', scopes: [] });
    const key = k.body.key ?? k.body.token ?? k.body.secret;
    expect(typeof key).toBe('string');
    const { default: request } = await import('supertest');
    const { getApp } = await import('../helpers/harness.js');
    const r = await request(getApp()).get(api(`/w/${s.workspaceId}/ai-queue`)).set('authorization', `Bearer ${key}`);
    expect(r.status).toBe(404);
  });
});

describe('connections', () => {
  it('connects Claude with a setup-token, stores it encrypted, never returns it', async () => {
    const bad = await s.agent.post(api('/ai-subscriptions/claude/connect')).set('x-csrf-token', s.csrf).send({ token: 'sk-ant-api03-notASubscriptionTokenAtAll1234567890' });
    expect(bad.status).toBe(400);
    const r = await s.agent.post(api('/ai-subscriptions/claude/connect')).set('x-csrf-token', s.csrf).send({ token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.test.ok).toBe(true);
    expect(r.body.connection.status).toBe('CONNECTED');
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    const list = await s.agent.get(api('/ai-subscriptions/connections'));
    expect(JSON.stringify(list.body)).not.toContain(TOKEN);
    expect(JSON.stringify(list.body)).not.toContain('encryptedCredential');
    const row = await db().aiSubscriptionConnection.findFirstOrThrow({ where: { provider: 'CLAUDE_SUBSCRIPTION' } });
    expect(row.encryptedCredential).toBeTruthy();
    expect(row.encryptedCredential).not.toContain(TOKEN);
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 360 * 86_400_000);
    const audit = await db().platformAuditEvent.findMany({ where: { action: { startsWith: 'ai_subscription.' } } });
    expect(audit.map((a) => a.action)).toContain('ai_subscription.connected');
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
  });

  it('marks Claude expired when the token is rejected, and disconnect removes the credential', async () => {
    claude.script = () => { throw new SubscriptionError('AUTH', 'Claude rejected the subscription token (expired or revoked).'); };
    const r = await s.agent.post(api('/ai-subscriptions/claude/connect')).set('x-csrf-token', s.csrf).send({ token: TOKEN });
    expect(r.body.test.ok).toBe(false);
    expect(r.body.connection.status).toBe('EXPIRED');
    const d = await s.agent.delete(api('/ai-subscriptions/CLAUDE_SUBSCRIPTION')).set('x-csrf-token', s.csrf);
    expect(d.status).toBe(200);
    const row = await db().aiSubscriptionConnection.findFirstOrThrow({ where: { provider: 'CLAUDE_SUBSCRIPTION' } });
    expect(row.status).toBe('DISCONNECTED');
    expect(row.encryptedCredential).toBeNull();
    expect((await db().platformAuditEvent.count({ where: { action: 'ai_subscription.disconnected' } }))).toBe(1);
  });

  it('connects Codex through the device-code sign-in and refuses an API-key sign-in', async () => {
    const r = await s.agent.post(api('/ai-subscriptions/codex/login')).set('x-csrf-token', s.csrf).send({});
    expect(r.status).toBe(200);
    expect(r.body.login).toMatchObject({ state: 'PENDING', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345' });
    await new Promise((res) => setTimeout(res, 80));
    const st = await s.agent.get(api('/ai-subscriptions/codex/login'));
    expect(st.body.login.state).toBe('SUCCEEDED');
    expect(st.body.connection.status).toBe('CONNECTED');
    // Test connection when Codex is signed in with an API key instead of ChatGPT.
    cli.method = 'an API key';
    const t = await s.agent.post(api('/ai-subscriptions/CODEX_SUBSCRIPTION/test')).set('x-csrf-token', s.csrf).send({});
    expect(t.body.ok).toBe(false);
    expect(t.body.error).toMatch(/not ChatGPT/);
    cli.method = 'ChatGPT';
    const d = await s.agent.delete(api('/ai-subscriptions/CODEX_SUBSCRIPTION')).set('x-csrf-token', s.csrf);
    expect(d.status).toBe(200);
    expect(cli.loggedOut).toBe(1);
  });

  it('both subscriptions can be connected at the same time', async () => {
    await connectBoth();
    const list = await s.agent.get(api('/ai-subscriptions/connections'));
    expect(list.body.connections.map((c: { status: string }) => c.status)).toEqual(['CONNECTED', 'CONNECTED']);
  });
});

describe('workflows and playbook', () => {
  it('creates the six presets once, and custom workflows can be created, reordered, duplicated and activated', async () => {
    const r = await s.agent.get(api('/ai-workflows'));
    expect(r.body.workflows.map((w: { presetKey: string }) => w.presetKey).sort()).toEqual(['api_only', 'claude_only', 'claude_then_codex', 'codex_only', 'codex_then_claude', 'custom_example']);
    expect(r.body.workflows.find((w: { isDefault: boolean }) => w.isDefault).presetKey).toBe('custom_example');
    expect((await s.agent.get(api('/ai-workflows'))).body.workflows).toHaveLength(6);
    const example = r.body.workflows.find((w: { presetKey: string }) => w.presetKey === 'custom_example');
    expect(example.stages.map((x: { provider: string }) => x.provider)).toEqual(['CLAUDE_SUBSCRIPTION', 'CLAUDE_SUBSCRIPTION', 'CODEX_SUBSCRIPTION', 'CLAUDE_SUBSCRIPTION']);

    // A stage may only read from an earlier stage: reordering that breaks this is rejected.
    const reversed = [...example.stages].reverse();
    const bad = await s.agent.post(api('/ai-workflows')).set('x-csrf-token', s.csrf).send({ name: 'Bad', stages: reversed });
    expect(bad.status).toBe(400);
    const custom = { name: 'Codex research then Claude writes', stages: [{ ...example.stages[0], provider: 'CODEX_SUBSCRIPTION', name: 'Research (Codex)' }, { ...example.stages[1], instructions: 'Keep it under 60 words.' }] };
    const created = await s.agent.post(api('/ai-workflows')).set('x-csrf-token', s.csrf).send(custom);
    expect(created.status).toBe(201);
    const edited = await s.agent.put(api(`/ai-workflows/${created.body.id}`)).set('x-csrf-token', s.csrf).send({ ...custom, stages: [custom.stages[0], { ...custom.stages[1], enabled: false }, { ...example.stages[3], inputs: ['stage:research', 'previous', 'playbook'] }] });
    expect(edited.status).toBe(200);
    expect(edited.body.version).toBe(2);
    const dup = await s.agent.post(api(`/ai-workflows/${created.body.id}/duplicate`)).set('x-csrf-token', s.csrf);
    expect(dup.body.name).toMatch(/copy/);
    expect((await s.agent.post(api(`/ai-workflows/${created.body.id}/activate`)).set('x-csrf-token', s.csrf)).status).toBe(200);
    expect((await s.agent.delete(api(`/ai-workflows/${created.body.id}`)).set('x-csrf-token', s.csrf)).status).toBe(400); // active one
    const tpl = await s.agent.post(api('/ai-stage-templates')).set('x-csrf-token', s.csrf).send({ name: 'My humanizer', stage: example.stages[2] });
    expect(tpl.status).toBe(201);
    expect((await s.agent.get(api('/ai-stage-templates'))).body.templates).toHaveLength(1);
  });

  it('seeds the playbook from ai/playbook/cold-email.md, versions edits and restores', async () => {
    const r = await s.agent.get(api('/ai-playbook'));
    expect(r.body.current.version).toBe(1);
    expect(r.body.current.content).toContain('We do NOT offer LinkedIn marketing.');
    const saved = await s.agent.post(api('/ai-playbook')).set('x-csrf-token', s.csrf).send({ content: `${r.body.current.content}\n\nNever use the word "synergy".`, note: 'no synergy' });
    expect(saved.body.version.version).toBe(2);
    const restored = await s.agent.post(api(`/ai-playbook/versions/${r.body.current.id}/restore`)).set('x-csrf-token', s.csrf);
    expect(restored.body.version.version).toBe(3);
    expect(restored.body.version.content).not.toContain('synergy');
    const h = await s.agent.get(api('/ai-playbook'));
    expect(h.body.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
  });
});

describe('generation runs', () => {
  let leadId: string;
  beforeEach(async () => {
    await connectBoth();
    const company = await db().company.create({ data: { workspaceId: s.workspaceId, name: 'Sunrise Clinic', website: 'https://clinic.example', domain: 'clinic.example' } });
    leadId = (await addLead(s.workspaceId, 'jane@clinic.example', { companyId: company.id, title: 'Owner' })).id;
  });

  async function runWith(body: Record<string, unknown>) {
    const r = await s.agent.post(ws('/ai-runs')).set('x-csrf-token', s.csrf).send({ leadId, ...body });
    expect(r.status).toBe(201);
    await drain();
    return (await s.agent.get(ws(`/ai-runs/${r.body.id}`))).body;
  }

  it('Claude only, Codex only, Claude → Codex and Codex → Claude each produce three distinct variants with the right provider per stage', async () => {
    const claudeOnly = await runWith({ mode: 'claude' });
    expect(claudeOnly.status).toBe('SUCCEEDED');
    expect(claudeOnly.executions.map((e: { provider: string }) => e.provider)).toEqual(['CLAUDE_SUBSCRIPTION', 'CLAUDE_SUBSCRIPTION']);
    expect(new Set(claudeOnly.variants.map((v: { body: string }) => v.body)).size).toBe(3);
    expect(claudeOnly.research.pain_point).toBe('few enquiries');
    // A "verified" observation without a source URL is downgraded to an assumption.
    expect(claudeOnly.research.observations.find((o: { text: string }) => o.text === 'Busy').verified).toBe(false);

    const codexOnly = await runWith({ mode: 'codex' });
    expect(codexOnly.status).toBe('SUCCEEDED');
    expect(codexOnly.executions.every((e: { provider: string }) => e.provider === 'CODEX_SUBSCRIPTION')).toBe(true);

    const ct = await runWith({ workflowId: await presetId('claude_then_codex') });
    expect(ct.executions.map((e: { provider: string }) => e.provider)).toEqual(['CLAUDE_SUBSCRIPTION', 'CLAUDE_SUBSCRIPTION', 'CODEX_SUBSCRIPTION']);
    expect(ct.variants[0].subject).toMatch(/^codex/); // humanized by Codex
    expect(ct.stageOutputs.drafting.output.variants[0].subject).toMatch(/^claude/); // original kept
    const tc = await runWith({ workflowId: await presetId('codex_then_claude') });
    expect(tc.executions.map((e: { provider: string }) => e.provider)).toEqual(['CODEX_SUBSCRIPTION', 'CODEX_SUBSCRIPTION', 'CLAUDE_SUBSCRIPTION']);

    // The humanization stage received the research and the drafted variants as inputs.
    const humanizeCall = codex.calls.find((c) => c.system.includes('Email humanization'))!;
    expect(humanizeCall.prompt).toContain('Output of stage "Prospect research"');
    expect(humanizeCall.prompt).toContain('Output of stage "Email drafting"');
    expect(fakes.openai.calls.length + fakes.anthropic.calls.length).toBe(0); // no paid API was used
  });

  it('runs the four-stage example and a custom workflow that mixes in an existing API provider', async () => {
    const example = await runWith({});
    expect(example.status).toBe('SUCCEEDED');
    expect(example.executions.map((e: { stageName: string }) => e.stageName)).toEqual(['Prospect research', 'Email drafting', 'Humanization', 'Quality review']);
    expect(example.variants).toHaveLength(3);
    expect(example.variants[0].checks.soft_question_ending).toBe(true);

    await addAiProvider(s.workspaceId, 'OPENAI', 'gpt-test');
    fakes.openai.on('email_variants_json', (req) => ({ variants: variantsFor('openai', Number(req.system.match(/exactly (\d+)/)?.[1] ?? 3)), notes: '' }));
    const wfRes = await s.agent.get(api('/ai-workflows'));
    const ex = wfRes.body.workflows.find((w: { presetKey: string }) => w.presetKey === 'custom_example');
    const custom = await s.agent.post(api('/ai-workflows')).set('x-csrf-token', s.csrf).send({ name: 'Mixed', stages: [ex.stages[0], { ...ex.stages[1], provider: 'API:OPENAI', allowWebResearch: false, temperature: 0.7 }] });
    const mixed = await runWith({ workflowId: custom.body.id });
    expect(mixed.status).toBe('SUCCEEDED');
    expect(mixed.executions.map((e: { provider: string }) => e.provider)).toEqual(['CLAUDE_SUBSCRIPTION', 'API:OPENAI']);
    expect(fakes.openai.calls[0].temperature).toBe(0.7);
    expect(await db().aiExecution.count({ where: { workspaceId: s.workspaceId, provider: 'OPENAI', status: 'SUCCEEDED' } })).toBe(1);
  });

  it('playbook changes affect the next generation', async () => {
    const pb = await s.agent.get(api('/ai-playbook'));
    await s.agent.post(api('/ai-playbook')).set('x-csrf-token', s.csrf).send({ content: `${pb.body.current.content}\n\nSign off with "Cheers, Arjun".` });
    claude.calls = [];
    await runWith({ mode: 'claude' });
    expect(claude.calls.find((c) => c.system.includes('Cold email generation'))!.prompt).toContain('Cheers, Arjun');
  });

  it('pauses on a usage limit with the exact message, never falls back to a paid API, and resumes only when asked', async () => {
    await addAiProvider(s.workspaceId, 'OPENAI', 'gpt-test');
    codex.script = () => { throw new SubscriptionError('USAGE_LIMIT', 'Codex usage limit reached', new Date(Date.now() + 3600_000), 'weekly'); };
    const run = await runWith({ mode: 'codex' });
    expect(run.status).toBe('PAUSED_LIMIT');
    expect(run.pausedReason).toBe('Codex usage limit reached — workflow paused.');
    expect(fakes.openai.calls).toHaveLength(0);
    const conn = await db().aiSubscriptionConnection.findFirstOrThrow({ where: { provider: 'CODEX_SUBSCRIPTION' } });
    expect(conn.status).toBe('USAGE_LIMITED');
    // Still limited: a retry pauses again rather than calling anything else.
    await s.agent.post(ws(`/ai-runs/${run.id}/resume`)).set('x-csrf-token', s.csrf).send({});
    await drain();
    expect((await s.agent.get(ws(`/ai-runs/${run.id}`))).body.status).toBe('PAUSED_LIMIT');
    // The owner explicitly picks Claude for the paused stage.
    const r = await s.agent.post(ws(`/ai-runs/${run.id}/resume`)).set('x-csrf-token', s.csrf).send({ stageProvider: 'CLAUDE_SUBSCRIPTION' });
    expect(r.status).toBe(200);
    await drain();
    const after = (await s.agent.get(ws(`/ai-runs/${run.id}`))).body;
    expect(after.executions.map((e: { provider: string; status: string }) => `${e.provider}:${e.status}`)).toContain('CLAUDE_SUBSCRIPTION:SUCCEEDED');
    expect(fakes.openai.calls).toHaveLength(0);
    expect((await db().platformAuditEvent.count({ where: { action: 'ai_workflow.stage_provider_override' } }))).toBe(1);
  });

  it('auto-resumes a limited run only when the owner asked for it and the limit has reset', async () => {
    let limited = true;
    claude.script = (req, n) => { if (limited) throw new SubscriptionError('USAGE_LIMIT', 'Claude usage limit reached', new Date(Date.now() - 1000), 'five_hour'); return defaultScript('CLAUDE_SUBSCRIPTION')(req, n); };
    const run = await runWith({ mode: 'claude' });
    expect(run.pausedReason).toBe('Claude usage limit reached — workflow paused.');
    limited = false;
    await subs.refreshLimits(); // limit reset, but autoResume was not requested
    await drain();
    expect((await s.agent.get(ws(`/ai-runs/${run.id}`))).body.status).toBe('PAUSED_LIMIT');
    await s.agent.post(ws(`/ai-runs/${run.id}/resume`)).set('x-csrf-token', s.csrf).send({ autoResume: true });
    await db().aiSubscriptionConnection.updateMany({ where: { provider: 'CLAUDE_SUBSCRIPTION' }, data: { status: 'USAGE_LIMITED', limitResetsAt: new Date(Date.now() - 1000) } });
    await subs.refreshLimits();
    await drain();
    expect((await s.agent.get(ws(`/ai-runs/${run.id}`))).body.status).toBe('SUCCEEDED');
  });

  it('a disconnected subscription pauses the workflow instead of switching provider; skip-if-unavailable skips the stage', async () => {
    await s.agent.delete(api('/ai-subscriptions/CLAUDE_SUBSCRIPTION')).set('x-csrf-token', s.csrf);
    const run = await runWith({ mode: 'claude' });
    expect(run.status).toBe('PAUSED');
    expect(run.pausedReason).toMatch(/Claude is unavailable/);
    expect(codex.calls.filter((c) => kindOf(c) !== 'test')).toHaveLength(0);

    const wfRes = await s.agent.get(api('/ai-workflows'));
    const ct = wfRes.body.workflows.find((w: { presetKey: string }) => w.presetKey === 'codex_then_claude');
    const wf = await s.agent.post(api('/ai-workflows')).set('x-csrf-token', s.csrf).send({ name: 'Optional Claude polish', stages: ct.stages.map((x: { id: string }) => (x.id === 'humanize' ? { ...x, condition: 'skip_if_provider_unavailable' } : x)) });
    const run2 = await runWith({ workflowId: wf.body.id });
    expect(run2.status).toBe('SUCCEEDED');
    expect(run2.stageOutputs.humanize.status).toBe('SKIPPED');
    expect(run2.variants[0].subject).toMatch(/^codex/);
  });

  it('retries with backoff, honours continue-on-error and fails cleanly after the last attempt', async () => {
    let fails = 1;
    claude.script = (req, n) => { if (kindOf(req) === 'research' && fails-- > 0) throw new SubscriptionError('FAILED', 'transient'); return defaultScript('CLAUDE_SUBSCRIPTION')(req, n); };
    const r = await runWith({ mode: 'claude' });
    expect(r.status).toBe('SUCCEEDED');
    expect(r.executions.filter((e: { stageName: string }) => e.stageName === 'Prospect research').map((e: { attempt: number; status: string }) => `${e.attempt}:${e.status}`)).toEqual(['1:FAILED', '2:SUCCEEDED']);
    claude.script = () => { throw new SubscriptionError('FAILED', 'always broken'); };
    const f = await runWith({ mode: 'claude' });
    expect(f.status).toBe('FAILED');
    expect(f.error).toMatch(/always broken/);
  });

  it('per-provider spacing re-queues the next stage with a delay instead of running it early', async () => {
    await s.agent.put(api('/ai-subscriptions/CLAUDE_SUBSCRIPTION/settings')).set('x-csrf-token', s.csrf).send({ delayMs: 120_000, concurrency: 1 });
    const r = await s.agent.post(ws('/ai-runs')).set('x-csrf-token', s.csrf).send({ leadId, mode: 'claude' });
    await drain();
    const run = (await s.agent.get(ws(`/ai-runs/${r.body.id}`))).body;
    expect(run.status).toBe('QUEUED');
    expect(run.currentStage).toBe(1); // research done, drafting waits for the spacing
    const delayed = await queue(QUEUES.aiClaude).getJobs(['delayed']);
    expect(delayed).toHaveLength(1);
    expect(delayed[0].id).toMatch(/^aiwf-delay_/);
    expect(delayed[0].opts.delay).toBeGreaterThan(100_000);
  });

  it('pause and resume a run', async () => {
    const r = await s.agent.post(ws('/ai-runs')).set('x-csrf-token', s.csrf).send({ leadId, mode: 'claude' });
    expect((await s.agent.post(ws(`/ai-runs/${r.body.id}/pause`)).set('x-csrf-token', s.csrf)).status).toBe(200);
    await drain();
    const paused = (await s.agent.get(ws(`/ai-runs/${r.body.id}`))).body;
    expect(paused.status).toBe('PAUSED');
    expect(paused.executions).toHaveLength(0);
    await s.agent.post(ws(`/ai-runs/${r.body.id}/resume`)).set('x-csrf-token', s.csrf).send({});
    await drain();
    expect((await s.agent.get(ws(`/ai-runs/${r.body.id}`))).body.status).toBe('SUCCEEDED');
  });

  it('variants can be edited, selected, regenerated one at a time and saved as a draft (nothing is sent)', async () => {
    const run = await runWith({ mode: 'claude' });
    const e = await s.agent.put(ws(`/ai-runs/${run.id}/variants/1`)).set('x-csrf-token', s.csrf).send({ subject: 'Quick question', body: 'Hi Jane,\nEdited body.\nWorth a chat?' });
    expect(e.body.edited).toBe(true);
    expect(e.body.history).toHaveLength(1);
    await s.agent.post(ws(`/ai-runs/${run.id}/variants/1/select`)).set('x-csrf-token', s.csrf);
    const before = (await s.agent.get(ws(`/ai-runs/${run.id}`))).body.variants[2].body;
    claude.script = () => ({ variants: [{ subject: 'Fresh angle', body: 'Hi Jane,\nA new angle.\nUseful?', pain_point: 'p', angle: 'new', reasoning: 'r' }], notes: '' });
    expect((await s.agent.post(ws(`/ai-runs/${run.id}/variants/2/regenerate`)).set("x-csrf-token", s.csrf)).status).toBe(202);
    await drain();
    const regen = (await s.agent.get(ws(`/ai-runs/${run.id}`))).body;
    expect(regen.variants[2].subject).toBe('Fresh angle');
    expect(regen.variants[2].history[0].body).toBe(before);
    expect(regen.variants[1].subject).toBe('Quick question');
    const lastCall = claude.calls[claude.calls.length - 1];
    expect(lastCall.prompt).toContain('Existing variants');
    const d = await s.agent.post(ws(`/ai-runs/${run.id}/draft`)).set('x-csrf-token', s.csrf).send({});
    expect(d.body.draft).toMatchObject({ variantIndex: 1, subject: 'Quick question' });
    expect(await db().outboundEmail.count()).toBe(0);
    expect(fakes.gmail.sent.length + fakes.graph.sent.length + fakes.smtp.sent.length).toBe(0);
  });

  it('queue dashboard lists counts, executions and paused runs; global queue pause works', async () => {
    codex.script = () => { throw new SubscriptionError('USAGE_LIMIT', 'Codex usage limit reached'); };
    await runWith({ mode: 'codex' });
    await runWith({ mode: 'claude' });
    const d = await s.agent.get(ws('/ai-queue'));
    expect(d.status).toBe(200);
    expect(d.body.counts.SUCCEEDED).toBe(1);
    expect(d.body.counts.PAUSED_LIMIT).toBe(1);
    expect(d.body.paused[0].pausedReason).toBe('Codex usage limit reached — workflow paused.');
    expect(d.body.executions[0]).toMatchObject({ provider: expect.any(String), stageName: expect.any(String), status: expect.any(String), attempt: 1 });
    expect(d.body.executions[0].run.lead.email).toBe('jane@clinic.example');
    expect((await s.agent.post(api('/ai-queue/pause')).set('x-csrf-token', s.csrf)).body.paused).toBe(true);
    expect((await s.agent.get(ws('/ai-queue'))).body.queues.every((q: { paused: boolean }) => q.paused)).toBe(true);
    await s.agent.post(api('/ai-queue/resume')).set('x-csrf-token', s.csrf);
  });

  it('credentials never appear in responses, execution logs or run records', async () => {
    claude.script = () => { throw new SubscriptionError('FAILED', `upstream said Bearer ${TOKEN} was bad and key ${TOKEN}`); };
    const run = await runWith({ mode: 'claude' });
    const all = JSON.stringify([run, (await s.agent.get(ws('/ai-queue'))).body, (await s.agent.get(api('/ai-subscriptions/connections'))).body, await db().aiWorkflowStageExecution.findMany(), await db().aiWorkflowRun.findMany(), await db().platformAuditEvent.findMany(), await db().jobRun.findMany()]);
    expect(all).not.toContain(TOKEN);
    expect(all).toContain('[token]');
  });

  it('a run whose stage was claimed by a crashed worker is re-queued once on restart; the stale job is ignored', async () => {
    const r = await s.agent.post(ws('/ai-runs')).set('x-csrf-token', s.csrf).send({ leadId, mode: 'claude' });
    const [job] = await queue(QUEUES.aiClaude).getJobs(['waiting']);
    // Simulate a worker that claimed the stage and died.
    await db().aiWorkflowRun.update({ where: { id: r.body.id }, data: { status: 'RUNNING', jobToken: `run:${job.data.token}` } });
    await job.remove();
    const rec = await runs.recoverAiRuns();
    expect(rec.requeued).toBe(1);
    expect(await runs.processStageJob(job.data)).toMatchObject({ skipped: expect.stringMatching(/superseded/) }); // BullMQ's stalled retry, if any
    await drain();
    const after = (await s.agent.get(ws(`/ai-runs/${r.body.id}`))).body;
    expect(after.status).toBe('SUCCEEDED');
    expect(claude.calls.filter((c) => kindOf(c) === 'research')).toHaveLength(1);
  });

  it('generateEmail(prospect, options, provider) works for Claude, Codex and an API provider', async () => {
    await addAiProvider(s.workspaceId, 'OPENAI', 'gpt-test');
    fakes.openai.on('email_variants_json', () => ({ variants: variantsFor('openai', 2), notes: '' }));
    const p = { ownerUserId: s.userId, workspaceId: s.workspaceId, leadId };
    for (const [provider, tag] of [['CLAUDE_SUBSCRIPTION', 'claude'], ['CODEX_SUBSCRIPTION', 'codex'], ['API:OPENAI', 'openai']] as const) {
      const r = await runs.generateEmail(p, { variants: 2 }, provider);
      expect(r.provider).toBe(provider);
      expect(r.variants).toHaveLength(2);
      expect(r.variants[0].subject).toMatch(new RegExp(`^${tag}`));
    }
  });
});
