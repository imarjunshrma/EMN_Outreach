import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ClaudeSubscriptionRunner, looksLikeClaudeOAuthToken } from '../../integrations/src/ai/subscription/claude-agent.js';
import { CodexSubscriptionRunner, classifyCodexError, codexCli, type CodexCli } from '../../integrations/src/ai/subscription/codex.js';
import { SubscriptionError, parseJsonReply, scrubSecrets } from '../../integrations/src/ai/subscription/types.js';

// Adapter behaviour against scripted SDK event streams. Event shapes mirror what the official SDKs emit
// (the Claude 401 sequence was captured from @anthropic-ai/claude-agent-sdk 0.3.330 with an invalid token).

const TOKEN = `sk-ant-oat01-${'x'.repeat(40)}`;
const req = { system: 'sys', prompt: 'p', jsonSchema: { type: 'object' }, allowWeb: false, timeoutMs: 5_000 };

function claudeWith(messages: Array<Record<string, unknown>>, capture?: (o: Record<string, unknown>) => void, throwAtEnd?: string) {
  return new ClaudeSubscriptionRunner({
    token: TOKEN, homeDir: '/tmp/emn-unit-claude',
    queryFn: ({ options }) => { capture?.(options); return (async function* () { for (const m of messages) yield m; if (throwAtEnd) throw new Error(throwAtEnd); })(); },
  });
}

describe('Claude subscription runner (Agent SDK)', () => {
  it('passes only the OAuth token — never ANTHROPIC_API_KEY — and returns structured output', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-should-never-be-passed-1234567890';
    let opts: Record<string, unknown> = {};
    const r = await claudeWith([
      { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1_900_000_000, rateLimitType: 'five_hour', utilization: 0.82 } },
      { type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { ok: true }, usage: { input_tokens: 10, output_tokens: 3 } },
    ], (o) => { opts = o; }).run({ ...req, allowWeb: true });
    delete process.env.ANTHROPIC_API_KEY;
    const env = opts.env as Record<string, string>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.keys(env)).not.toContain('DATABASE_URL');
    expect(opts.tools).toEqual(['WebSearch', 'WebFetch']);
    expect(opts.settingSources).toEqual([]);
    expect(opts.persistSession).toBe(false);
    expect(opts.permissionMode).toBe('dontAsk');
    expect(r.data).toEqual({ ok: true });
    expect(r.model).toBe('claude-sonnet-5-5');
    expect(r.rateLimit).toMatchObject({ status: 'allowed_warning', type: 'five_hour', utilization: 0.82 });
    expect(r.rateLimit!.resetsAt!.getTime()).toBe(1_900_000_000_000);
  });

  it('maps the real 401 sequence to an AUTH (expired/revoked) error', async () => {
    const run = claudeWith([
      { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' },
      { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 549, error_status: 401, error: 'authentication_failed' },
    ], undefined, 'Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token is invalid.');
    await expect(run.run(req)).rejects.toMatchObject({ kind: 'AUTH' });
  });

  it('maps a rejected rate-limit event to USAGE_LIMIT with the reset time', async () => {
    const e = await claudeWith([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_900_000_000, rateLimitType: 'seven_day' } }]).run(req).catch((x) => x);
    expect(e).toBeInstanceOf(SubscriptionError);
    expect(e.kind).toBe('USAGE_LIMIT');
    expect(e.limitType).toBe('seven_day');
    expect(e.resetsAt.getTime()).toBe(1_900_000_000_000);
  });

  it('maps assistant errors and failed results', async () => {
    await expect(claudeWith([{ type: 'assistant', error: 'rate_limit', message: {} }]).run(req)).rejects.toMatchObject({ kind: 'USAGE_LIMIT' });
    await expect(claudeWith([{ type: 'assistant', error: 'overloaded', message: {} }]).run(req)).rejects.toMatchObject({ kind: 'FAILED' });
    await expect(claudeWith([{ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, errors: ['bad json'] }]).run(req)).rejects.toMatchObject({ kind: 'OUTPUT' });
    await expect(claudeWith([]).run(req)).rejects.toMatchObject({ kind: 'FAILED' });
  });

  it('recognises setup-token tokens and rejects API keys', () => {
    expect(looksLikeClaudeOAuthToken(TOKEN)).toBe(true);
    expect(looksLikeClaudeOAuthToken('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe(false);
  });
});

function fakeCli(method: string | null): CodexCli {
  return { status: async () => ({ loggedIn: !!method, method, raw: '' }), logout: async () => undefined, startDeviceLogin: () => ({ cancel: () => undefined }) };
}
function codexWith(events: Array<Record<string, unknown>>, method: string | null = 'ChatGPT', capture?: (o: Record<string, unknown>, env: Record<string, string>) => void) {
  return new CodexSubscriptionRunner({
    codexHome: '/tmp/emn-unit-codex/.codex', cli: fakeCli(method),
    codexFactory: ({ env }) => ({ startThread: (o) => { capture?.(o, env); return { runStreamed: async () => ({ events: (async function* () { for (const e of events) yield e; })() }) }; } }),
  });
}

describe('Codex subscription runner (Codex SDK / CLI)', () => {
  it('runs read-only with a ChatGPT sign-in, no API key, and returns the structured answer', async () => {
    process.env.OPENAI_API_KEY = 'sk-should-not-pass-0000000000000';
    let threadOpts: Record<string, unknown> = {};
    let env: Record<string, string> = {};
    const r = await codexWith([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' }, // non-fatal
      { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: '{"ok":true}' } },
      { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } },
    ], 'ChatGPT', (o, e) => { threadOpts = o; env = e; }).run({ ...req, reasoningEffort: 'low' });
    delete process.env.OPENAI_API_KEY;
    expect(r.data).toEqual({ ok: true });
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    expect(threadOpts).toMatchObject({ sandboxMode: 'read-only', approvalPolicy: 'never', skipGitRepoCheck: true, webSearchMode: 'disabled', modelReasoningEffort: 'low' });
    expect(env.CODEX_HOME).toBe('/tmp/emn-unit-codex/.codex');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
  });

  it('refuses to run when Codex is signed out or signed in with an API key', async () => {
    await expect(codexWith([], null).run(req)).rejects.toMatchObject({ kind: 'AUTH' });
    await expect(codexWith([], 'an API key').run(req)).rejects.toMatchObject({ kind: 'AUTH' });
  });

  it('classifies usage limits and auth failures from Codex error text', async () => {
    await expect(codexWith([{ type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 5:00 PM." } }]).run(req)).rejects.toMatchObject({ kind: 'USAGE_LIMIT' });
    await expect(codexWith([{ type: 'error', message: 'usage_limit_reached' }]).run(req)).rejects.toMatchObject({ kind: 'USAGE_LIMIT' });
    expect(classifyCodexError('ChatGPT account ID not available, please re-run `codex login`').kind).toBe('AUTH');
    expect(classifyCodexError('stream disconnected').kind).toBe('FAILED');
  });

  it('parses the device-code prompt printed by `codex login --device-auth`', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => undefined;
    const cli = codexCli('/tmp/emn-unit-codex/.codex', { binary: '/usr/bin/codex', spawnFn: () => child as never });
    const updates: unknown[] = [];
    cli.startDeviceLogin((u) => updates.push(u));
    // Text as embedded in the codex 0.171.0 binary.
    child.stdout.write('\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   7KQ2-MXP4Z\n');
    await new Promise((r) => setTimeout(r, 10));
    child.emit('close', 0);
    expect(updates[0]).toMatchObject({ state: 'PENDING', verificationUrl: 'https://auth.openai.com/codex/device', userCode: '7KQ2-MXP4Z' });
    expect(updates[1]).toEqual({ state: 'SUCCEEDED' });
  });
});

describe('helpers', () => {
  it('scrubs tokens, keys and JWTs', () => {
    const s = scrubSecrets(`token ${TOKEN} key sk-proj-abcdefghijklmnop jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij Bearer abcdefghijklmnopqrstu`);
    expect(s).not.toContain(TOKEN);
    expect(s).not.toContain('sk-proj-abcdefghijklmnop');
    expect(s).not.toContain('eyJhbGci');
    expect(s).toContain('Bearer [secret]');
  });
  it('extracts JSON from fenced or surrounded replies', () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('Here you go: {"a":2} thanks')).toEqual({ a: 2 });
    expect(() => parseJsonReply('no json')).toThrow(SubscriptionError);
  });
});
