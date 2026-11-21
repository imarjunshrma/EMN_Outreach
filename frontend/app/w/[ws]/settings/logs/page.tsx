'use client';

import Link from 'next/link';
import { useState } from 'react';
import { qs, type Paged } from '@/lib/api';
import { useWs, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Empty, PageHeader, Pagination, QueryView, Select, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Logs() {
  const ws = useWs();
  const [source, setSource] = useState('');
  const [page, setPage] = useState(1);
  const q = useWsQuery<Paged<any>>(`/error-logs${qs({ source, page, pageSize: 50 })}`);
  return (
    <>
      <PageHeader title="Error & activity logs" subtitle={<>Errors from the API and worker for this workspace. Business activity is in the <Link className="underline" href={`/w/${ws}/settings/audit`}>audit log</Link>; full process logs are in journald on the server (<code>journalctl -u emn-api -u emn-worker</code>).</>} />
      <Select className="mb-3 w-40" value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} options={[{ value: '', label: 'All sources' }, { value: 'api', label: 'API' }, { value: 'worker', label: 'Worker' }]} />
      <QueryView q={q} isEmpty={(d) => d.total === 0} empty={<Empty title="No errors recorded" />}>
        {(d) => <div className="card p-2"><Table head={['When', 'Source', 'Code', 'Message', 'Context']}>{d.data.map((e: any) => <tr key={e.id}><td className="td text-xs">{fmtDate(e.createdAt)}</td><td className="td"><Badge>{e.source}</Badge></td><td className="td text-xs">{e.code}</td><td className="td max-w-md text-sm text-red-700">{e.message}</td><td className="td max-w-xs truncate text-xs text-slate-500">{JSON.stringify(e.context)}</td></tr>)}</Table><Pagination page={d.page} totalPages={d.totalPages} total={d.total} onPage={setPage} /></div>}
      </QueryView>
    </>
  );
}
