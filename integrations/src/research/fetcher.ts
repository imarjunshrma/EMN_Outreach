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
  if (addrs.length === 0) throw new ProviderError('fetcher', 'host did not resolve');
  if (addrs.some(isPrivateAddress)) throw new ProviderError('fetcher', 'private or reserved address blocked');
  return u;
}

export interface FetchedPage { url: string; status: number; title: string | null; text: string; links: string[] }

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

export class SafeFetcher {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly resolver: Resolver = defaultResolver,
    private readonly opts = { timeoutMs: 10_000, maxBytes: 2_000_000, maxChars: 30_000, maxRedirects: 3, userAgent: 'EMN-Outreach-OS-Research/1.0 (+company research; respects robots)' },
  ) {}

  async robotsAllows(u: URL): Promise<boolean> {
    try {
      const r = await this.raw(new URL('/robots.txt', u).toString(), 0);
      if (r.status >= 400) return true;
      let applies = false;
      for (const line of r.body.split('\n')) {
        const [k, ...rest] = line.split(':');
        const key = k.trim().toLowerCase();
        const val = rest.join(':').trim();
        if (key === 'user-agent') applies = val === '*' || val.toLowerCase().includes('emn-outreach');
        if (applies && key === 'disallow' && val && u.pathname.startsWith(val)) return false;
      }
      return true;
    } catch { return true; }
  }

  private async raw(url: string, depth: number): Promise<{ url: string; status: number; body: string; contentType: string }> {
    const u = await assertPublicUrl(url, this.resolver);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    try {
      const res = await this.fetchImpl(u.toString(), { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': this.opts.userAgent, accept: 'text/html,text/plain' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (depth >= this.opts.maxRedirects) throw new ProviderError('fetcher', 'too many redirects');
        return this.raw(new URL(res.headers.get('location')!, u).toString(), depth + 1);
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
      return { url: u.toString(), status: res.status, body: Buffer.concat(chunks).toString('utf8'), contentType };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('fetcher', (e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message);
    } finally { clearTimeout(t); }
  }

  async fetchPage(url: string): Promise<FetchedPage> {
    const u = await assertPublicUrl(url, this.resolver);
    if (!(await this.robotsAllows(u))) throw new ProviderError('fetcher', 'disallowed by robots.txt');
    const r = await this.raw(u.toString(), 0);
    if (!/text\/html|text\/plain|application\/xhtml/i.test(r.contentType) && r.contentType) throw new ProviderError('fetcher', `unsupported content-type ${r.contentType}`);
    const { title, text, links } = htmlToText(r.body);
    return { url: r.url, status: r.status, title, text: text.slice(0, this.opts.maxChars), links };
  }
}
