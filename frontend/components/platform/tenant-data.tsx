'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { Card, ErrorState, Input, Loading } from '@/components/ui';

type ModelRow = { name: string; scope: string; count: number | null; tenantData: boolean };

/** Every table that holds this tenant's data, with record counts; each opens in the data explorer filtered to the tenant. */
export function TenantData({ orgId, workspaceId }: { orgId: string; workspaceId?: string }) {
  const q = useQuery({ queryKey: ['platform-data-models', orgId, workspaceId], queryFn: () => api<{ models: ModelRow[] }>(`/platform/data${qs({ organizationId: orgId, workspaceId })}`) });
  const [term, setTerm] = useState('');
  const [showEmpty, setShowEmpty] = useState(false);
  if (q.isLoading) return <Loading label="Counting records in every table…" />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const rows = q.data.models.filter((m) => m.tenantData && (showEmpty || (m.count ?? 0) > 0) && m.name.toLowerCase().includes(term.toLowerCase()));
  const total = q.data.models.filter((m) => m.tenantData).reduce((n, m) => n + (m.count ?? 0), 0);
  return (
    <Card title={`All data of this ${workspaceId ? 'workspace' : 'tenant'} · ${total.toLocaleString()} records`} actions={<label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />Show empty tables</label>}>
      <div className="mb-3 max-w-sm"><Input icon={Search} placeholder="Find a table (Lead, Campaign, Message…)" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Find a table" /></div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((m) => (
          <Link key={m.name} href={`/platform/data/${m.name}${qs({ organizationId: orgId, workspaceId })}`} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm hover:border-brand-400 hover:bg-brand-50 dark:border-slate-700 dark:hover:bg-slate-800" data-testid={`tenant-table-${m.name}`}>
            <span className="font-semibold">{m.name}</span><span className="tnum text-slate-500">{(m.count ?? 0).toLocaleString()}</span>
          </Link>
        ))}
      </div>
      {rows.length === 0 && <p className="text-sm text-slate-500">No tables match.</p>}
    </Card>
  );
}
