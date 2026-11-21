import { z } from 'zod';
import type { RouteDef } from './router.js';
import { ERROR_CODES } from '../core/errors.js';

function toJson(schema: z.ZodType | undefined, io: 'input' | 'output' = 'input') {
  if (!schema) return undefined;
  try {
    const js = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
    delete js.$schema;
    return js;
  } catch {
    return { type: 'object' };
  }
}

/** Builds an OpenAPI 3.1 document from the route registry. */
export function buildOpenApi(routes: RouteDef<any, any>[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const p = `/api/v1${r.path}`.replace(/:([a-zA-Z]+)/g, '{$1}');
    const params = [...r.path.matchAll(/:([a-zA-Z]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const q = toJson(r.query) as { properties?: Record<string, unknown>; required?: string[] } | undefined;
    for (const [name, schema] of Object.entries(q?.properties ?? {})) params.push({ name, in: 'query', required: q?.required?.includes(name) ?? false, schema: schema as { type: string } });
    // API keys are workspace-bound: they work only on /w/:workspaceId routes.
    const security = r.auth === 'public' ? [] : r.auth === 'workspace' ? [{ sessionCookie: [], csrfHeader: [] }, { apiKey: [] }] : [{ sessionCookie: [], csrfHeader: [] }];
    const AUTH: Record<string, string> = { public: 'none (public)', user: 'signed-in user (session cookie)', workspace: 'workspace member (session cookie or workspace API key)', org: 'organization member (session cookie)', platform: 'platform staff only (session cookie); returns 404 to everyone else' };
    const rr = r as typeof r & { orgPermission?: string; platformPermission?: string; allowWhenInactive?: boolean };
    paths[p] ??= {};
    paths[p][r.method] = {
      tags: [r.tag],
      summary: r.summary,
      description: [
        `Authentication: ${AUTH[r.auth] ?? r.auth}`,
        r.role ? `Minimum workspace role: ${r.role}` : null,
        rr.orgPermission && rr.orgPermission !== 'view' ? `Organization permission: ${rr.orgPermission}` : null,
        rr.platformPermission ? `Platform permission: ${rr.platformPermission}` : null,
        rr.allowWhenInactive ? 'Available while the organization is suspended or cancelled' : null,
        r.rateLimit ? `Rate limit: ${r.rateLimit.limit} requests / ${r.rateLimit.windowSec}s per ${r.rateLimit.key ?? 'ip'}` : 'Rate limit: global Nginx limit',
      ].filter(Boolean).join('\n\n'),
      parameters: params,
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: toJson(r.body) } } } } : {}),
      security,
      'x-emn': { auth: r.auth, role: r.role ?? null, orgPermission: rr.orgPermission ?? null, platformPermission: rr.platformPermission ?? null, rateLimit: r.rateLimit ?? null, status: r.status ?? (r.method === 'post' ? 201 : 200), allowWhenInactive: !!rr.allowWhenInactive },
      responses: {
        [String(r.status ?? (r.method === 'post' ? 201 : 200))]: { description: 'Success (JSON). List endpoints return { data, page, pageSize, total, totalPages }.' },
        400: { $ref: '#/components/responses/Error' }, 401: { $ref: '#/components/responses/Error' }, 403: { $ref: '#/components/responses/Error' },
        404: { $ref: '#/components/responses/Error' }, 409: { $ref: '#/components/responses/Error' }, 429: { $ref: '#/components/responses/Error' },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'EMN Outreach OS API', version: '1.4.0', description: `Error codes:\n${Object.entries(ERROR_CODES).map(([k, v]) => `- ${k}: ${v}`).join('\n')}` },
    servers: [{ url: process.env.APP_URL ?? 'http://localhost:3000' }],
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'emn_session' },
        csrfHeader: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token', description: 'Required with cookie auth on POST/PUT/PATCH/DELETE' },
        apiKey: { type: 'http', scheme: 'bearer', description: 'Workspace API key: emn_<prefix>_<secret>' },
      },
      responses: {
        Error: { description: 'Error', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string', enum: Object.keys(ERROR_CODES) }, message: { type: 'string' }, details: {}, requestId: { type: 'string' } } } } } } } },
      },
    },
    paths,
  };
}
