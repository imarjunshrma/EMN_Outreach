'use client';
import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Filter, Search, X } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { Button, ErrorState, Input, Loading, PageHeader, Pagination, Select } from '@/components/ui';
import { TenantFilter } from '@/components/platform/tenant-filter';
import { DataValue, type DataField } from '@/components/platform/data-value';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rows = { model: { name: string; scope: string; idField: string | null; fields: DataField[] }; data: Array<Record<string, any>>; total: number; page: number; totalPages: number; note?: string };

const PREFERRED = ['name', 'email', 'emailAddress', 'title', 'subject', 'firstName', 'lastName', 'companyName', 'status', 'role', 'type', 'kind', 'action', 'provider', 'code', 'domain', 'key', 'task', 'model'];

/** The columns shown by default: the id, the most telling text/status fields, and when it was created. */
function defaultColumns(fields: DataField[]) {
  const usable = fields.filter((f) => !f.secret && !f.isList && f.type !== 'Json');
  const pick = PREFERRED.map((p) => usable.find((f) => f.name === p)).filter(Boolean) as DataField[];
  const fks = usable.filter((f) => /Id$/.test(f.name) && ['workspaceId', 'organizationId', 'userId'].includes(f.name));
  const rest = usable.filter((f) => !pick.includes(f) && !fks.includes(f) && f.name !== 'id' && !['createdAt', 'updatedAt'].includes(f.name) && (f.kind === 'enum' || f.type === 'Boolean' || f.type === 'Int'));
  const id = usable.find((f) => f.name === 'id');
  const created = usable.find((f) => f.name === 'createdAt');
  return [...(id ? [id] : []), ...pick, ...rest, ...fks].slice(0, 8).concat(created ? [created] : []);
}

export default function DataTable() { return <Suspense><Inner /></Suspense>; }

function Inner() {
  const { model } = useParams<{ model: string }>();
  const params = useSearchParams(); const router = useRouter();
  const p = Object.fromEntries(params.entries()) as Record<string, string>;
  const page = Number(p.page ?? 1);
  const set = (patch: Record<string, string | number | undefined>) => router.replace(`/platform/data/${model}${qs({ ...p, page: undefined, ...patch })}`);
  const q = useQuery({ queryKey: ['platform-data-rows', model, p], queryFn: () => api<Rows>(`/platform/data/${model}${qs(p)}`) });
  const [term, setTerm] = useState(p.q ?? '');
  useEffect(() => { const t = setTimeout(() => { if ((p.q ?? '') !== term) set({ q: term || undefined }); }, 350); return () => clearTimeout(t); }, [term]); // eslint-disable-line react-hooks/exhaustive-deps
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState<{ field: string; value: string } | null>(null);
  const cols = useMemo(() => (q.data ? (all ? q.data.model.fields : defaultColumns(q.data.model.fields)) : []), [q.data, all]);

  return (
    <>
      <Link href={`/platform/data${qs({ organizationId: p.organizationId })}`} className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-600 hover:text-ink"><ArrowLeft className="h-4 w-4" aria-hidden />All tables</Link>
      <PageHeader title={model} subtitle={q.data ? `${q.data.total.toLocaleString()} record${q.data.total === 1 ? '' : 's'}${p.field ? ` where ${p.field} = ${p.value || 'empty'}` : ''}` : undefined} />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <TenantFilter orgId={p.organizationId} onChange={(id) => set({ organizationId: id, workspaceId: undefined })} />
        {p.workspaceId && <span className="inline-flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-semibold dark:bg-slate-800">Workspace <code className="text-xs">{p.workspaceId.slice(0, 8)}</code><button aria-label="Clear workspace filter" onClick={() => set({ workspaceId: undefined })}><X className="h-4 w-4" /></button></span>}
        <div className="w-72"><Input icon={Search} placeholder="Search text, or paste an id" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Search records" /></div>
        {p.field
          ? <span className="inline-flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-semibold dark:bg-slate-800"><Filter className="h-4 w-4" aria-hidden />{p.field} = {p.value || 'empty'}<button aria-label="Clear column filter" onClick={() => set({ field: undefined, value: undefined })}><X className="h-4 w-4" /></button></span>
          : <Button variant="secondary" size="sm" icon={Filter} onClick={() => setFilter({ field: q.data?.model.fields.find((f) => !f.secret)?.name ?? 'id', value: '' })}>Filter by column</Button>}
        <label className="ml-auto flex items-center gap-2 text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Show all columns</label>
      </div>
      {filter && q.data && (
        <div className="card mb-3 flex flex-wrap items-end gap-2 p-3">
          <div className="w-56"><Select aria-label="Column" value={filter.field} onChange={(e) => setFilter({ ...filter, field: e.target.value })} options={q.data.model.fields.filter((f) => !f.secret && !f.isList && f.type !== 'Json').map((f) => ({ value: f.name, label: `${f.name} (${f.type})` }))} /></div>
          {(() => { const f = q.data!.model.fields.find((x) => x.name === filter.field); return f?.enumValues
            ? <div className="w-56"><Select aria-label="Value" value={filter.value} onChange={(e) => setFilter({ ...filter, value: e.target.value })} options={[{ value: '', label: 'empty' }, ...f.enumValues.map((v) => ({ value: v, label: v }))]} /></div>
            : f?.type === 'Boolean' ? <div className="w-40"><Select aria-label="Value" value={filter.value} onChange={(e) => setFilter({ ...filter, value: e.target.value })} options={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }, { value: '', label: 'empty' }]} /></div>
            : <div className="w-72"><Input aria-label="Value" placeholder="exact value (empty = no value)" value={filter.value} onChange={(e) => setFilter({ ...filter, value: e.target.value })} /></div>; })()}
          <Button size="sm" onClick={() => { set({ field: filter.field, value: filter.value }); setFilter(null); }}>Apply</Button>
          <Button size="sm" variant="ghost" onClick={() => setFilter(null)}>Cancel</Button>
        </div>
      )}
      {q.isLoading ? <Loading /> : q.error || !q.data ? <ErrorState error={q.error} /> : (
        <>
          {q.data.note && <p className="mb-3 text-sm text-slate-600">{q.data.note}</p>}
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-200 text-left dark:border-slate-700">{cols.map((c) => {
                const active = (p.sort ?? 'createdAt') === c.name; const dir = p.dir ?? 'desc';
                return <th key={c.name} className="whitespace-nowrap px-3 py-2 text-xs font-semibold text-slate-500">
                  {c.isList || c.type === 'Json' || c.secret ? c.name : <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => set({ sort: c.name, dir: active && dir === 'desc' ? 'asc' : 'desc' })}>{c.name}{active && (dir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}</button>}
                </th>; })}</tr></thead>
              <tbody>
                {q.data.data.map((r, i) => {
                  const href = q.data!.model.idField ? `/platform/data/${model}/${encodeURIComponent(String(r[q.data!.model.idField]))}` : null;
                  return <tr key={i} className={`border-b border-slate-100 last:border-0 dark:border-slate-800 ${href ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60' : ''}`} onClick={() => href && router.push(href)} data-testid="data-row">
                    {cols.map((c) => <td key={c.name} className="max-w-[260px] truncate px-3 py-2 align-top"><DataValue field={c} value={r[c.name]} compact /></td>)}
                  </tr>;
                })}
              </tbody>
            </table>
            {q.data.data.length === 0 && <p className="p-6 text-center text-sm text-slate-500">No records.</p>}
          </div>
          <Pagination page={page} totalPages={q.data.totalPages} total={q.data.total} onPage={(n) => set({ page: n })} />
        </>
      )}
    </>
  );
}
