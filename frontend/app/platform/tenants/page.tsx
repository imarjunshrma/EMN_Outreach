'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { STATUSES, statusColor } from '@/components/platform/status';
import { Badge, ErrorState, Input, Loading, PageHeader, Pagination, Select, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function Tenants() {
  const [f, setF] = useState({ q: '', status: '', plan: '', page: 1 });
  const q = useQuery({ queryKey: ['platform-tenants', f], queryFn: () => api<any>(`/platform/tenants${qs({ q: f.q, status: f.status, plan: f.plan, page: f.page })}`) });
  return (
    <>
      <PageHeader title="Tenants" subtitle="Every customer organization. Opening a tenant is recorded in the platform audit trail." />
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="min-w-[240px] flex-1"><Input icon={Search} placeholder="Name, slug or owner email" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} aria-label="Search tenants" /></div>
        <Select className="!w-auto" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} options={[{ value: '', label: 'All statuses (not deleted)' }, ...STATUSES.map((s) => ({ value: s, label: s.toLowerCase().replace(/_/g, ' ') }))]} aria-label="Status" />
        <Input className="!w-36" placeholder="Plan code" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value, page: 1 })} aria-label="Plan code" />
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : (
        <>
          <Table head={['Organization', 'Status', 'Plan', 'Owner', 'Members', 'Workspaces', 'Created']}>
            {q.data.data.map((t: any) => (
              <tr key={t.id}>
                <td className="td"><Link className="font-semibold hover:underline" href={`/platform/tenants/${t.id}`}>{t.name}</Link><p className="text-xs text-slate-500">{t.slug}</p></td>
                <td className="td"><Badge color={statusColor(t.status)}>{t.status.toLowerCase().replace(/_/g, ' ')}</Badge></td>
                <td className="td text-xs">{t.plan ?? '—'}{t.subscriptionStatus && <span className="block text-slate-500">{t.subscriptionStatus.toLowerCase()}</span>}</td>
                <td className="td text-xs">{t.owner?.email ?? '—'}</td>
                <td className="td tnum">{t.members}</td><td className="td tnum">{t.workspaces}</td>
                <td className="td text-xs">{fmtDate(t.createdAt)}</td>
              </tr>
            ))}
          </Table>
          {q.data.data.length === 0 && <p className="mt-4 text-center text-sm text-slate-500">No tenants match these filters.</p>}
          <div className="mt-3"><Pagination page={q.data.page} totalPages={q.data.totalPages} total={q.data.total} onPage={(page) => setF({ ...f, page })} /></div>
        </>
      )}
    </>
  );
}
