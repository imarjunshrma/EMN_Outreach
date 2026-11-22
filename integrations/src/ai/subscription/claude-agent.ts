import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SubscriptionError, parseJsonReply, scrubSecrets, type RateLimitInfo, type SubscriptionRunRequest, type SubscriptionRunResult, type SubscriptionRunner } from './types.js';

// Claude — My Subscription, through the official @anthropic-ai/claude-agent-sdk (which runs the official
// Claude Code binary). Authentication: CLAUDE_CODE_OAUTH_TOKEN produced by `claude setup-token`, passed only
// in the child process environment. The SDK's `env` option REPLACES process.env, so ANTHROPIC_API_KEY and any
// other server secret are never inherited and requests cannot silently bill a paid API key.

type QueryFn = (p: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>;

const PASS_THROUGH_ENV = ['PATH', 'LANG', 'TZ', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];

export interface ClaudeRunnerOptions {
  token: string;
  /** Private directory for the Claude Code child process (HOME and CLAUDE_CONFIG_DIR live here). */
  homeDir: string;
  executablePath?: string | null;
  queryFn?: QueryFn;
}

export class ClaudeSubscriptionRunner implements SubscriptionRunner {
  readonly provider = 'CLAUDE_SUBSCRIPTION' as const;
  constructor(private readonly o: ClaudeRunnerOptions) {}

  private env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const k of PASS_THROUGH_ENV) if (process.env[k]) env[k] = process.env[k] as string;
    env.HOME = this.o.homeDir;
    env.CLAUDE_CONFIG_DIR = join(this.o.homeDir, '.claude');
    env.CLAUDE_CODE_OAUTH_TOKEN = this.o.token;
    env.CLAUDE_AGENT_SDK_CLIENT_APP = 'emn-outreach-os';
    env.DISABLE_AUTOUPDATER = '1';
    return env;
  }

  async run(req: SubscriptionRunRequest): Promise<SubscriptionRunResult> {
    const queryFn: QueryFn = this.o.queryFn ?? ((await import('@anthropic-ai/claude-agent-sdk')).query as unknown as QueryFn);
    const workDir = join(this.o.homeDir, 'work');
    mkdirSync(join(this.o.homeDir, '.claude'), { recursive: true, mode: 0o700 });
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), req.timeoutMs);
    req.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    const tools = req.allowWeb ? ['WebSearch', 'WebFetch'] : [];
    const started = Date.now();
    let rateLimit: RateLimitInfo | null = null;
    let classified: SubscriptionError | null = null;
    let result: Record<string, unknown> | null = null;
    let model: string | null = req.model ?? null;
    try {
      const stream = queryFn({
        prompt: req.prompt,
        options: {
          env: this.env(),
          systemPrompt: req.system,
          tools, allowedTools: tools, permissionMode: 'dontAsk',
          settingSources: [], persistSession: false,
          maxTurns: req.allowWeb ? 30 : 4,
          cwd: workDir,
          outputFormat: { type: 'json_schema', schema: req.jsonSchema },
          ...(req.model ? { model: req.model } : {}),
          ...(this.o.executablePath ? { pathToClaudeCodeExecutable: this.o.executablePath } : {}),
          abortController: ac,
          stderr: () => undefined, // never log the child's stderr verbatim (it can echo environment details)
        },
      });
      for await (const m of stream) {
        if (m.type === 'system' && m.subtype === 'init' && typeof m.model === 'string') model = m.model;
        if (m.type === 'rate_limit_event') {
          const r = m.rate_limit_info as { status: RateLimitInfo['status']; resetsAt?: number; rateLimitType?: string; utilization?: number };
          rateLimit = { status: r.status, resetsAt: r.resetsAt ? new Date(r.resetsAt * (r.resetsAt < 1e12 ? 1000 : 1)) : null, type: r.rateLimitType ?? null, utilization: r.utilization ?? null };
          if (r.status === 'rejected') { classified = new SubscriptionError('USAGE_LIMIT', 'Claude usage limit reached', rateLimit.resetsAt, rateLimit.type); ac.abort(); break; }
        }
        if (m.type === 'system' && m.subtype === 'api_retry' && (m.error_status === 401 || m.error === 'authentication_failed')) {
          classified = new SubscriptionError('AUTH', 'Claude rejected the subscription token (expired or revoked). Run `claude setup-token` and reconnect.'); ac.abort(); break;
        }
        if (m.type === 'assistant' && typeof m.error === 'string') {
          const err = m.error;
          if (err === 'authentication_failed' || err === 'oauth_org_not_allowed' || err === 'account_on_hold' || err === 'verification_required') classified = new SubscriptionError('AUTH', `Claude subscription authentication failed (${err}). Reconnect Claude.`);
          else if (err === 'rate_limit' || err === 'billing_error') classified = new SubscriptionError('USAGE_LIMIT', 'Claude usage limit reached', rateLimit?.resetsAt ?? null, rateLimit?.type ?? err);
          else if (err === 'model_not_found' || err === 'invalid_request') classified = new SubscriptionError('FAILED', `Claude rejected the request (${err})`);
          else classified = new SubscriptionError('FAILED', `Claude returned an error (${err})`);
        }
        if (m.type === 'result') { result = m; break; }
      }
    } catch (e) {
      if (!classified) {
        const msg = scrubSecrets((e as Error).message ?? String(e));
        if (ac.signal.aborted && Date.now() - started >= req.timeoutMs - 50) throw new SubscriptionError('TIMEOUT', `Claude did not finish within ${Math.round(req.timeoutMs / 1000)} s`);
        if (/401|authenticat|oauth/i.test(msg)) throw new SubscriptionError('AUTH', 'Claude rejected the subscription token (expired or revoked). Run `claude setup-token` and reconnect.');
        if (/rate.?limit|usage limit|429/i.test(msg)) throw new SubscriptionError('USAGE_LIMIT', 'Claude usage limit reached', rateLimit?.resetsAt ?? null, rateLimit?.type ?? null);
        if (/ENOENT|spawn|executable/i.test(msg)) throw new SubscriptionError('UNAVAILABLE', `The Claude Code executable could not start: ${msg}`);
        throw new SubscriptionError('FAILED', msg);
      }
    } finally {
      clearTimeout(timer);
    }
    if (classified) throw classified;
    if (!result) {
      if (ac.signal.aborted) throw new SubscriptionError('TIMEOUT', `Claude did not finish within ${Math.round(req.timeoutMs / 1000)} s`);
      throw new SubscriptionError('FAILED', 'Claude ended without a result');
    }
    if (result.subtype !== 'success' || result.is_error) {
      const errors = Array.isArray(result.errors) ? (result.errors as string[]).join('; ') : String(result.result ?? result.subtype);
      if (/401|authenticat/i.test(errors)) throw new SubscriptionError('AUTH', 'Claude rejected the subscription token (expired or revoked). Reconnect Claude.');
      throw new SubscriptionError(result.subtype === 'error_max_structured_output_retries' ? 'OUTPUT' : 'FAILED', scrubSecrets(`Claude run failed: ${result.subtype}${errors ? ` — ${errors}` : ''}`));
    }
    const data = result.structured_output !== undefined && result.structured_output !== null ? result.structured_output : parseJsonReply(String(result.result ?? ''));
    const u = result.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined;
    return {
      data, model, durationMs: Date.now() - started, rateLimit,
      usage: u ? { inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0 } : null,
    };
  }
}

/** Shape check only: tokens from `claude setup-token` start with sk-ant-oat. The real check is a test call. */
export function looksLikeClaudeOAuthToken(token: string): boolean {
  return /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/.test(token.trim());
}
