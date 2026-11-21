'use client';

import Link from 'next/link';
import { useState } from 'react';
import { qs, type Paged } from '@/lib/api';
import { useWs, useWsQuery } from '@/lib/hooks';
import { Empty, Input, PageHeader, Pagination, QueryView, Table } from '@/components/ui';

interface Company { id: string; name: string; domain: string | null; industry: string | null; employeeCount: number | null; country: string | null; _count: { leads: number } }

export default function Companies() {
  const ws = useWs();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const data = useWsQuery<Paged<Company>>(`/companies${qs({ q, page, pageSize: 50 })}`);
  return (
    <>
      <PageHeader title="Companies" subtitle="Companies are created automatically from lead email domains and imports, and enriched by research." />
      <Input className="mb-4 max-w-sm" placeholder="Search name or domain" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      <QueryView q={data} isEmpty={(d) => d.total === 0} empty={<Empty title="No companies yet">Add or import leads to create companies.</Empty>}>
        {(d) => (
          <div className="card p-2">
            <Table head={['Company', 'Domain', 'Industry', 'Employees', 'Country', 'Leads']}>
              {d.data.map((c) => <tr key={c.id} className="hover:bg-slate-50"><td className="td"><Link className="font-medium text-brand-700 hover:underline" href={`/w/${ws}/companies/${c.id}`}>{c.name}</Link></td><td className="td">{c.domain ?? '—'}</td><td className="td">{c.industry ?? '—'}</td><td className="td">{c.employeeCount ?? '—'}</td><td className="td">{c.country ?? '—'}</td><td className="td">{c._count.leads}</td></tr>)}
            </Table>
            <Pagination page={d.page} totalPages={d.totalPages} total={d.total} onPage={setPage} />
          </div>
        )}
      </QueryView>
    </>
  );
}
