'use client';

import { useState } from 'react';
import { qs, type Paged } from '@/lib/api';
import { useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Input, PageHeader, Pagination, QueryView, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Audit() {
  const [f, setF] = useState({ action: '', entityType: '', page: 1 });
  const q = useWsQuery<Paged<any>>(`/audit-logs${qs({ ...f, pageSize: 50 })}`);
  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only record of security-relevant and business actions (logins, key changes, approvals, suppression changes, exports…)." />
      <div className="mb-3 flex gap-2"><Input className="max-w-xs" placeholder="Action contains… e.g. campaign" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value, page: 1 })} /><Input className="max-w-xs" placeholder="Entity type" value={f.entityType} onChange={(e) => setF({ ...f, entityType: e.target.value, page: 1 })} /></div>
      <QueryView q={q}>
        {(d) => <div className="card p-2"><Table head={['When', 'Actor', 'Action', 'Entity', 'Details', 'IP']}>{d.data.map((a: any) => <tr key={a.id}><td className="td text-xs">{fmtDate(a.createdAt)}</td><td className="td text-xs">{a.actor ? `${a.actor.name}` : <Badge>{a.actorType}</Badge>}</td><td className="td text-sm font-medium">{a.action}</td><td className="td text-xs">{a.entityType} {a.entityId?.slice(0, 8)}</td><td className="td max-w-md truncate text-xs text-slate-500">{JSON.stringify(a.metadata)}</td><td className="td text-xs">{a.ipAddress}</td></tr>)}</Table><Pagination page={d.page} totalPages={d.totalPages} total={d.total} onPage={(p) => setF({ ...f, page: p })} /></div>}
      </QueryView>
    </>
  );
}
