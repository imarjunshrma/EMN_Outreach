import { httpJson, ProviderError, type FetchLike } from '../http.js';

// Licensed data-provider adapters. All require live verification with real API keys; endpoint
// paths are configurable because vendors change them. Never scrape sites whose terms forbid it.

// ------------------------------------------------------------------ lead data

export interface ProspectFilters {
  titles: string[];
  keywords: string[];
  countries: string[];
  industries: string[];
  employeeMin: number | null;
  employeeMax: number | null;
  page: number;
  perPage: number;
}

export interface ProspectResult {
  externalId: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null; // usually null until enrichment
  linkedinUrl: string | null;
  city: string | null;
  country: string | null;
  company: { name: string | null; domain: string | null; website: string | null; industry: string | null; employeeCount: number | null };
}

export interface LeadDataProvider {
  readonly name: string;
  search(apiKey: string, filters: ProspectFilters): Promise<{ results: ProspectResult[]; total: number | null }>;
  /** Reveal / find business email for selected people. Consumes provider credits. */
  enrich(apiKey: string, people: ProspectResult[]): Promise<ProspectResult[]>;
  test(apiKey: string): Promise<{ ok: boolean; error?: string }>;
}

const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia', IN: 'India', IE: 'Ireland', DE: 'Germany', FR: 'France', NL: 'Netherlands', AE: 'United Arab Emirates', SG: 'Singapore', NZ: 'New Zealand',
};

function employeeRanges(min: number | null, max: number | null): string[] {
  if (min === null && max === null) return [];
  return [`${min ?? 1},${max ?? 1000000}`];
}

interface ApolloPerson {
  id: string; first_name?: string; last_name?: string; title?: string; email?: string | null; linkedin_url?: string;
  city?: string; country?: string;
  organization?: { name?: string; primary_domain?: string; website_url?: string; industry?: string; estimated_num_employees?: number };
}

export class ApolloProvider implements LeadDataProvider {
  readonly name = 'apollo';
  constructor(
    private readonly fetchImpl?: FetchLike,
    private readonly baseUrl = 'https://api.apollo.io/api/v1',
    private readonly searchPath = '/mixed_people/api_search',
  ) {}

  private map(p: ApolloPerson): ProspectResult {
    const countryCode = Object.entries(COUNTRY_NAMES).find(([, n]) => n === p.country)?.[0] ?? null;
    return {
      externalId: p.id,
      firstName: p.first_name ?? null,
      lastName: p.last_name ?? null,
      title: p.title ?? null,
      email: p.email && !p.email.includes('email_not_unlocked') ? p.email.toLowerCase() : null,
      linkedinUrl: p.linkedin_url ?? null,
      city: p.city ?? null,
      country: countryCode,
      company: {
        name: p.organization?.name ?? null,
        domain: p.organization?.primary_domain ?? null,
        website: p.organization?.website_url ?? null,
        industry: p.organization?.industry ?? null,
        employeeCount: p.organization?.estimated_num_employees ?? null,
      },
    };
  }

  async search(apiKey: string, f: ProspectFilters) {
    const body = {
      person_titles: f.titles,
      q_keywords: f.keywords.join(' ') || undefined,
      person_locations: f.countries.map((c) => COUNTRY_NAMES[c] ?? c),
      organization_num_employees_ranges: employeeRanges(f.employeeMin, f.employeeMax),
      page: f.page,
      per_page: f.perPage,
    };
    const r = await httpJson<{ people?: ApolloPerson[]; pagination?: { total_entries?: number }; total_entries?: number }>(
      `${this.baseUrl}${this.searchPath}`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'cache-control': 'no-cache' }, body: JSON.stringify(body) },
      { provider: 'apollo', fetchImpl: this.fetchImpl },
    );
    return { results: (r.people ?? []).map((p) => this.map(p)), total: r.pagination?.total_entries ?? r.total_entries ?? null };
  }

  async enrich(apiKey: string, people: ProspectResult[]) {
    const out: ProspectResult[] = [];
    for (let i = 0; i < people.length; i += 10) {
      const batch = people.slice(i, i + 10);
      const r = await httpJson<{ matches?: Array<ApolloPerson | null> }>(
        `${this.baseUrl}/people/bulk_match`,
        { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify({ details: batch.map((p) => ({ id: p.externalId })), reveal_personal_emails: false }) },
        { provider: 'apollo', fetchImpl: this.fetchImpl },
      );
      batch.forEach((p, idx) => {
        const m = r.matches?.[idx];
        out.push(m ? { ...p, ...this.map(m), company: { ...p.company, ...this.map(m).company } } : p);
      });
    }
    return out;
  }

  async test(apiKey: string) {
    try {
      await httpJson(`${this.baseUrl}/auth/health`, { headers: { 'x-api-key': apiKey } }, { provider: 'apollo', fetchImpl: this.fetchImpl, retries: 0 });
      return { ok: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }
}

// ------------------------------------------------------------------ verification

export type VerificationResult = 'VALID' | 'INVALID' | 'RISKY' | 'CATCH_ALL' | 'UNKNOWN';

export interface EmailVerifier {
  readonly name: string;
  verify(apiKey: string, email: string): Promise<{ result: VerificationResult; raw: string }>;
}

export class MillionVerifierProvider implements EmailVerifier {
  readonly name = 'millionverifier';
  constructor(private readonly fetchImpl?: FetchLike, private readonly baseUrl = 'https://api.millionverifier.com/api/v3/') {}
  async verify(apiKey: string, email: string) {
    const u = new URL(this.baseUrl);
    u.searchParams.set('api', apiKey);
    u.searchParams.set('email', email);
    u.searchParams.set('timeout', '20');
    const r = await httpJson<{ result?: string; error?: string }>(u.toString(), {}, { provider: 'millionverifier', fetchImpl: this.fetchImpl, timeoutMs: 30_000 });
    if (r.error) throw new ProviderError('millionverifier', r.error);
    const raw = (r.result ?? 'unknown').toLowerCase();
    const map: Record<string, VerificationResult> = { ok: 'VALID', invalid: 'INVALID', disposable: 'INVALID', catch_all: 'CATCH_ALL', unknown: 'UNKNOWN' };
    return { result: map[raw] ?? 'RISKY', raw };
  }
}

// ------------------------------------------------------------------ web search

export interface SearchHit { title: string; url: string; snippet: string }
export interface WebSearchProvider {
  readonly name: string;
  search(apiKey: string, query: string, count: number): Promise<SearchHit[]>;
}

export class BraveSearchProvider implements WebSearchProvider {
  readonly name = 'brave';
  constructor(private readonly fetchImpl?: FetchLike) {}
  async search(apiKey: string, query: string, count: number) {
    const u = new URL('https://api.search.brave.com/res/v1/web/search');
    u.searchParams.set('q', query);
    u.searchParams.set('count', String(count));
    const r = await httpJson<{ web?: { results?: Array<{ title: string; url: string; description?: string }> } }>(
      u.toString(), { headers: { accept: 'application/json', 'x-subscription-token': apiKey } }, { provider: 'brave', fetchImpl: this.fetchImpl },
    );
    return (r.web?.results ?? []).map((x) => ({ title: x.title, url: x.url, snippet: (x.description ?? '').replace(/<[^>]+>/g, '') }));
  }
}

export class SerperSearchProvider implements WebSearchProvider {
  readonly name = 'serper';
  constructor(private readonly fetchImpl?: FetchLike) {}
  async search(apiKey: string, query: string, count: number) {
    const r = await httpJson<{ organic?: Array<{ title: string; link: string; snippet?: string }> }>(
      'https://google.serper.dev/search',
      { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify({ q: query, num: count }) },
      { provider: 'serper', fetchImpl: this.fetchImpl },
    );
    return (r.organic ?? []).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet ?? '' }));
  }
}

// ------------------------------------------------------------------ Smartlead (optional export target)

export class SmartleadAdapter {
  constructor(private readonly fetchImpl?: FetchLike, private readonly baseUrl = 'https://server.smartlead.ai/api/v1') {}
  async addLeads(apiKey: string, campaignId: string, leads: Array<{ email: string; first_name?: string | null; last_name?: string | null; company_name?: string | null; custom_fields?: Record<string, string> }>) {
    const out = { uploaded: 0 };
    for (let i = 0; i < leads.length; i += 100) {
      const chunk = leads.slice(i, i + 100);
      await httpJson(`${this.baseUrl}/campaigns/${encodeURIComponent(campaignId)}/leads?api_key=${encodeURIComponent(apiKey)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lead_list: chunk }),
      }, { provider: 'smartlead', fetchImpl: this.fetchImpl });
      out.uploaded += chunk.length;
    }
    return out;
  }
  async test(apiKey: string) {
    try {
      await httpJson(`${this.baseUrl}/campaigns?api_key=${encodeURIComponent(apiKey)}`, {}, { provider: 'smartlead', fetchImpl: this.fetchImpl, retries: 0 });
      return { ok: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }
}
