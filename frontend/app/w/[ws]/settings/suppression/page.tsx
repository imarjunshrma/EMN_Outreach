'use client';

import { useState } from 'react';
import { api, qs, describeError, type Paged } from '@/lib/api';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, Empty, Field, Input, PageHeader, Pagination, QueryView, Select, Table } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useQueryClient } from '@tanstack/react-query';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Suppression() {
  const ws = useWs();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ q: '', reason: '', page: 1 });
  const q = useWsQuery<Paged<any>>(`/suppressions${qs({ ...f, pageSize: 50 })}`);
  const [add, setAdd] = useState({ type: 'EMAIL', value: '', reason: 'MANUAL', note: '' });
  const create = useWsMutation(() => ({ path: '/suppressions', body: { ...add, note: add.note || undefined } }), { success: 'Added — active sequences for this address/domain were stopped', onSuccess: () => setAdd({ ...add, value: '', note: '' }) });
  const remove = useWsMutation<{ id: string; reason: string }>((b) => ({ path: `/suppressions/${b.id}?reason=${encodeURIComponent(b.reason)}`, method: 'DELETE' }), { success: 'Removed' });
  async function upload(file: File) {
    const form = new FormData(); form.append('file', file);
    try { const r = await api<{ added: number }>(`/w/${ws}/suppressions/import`, { method: 'POST', form }); toast.success(`${r.added} entries added`); void qc.invalidateQueries({ queryKey: ['ws', ws] }); } catch (e) { toast.error(describeError(e)); }
  }
  return (
    <>
      <PageHeader title="Suppression & unsubscribes" subtitle="Global do-not-contact list for this workspace. Unsubscribes, hard bounces, complaints and erasure requests are added automatically and checked before every send." actions={<a className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" href={`/api/v1/w/${ws}/suppressions/export`}>Export CSV</a>} />
      <div className="grid gap-4 lg:grid-cols-4">
        <div className="space-y-4">
          <Card title="Add entry">
            <Field label="Type"><Select value={add.type} onChange={(e) => setAdd({ ...add, type: e.target.value })} options={[{ value: 'EMAIL', label: 'Email address' }, { value: 'DOMAIN', label: 'Whole domain' }]} /></Field>
            <Field label={add.type === 'EMAIL' ? 'Email' : 'Domain'}><Input value={add.value} onChange={(e) => setAdd({ ...add, value: e.target.value })} /></Field>
            <Field label="Reason"><Select value={add.reason} onChange={(e) => setAdd({ ...add, reason: e.target.value })} options={['MANUAL', 'UNSUBSCRIBED', 'DO_NOT_CONTACT_REQUEST', 'LEGAL', 'COMPLAINT']} /></Field>
            <Field label="Note"><Input value={add.note} onChange={(e) => setAdd({ ...add, note: e.target.value })} /></Field>
            <Button className="mt-3" disabled={!add.value} loading={create.isPending} onClick={() => create.mutate()}>Add</Button>
          </Card>
          <Card title="Bulk import CSV"><input type="file" accept=".csv" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /><p className="mt-1 text-xs text-slate-500">First column: email or @domain.</p></Card>
        </div>
        <div className="lg:col-span-3">
          <div className="mb-3 flex gap-2"><Input className="max-w-xs" placeholder="Search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} /><Select className="w-56" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value, page: 1 })} options={[{ value: '', label: 'Any reason' }, ...['UNSUBSCRIBED', 'HARD_BOUNCE', 'COMPLAINT', 'DO_NOT_CONTACT_REQUEST', 'MANUAL', 'LEGAL'].map((r) => ({ value: r, label: r.toLowerCase().replace(/_/g, ' ') }))]} /></div>
          <QueryView q={q} isEmpty={(d) => d.total === 0} empty={<Empty title="Suppression list is empty" />}>
            {(d) => <div className="card p-2"><Table head={['Value', 'Type', 'Reason', 'Source', 'Added', '']}>{d.data.map((s: any) => <tr key={s.id}><td className="td font-mono text-xs">{s.value}</td><td className="td text-xs">{s.type}</td><td className="td"><Badge>{s.reason}</Badge></td><td className="td text-xs">{s.source}{s.note && ` — ${s.note}`}</td><td className="td text-xs">{fmtDate(s.createdAt)}</td><td className="td"><Button variant="ghost" onClick={() => { const r = window.prompt(['UNSUBSCRIBED', 'COMPLAINT', 'DO_NOT_CONTACT_REQUEST'].includes(s.reason) ? 'This is an opt-out. Document why it may be removed (min 10 characters):' : 'Reason for removal:'); if (r !== null) remove.mutate({ id: s.id, reason: r }); }}>Remove</Button></td></tr>)}</Table><Pagination page={d.page} totalPages={d.totalPages} total={d.total} onPage={(p) => setF({ ...f, page: p })} /></div>}
          </QueryView>
        </div>
      </div>
    </>
  );
}
