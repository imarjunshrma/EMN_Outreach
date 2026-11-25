import { describe, expect, it, vi } from 'vitest';
import { SafeFetcher, type Resolver } from '../../integrations/src/research/fetcher.js';

const publicDns: Resolver = async () => ['93.184.216.34'];
const origin = 'https://site.example';
const opts = { timeoutMs: 100, maxBytes: 512_000, maxChars: 500, maxRedirects: 3, userAgent: 'EMN-Outreach-OS-Research/1.0 (+company research; respects robots)' };

function fixture(robots: () => Response, options = opts) {
  const log = vi.fn();
  const fetch = vi.fn(async (url: string | URL) => new URL(url).pathname === '/robots.txt' ? robots() : new Response('Public page'));
  return { fetch, log, crawler: new SafeFetcher(fetch, publicDns, options, log) };
}

describe('robots.txt fetch decisions', () => {
  it.each([200, 404, 410])('allows public pages with a usable or absent robots.txt (HTTP %i)', async (status) => {
    const { crawler, fetch } = fixture(() => new Response('User-agent: *\nDisallow: /private', { status }));
    await expect(crawler.fetchPage(origin + '/public#section')).resolves.toMatchObject({ url: origin + '/public', status: 200 });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([origin + '/robots.txt', origin + '/public']);
  });

  it('identifies the configured crawler in the header and matches grouped, case-insensitive agents', async () => {
    const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(
      'User-agent: custom-research\nUser-agent: OtherBot\nDisallow: /private',
    ));
    const crawler = new SafeFetcher(fetch, publicDns, { ...opts, userAgent: 'Custom-Research/2.0 (+research)' });
    await expect(crawler.fetchPage(origin + '/private')).rejects.toMatchObject({ code: 'ROBOTS_DISALLOWED' });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('User-Agent')).toBe('Custom-Research/2.0 (+research)');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([403, 429, 500, 503])('holds the crawl and identifies robots HTTP %i', async (status) => {
    const { crawler, fetch, log } = fixture(() => new Response('', { status }));
    await expect(crawler.fetchPage(origin + '/public?token=secret#private')).rejects.toMatchObject({ code: 'ROBOTS_HTTP_ERROR', status });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      requestedUrl: origin + '/public', finalUrl: origin + '/public', httpStatus: null,
      robotsUrl: origin + '/robots.txt', robotsHttpStatus: status, reason: 'ROBOTS_HTTP_ERROR',
    });
  });

  it.each([
    () => new Response('<!doctype html><title>Access denied</title>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('User-agent *\nDisallow: /'),
    () => new Response('User-agent: *\nDisallow: /private', { status: 206 }),
    () => new Response('User-agent: *\n#' + 'X'.repeat(520_000)),
  ])('holds the crawl when the policy is malformed or incomplete', async (robots) => {
    const { crawler, fetch } = fixture(robots);
    await expect(crawler.fetchPage(origin + '/')).rejects.toMatchObject({ code: 'ROBOTS_MALFORMED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('distinguishes robots timeouts from DNS failures', async () => {
    const stalled = vi.fn(async (_url: string | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    }));
    const crawler = new SafeFetcher(stalled, publicDns, { ...opts, timeoutMs: 15 });
    await expect(crawler.fetchPage(origin + '/')).rejects.toMatchObject({ code: 'ROBOTS_TIMEOUT' });
    let lookups = 0;
    const resolver: Resolver = async () => ++lookups === 1 ? publicDns('site.example') : [];
    await expect(new SafeFetcher(stalled, resolver).fetchPage(origin + '/')).rejects.toMatchObject({ code: 'ROBOTS_DNS_FAILURE' });
    expect(stalled).toHaveBeenCalledTimes(1);
  });

  it('evaluates redirected robots rules for the destination URL and keeps secrets out of logs', async () => {
    const destination = 'https://target.example';
    const policy = 'https://rules.example/policy';
    const fetch = vi.fn(async (url: string | URL) => {
      switch (String(url)) {
        case origin + '/robots.txt': return new Response('', { status: 404 });
        case origin + '/start': return new Response(null, { status: 302, headers: { location: destination + '/a/../%70rivate?token=secret#frag' } });
        case destination + '/robots.txt': return new Response(null, { status: 302, headers: { location: policy } });
        case policy: return new Response('User-agent: *\nDisallow: /private?token=*$');
        default: throw new Error('Destination must never be fetched');
      }
    });
    const log = vi.fn();
    await expect(new SafeFetcher(fetch, publicDns, opts, log).fetchPage(origin + '/start')).rejects.toMatchObject({ code: 'ROBOTS_DISALLOWED' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([origin + '/robots.txt', origin + '/start', destination + '/robots.txt', policy]);
    expect(log).toHaveBeenCalledWith({
      requestedUrl: origin + '/start', finalUrl: destination + '/%70rivate', httpStatus: null,
      robotsUrl: policy, robotsHttpStatus: 200, reason: 'ROBOTS_DISALLOWED',
    });
  });

  it('checks the new path on a same-origin redirect and keeps conservative disallow precedence', async () => {
    const fetch = vi.fn(async (url: string | URL) => {
      if (String(url) === origin + '/robots.txt') return new Response(
        'User-agent: *\rDisallow: /private\rAllow: /private/about',
      );
      return new Response(null, { status: 302, headers: { location: '/private/about' } });
    });
    await expect(new SafeFetcher(fetch, publicDns).fetchPage(origin + '/start')).rejects.toMatchObject({ code: 'ROBOTS_DISALLOWED' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([origin + '/robots.txt', origin + '/start', origin + '/robots.txt']);
  });

  it('redacts embedded credentials and reports HTTP errors on the page separately', async () => {
    const { crawler, log, fetch } = fixture(() => new Response('', { status: 404 }));
    await expect(crawler.fetchPage('https://user:password@site.example/private?token=secret')).rejects.toThrow(/credentials/);
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ requestedUrl: origin + '/private', finalUrl: origin + '/private' }));
    fetch.mockImplementationOnce(async () => new Response('', { status: 404 }))
      .mockImplementationOnce(async () => new Response('', { status: 403 }));
    await expect(crawler.fetchPage(origin + '/private')).resolves.toMatchObject({ status: 403 });
    expect(log).toHaveBeenLastCalledWith(expect.objectContaining({ httpStatus: 403, reason: 'PAGE_HTTP_ERROR' }));
  });
});
