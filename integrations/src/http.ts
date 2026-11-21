// Small fetch wrapper used by every external adapter: timeouts, retries on transient errors,
// Retry-After support and a typed error that never contains credentials.

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
    public readonly code?: string,
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
      const err = new ProviderError(opts.provider, `HTTP ${res.status}: ${body.slice(0, 300)}`, res.status, isRetryableStatus(res.status), retryAfter);
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
