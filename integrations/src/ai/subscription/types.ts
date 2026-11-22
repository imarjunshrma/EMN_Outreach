// Personal-subscription AI runners (Claude via the official Agent SDK, Codex via the official Codex SDK/CLI).
// They never call model HTTP APIs directly and never receive API keys: authentication is the subscription's
// own supported mechanism (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`; Codex ChatGPT sign-in in CODEX_HOME).

export interface SubscriptionRunRequest {
  system: string;
  prompt: string;
  /** Strict JSON Schema for the final answer. */
  jsonSchema: Record<string, unknown>;
  model?: string | null;
  /** Allow read-only web research (Claude: WebSearch/WebFetch tools; Codex: live web search). */
  allowWeb: boolean;
  timeoutMs: number;
  /** Codex only. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | null;
  signal?: AbortSignal;
}

export interface RateLimitInfo { status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt: Date | null; type: string | null; utilization: number | null }

export interface SubscriptionRunResult {
  data: unknown;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  durationMs: number;
  rateLimit: RateLimitInfo | null;
}

export class SubscriptionError extends Error {
  constructor(public readonly kind: 'AUTH' | 'USAGE_LIMIT' | 'UNAVAILABLE' | 'TIMEOUT' | 'OUTPUT' | 'FAILED', message: string, public readonly resetsAt: Date | null = null, public readonly limitType: string | null = null) {
    super(message);
  }
  get retryable() { return this.kind === 'FAILED' || this.kind === 'OUTPUT' || this.kind === 'TIMEOUT'; }
}

export interface SubscriptionRunner {
  readonly provider: 'CLAUDE_SUBSCRIPTION' | 'CODEX_SUBSCRIPTION';
  run(req: SubscriptionRunRequest): Promise<SubscriptionRunResult>;
}

/** Strip anything that looks like a credential before an error message is stored or logged. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[token]')
    .replace(/\b(sk|rk|pk)[-_][A-Za-z0-9_-]{12,}/g, '[secret]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[jwt]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [secret]')
    .slice(0, 1000);
}

/** Pull the first JSON object out of a model reply (used when a provider returns text around the JSON). */
export function parseJsonReply(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* fall through */ } }
  const start = t.indexOf('{'); const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch { /* fall through */ } }
  throw new SubscriptionError('OUTPUT', 'The provider did not return valid JSON');
}
