import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { ProviderError, type FetchLike } from '../http.js';

// SSRF-safe page fetcher for company research. Only http/https on ports 80/443, rejects private,
// loopback, link-local and metadata addresses, re-validates every redirect, caps size and time.
// Note: DNS can change between check and connect (rebinding); the server should additionally block
// private egress at the firewall for full protection (see deployment/README).

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return false;
}

export async function assertPublicUrl(raw: string, resolver: Resolver = defaultResolver): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ProviderError('fetcher', 'invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ProviderError('fetcher', 'only http/https allowed');
  if (u.port && u.port !== '80' && u.port !== '443') throw new ProviderError('fetcher', 'non-standard port blocked');
  if (u.username || u.password) throw new ProviderError('fetcher', 'credentials in URL blocked');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : await resolver(host).catch(() => []);
  if (addrs.length === 0) throw new ProviderError('fetcher', 'host did not resolve (DNS failure)', undefined, false, undefined, 'DNS_FAILURE');
  if (addrs.some(isPrivateAddress)) throw new ProviderError('fetcher', 'private or reserved address blocked');
  return u;
}

export interface FetchedPage { url: string; status: number; title: string | null; text: string; links: string[]; publishedAt?: Date }

export function htmlToText(html: string): { title: string | null; text: string; links: string[] } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
  const links = [...html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|br|section|article|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  return { title, text, links };
}

function robotsPathMatches(pattern: string, path: string): boolean {
  const endAnchored = pattern.endsWith('$');
  const parts = (endAnchored ? pattern.slice(0, -1) : pattern).split('*');
  const first = parts.shift()!;
  if (!path.startsWith(first)) return false;
  if (!parts.length) return !endAnchored || path === first;

  const suffix = endAnchored ? parts.pop()! : '';
  if (endAnchored && !path.endsWith(suffix)) return false;
  const end = path.length - suffix.length;
  let offset = first.length;
  for (const part of parts) {
    const found = path.indexOf(part, offset);
    if (found < 0 || found + part.length > end) return false;
    offset = found + part.length;
  }
  return offset <= end;
}

export function isRestrictedResearchHost(host: string): boolean {
  return /(^|\.)(linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com|youtube\.com|youtu\.be)$/i.test(host.replace(/\.$/, ''));
}

const RESEARCH_PRODUCT = 'EMN-Outreach-OS-Research';

type RequestTrace = { finalUrl: string; httpStatus: number | null };
type FetchRejection = {
  requestedUrl: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  reason: string;
  robotsUrl?: string | null;
  robotsHttpStatus?: number | null;
};

function safeLogUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin + url.pathname : null;
  } catch { return null; }
}

function normalizeRulePath(value: string): string {
  return value.replace(/%[\da-f]{2}|[^\x00-\x7f]/giu, (part) => {
    if (!part.startsWith('%')) return encodeURIComponent(part);
    const char = String.fromCharCode(parseInt(part.slice(1), 16));
    return /^[a-z0-9._~-]$/i.test(char) ? char : part.toUpperCase();
  });
}

function evaluateRobots(body: string, url: URL, userAgent: string) {
  const product = userAgent.trim().split(/[\s/]/, 1)[0].toLowerCase();
  const path = url.pathname + url.search;
  const normalizedPath = normalizeRulePath(path);
  let applies = false;
  let hasAgent = false;
  let hasRules = false;
  let malformed = /[\u0000\ufffd]/u.test(body);
  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const line = rawLine.split('#', 1)[0].trim();
    if (!line) continue;
    const record = /^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i.exec(line);
    if (!record) { malformed = true; continue; }
    const [, field, value] = record;
    const key = field.toLowerCase();
    if (key === 'user-agent') {
      if (hasRules) { applies = false; hasRules = false; }
      hasAgent = true;
      if (!value) malformed = true;
      const agent = value.toLowerCase();
      // Preserve the existing wildcard and legacy crawler restrictions.
      applies ||= agent === '*' || agent === product || agent.includes('emn-outreach');
    } else if (key === 'allow' || key === 'disallow') {
      hasRules = true;
      if (!hasAgent || (value && !value.startsWith('/'))) malformed = true;
      if (applies && key === 'disallow' && value &&
          (robotsPathMatches(value, path) || robotsPathMatches(normalizeRulePath(value), normalizedPath))) return 'ROBOTS_DISALLOWED';
    }
  }
  return malformed ? 'ROBOTS_MALFORMED' : null;
}

export class SafeFetcher {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly resolver: Resolver = defaultResolver,
    private readonly opts = { timeoutMs: 10_000, maxBytes: 2_000_000, maxChars: 30_000, maxRedirects: 3, userAgent: `${RESEARCH_PRODUCT}/1.0 (+company research; respects robots)` },
    private readonly logRejection: (entry: FetchRejection) => void = () => {},
  ) {}

  private async checkRobots(url: URL) {
    const robots: RequestTrace = { finalUrl: new URL('/robots.txt', url).href, httpStatus: null };
    let reason: string | null;
    try {
      const result = await this.raw(robots.finalUrl, 0, robots);
      if (result.status === 404 || result.status === 410) return;
      if (result.status < 200 || result.status >= 300) reason = 'ROBOTS_HTTP_ERROR';
      else if (result.truncated || result.status === 206 || /html/i.test(result.contentType)) reason = 'ROBOTS_MALFORMED';
      else reason = evaluateRobots(result.body, url, this.opts.userAgent);
    } catch (error) {
      reason = error instanceof ProviderError && error.code ? `ROBOTS_${error.code}` : 'ROBOTS_REQUEST_FAILED';
    }
    if (!reason) return;

    const status = robots.httpStatus ?? undefined;
    const detail = reason === 'ROBOTS_DISALLOWED' ? 'disallowed by robots.txt'
      : reason === 'ROBOTS_MALFORMED' ? 'robots.txt response is malformed or incomplete'
      : reason === 'ROBOTS_HTTP_ERROR' ? `robots.txt retrieval failed (HTTP ${status})`
      : reason === 'ROBOTS_TIMEOUT' ? 'robots.txt retrieval timed out'
      : reason === 'ROBOTS_DNS_FAILURE' ? 'robots.txt retrieval failed (DNS failure)'
      : 'robots.txt retrieval failed';
    const error = new ProviderError('fetcher', detail, status, false, undefined, reason);
    Object.assign(error, { robotsUrl: safeLogUrl(robots.finalUrl), robotsHttpStatus: robots.httpStatus });
    throw error;
  }

  private async raw(url: string, depth: number, trace: RequestTrace, pageRequest = false): Promise<{ url: string; status: number; body: string; contentType: string; truncated: boolean }> {
    trace.finalUrl = url;
    trace.httpStatus = null;
    if (isRestrictedResearchHost(new URL(url).hostname)) throw new ProviderError('fetcher', 'automated access unavailable for this platform');
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startDeadline = () => { timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs); };
    startDeadline();
    try {
      const u = await Promise.race([
        assertPublicUrl(url, this.resolver),
        new Promise<never>((_, reject) => ctrl.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })),
      ]);
      u.hash = '';
      trace.finalUrl = u.href;
      if (pageRequest) {
        clearTimeout(timer);
        await this.checkRobots(u);
        startDeadline();
      }
      const res = await this.fetchImpl(u.toString(), { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': this.opts.userAgent, accept: 'text/html,text/plain,application/xml,text/xml' } });
      trace.httpStatus = res.status;
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (depth >= this.opts.maxRedirects) throw new ProviderError('fetcher', 'too many redirects', res.status, false, undefined, 'REDIRECT_LIMIT');
        let destination: URL;
        try { destination = new URL(res.headers.get('location')!, u); }
        catch { throw new ProviderError('fetcher', 'invalid redirect location', res.status, false, undefined, 'INVALID_REDIRECT'); }
        await res.body?.cancel();
        clearTimeout(timer);
        return this.raw(destination.href, depth + 1, trace, pageRequest);
      }
      const contentType = res.headers.get('content-type') ?? '';
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > this.opts.maxBytes) { await reader.cancel(); break; }
          chunks.push(value);
        }
      }
      return { url: u.toString(), status: res.status, body: Buffer.concat(chunks).toString('utf8'), contentType, truncated: size > this.opts.maxBytes };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const cause = (e as { cause?: { code?: string } } | null)?.cause?.code;
      if (ctrl.signal.aborted || cause === 'UND_ERR_CONNECT_TIMEOUT' || cause === 'ETIMEDOUT') {
        throw new ProviderError('fetcher', 'timeout', undefined, false, undefined, 'TIMEOUT');
      }
      if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') {
        throw new ProviderError('fetcher', 'DNS failure', undefined, false, undefined, 'DNS_FAILURE');
      }
      throw new ProviderError('fetcher', 'network request failed', undefined, false, undefined, 'NETWORK_FAILURE');
    } finally { clearTimeout(timer); }
  }

  async fetchPage(url: string): Promise<FetchedPage> {
    const trace: RequestTrace = { finalUrl: url, httpStatus: null };
    try {
      return await this.fetchPageWithTrace(url, trace);
    } catch (error) {
      const rejection = error instanceof ProviderError ? error : new ProviderError('fetcher', 'invalid URL or redirect');
      const robots = rejection as ProviderError & Pick<FetchRejection, 'robotsUrl' | 'robotsHttpStatus'>;
      this.logRejection({
        requestedUrl: safeLogUrl(url), finalUrl: safeLogUrl(trace.finalUrl), httpStatus: trace.httpStatus,
        reason: rejection.code ?? rejection.message,
        ...(robots.robotsUrl !== undefined ? { robotsUrl: robots.robotsUrl, robotsHttpStatus: robots.robotsHttpStatus } : {}),
      });
      throw rejection;
    }
  }

  private async fetchPageWithTrace(url: string, trace: RequestTrace): Promise<FetchedPage> {
    const r = await this.raw(url, 0, trace, true);
    if (r.status < 200 || r.status >= 300) this.logRejection({
      requestedUrl: safeLogUrl(url), finalUrl: safeLogUrl(r.url), httpStatus: r.status, reason: 'PAGE_HTTP_ERROR',
    });
    if (/\/sitemap[^/]*\.xml$/i.test(new URL(r.url).pathname) && /(?:application|text)\/xml/i.test(r.contentType)) {
      const links = [...r.body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].slice(0, 100).map((match) => match[1].replace(/&amp;/g, '&'));
      return { url: r.url, status: r.status, title: null, text: '', links };
    }
    if (!/text\/html|text\/plain|application\/xhtml/i.test(r.contentType) && r.contentType) throw new ProviderError('fetcher', 'unsupported page content type');
    const publishedMeta = [...r.body.matchAll(/<meta\b[^>]*>/gi)].find(([tag]) =>
      /(?:property|name)\s*=\s*["'](?:article:published_time|datePublished)["']/i.test(tag));
    const publishedValue = publishedMeta?.[0].match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
    const publishedAt = publishedValue && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(publishedValue) ? new Date(publishedValue) : undefined;
    const { title, text, links } = htmlToText(r.body);
    return { url: r.url, status: r.status, title, text: text.slice(0, this.opts.maxChars), links, ...(publishedAt && Number.isFinite(publishedAt.getTime()) ? { publishedAt } : {}) };
  }
}
