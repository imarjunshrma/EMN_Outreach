import { ProviderError } from '../../integrations/src/http.js';
import type { AiProviderAdapter, StructuredRequest } from '../../integrations/src/ai/types.js';
import type { AuthHandle, EmailProvider, NormalizedMessage, OutgoingMessage, SentResult, SyncResult, OAuthClient, TokenSet } from '../../integrations/src/email/types.js';
import type { EmailVerifier, LeadDataProvider, ProspectFilters, ProspectResult, WebSearchProvider } from '../../integrations/src/providers/index.js';
import type { FetchedPage } from '../../integrations/src/research/fetcher.js';

/** In-memory mailbox provider. Simulates sends, crashes and inbound messages. */
export class FakeEmailProvider implements EmailProvider {
  readonly name: 'GMAIL' | 'MICROSOFT' | 'SMTP_IMAP';
  sent: OutgoingMessage[] = [];
  inbox: NormalizedMessage[] = [];
  /** Next send: accept the message, then throw a network error (crash/timeout after provider accepted). */
  failAfterAccept = false;
  /** Next send: throw this error without sending. */
  failBeforeSend: ProviderError | null = null;
  sendDelayMs = 0;
  constructor(name: 'GMAIL' | 'MICROSOFT' | 'SMTP_IMAP' = 'GMAIL') { this.name = name; }

  async testConnection(auth: AuthHandle) { return { email: auth.email, providerAccountId: `fake-${auth.email}` }; }

  async send(_auth: AuthHandle, msg: OutgoingMessage): Promise<SentResult> {
    if (this.failBeforeSend) { const e = this.failBeforeSend; this.failBeforeSend = null; throw e; }
    if (this.sendDelayMs) await new Promise((r) => setTimeout(r, this.sendDelayMs));
    this.sent.push(msg);
    if (this.failAfterAccept) { this.failAfterAccept = false; throw new ProviderError('fake', 'network error: socket hang up', undefined, true); }
    return { providerMessageId: `pm-${this.sent.length}`, providerThreadId: msg.threadId ?? `thread-${msg.messageId}`, internetMessageId: msg.messageId };
  }

  async findSentByOutboundId(_auth: AuthHandle, q: { outboundId: string }) {
    const idx = this.sent.findIndex((m) => m.headers['X-EMN-Outbound-Id'] === q.outboundId);
    if (idx < 0) return null;
    const m = this.sent[idx];
    return { providerMessageId: `pm-${idx + 1}`, providerThreadId: m.threadId ?? `thread-${m.messageId}`, internetMessageId: m.messageId };
  }

  async sync(_auth: AuthHandle, cursor: string | null): Promise<SyncResult> {
    const start = cursor ? Number(cursor) : 0;
    return { messages: this.inbox.slice(start), nextCursor: String(this.inbox.length) };
  }
}

type AiResponder = (req: StructuredRequest) => unknown;

/** AI adapter returning scripted structured outputs per task (schemaName = task in lower case). */
export class FakeAi implements AiProviderAdapter {
  calls: StructuredRequest[] = [];
  responders: Record<string, AiResponder> = {};
  failWith: Error | null = null;
  constructor(readonly name: 'OPENAI' | 'ANTHROPIC') {}
  on(task: string, fn: AiResponder) { this.responders[task.toLowerCase()] = fn; return this; }
  async generateStructured(_key: string, req: StructuredRequest) {
    this.calls.push(req);
    if (this.failWith) throw this.failWith;
    const fn = this.responders[req.schemaName];
    if (!fn) throw new ProviderError(this.name, `no fake response for ${req.schemaName}`, 400);
    return { data: fn(req), usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0 }, latencyMs: 5 };
  }
  async testConnection() { return { ok: true as const }; }
}

export class FakeOAuth implements OAuthClient {
  refreshCalls = 0;
  failRefresh: Error | null = null;
  constructor(readonly provider: 'GMAIL' | 'MICROSOFT') {}
  buildAuthUrl(p: { state: string }) { return `https://fake-oauth/authorize?state=${p.state}`; }
  async exchangeCode() { return { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(Date.now() + 3600_000), scopes: [], profile: { email: 'sender@ourco.com', providerAccountId: 'p1' } }; }
  async refresh(): Promise<TokenSet> {
    this.refreshCalls++;
    if (this.failRefresh) throw this.failRefresh;
    return { accessToken: `at-${this.refreshCalls}`, refreshToken: 'rt', expiresAt: new Date(Date.now() + 3600_000), scopes: [] };
  }
  async revoke() { /* no-op */ }
}

export class FakeFetcher {
  pages = new Map<string, FetchedPage>();
  async fetchPage(url: string): Promise<FetchedPage> {
    const p = this.pages.get(url) ?? this.pages.get(url.replace(/\/$/, ''));
    if (!p) throw new ProviderError('fetcher', `404 ${url}`, 404);
    return p;
  }
}

export class FakeVerifier implements EmailVerifier {
  readonly name = 'millionverifier';
  results = new Map<string, 'VALID' | 'INVALID' | 'RISKY' | 'CATCH_ALL' | 'UNKNOWN'>();
  async verify(_k: string, email: string) { const r = this.results.get(email) ?? 'VALID'; return { result: r, raw: r.toLowerCase() }; }
}

export class FakeLeadData implements LeadDataProvider {
  readonly name = 'apollo';
  people: ProspectResult[] = [];
  lastFilters: ProspectFilters | null = null;
  async search(_k: string, f: ProspectFilters) { this.lastFilters = f; return { results: this.people, total: this.people.length }; }
  async enrich(_k: string, people: ProspectResult[]) { return people.map((p) => ({ ...p, email: p.email ?? `${(p.firstName ?? 'x').toLowerCase()}@${p.company.domain}` })); }
  async test() { return { ok: true }; }
}

export class FakeSearch implements WebSearchProvider {
  readonly name = 'brave';
  async search() { return []; }
}

export const fakeDns = {
  records: new Map<string, string[][]>(),
  mx: new Map<string, Array<{ exchange: string; priority: number }>>(),
  async resolveTxt(name: string) { const r = fakeDns.records.get(name); if (!r) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); return r; },
  async resolveMx(name: string) { const r = fakeDns.mx.get(name); if (!r) throw new Error('ENOTFOUND'); return r; },
};

export class FakeFinder {
  readonly name = 'hunter';
  emails = new Map<string, string>();
  async find(_k: string, q: { firstName: string; lastName: string; domain: string }) { const e = this.emails.get(`${q.firstName} ${q.lastName}@${q.domain}`) ?? null; return { email: e, confidence: e ? 91 : null, raw: '{}' }; }
  async test() { return { ok: true }; }
}

export class FakeCloudflare {
  readonly name = 'cloudflare';
  zones = new Map<string, string>();
  records: Array<{ id: string; zoneId: string; type: string; name: string; content: string; ttl: number }> = [];
  async verifyToken() { return { ok: true }; }
  async findZone(_t: string, domain: string) { const id = this.zones.get(domain); return id ? { id, name: domain, status: 'active' } : null; }
  async listRecords(_t: string, zoneId: string, q: { type?: string; name?: string }) { return this.records.filter((r) => r.zoneId === zoneId && (!q.type || r.type === q.type) && (!q.name || r.name === q.name)); }
  async createRecord(_t: string, zoneId: string, r: { type: string; name: string; content: string; ttl?: number }) { const rec = { id: `rec${this.records.length + 1}`, zoneId, ttl: 1, ...r }; this.records.push(rec as never); return rec; }
}
