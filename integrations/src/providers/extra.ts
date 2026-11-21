import { httpJson, ProviderError, type FetchLike } from '../http.js';
import type { EmailVerifier, VerificationResult } from './index.js';

// Additional provider adapters written against each vendor's public REST documentation.
// None of these has been exercised against the live service from this codebase — run the
// Integrations → Test button with a real key before relying on them.

export class ZeroBounceProvider implements EmailVerifier {
  readonly name = 'zerobounce';
  constructor(private readonly fetchImpl?: FetchLike, private readonly base = 'https://api.zerobounce.net/v2') {}
  async verify(apiKey: string, email: string) {
    const u = new URL(`${this.base}/validate`);
    u.searchParams.set('api_key', apiKey); u.searchParams.set('email', email); u.searchParams.set('ip_address', '');
    const r = await httpJson<{ status?: string; sub_status?: string; error?: string }>(u.toString(), {}, { provider: 'zerobounce', fetchImpl: this.fetchImpl, timeoutMs: 30_000 });
    if (r.error) throw new ProviderError('zerobounce', r.error);
    const s = (r.status ?? 'unknown').toLowerCase();
    const map: Record<string, VerificationResult> = { valid: 'VALID', invalid: 'INVALID', 'catch-all': 'CATCH_ALL', unknown: 'UNKNOWN', spamtrap: 'INVALID', do_not_mail: 'INVALID', abuse: 'RISKY' };
    return { result: map[s] ?? 'UNKNOWN', raw: `${s}${r.sub_status ? `/${r.sub_status}` : ''}` };
  }
}

export class NeverBounceProvider implements EmailVerifier {
  readonly name = 'neverbounce';
  constructor(private readonly fetchImpl?: FetchLike, private readonly base = 'https://api.neverbounce.com/v4') {}
  async verify(apiKey: string, email: string) {
    const u = new URL(`${this.base}/single/check`);
    u.searchParams.set('key', apiKey); u.searchParams.set('email', email);
    const r = await httpJson<{ status?: string; result?: string; message?: string }>(u.toString(), {}, { provider: 'neverbounce', fetchImpl: this.fetchImpl, timeoutMs: 30_000 });
    if (r.status !== 'success') throw new ProviderError('neverbounce', r.message ?? `status ${r.status}`);
    const map: Record<string, VerificationResult> = { valid: 'VALID', invalid: 'INVALID', disposable: 'INVALID', catchall: 'CATCH_ALL', unknown: 'UNKNOWN' };
    return { result: map[r.result ?? 'unknown'] ?? 'UNKNOWN', raw: r.result ?? 'unknown' };
  }
}

export interface EmailFinder { readonly name: string; find(apiKey: string, q: { firstName: string; lastName: string; domain: string }): Promise<{ email: string | null; confidence: number | null; raw: string }>; test(apiKey: string): Promise<{ ok: boolean; error?: string }> }

export class HunterFinder implements EmailFinder {
  readonly name = 'hunter';
  constructor(private readonly fetchImpl?: FetchLike, private readonly base = 'https://api.hunter.io/v2') {}
  async find(apiKey: string, q: { firstName: string; lastName: string; domain: string }) {
    const u = new URL(`${this.base}/email-finder`);
    u.searchParams.set('domain', q.domain); u.searchParams.set('first_name', q.firstName); u.searchParams.set('last_name', q.lastName); u.searchParams.set('api_key', apiKey);
    const r = await httpJson<{ data?: { email?: string | null; score?: number | null }; errors?: Array<{ details: string }> }>(u.toString(), {}, { provider: 'hunter', fetchImpl: this.fetchImpl, timeoutMs: 30_000 });
    if (r.errors?.length) throw new ProviderError('hunter', r.errors.map((e) => e.details).join('; '));
    return { email: r.data?.email ?? null, confidence: r.data?.score ?? null, raw: JSON.stringify({ score: r.data?.score ?? null }) };
  }
  async test(apiKey: string) {
    try { await httpJson(`${this.base}/account?api_key=${encodeURIComponent(apiKey)}`, {}, { provider: 'hunter', fetchImpl: this.fetchImpl }); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; }
  }
}

export interface DnsRecord { id: string; type: string; name: string; content: string; ttl: number }
export interface DnsProviderAdapter {
  readonly name: string;
  verifyToken(token: string): Promise<{ ok: boolean; error?: string }>;
  findZone(token: string, domain: string): Promise<{ id: string; name: string; status: string } | null>;
  listRecords(token: string, zoneId: string, q: { type?: string; name?: string }): Promise<DnsRecord[]>;
  createRecord(token: string, zoneId: string, r: { type: 'TXT' | 'CNAME' | 'MX'; name: string; content: string; ttl?: number; priority?: number }): Promise<DnsRecord>;
  /** Replaces content/TTL of one existing record (type and name are kept). */
  updateRecord(token: string, zoneId: string, recordId: string, r: { type: string; name: string; content: string; ttl?: number; priority?: number }): Promise<DnsRecord>;
  deleteRecord(token: string, zoneId: string, recordId: string): Promise<void>;
}
// Adding another DNS provider (Route 53, DigitalOcean, …) means implementing DnsProviderAdapter and
// registering it in backend/src/core/container.ts under `dnsProviders`; the domain service selects
// the adapter by the workspace's connected DNS integration and never hard-codes a provider.

/** Cloudflare API v4 (DNS only — Cloudflare Registrar has no public API for registering domains). */
export class CloudflareDns implements DnsProviderAdapter {
  readonly name = 'cloudflare';
  constructor(private readonly fetchImpl?: FetchLike, private readonly base = 'https://api.cloudflare.com/client/v4') {}
  private async call<T>(token: string, path: string, init: RequestInit = {}) {
    const r = await httpJson<{ success: boolean; errors?: Array<{ message: string }>; result: T }>(`${this.base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } }, { provider: 'cloudflare', fetchImpl: this.fetchImpl });
    if (!r.success) throw new ProviderError('cloudflare', (r.errors ?? []).map((e) => e.message).join('; ') || 'Cloudflare API error');
    return r.result;
  }
  async verifyToken(token: string) { try { await this.call(token, '/user/tokens/verify'); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; } }
  async findZone(token: string, domain: string) {
    const zones = await this.call<Array<{ id: string; name: string; status: string }>>(token, `/zones?name=${encodeURIComponent(domain)}`);
    return zones[0] ?? null;
  }
  async listRecords(token: string, zoneId: string, q: { type?: string; name?: string }) {
    const p = new URLSearchParams(); if (q.type) p.set('type', q.type); if (q.name) p.set('name', q.name);
    return this.call<DnsRecord[]>(token, `/zones/${zoneId}/dns_records?${p.toString()}`);
  }
  async createRecord(token: string, zoneId: string, r: { type: 'TXT' | 'CNAME' | 'MX'; name: string; content: string; ttl?: number; priority?: number }) {
    return this.call<DnsRecord>(token, `/zones/${zoneId}/dns_records`, { method: 'POST', body: JSON.stringify({ ...r, ttl: r.ttl ?? 1 }) });
  }
  async updateRecord(token: string, zoneId: string, recordId: string, r: { type: string; name: string; content: string; ttl?: number; priority?: number }) {
    return this.call<DnsRecord>(token, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'PUT', body: JSON.stringify({ ...r, ttl: r.ttl ?? 1 }) });
  }
  async deleteRecord(token: string, zoneId: string, recordId: string) {
    await this.call(token, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
  }
}

/** Common disposable-address domains (offline check; avoids paying a verifier for obvious throwaways). */
export const DISPOSABLE_DOMAINS = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'spamgourmet.com']);
