'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDay } from '@/lib/format';
import { Button, Card, ConfirmButton, Empty, Field, Input, PageHeader, QueryView, Table } from '@/components/ui';

interface List { id: string; name: string; description: string | null; memberCount: number; createdAt: string }

export default function Lists() {
  const ws = useWs();
  const q = useWsQuery<List[]>('/lists');
  const [f, setF] = useState({ name: '', description: '' });
  const create = useWsMutation(() => ({ path: '/lists', body: { name: f.name, description: f.description || null } }), { success: 'List created', onSuccess: () => setF({ name: '', description: '' }) });
  const del = useWsMutation<string>((id) => ({ path: `/lists/${id}`, method: 'DELETE' }), { success: 'List deleted' });
  const rename = useWsMutation<{ id: string; name: string }>((b) => ({ path: `/lists/${b.id}`, method: 'PATCH', body: { name: b.name } }), { success: 'Renamed' });
  return (
    <>
      <PageHeader title="Lead lists" subtitle="Open a list to manage its leads, or upload a CSV or Excel workbook directly into it." actions={<>
        <Link className="inline-flex items-center rounded-md border border-slate-300 px-3 py-2 text-sm" href={`/w/${ws}/leads`}>All leads</Link>
        <Link className="inline-flex items-center rounded-md bg-brand-600 px-3 py-2 text-sm font-semibold text-white" href={`/w/${ws}/leads/import?destination=new`}>Upload to a new list</Link>
      </>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="New list">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Description"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Button className="mt-3" disabled={!f.name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create</Button>
        </Card>
        <div className="lg:col-span-2">
          <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No lists yet">Create a list here or <Link className="text-brand-700 underline" href={`/w/${ws}/leads/import?destination=new`}>create one during an upload</Link>.</Empty>}>
            {(rows) => (
              <div className="card p-2"><Table head={['List', 'Leads', 'Created', '']}>
                {rows.map((l) => <tr key={l.id}><td className="td"><Link className="font-medium text-brand-700 hover:underline" href={`/w/${ws}/leads?listId=${l.id}`}>{l.name}</Link><div className="text-xs text-slate-500">{l.description}</div></td><td className="td">{l.memberCount}</td><td className="td text-xs">{fmtDay(l.createdAt)}</td>
                  <td className="td text-right"><Link className="mr-3 font-medium text-brand-700 hover:underline" href={`/w/${ws}/leads/import?listId=${l.id}`} aria-label={`Upload to ${l.name}`}>Upload leads</Link><Button variant="ghost" onClick={() => { const n = window.prompt('New name', l.name); if (n) rename.mutate({ id: l.id, name: n }); }}>Rename</Button><ConfirmButton variant="ghost" confirm="Delete this list? Leads are kept." onConfirm={() => del.mutate(l.id)}>Delete</ConfirmButton></td></tr>)}
              </Table></div>
            )}
          </QueryView>
        </div>
      </div>
    </>
  );
}
