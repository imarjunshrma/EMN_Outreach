import type { ApiOp } from '@/lib/docs';
import { CodeBlock } from './blocks';

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[]; const?: unknown; format?: string; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; default?: unknown; anyOf?: Schema[]; oneOf?: Schema[]; description?: string; pattern?: string; additionalProperties?: Schema | boolean };

const METHOD: Record<string, string> = { get: 'bg-emerald-100 text-emerald-800', post: 'bg-brand-100 text-brand-800', put: 'bg-amber-100 text-amber-900', patch: 'bg-amber-100 text-amber-900', delete: 'bg-red-100 text-red-800' };
export function MethodBadge({ method }: { method: string }) {
  return <span className={`inline-block w-[58px] rounded-md py-0.5 text-center font-mono text-[11.5px] font-bold uppercase ${METHOD[method] ?? 'bg-slate-100'}`}>{method}</span>;
}

function typeOf(s: Schema): string {
  if (s.anyOf || s.oneOf) return (s.anyOf ?? s.oneOf)!.map(typeOf).filter((t) => t !== 'null').join(' | ') + ((s.anyOf ?? s.oneOf)!.some((x) => x.type === 'null') ? ' | null' : '');
  if (s.enum) return 'enum';
  if (s.const !== undefined) return JSON.stringify(s.const);
  const t = Array.isArray(s.type) ? s.type.join(' | ') : s.type ?? 'any';
  if (t === 'array' && s.items) return `${typeOf(s.items)}[]`;
  return s.format ? `${t} (${s.format})` : t;
}
function rules(s: Schema): string {
  const r: string[] = [];
  const e = s.enum ?? (s.anyOf ?? []).flatMap((x) => x.enum ?? []);
  if (e.length) r.push(`One of: ${e.map((v) => `\`${String(v)}\``).join(', ')}`);
  if (s.minLength !== undefined || s.maxLength !== undefined) r.push(`Length ${s.minLength ?? 0}–${s.maxLength ?? '∞'}`);
  if (s.minimum !== undefined || s.maximum !== undefined) r.push(`Range ${s.minimum ?? '−∞'}–${s.maximum ?? '∞'}`);
  if (s.default !== undefined) r.push(`Default \`${JSON.stringify(s.default)}\``);
  if (s.pattern && s.pattern.length < 60) r.push(`Pattern \`${s.pattern}\``);
  return r.join(' · ');
}
function rows(s: Schema | undefined, prefix = '', depth = 0): Array<{ name: string; type: string; required: boolean; rules: string; description?: string }> {
  if (!s?.properties || depth > 2) return [];
  return Object.entries(s.properties).flatMap(([k, v]) => {
    const name = prefix ? `${prefix}.${k}` : k;
    const self = { name, type: typeOf(v), required: !!s.required?.includes(k), rules: rules(v), description: v.description };
    const child = v.type === 'object' ? rows(v, name, depth + 1) : v.items?.type === 'object' ? rows(v.items, `${name}[]`, depth + 1) : [];
    return [self, ...child];
  });
}
function example(s: Schema | undefined, depth = 0): unknown {
  if (!s || depth > 3) return null;
  if (s.default !== undefined) return s.default;
  if (s.const !== undefined) return s.const;
  if (s.enum?.length) return s.enum[0];
  if (s.anyOf || s.oneOf) return example((s.anyOf ?? s.oneOf)!.find((x) => x.type !== 'null'), depth + 1);
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  if (t === 'object') { const o: Record<string, unknown> = {}; for (const [k, v] of Object.entries(s.properties ?? {})) if (s.required?.includes(k) || depth === 0) o[k] = example(v, depth + 1); return o; }
  if (t === 'array') return s.items ? [example(s.items, depth + 1)] : [];
  if (t === 'string') return s.format === 'email' ? 'name@example.com' : s.format === 'uuid' ? '00000000-0000-4000-8000-000000000000' : s.format === 'date-time' ? '2026-12-01T09:00:00Z' : s.format === 'uri' ? 'https://example.com' : 'string';
  if (t === 'integer' || t === 'number') return s.minimum ?? 1;
  if (t === 'boolean') return true;
  return null;
}

const AUTH_LABEL: Record<string, string> = { public: 'No authentication', user: 'Signed-in user', workspace: 'Workspace member or API key', org: 'Organization member', platform: 'Platform staff' };

export function ApiOperation({ op }: { op: ApiOp }) {
  const params = op.params.filter((p) => p.in === 'query');
  const pathParams = op.params.filter((p) => p.in === 'path');
  const bodyRows = rows(op.body as Schema | undefined);
  const ex = op.body ? example(op.body as Schema) : undefined;
  const url = `https://app.example.com${op.path.replace(/\{(\w+)\}/g, (_, n) => `$${n.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`)}`;
  const authHeader = op.auth === 'workspace' ? `  -H "Authorization: Bearer $EMN_API_KEY"` : op.auth === 'public' ? '' : `  -b cookies.txt -H "X-CSRF-Token: $CSRF"`;
  const curl = [`curl -X ${op.method.toUpperCase()} "${url}"`, authHeader, op.body ? `  -H "Content-Type: application/json"` : '', op.body ? `  -d '${JSON.stringify(ex, null, 2).replace(/\n/g, '\n  ')}'` : ''].filter(Boolean).join(' \\\n');
  const perm = [op.role && `Role ${op.role.toLowerCase()} or higher`, op.orgPermission && op.orgPermission !== 'view' && `Organization permission: ${op.orgPermission}`, op.platformPermission && `Permission ${op.platformPermission}`].filter(Boolean);
  return (
    <section id={op.id} className="scroll-mt-24 border-t border-slate-200 py-10" data-testid="api-op">
      <h3 className="flex flex-wrap items-center gap-3"><MethodBadge method={op.method} /><code className="!bg-transparent !p-0 text-[15px] font-semibold text-ink">{op.path}</code></h3>
      <p className="mt-3 text-[16px] font-semibold text-ink">{op.summary}</p>
      <div className="mt-3 flex flex-wrap gap-2 text-[12px] font-semibold">
        <span className="rounded-full bg-paper px-2.5 py-1 text-slate-600 ring-1 ring-slate-200">{AUTH_LABEL[op.auth] ?? op.auth}</span>
        {perm.map((p) => <span key={p as string} className="rounded-full bg-paper px-2.5 py-1 text-slate-600 ring-1 ring-slate-200">{p}</span>)}
        {op.rateLimit && <span className="rounded-full bg-paper px-2.5 py-1 text-slate-600 ring-1 ring-slate-200">{op.rateLimit.limit} requests / {op.rateLimit.windowSec >= 3600 ? `${op.rateLimit.windowSec / 3600} h` : op.rateLimit.windowSec >= 60 ? `${op.rateLimit.windowSec / 60} min` : `${op.rateLimit.windowSec} s`} per {op.rateLimit.key ?? 'IP'}</span>}
        {op.allowWhenInactive && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-800 ring-1 ring-amber-200">Works while suspended</span>}
        <span className="rounded-full bg-paper px-2.5 py-1 text-slate-600 ring-1 ring-slate-200">Success: {op.status}</span>
      </div>
      <div className="mt-6 grid gap-8 2xl:grid-cols-[1fr_minmax(0,460px)]">
        <div className="min-w-0 space-y-6">
          {pathParams.length > 0 && <FieldTable title="Path parameters" rows={pathParams.map((p) => ({ name: p.name, type: 'string', required: true, rules: '' }))} />}
          {params.length > 0 && <FieldTable title="Query parameters" rows={params.map((p) => ({ name: p.name, type: typeOf((p.schema ?? {}) as Schema), required: p.required, rules: rules((p.schema ?? {}) as Schema) }))} />}
          {bodyRows.length > 0 && <FieldTable title="Request body (JSON)" rows={bodyRows} />}
          {!pathParams.length && !params.length && !bodyRows.length && <p className="text-[14px] text-slate-500">No parameters.</p>}
        </div>
        <div className="min-w-0"><CodeBlock lang="bash" title="Request" code={curl} /></div>
      </div>
    </section>
  );
}

function FieldTable({ title, rows: r }: { title: string; rows: Array<{ name: string; type: string; required: boolean; rules: string; description?: string }> }) {
  return (
    <div>
      <p className="mb-2 text-[13px] font-bold text-ink">{title}</p>
      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-left text-[13.5px]">
          <tbody>{r.map((x) => (
            <tr key={x.name} className="border-b border-slate-100 align-top last:border-0">
              <td className="w-[40%] px-4 py-2.5"><code className="font-semibold">{x.name}</code>{x.required && <span className="ml-2 text-[11px] font-bold text-brand-700">required</span>}</td>
              <td className="px-4 py-2.5 text-slate-600"><span className="font-mono text-[12.5px] text-slate-500">{x.type}</span>{(x.rules || x.description) && <span className="mt-1 block text-[12.5px]">{[x.description, x.rules.replace(/`/g, '')].filter(Boolean).join(' · ')}</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
