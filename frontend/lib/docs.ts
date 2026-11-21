// Server-only: uses node:fs. Imported only from server components.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { headingsOf, parseFrontmatter, plainText } from './markdown';

// Documentation content lives in frontend/content/docs/*.md and is read at build time (all docs pages
// are statically generated). Order and grouping come from each file's frontmatter.

export interface Doc { slug: string; title: string; description: string; section: string; order: number; body: string }
const DIR = path.join(process.cwd(), 'content', 'docs');
export const SECTIONS = ['Getting started', 'Guides', 'Agencies & teams', 'Developers', 'Security & operations'] as const;

let cache: Doc[] | null = null;
export function allDocs(): Doc[] {
  if (cache && process.env.NODE_ENV === 'production') return cache;
  cache = readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => {
    const { meta, body } = parseFrontmatter(readFileSync(path.join(DIR, f), 'utf8'));
    return { slug: f.replace(/\.md$/, ''), title: meta.title ?? f, description: meta.description ?? '', section: meta.section ?? 'Guides', order: Number(meta.order ?? 99), body };
  }).sort((a, b) => SECTIONS.indexOf(a.section as never) - SECTIONS.indexOf(b.section as never) || a.order - b.order);
  return cache;
}
export const getDoc = (slug: string) => allDocs().find((d) => d.slug === slug) ?? null;

export interface NavGroup { section: string; items: Array<{ href: string; title: string }> }
export function docsNav(): NavGroup[] {
  const groups: NavGroup[] = SECTIONS.map((s) => ({ section: s, items: allDocs().filter((d) => d.section === s).map((d) => ({ href: d.slug === 'introduction' ? '/docs' : `/docs/${d.slug}`, title: d.title })) }));
  groups.find((g) => g.section === 'Developers')?.items.push({ href: '/docs/api', title: 'API reference' });
  return groups.filter((g) => g.items.length);
}

export interface SearchEntry { href: string; title: string; section: string; text: string }
export function searchIndex(): SearchEntry[] {
  const docs = allDocs().flatMap((d) => {
    const href = d.slug === 'introduction' ? '/docs' : `/docs/${d.slug}`;
    return [{ href, title: d.title, section: d.section, text: `${d.description} ${plainText(d.body)}`.slice(0, 4000) },
      ...headingsOf(d.body).map((h) => ({ href: `${href}#${h.id}`, title: `${d.title} › ${h.text}`, section: d.section, text: h.text }))];
  });
  const api = apiOperations().map((o) => ({ href: `/docs/api/${o.tagSlug}#${o.id}`, title: `${o.method.toUpperCase()} ${o.path}`, section: 'API reference', text: `${o.summary} ${o.tag}` }));
  return [...docs, ...api];
}

// ------------------------------------------------------------------ API reference (from openapi.json)

export interface ApiParam { name: string; in: string; required: boolean; schema?: Record<string, unknown> }
export interface ApiOp {
  id: string; method: string; path: string; tag: string; tagSlug: string; summary: string; description: string;
  params: ApiParam[]; body?: Record<string, unknown>; auth: string; role: string | null; orgPermission: string | null; platformPermission: string | null;
  rateLimit: { limit: number; windowSec: number; key?: string } | null; status: number; allowWhenInactive: boolean;
}
let apiCache: { ops: ApiOp[]; errors: Array<[string, string]>; version: string } | null = null;
function loadApi() {
  if (apiCache) return apiCache;
  const doc = JSON.parse(readFileSync(path.join(process.cwd(), 'content', 'openapi.json'), 'utf8')) as {
    info: { version: string; description: string }; paths: Record<string, Record<string, { tags: string[]; summary: string; description: string; parameters?: ApiParam[]; requestBody?: { content: { 'application/json': { schema: Record<string, unknown> } } }; 'x-emn'?: Omit<ApiOp, 'id'> }>>;
  };
  const ops: ApiOp[] = [];
  for (const [p, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const x = (op['x-emn'] ?? {}) as Partial<ApiOp>;
      const tag = op.tags?.[0] ?? 'Other';
      ops.push({
        id: `${method}-${p}`.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase(), method, path: p, tag, tagSlug: tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        summary: op.summary, description: op.description, params: op.parameters ?? [], body: op.requestBody?.content['application/json']?.schema,
        auth: x.auth ?? 'user', role: x.role ?? null, orgPermission: x.orgPermission ?? null, platformPermission: x.platformPermission ?? null, rateLimit: x.rateLimit ?? null, status: x.status ?? 200, allowWhenInactive: !!x.allowWhenInactive,
      });
    }
  }
  const errors = doc.info.description.split('\n').filter((l) => l.startsWith('- ')).map((l) => { const [k, ...v] = l.slice(2).split(': '); return [k, v.join(': ')] as [string, string]; });
  apiCache = { ops, errors, version: doc.info.version };
  return apiCache;
}
export const apiOperations = () => loadApi().ops;
export const apiErrors = () => loadApi().errors;
export const apiVersion = () => loadApi().version;

/** Tags grouped for the reference sidebar, in a reading order that follows the product. */
const TAG_GROUPS: Array<[string, string[]]> = [
  ['Account & tenancy', ['Auth', 'Public', 'Organizations', 'Workspaces', 'Team', 'API keys', 'Billing']],
  ['Prospects', ['Leads', 'Companies', 'Lists', 'Imports', 'Saved filters', 'Prospecting', 'Research', 'Enrichment', 'ICP', 'Qualification']],
  ['Outreach', ['Campaigns', 'Personalization', 'Writing', 'AI Studio', 'Prompt library', 'AI', 'Sending', 'Inbox', 'Reply assistant', 'Copilot']],
  ['Infrastructure', ['Mailboxes', 'Deliverability', 'Suppression', 'Compliance', 'Privacy']],
  ['Automation & CRM', ['CRM', 'Workflows', 'Automation', 'Webhooks', 'Integrations', 'Analytics', 'Reports', 'Notifications']],
  ['Operations', ['Jobs', 'Logs', 'Platform']],
];
export function apiTags(): Array<{ group: string; tags: Array<{ tag: string; slug: string; count: number }> }> {
  const counts = new Map<string, { slug: string; count: number }>();
  for (const o of apiOperations()) { const c = counts.get(o.tag) ?? { slug: o.tagSlug, count: 0 }; c.count++; counts.set(o.tag, c); }
  const used = new Set<string>();
  const out = TAG_GROUPS.map(([group, tags]) => ({ group, tags: tags.filter((t) => counts.has(t)).map((t) => { used.add(t); return { tag: t, ...counts.get(t)! }; }) })).filter((g) => g.tags.length);
  const rest = [...counts.keys()].filter((t) => !used.has(t)).sort();
  if (rest.length) out.push({ group: 'More', tags: rest.map((t) => ({ tag: t, ...counts.get(t)! })) });
  return out;
}
