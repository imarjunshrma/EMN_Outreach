'use client';

import Link from 'next/link';
import { useState } from 'react';
import { qs } from '@/lib/api';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, ConfirmButton, Empty, Field, Input, PageHeader, QueryView, Select, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Tasks() {
  const ws = useWs();
  const [filter, setFilter] = useState({ status: 'OPEN', due: '' });
  const q = useWsQuery<any[]>(`/tasks${qs(filter)}`);
  const members = useWsQuery<{ members: Array<{ user: { id: string; name: string } }> }>('/members');
  const [f, setF] = useState({ title: '', dueAt: '', priority: 'MEDIUM', assigneeId: '' });
  const create = useWsMutation(() => ({ path: '/tasks', body: { title: f.title, priority: f.priority, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : null, assigneeId: f.assigneeId || null } }), { success: 'Task created', onSuccess: () => setF({ ...f, title: '' }) });
  const upd = useWsMutation<{ id: string; status: string }>((b) => ({ path: `/tasks/${b.id}`, method: 'PATCH', body: { status: b.status } }), { success: 'Updated' });
  const del = useWsMutation<string>((id) => ({ path: `/tasks/${id}`, method: 'DELETE' }), { success: 'Deleted' });
  return (
    <>
      <PageHeader title="Tasks & follow-up reminders" subtitle="Reminders notify the assignee when due. Tasks are also created by automation rules (e.g. when a prospect is interested)." />
      <div className="grid gap-4 lg:grid-cols-4">
        <Card title="New task">
          <Field label="Title"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Due"><Input type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
          <Field label="Priority"><Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} options={['LOW', 'MEDIUM', 'HIGH']} /></Field>
          <Field label="Assignee"><Select value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })} options={[{ value: '', label: 'Me' }, ...(members.data?.members ?? []).map((m) => ({ value: m.user.id, label: m.user.name }))]} /></Field>
          <Button className="mt-3" disabled={!f.title.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create</Button>
        </Card>
        <div className="lg:col-span-3">
          <div className="mb-3 flex gap-2">
            <Select className="w-40" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} options={['OPEN', 'DONE', 'CANCELLED']} />
            <Select className="w-40" value={filter.due} onChange={(e) => setFilter({ ...filter, due: e.target.value })} options={[{ value: '', label: 'Any due date' }, { value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Due today' }, { value: 'upcoming', label: 'Upcoming' }]} />
          </div>
          <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No tasks" />}>
            {(rows) => (
              <div className="card p-2"><Table head={['Task', 'Lead', 'Priority', 'Due', 'Assignee', '']}>
                {rows.map((t) => <tr key={t.id}><td className="td">{t.title}</td><td className="td text-sm">{t.lead ? <Link className="text-brand-700 hover:underline" href={`/w/${ws}/leads/${t.lead.id}`}>{t.lead.email}</Link> : '—'}</td><td className="td"><Badge>{t.priority}</Badge></td><td className={`td text-xs ${t.dueAt && new Date(t.dueAt) < new Date() && t.status === 'OPEN' ? 'text-red-600' : ''}`}>{fmtDate(t.dueAt)}</td><td className="td text-sm">{t.assignee?.name ?? '—'}</td>
                  <td className="td text-right">{t.status === 'OPEN' ? <Button variant="secondary" onClick={() => upd.mutate({ id: t.id, status: 'DONE' })}>Done</Button> : <Button variant="ghost" onClick={() => upd.mutate({ id: t.id, status: 'OPEN' })}>Reopen</Button>}<ConfirmButton variant="ghost" confirm="Delete task?" onConfirm={() => del.mutate(t.id)}>✕</ConfirmButton></td></tr>)}
              </Table></div>
            )}
          </QueryView>
        </div>
      </div>
    </>
  );
}
