'use client';
import Link from 'next/link';
import { Suspense, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { Badge, ErrorState, Input, Loading, PageHeader } from '@/components/ui';
import { TenantFilter } from '@/components/platform/tenant-filter';

type ModelRow = { name: string; scope: string; fields: number; relations: number; count: number | null; tenantData: boolean; editable: boolean };
const SCOPE: Record<string, string> = { organization: 'per organization', workspace: 'per workspace', user: 'people', member: 'per person', self: 'organizations', global: 'platform-wide' };

export default function DataExplorer() { return <Suspense><Inner /></Suspense>; }

function Inner() {
  const params = useSearchParams(); const router = useRouter();
  const orgId = params.get('organizationId') ?? undefined;
  const q = useQuery({ queryKey: ['platform-data-models', orgId], queryFn: () => api<{ models: ModelRow[] }>(`/platform/data${qs({ organizationId: orgId })}`) });
  const [term, setTerm] = useState('');
  const [hideEmpty, setHideEmpty] = useState(false);
  const rows = useMemo(() => (q.data?.models ?? []).filter((m) => m.name.toLowerCase().includes(term.toLowerCase()) && (!hideEmpty || (m.count ?? 0) > 0) && (!orgId || m.tenantData)), [q.data, term, hideEmpty, orgId]);
  return (
    <>
      <PageHeader title="Data explorer" subtitle="Every table in the database. Open any record, follow its links, and change or delete it with a reason. Passwords, tokens, API keys and stored credentials are never shown." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <TenantFilter orgId={orgId} onChange={(id) => router.replace(`/platform/data${qs({ organizationId: id })}`)} />
        <div className="w-72"><Input icon={Search} placeholder="Find a table" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Find a table" /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />Hide empty tables</label>
      </div>
      {q.isLoading ? <Loading label="Counting records…" /> : q.error ? <ErrorState error={q.error} /> : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rows.map((m) => (
            <Link key={m.name} href={`/platform/data/${m.name}${qs({ organizationId: orgId })}`} className="card flex items-start justify-between gap-2 p-3 hover:border-brand-400" data-testid={`table-${m.name}`}>
              <span><b className="text-sm">{m.name}</b><span className="block text-xs text-slate-500">{SCOPE[m.scope] ?? m.scope} · {m.fields} columns · {m.relations} links</span></span>
              <span className="text-right"><span className="tnum block font-display text-lg font-bold">{m.count === null ? '—' : m.count.toLocaleString()}</span>{!m.editable && <Badge>read only</Badge>}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
