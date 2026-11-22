import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SubscriptionError, parseJsonReply, scrubSecrets, type SubscriptionRunRequest, type SubscriptionRunResult, type SubscriptionRunner } from './types.js';

// Codex — My ChatGPT Subscription, through the official @openai/codex-sdk, which drives the official
// `codex exec` binary. Authentication is the Codex CLI's own ChatGPT sign-in (`codex login --device-auth`),
// cached by Codex in CODEX_HOME/auth.json and refreshed by Codex itself. We never read that file, never pass
// an API key (`apiKey` is never set; OPENAI_API_KEY / CODEX_API_KEY are not inherited because `env` replaces
// process.env), and refuse to run when `codex login status` reports anything other than a ChatGPT sign-in.

const PASS_THROUGH_ENV = ['PATH', 'LANG', 'TZ', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'CODEX_CA_CERTIFICATE'];

export function codexEnv(codexHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_THROUGH_ENV) if (process.env[k]) env[k] = process.env[k] as string;
  env.HOME = dirname(codexHome);
  env.CODEX_HOME = codexHome;
  return env;
}

/** Path of the codex binary: CODEX_PATH, else the one shipped with @openai/codex (dependency of @openai/codex-sdk). */
export function resolveCodexBinary(override?: string | null): string {
  if (override) return override;
  const req = createRequire(import.meta.url);
  try {
    const pkg = req.resolve('@openai/codex/package.json', { paths: [dirname(req.resolve('@openai/codex-sdk'))] });
    const bin = join(dirname(pkg), 'bin', 'codex.js');
    if (existsSync(bin)) return bin;
  } catch { /* fall back to PATH */ }
  return 'codex';
}

type SpawnFn = (cmd: string, args: string[], opts: { env: Record<string, string>; stdio: ['ignore', 'pipe', 'pipe'] }) => ChildProcess;

export interface CodexCli {
  status(): Promise<{ loggedIn: boolean; method: string | null; raw: string }>;
  logout(): Promise<void>;
  startDeviceLogin(onUpdate: (u: DeviceLoginUpdate) => void): { cancel: () => void };
}
export type DeviceLoginUpdate =
  | { state: 'PENDING'; verificationUrl: string; userCode: string; expiresAt: Date }
  | { state: 'SUCCEEDED' }
  | { state: 'FAILED'; error: string };

function runCli(bin: string, args: string[], env: Record<string, string>, spawnFn: SpawnFn, timeoutMs = 30_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const [cmd, cmdArgs] = bin.endsWith('.js') ? [process.execPath, [bin, ...args]] : [bin, args];
    const child = spawnFn(cmd, cmdArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d) => { out += String(d); });
    child.stderr?.on('data', (d) => { out += String(d); });
    const t = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (e) => { clearTimeout(t); resolve({ code: 127, out: e.message }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, out }); });
  });
}

export function codexCli(codexHome: string, opts: { binary?: string | null; spawnFn?: SpawnFn } = {}): CodexCli {
  const bin = resolveCodexBinary(opts.binary);
  const spawnFn: SpawnFn = opts.spawnFn ?? ((c, a, o) => spawn(c, a, o));
  const env = () => { mkdirSync(codexHome, { recursive: true, mode: 0o700 }); return codexEnv(codexHome); };
  return {
    async status() {
      const r = await runCli(bin, ['login', 'status'], env(), spawnFn);
      const raw = scrubSecrets(r.out.replace(/WARNING: proceeding, even though[^\n]*\n?/g, '').trim());
      const m = raw.match(/Logged in using ([A-Za-z][A-Za-z -]*)/);
      return { loggedIn: r.code === 0 && !!m, method: m ? m[1].trim() : null, raw: raw.slice(0, 300) };
    },
    async logout() { await runCli(bin, ['logout'], env(), spawnFn); },
    startDeviceLogin(onUpdate) {
      const [cmd, args] = bin.endsWith('.js') ? [process.execPath, [bin, 'login', '--device-auth']] : [bin, ['login', '--device-auth']];
      const child = spawnFn(cmd, args, { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      let announced = false;
      let done = false;
      const onData = (d: unknown) => {
        // eslint-disable-next-line no-control-regex -- strip ANSI colour codes from the CLI output
        buf += String(d).replace(/\u001b\[[0-9;]*m/g, '');
        if (announced) return;
        const url = buf.match(/https:\/\/[^\s]+/)?.[0];
        const code = buf.match(/\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\b/)?.[1];
        if (url && code) {
          announced = true;
          const mins = Number(buf.match(/expires in (\d+) minutes?/)?.[1] ?? 15);
          onUpdate({ state: 'PENDING', verificationUrl: url, userCode: code, expiresAt: new Date(Date.now() + mins * 60_000) });
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (e) => { if (!done) { done = true; onUpdate({ state: 'FAILED', error: scrubSecrets(e.message) }); } });
      child.on('close', (code) => {
        if (done) return;
        done = true;
        if (code === 0) onUpdate({ state: 'SUCCEEDED' });
        else {
          const tail = buf.trim().split('\n').slice(-3).join(' ');
          const hint = /not enabled/i.test(buf) ? ' Turn on device code sign-in in your ChatGPT security settings, or sign in from the server shell (see the deployment guide).' : '';
          onUpdate({ state: 'FAILED', error: scrubSecrets(`Codex sign-in did not complete: ${tail || `exit ${code}`}.${hint}`) });
        }
      });
      return { cancel: () => { if (!done) { done = true; child.kill('SIGTERM'); onUpdate({ state: 'FAILED', error: 'Sign-in cancelled' }); } } };
    },
  };
}

export function classifyCodexError(message: string): SubscriptionError {
  const msg = scrubSecrets(message);
  if (/usage limit|usage_limit_reached|rate_limit_exceeded|hit your usage limit/i.test(msg)) {
    const reset = msg.match(/try again (?:at|in) ([^.]+)/i)?.[1] ?? null;
    return new SubscriptionError('USAGE_LIMIT', 'Codex usage limit reached', null, reset);
  }
  if (/re-run `?codex login`?|not logged in|401|unauthori[sz]ed|refresh token|token (?:has )?expired|sign in again/i.test(msg)) return new SubscriptionError('AUTH', 'Codex is not signed in to ChatGPT or the sign-in expired. Reconnect Codex.');
  if (/ENOENT|spawn/i.test(msg)) return new SubscriptionError('UNAVAILABLE', `The Codex executable could not start: ${msg}`);
  return new SubscriptionError('FAILED', msg);
}

interface CodexThreadLike {
  runStreamed(input: string, opts: { outputSchema?: unknown; signal?: AbortSignal }): Promise<{ events: AsyncIterable<Record<string, unknown>> }>;
}
interface CodexLike { startThread(o: Record<string, unknown>): CodexThreadLike }

export interface CodexRunnerOptions {
  codexHome: string;
  binary?: string | null;
  /** Inject a fake Codex for tests. */
  codexFactory?: (o: { env: Record<string, string>; codexPathOverride?: string }) => CodexLike;
  cli?: CodexCli;
}

export class CodexSubscriptionRunner implements SubscriptionRunner {
  readonly provider = 'CODEX_SUBSCRIPTION' as const;
  constructor(private readonly o: CodexRunnerOptions) {}

  async run(req: SubscriptionRunRequest): Promise<SubscriptionRunResult> {
    const cli = this.o.cli ?? codexCli(this.o.codexHome, { binary: this.o.binary });
    const st = await cli.status();
    if (!st.loggedIn) throw new SubscriptionError('AUTH', 'Codex is not signed in. Connect Codex with your ChatGPT account.');
    if (st.method !== 'ChatGPT') throw new SubscriptionError('AUTH', `Codex is signed in with "${st.method}", not a ChatGPT subscription. Disconnect and sign in with ChatGPT.`);
    const workDir = join(this.o.codexHome, 'work');
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const env = codexEnv(this.o.codexHome);
    const factory = this.o.codexFactory ?? (async () => {
      const { Codex } = await import('@openai/codex-sdk');
      return (o: { env: Record<string, string>; codexPathOverride?: string }) => new Codex(o) as unknown as CodexLike;
    })();
    const make = typeof factory === 'function' ? factory : await factory;
    const codex = make({ env, ...(this.o.binary ? { codexPathOverride: this.o.binary } : {}) });
    const thread = codex.startThread({
      sandboxMode: 'read-only', approvalPolicy: 'never', skipGitRepoCheck: true, workingDirectory: workDir,
      networkAccessEnabled: false, webSearchMode: req.allowWeb ? 'live' : 'disabled',
      ...(req.model ? { model: req.model } : {}),
      ...(req.reasoningEffort ? { modelReasoningEffort: req.reasoningEffort } : {}),
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), req.timeoutMs);
    req.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    const started = Date.now();
    let finalText = '';
    let usage: SubscriptionRunResult['usage'] = null;
    try {
      const prompt = `${req.system}\n\n---\n\n${req.prompt}`;
      const { events } = await thread.runStreamed(prompt, { outputSchema: req.jsonSchema, signal: ac.signal });
      for await (const e of events) {
        if (e.type === 'item.completed' && (e.item as { type?: string })?.type === 'agent_message') finalText = String((e.item as { text?: string }).text ?? '');
        if (e.type === 'turn.completed') { const u = e.usage as { input_tokens?: number; output_tokens?: number } | undefined; usage = u ? { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 } : null; }
        if (e.type === 'turn.failed') throw classifyCodexError(String((e.error as { message?: string })?.message ?? 'Codex turn failed'));
        // Top-level `error` events include non-fatal "Reconnecting..." notices; only usage-limit/auth errors stop the run.
        if (e.type === 'error') {
          const c = classifyCodexError(String(e.message ?? ''));
          if (c.kind === 'USAGE_LIMIT' || c.kind === 'AUTH') throw c;
        }
      }
    } catch (e) {
      if (e instanceof SubscriptionError) throw e;
      if (ac.signal.aborted) throw new SubscriptionError('TIMEOUT', `Codex did not finish within ${Math.round(req.timeoutMs / 1000)} s`);
      throw classifyCodexError((e as Error).message ?? String(e));
    } finally {
      clearTimeout(timer);
    }
    if (!finalText) throw new SubscriptionError('OUTPUT', 'Codex finished without an answer');
    return { data: parseJsonReply(finalText), model: req.model ?? null, usage, durationMs: Date.now() - started, rateLimit: null };
  }
}
