'use client';

import { useState } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, Checkbox, ConfirmButton, Empty, Field, Input, Modal, Notice, PageHeader, QueryView, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Webhooks() {
  const q = useWsQuery<{ webhooks: any[]; events: string[] }>('/webhooks');
  const [f, setF] = useState({ name: '', url: '', events: [] as string[] });
  const [secret, setSecret] = useState<string | null>(null);
  const [view, setView] = useState<string | null>(null);
  const create = useWsMutation(() => ({ path: '/webhooks', body: { ...f, isEnabled: true } }), { onSuccess: (r: any) => { setSecret(r.secret); setF({ name: '', url: '', events: [] }); } });
  const toggle = useWsMutation<any>((h) => ({ path: `/webhooks/${h.id}`, method: 'PUT', body: { name: h.name, url: h.url, events: h.events, isEnabled: !h.isEnabled } }), { success: 'Updated' });
  const test = useWsMutation<string>((id) => ({ path: `/webhooks/${id}/test`, body: {} }), { success: 'Test delivery queued' });
  const del = useWsMutation<string>((id) => ({ path: `/webhooks/${id}`, method: 'DELETE' }), { success: 'Deleted' });
  const deliveries = useWsQuery<any[]>(view ? `/webhooks/${view}/deliveries` : null);
  return (
    <>
      <PageHeader title="Webhooks" subtitle="Send events to your CRM or automation tools. Each request is signed: header X-EMN-Signature = t=<unix>,v1=HMAC-SHA256(secret, `<t>.<body>`) (base64url). Failed deliveries retry with backoff." />
      {secret && <div className="mb-4"><Notice kind="warning"><b>Signing secret (shown once):</b> <code className="break-all">{secret}</code> <Button variant="ghost" onClick={() => setSecret(null)}>Done</Button></Notice></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="New webhook">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="HTTPS URL"><Input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://…" /></Field>
          <p className="label mt-3">Events</p>
          {(q.data?.events ?? []).map((e) => <Checkbox key={e} label={e} checked={f.events.includes(e)} onChange={(v) => setF({ ...f, events: v ? [...f.events, e] : f.events.filter((x) => x !== e) })} />)}
          <Button className="mt-3" disabled={!f.name || !f.url || f.events.length === 0} loading={create.isPending} onClick={() => create.mutate()}>Create</Button>
        </Card>
        <div className="lg:col-span-2"><QueryView q={q} isEmpty={(d) => d.webhooks.length === 0} empty={<Empty title="No webhooks" />}>
          {(d) => <div className="card p-2"><Table head={['Name', 'URL', 'Events', 'Status', 'Failures', '']}>{d.webhooks.map((h) => <tr key={h.id}><td className="td">{h.name}</td><td className="td max-w-xs truncate text-xs">{h.url}</td><td className="td text-xs">{h.events.join(', ')}</td><td className="td">{h.isEnabled ? <Badge color="green">on</Badge> : <Badge>off</Badge>}</td><td className="td">{h.failureCount}</td><td className="td whitespace-nowrap"><Button variant="ghost" onClick={() => test.mutate(h.id)}>Test</Button><Button variant="ghost" onClick={() => setView(h.id)}>Deliveries</Button><Button variant="ghost" onClick={() => toggle.mutate(h)}>{h.isEnabled ? 'Disable' : 'Enable'}</Button><ConfirmButton variant="ghost" confirm="Delete webhook?" onConfirm={() => del.mutate(h.id)}>✕</ConfirmButton></td></tr>)}</Table></div>}
        </QueryView></div>
      </div>
      <Modal open={!!view} wide title="Recent deliveries" onClose={() => setView(null)}>
        <QueryView q={deliveries} isEmpty={(d) => d.length === 0} empty={<p className="text-sm">No deliveries yet.</p>}>
          {(rows) => <Table head={['When', 'Event', 'Status', 'HTTP', 'Attempts', 'Error']}>{rows.map((d) => <tr key={d.id}><td className="td text-xs">{fmtDate(d.createdAt)}</td><td className="td text-xs">{d.event}</td><td className="td"><Badge>{d.status}</Badge></td><td className="td">{d.responseStatus ?? '—'}</td><td className="td">{d.attempts}</td><td className="td text-xs text-red-600">{d.error}</td></tr>)}</Table>}
        </QueryView>
      </Modal>
    </>
  );
}
