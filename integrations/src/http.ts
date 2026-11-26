// Small fetch wrapper used by every external adapter: timeouts, retries on transient errors,
// Retry-After support and a typed error that never contains credentials.

export type SubmissionOutcome = 'DEFINITELY_NOT_SENT' | 'PROVIDER_REJECTED' | 'ACCEPTED' | 'UNKNOWN_OUTCOME';

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
    public readonly code?: string,
    public readonly submissionOutcome?: SubmissionOutcome,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
  }
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  provider: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retries?: number;
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (!Number.isNaN(secs)) return secs * 1000;
  const date = Date.parse(h);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function providerErrorDetails(body: string): { message: string; code?: string } {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; code?: unknown }; message?: unknown; code?: unknown };
    const source = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed;
    const message = typeof source.message === 'string' ? source.message : 'request rejected';
    const code = typeof source.code === 'string' ? source.code : undefined;
    // Provider error payloads can include echoed generations or request data; keep only the
    // short human-readable message and machine code, and mask credentials if echoed there.
    return { message: message.slice(0, 240).replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]').replace(/((?:api[_-]?key|token|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]'), code };
  } catch {
    return { message: body ? 'request rejected with a non-JSON error response' : 'request rejected' };
  }
}

export async function httpRequest(url: string, init: RequestInit, opts: HttpOptions): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
    try {
      const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
      if (res.ok) return res;
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      const body = await res.text().catch(() => '');
      const details = providerErrorDetails(body);
      const err = new ProviderError(opts.provider, `HTTP ${res.status}${details.code ? ` ${details.code}` : ''}: ${details.message}`, res.status, isRetryableStatus(res.status), retryAfter, details.code);
      if (!err.retryable || attempt === retries) throw err;
      lastErr = err;
      await sleep(Math.min(retryAfter ?? 500 * 2 ** attempt, 10_000));
    } catch (e) {
      if (e instanceof ProviderError) {
        if (!e.retryable || attempt === retries) throw e;
        lastErr = e;
        continue;
      }
      const msg = (e as Error).name === 'AbortError' ? 'request timed out' : (e as Error).message;
      lastErr = new ProviderError(opts.provider, `network error: ${msg}`, undefined, true);
      if (attempt === retries) throw lastErr;
      await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function httpJson<T>(url: string, init: RequestInit, opts: HttpOptions): Promise<T> {
  const res = await httpRequest(url, init, opts);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}
