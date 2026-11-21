'use client';

import { useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader, QueryView, Select, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Privacy() {
  const ws = useWs();
  const q = useWsQuery<any[]>('/privacy/requests', { refetchInterval: 10_000 });
  const [f, setF] = useState({ type: 'EXPORT', subjectEmail: '' });
  const create = useWsMutation(() => ({ path: '/privacy/requests', body: f }), { success: 'Request queued', onSuccess: () => setF({ ...f, subjectEmail: '' }) });
  return (
    <>
      <PageHeader title="Data export & deletion" subtitle="Handle data-subject requests and export your workspace data." actions={<a className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" href={`/api/v1/w/${ws}/export`}>Download full workspace export (owner)</a>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="New request">
          <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} options={[{ value: 'EXPORT', label: 'Export everything about a person' }, { value: 'ERASURE', label: 'Erase a person' }]} /></Field>
          <Field label="Email address"><Input type="email" value={f.subjectEmail} onChange={(e) => setF({ ...f, subjectEmail: e.target.value })} /></Field>
          {f.type === 'ERASURE' && <div className="mt-2"><Notice kind="warning">Erasure permanently deletes the lead, their messages, research, notes and events. Only the email and a “do not contact” reason are kept on the suppression list so they are never contacted or re-imported again. Confirm this approach with your advisor.</Notice></div>}
          <Button className="mt-3" variant={f.type === 'ERASURE' ? 'danger' : 'primary'} disabled={!f.subjectEmail} loading={create.isPending} onClick={() => (f.type !== 'ERASURE' || window.confirm(`Permanently erase ${f.subjectEmail}?`)) && create.mutate()}>Submit</Button>
        </Card>
        <div className="lg:col-span-2"><QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No requests yet" />}>
          {(rows) => <div className="card p-2"><Table head={['When', 'Type', 'Email', 'Status', '']}>{rows.map((r) => <tr key={r.id}><td className="td text-xs">{fmtDate(r.createdAt)}</td><td className="td"><Badge>{r.type}</Badge></td><td className="td">{r.subjectEmail}</td><td className="td"><Badge>{r.status}</Badge></td><td className="td">{r.type === 'EXPORT' && r.status === 'COMPLETED' && <a className="text-sm text-brand-700 underline" href={`/api/v1/w/${ws}/privacy/requests/${r.id}/download`}>Download</a>}</td></tr>)}</Table></div>}
        </QueryView></div>
      </div>
    </>
  );
}
