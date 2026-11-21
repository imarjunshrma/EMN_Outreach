'use client';

import Link from 'next/link';
import { useState } from 'react';
import { qs, type Paged } from '@/lib/api';
import { useWs, useWsQuery } from '@/lib/hooks';
import { fmtDate, fullName } from '@/lib/format';
import { Badge, Empty, PageHeader, Pagination, QueryView, Select, Table } from '@/components/ui';

interface Report { id: string; status: string; summary: string | null; error: string | null; createdAt: string; lead: { id: string; email: string; firstName: string | null; lastName: string | null } | null; company: { id: string; name: string } | null; _count: { claims: number; evidence: number } }

export default function Research() {
  const ws = useWs();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useWsQuery<Paged<Report>>(`/research${qs({ status, page, pageSize: 30 })}`, { refetchInterval: 15_000 });
  return (
    <>
      <PageHeader title="Research" subtitle="Each report stores the sources it read and only the facts backed by a verbatim quote from those sources. Start research from a lead, a company or a bulk action." />
      <Select className="mb-4 w-48" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} options={[{ value: '', label: 'Any status' }, ...['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'].map((s) => ({ value: s, label: s.toLowerCase() }))]} />
      <QueryView q={q} isEmpty={(d) => d.total === 0} empty={<Empty title="No research yet">Open a lead and click “Research”, or select leads and use the bulk “Research” action.</Empty>}>
        {(d) => (
          <div className="card p-2">
            <Table head={['Subject', 'Status', 'Summary', 'Facts', 'Sources', 'When']}>
              {d.data.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="td"><Link className="font-medium text-brand-700 hover:underline" href={`/w/${ws}/research/${r.id}`}>{r.lead ? fullName(r.lead) : r.company?.name}</Link>{r.company && r.lead && <div className="text-xs text-slate-500">{r.company.name}</div>}</td>
                  <td className="td"><Badge>{r.status}</Badge></td>
                  <td className="td max-w-md text-sm">{r.summary ?? <span className="text-xs text-slate-500">{r.error}</span>}</td>
                  <td className="td">{r._count.claims}</td><td className="td">{r._count.evidence}</td><td className="td text-xs">{fmtDate(r.createdAt)}</td>
                </tr>
              ))}
            </Table>
            <Pagination page={d.page} totalPages={d.totalPages} total={d.total} onPage={setPage} />
          </div>
        )}
      </QueryView>
    </>
  );
}
