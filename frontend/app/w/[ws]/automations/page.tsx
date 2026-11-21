'use client';

import { useState } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { LEAD_STATUSES, REPLY_CATEGORIES } from '@/lib/constants';
import { Badge, Button, Card, Checkbox, ConfirmButton, Empty, Field, Input, PageHeader, QueryView, Select, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Action = { type: string; [k: string]: unknown };
const BLANK = { name: '', isEnabled: true, trigger: 'reply.categorized', conditions: { categories: ['INTERESTED', 'WANTS_MEETING', 'WANTS_PRICING'] } as any, actions: [{ type: 'create_task', title: 'Respond to interested prospect', dueInDays: 0 }] as Action[] };

export default function Automations() {
  const q = useWsQuery<any[]>('/automations');
  const runs = useWsQuery<any[]>('/automations/runs');
  const lists = useWsQuery<Array<{ id: string; name: string }>>('/lists');
  const campaigns = useWsQuery<Array<{ id: string; name: string; status: string }>>('/campaigns');
  const [r, setR] = useState(BLANK);
  const [editing, setEditing] = useState<string | null>(null);
  const save = useWsMutation(() => ({ path: editing ? `/automations/${editing}` : '/automations', method: editing ? 'PUT' : 'POST', body: r }), { success: 'Rule saved', onSuccess: () => { setR(BLANK); setEditing(null); } });
  const del = useWsMutation<string>((id) => ({ path: `/automations/${id}`, method: 'DELETE' }), { success: 'Deleted' });
  const setAction = (i: number, a: Action) => setR({ ...r, actions: r.actions.map((x, j) => (j === i ? a : x)) });
  return (
    <>
      <PageHeader title="Automations" subtitle="When something happens, run deterministic actions. AI only supplies the reply category or score; it never takes actions directly. Each event runs a rule at most once." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={editing ? 'Edit rule' : 'New rule'}>
          <Field label="Name"><Input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} /></Field>
          <Field label="When"><Select value={r.trigger} onChange={(e) => setR({ ...r, trigger: e.target.value, conditions: {} })} options={[{ value: 'reply.categorized', label: 'A reply is categorised' }, { value: 'lead.scored', label: 'A lead is scored' }, { value: 'lead.status_changed', label: 'A lead status changes' }]} /></Field>
          {r.trigger === 'reply.categorized' && <Field label="Categories"><div className="grid grid-cols-2 gap-1">{REPLY_CATEGORIES.map((c) => <Checkbox key={c} label={c.toLowerCase().replace(/_/g, ' ')} checked={(r.conditions.categories ?? []).includes(c)} onChange={(v) => setR({ ...r, conditions: { ...r.conditions, categories: v ? [...(r.conditions.categories ?? []), c] : (r.conditions.categories ?? []).filter((x: string) => x !== c) } })} />)}</div></Field>}
          {r.trigger === 'lead.scored' && <div className="grid grid-cols-2 gap-2"><Field label="Min score"><Input type="number" value={r.conditions.minScore ?? ''} onChange={(e) => setR({ ...r, conditions: { ...r.conditions, minScore: e.target.value === '' ? undefined : Number(e.target.value) } })} /></Field><Field label="Max score"><Input type="number" value={r.conditions.maxScore ?? ''} onChange={(e) => setR({ ...r, conditions: { ...r.conditions, maxScore: e.target.value === '' ? undefined : Number(e.target.value) } })} /></Field></div>}
          {r.trigger === 'lead.status_changed' && <Field label="New status is"><Select value={(r.conditions.toStatuses ?? [''])[0]} onChange={(e) => setR({ ...r, conditions: { toStatuses: e.target.value ? [e.target.value] : undefined } })} options={[{ value: '', label: 'any' }, ...LEAD_STATUSES.map((s) => ({ value: s, label: s.toLowerCase().replace(/_/g, ' ') }))]} /></Field>}
          <p className="label mt-3">Then</p>
          {r.actions.map((a, i) => (
            <div key={i} className="mb-2 grid grid-cols-3 gap-2 rounded border border-slate-200 p-2">
              <Select value={a.type} onChange={(e) => setAction(i, { type: e.target.value })} options={[{ value: 'create_task', label: 'Create task' }, { value: 'set_status', label: 'Set lead status' }, { value: 'add_to_list', label: 'Add to list' }, { value: 'create_opportunity', label: 'Create opportunity' }, { value: 'notify', label: 'Notify team' }, { value: 'enroll_campaign', label: 'Enroll in campaign' }]} />
              {['create_task', 'notify', 'create_opportunity'].includes(a.type) && <Input placeholder="title" value={(a.title as string) ?? ''} onChange={(e) => setAction(i, { ...a, title: e.target.value })} />}
              {a.type === 'create_task' && <Input type="number" placeholder="due in days" value={(a.dueInDays as number) ?? 0} onChange={(e) => setAction(i, { ...a, dueInDays: Number(e.target.value) })} />}
              {a.type === 'create_opportunity' && <Input type="number" placeholder="value (USD)" value={((a.valueCents as number) ?? 0) / 100} onChange={(e) => setAction(i, { ...a, valueCents: Math.round(Number(e.target.value) * 100) })} />}
              {a.type === 'set_status' && <Select value={(a.status as string) ?? ''} onChange={(e) => setAction(i, { ...a, status: e.target.value })} options={[{ value: '', label: 'choose…' }, ...LEAD_STATUSES.map((s) => ({ value: s, label: s }))]} />}
              {a.type === 'add_to_list' && <Select value={(a.listId as string) ?? ''} onChange={(e) => setAction(i, { ...a, listId: e.target.value })} options={[{ value: '', label: 'choose list…' }, ...(lists.data ?? []).map((l) => ({ value: l.id, label: l.name }))]} />}
              {a.type === 'enroll_campaign' && <Select value={(a.campaignId as string) ?? ''} onChange={(e) => setAction(i, { ...a, campaignId: e.target.value })} options={[{ value: '', label: 'approved campaign…' }, ...(campaigns.data ?? []).filter((c) => ['APPROVED', 'RUNNING'].includes(c.status)).map((c) => ({ value: c.id, label: c.name }))]} />}
              <Button variant="ghost" onClick={() => setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })}>Remove</Button>
            </div>
          ))}
          <Button variant="secondary" onClick={() => setR({ ...r, actions: [...r.actions, { type: 'notify', title: 'New event' }] })}>Add action</Button>
          <div className="mt-3"><Checkbox label="Enabled" checked={r.isEnabled} onChange={(v) => setR({ ...r, isEnabled: v })} /></div>
          <div className="mt-3 flex gap-2"><Button disabled={!r.name.trim() || r.actions.length === 0} loading={save.isPending} onClick={() => save.mutate()}>{editing ? 'Save' : 'Create rule'}</Button>{editing && <Button variant="secondary" onClick={() => { setEditing(null); setR(BLANK); }}>Cancel</Button>}</div>
        </Card>
        <div className="space-y-4">
          <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No rules yet" />}>
            {(rows) => <div className="space-y-2">{rows.map((x) => <Card key={x.id} title={<>{x.name} {x.isEnabled ? <Badge color="green">on</Badge> : <Badge>off</Badge>}</>} actions={<><Button variant="ghost" onClick={() => { setEditing(x.id); setR({ name: x.name, isEnabled: x.isEnabled, trigger: x.trigger, conditions: x.conditions, actions: x.actions }); }}>Edit</Button><ConfirmButton variant="ghost" confirm="Delete rule?" onConfirm={() => del.mutate(x.id)}>Delete</ConfirmButton></>}><p className="text-sm text-slate-600">{x.trigger} → {x.actions.map((a: Action) => a.type).join(', ')} · {x._count.runs} runs</p></Card>)}</div>}
          </QueryView>
          <Card title="Recent runs">
            <QueryView q={runs} isEmpty={(d) => d.length === 0} empty={<p className="text-sm text-slate-500">No runs yet.</p>}>
              {(rows) => <Table head={['When', 'Rule', 'Status', 'Result']}>{rows.slice(0, 50).map((x) => <tr key={x.id}><td className="td text-xs">{fmtDate(x.createdAt)}</td><td className="td text-sm">{x.rule.name}</td><td className="td"><Badge>{x.status}</Badge></td><td className="td text-xs">{(x.result as any[]).map((a) => `${a.action}: ${a.ok ? 'ok' : a.detail}`).join('; ')}</td></tr>)}</Table>}
            </QueryView>
          </Card>
        </div>
      </div>
    </>
  );
}
