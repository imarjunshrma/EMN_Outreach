'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { ErrorState, Input, Loading, PageHeader, Pagination, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Audit() {
  const [f, setF] = useState({ action: '', organizationId: '', page: 1 });
  const q = useQuery({ queryKey: ['platform-audit', f], queryFn: () => api<any>(`/platform/audit${qs({ action: f.action, organizationId: /^[0-9a-f-]{36}$/i.test(f.organizationId) ? f.organizationId : undefined, page: f.page })}`) });
  return (
    <>
      <PageHeader title="Audit trail" subtitle="Append-only record of registrations, lifecycle changes, plan edits, overrides and support access. Entries cannot be edited or deleted." />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input className="!w-60" placeholder="Action starts with… (e.g. support.)" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value, page: 1 })} aria-label="Action" />
        <Input className="!w-96" placeholder="Organization id" value={f.organizationId} onChange={(e) => setF({ ...f, organizationId: e.target.value.trim(), page: 1 })} aria-label="Organization id" />
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : (
        <>
          <Table head={['When', 'Who', 'Action', 'Organization', 'Reason', 'Target']}>
            {q.data.data.map((a: any) => <tr key={a.id}><td className="td whitespace-nowrap text-xs">{fmtDate(a.createdAt)}</td><td className="td text-xs">{a.actorEmail ?? 'system'}</td><td className="td text-xs font-semibold">{a.action}</td><td className="td text-xs"><code>{a.organizationId?.slice(0, 8) ?? '—'}</code></td><td className="td max-w-[280px] text-xs">{a.reason ?? ''}</td><td className="td max-w-[280px] truncate text-xs text-slate-500">{a.targetType ? `${a.targetType}: ${a.targetId ?? ''}` : ''}</td></tr>)}
          </Table>
          <div className="mt-3"><Pagination page={q.data.page} totalPages={q.data.totalPages} total={q.data.total} onPage={(page) => setF({ ...f, page })} /></div>
        </>
      )}
    </>
  );
}
