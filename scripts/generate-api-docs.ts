// Writes API_DOCUMENTATION.md from the live route registry (single source of truth).
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
process.env.DATABASE_URL ??= 'postgresql://unused@127.0.0.1/unused';
const { routes } = await import('../backend/src/http/router.js');
await import('../backend/src/app.js');
const { ERROR_CODES } = await import('../backend/src/core/errors.js');

function fields(schema: unknown): string {
  if (!schema) return '—';
  try {
    const js = z.toJSONSchema(schema as z.ZodType, { unrepresentable: 'any', io: 'input' }) as { properties?: Record<string, { type?: unknown; enum?: unknown[] }>; required?: string[] };
    if (!js.properties) return 'see OpenAPI';
    const req = new Set(js.required ?? []);
    return Object.entries(js.properties).map(([k, v]) => {
      const t = v.enum ? v.enum.slice(0, 6).join('\\|') + (v.enum.length > 6 ? '…' : '') : Array.isArray(v.type) ? v.type.join('\\|') : (v.type as string | undefined) ?? 'object';
      return `\`${k}${req.has(k) ? '' : '?'}\`: ${t}`;
    }).join(', ');
  } catch { return 'see OpenAPI'; }
}

const authText = (a: string, role?: string) => a === 'public' ? 'public' : a === 'user' ? 'session' : `session/API key · ${role ?? 'VIEWER'}+`;
const byTag = new Map<string, typeof routes>();
for (const r of routes) byTag.set(r.tag, [...(byTag.get(r.tag) ?? []), r]);

let md = `# Outvexa — API documentation

Generated from the route registry by \`npm run api-docs\` (${routes.length} operations). The machine-readable
OpenAPI 3.1 document is \`docs/openapi.json\` (\`npm run openapi\`) and is also served at \`GET /api/v1/openapi.json\`.

## Conventions

* **Base URL**: \`https://<your-domain>/api/v1\`. Workspace resources live under \`/w/:workspaceId/…\`;
  a user who is not a member of that workspace receives **404** (existence is not revealed).
* **Browser auth**: \`emn_session\` cookie (httpOnly) + CSRF double submit — send the \`emn_csrf\` cookie value
  in the \`X-CSRF-Token\` header on every non-GET request.
* **API keys** (Settings → API keys): \`Authorization: Bearer emn_<prefix>_<secret>\`. A key is bound to one
  workspace and carries a role; no CSRF header is needed. Keys are shown once and stored hashed.
* **Roles** (highest first): OWNER > ADMIN > MANAGER > MEMBER > VIEWER. "MEMBER+" means MEMBER or higher.
* **Pagination**: \`?page=1&pageSize=50\` (max 200) → \`{ data, page, pageSize, total, totalPages }\`.
* **Errors**: \`{ "error": { "code", "message", "details?", "requestId" } }\`. Every response carries \`X-Request-Id\`.
* **Rate limits**: per-route limits below (Redis sliding window) plus Nginx per-IP limits. Exceeding one returns 429 with \`Retry-After\`.
* **Realtime**: \`GET /w/:workspaceId/events\` is a Server-Sent Events stream (new replies, job progress, notifications).
* \`?\` after a field name = optional.

## Error codes

| Code | Meaning |
|---|---|
${Object.entries(ERROR_CODES).map(([k, v]) => `| \`${k}\` | ${v} |`).join('\n')}

## Non-registry endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | \`/healthz\` | public | Liveness |
| GET | \`/readyz\` | public (Nginx: localhost only) | DB + Redis readiness |
| GET | \`/api/v1/openapi.json\` | public | OpenAPI document |
| GET | \`/api/v1/oauth/callback/:provider\` | OAuth state | Google / Microsoft OAuth redirect target |
| POST | \`/api/v1/webhooks/graph\` | Graph clientState | Microsoft Graph change notifications (optional) |
| POST | \`/api/v1/hooks/booking/:workspaceId\` | HMAC \`X-EMN-Signature: t=…,v1=…\` | Meeting-booked webhook from any scheduler |
| POST | \`/api/v1/public/unsubscribe/:token\` | signed token | RFC 8058 one-click unsubscribe |
| GET | \`/api/v1/public/t/o/:id.gif\`, \`/api/v1/public/t/c/:token\` | public | Optional open / click tracking (off by default) |
| GET | \`/api/v1/w/:workspaceId/events\` | session | SSE realtime stream |

`;
for (const [tag, list] of [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  md += `## ${tag}\n\n| Method | Path | Auth · role | Rate limit | Body | Query | Summary |\n|---|---|---|---|---|---|---|\n`;
  for (const r of list) {
    const rl = r.rateLimit ? `${r.rateLimit.limit}/${r.rateLimit.windowSec}s per ${r.rateLimit.key ?? 'ip'}` : '—';
    md += `| ${r.method.toUpperCase()} | \`${r.path}\` | ${authText(r.auth, r.role)} | ${rl} | ${fields(r.body)} | ${fields(r.query)} | ${r.summary.replace(/\|/g, '\\|')} |\n`;
  }
  md += '\n';
}
writeFileSync('API_DOCUMENTATION.md', md);
console.log(`wrote API_DOCUMENTATION.md (${routes.length} operations, ${byTag.size} groups)`);
process.exit(0);
