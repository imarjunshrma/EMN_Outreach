'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, Checkbox, ConfirmButton, Empty, Field, Input, Notice, PageHeader, QueryView, Tabs, Textarea } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const TEMPLATE_CATS = ['INTERESTED', 'WANTS_MEETING', 'NEEDS_INFO', 'WRONG_PERSON'];

export default function ReplyAssistant() {
  const ws = useWs();
  const [tab, setTab] = useState('queue');
  const settings = useWsQuery<any>('');
  const pending = useWsQuery<any[]>('/reply-suggestions?status=PENDING', { refetchInterval: 30_000 });
  const recent = useWsQuery<any[]>('/reply-suggestions');
  const templates = useWsQuery<any[]>('/reply-templates');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const approve = useWsMutation<{ id: string; body?: string }>((b) => ({ path: `/reply-suggestions/${b.id}/approve`, body: { body: b.body } }), { success: 'Approved — sending from the original mailbox' });
  const dismiss = useWsMutation<string>((id) => ({ path: `/reply-suggestions/${id}/dismiss`, body: {} }), { success: 'Dismissed' });
  const [t, setT] = useState<{ id: string | null; name: string; body: string; categories: string[] }>({ id: null, name: '', body: '', categories: [] });
  const saveT = useWsMutation(() => ({ path: t.id ? `/reply-templates/${t.id}` : '/reply-templates', method: t.id ? 'PUT' : 'POST', body: { name: t.name, body: t.body, categories: t.categories } }), { success: 'Template saved (needs manager approval before auto use)', onSuccess: () => setT({ id: null, name: '', body: '', categories: [] }) });
  const approveT = useWsMutation<{ id: string; approve: boolean }>((b) => ({ path: `/reply-templates/${b.id}/approve`, body: { approve: b.approve } }), { success: 'Updated' });
  const delT = useWsMutation<string>((id) => ({ path: `/reply-templates/${id}`, method: 'DELETE' }), { success: 'Deleted' });
  const mode = settings.data?.settings?.replyMode ?? 'draft';
  return (
    <>
      <PageHeader title="Reply assistant" subtitle="AI drafts replies to inbound messages. By default a person approves every reply before it is sent." actions={<Link href={`/w/${ws}/settings/policies`}><Button variant="secondary">Mode: {mode === 'auto_narrow' ? 'narrow auto' : mode}</Button></Link>} />
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'queue', label: 'Awaiting approval', count: pending.data?.length }, { id: 'history', label: 'History' }, { id: 'templates', label: 'Reply templates', count: templates.data?.length }]} />
      {tab === 'queue' && <QueryView q={pending} isEmpty={(d) => d.length === 0} empty={<Empty title="Nothing awaiting approval">New drafts appear here after replies are classified.</Empty>}>
        {(rows) => <div className="space-y-3">{rows.map((s) => {
          const flagged = /\b(price|pricing|cost|\$|₹|discount|guarantee|contract|commit)/i.test(s.body);
          return (
            <Card key={s.id} title={<><Badge>{s.category ?? 'reply'}</Badge> <span className="ml-1 text-xs font-normal text-slate-500">{s.mode.toLowerCase()} · {fmtDate(s.createdAt)}</span></>} actions={<Link className="text-sm underline" href={`/w/${ws}/inbox/${s.conversationId}`}>Open thread</Link>}>
              {flagged && <div className="mb-2"><Notice kind="warning">This draft mentions pricing or commitments. Make sure every figure and promise comes from you.</Notice></div>}
              {s.reason && <p className="mb-2 text-xs text-slate-500">{s.reason}</p>}
              <Textarea rows={6} value={edits[s.id] ?? s.body} onChange={(e) => setEdits({ ...edits, [s.id]: e.target.value })} />
              <div className="mt-2 flex gap-2"><ConfirmButton confirm="Send this reply from the original mailbox?" loading={approve.isPending} onConfirm={() => approve.mutate({ id: s.id, body: edits[s.id] })}>Approve & send</ConfirmButton><Button variant="ghost" onClick={() => dismiss.mutate(s.id)}>Dismiss</Button></div>
            </Card>
          );
        })}</div>}
      </QueryView>}
      {tab === 'history' && <QueryView q={recent} isEmpty={(d) => d.length === 0} empty={<Empty title="No suggestions yet" />}>
        {(rows) => <div className="card divide-y divide-slate-100">{rows.map((s) => <div key={s.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm"><span className="truncate"><Badge>{s.status}</Badge> <Badge color="gray">{s.mode}</Badge> {s.body.slice(0, 120)}</span><span className="text-xs text-slate-500">{fmtDate(s.createdAt)}</span></div>)}</div>}
      </QueryView>}
      {tab === 'templates' && <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t.id ? 'Edit template' : 'New template'}>
          <Field label="Name"><Input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></Field>
          <Field label="Body" hint="Variables: {{firstName}}, {{bookingLink}}, {{sender.name}}. No prices or commitments."><Textarea rows={7} value={t.body} onChange={(e) => setT({ ...t, body: e.target.value })} /></Field>
          <p className="label mt-2">Use for categories</p>
          {TEMPLATE_CATS.map((c) => <Checkbox key={c} label={c.toLowerCase().replace(/_/g, ' ')} checked={t.categories.includes(c)} onChange={(v) => setT({ ...t, categories: v ? [...t.categories, c] : t.categories.filter((x) => x !== c) })} />)}
          <Button className="mt-3" disabled={!t.name || !t.body} loading={saveT.isPending} onClick={() => saveT.mutate()}>Save</Button>
          {t.id && <Button variant="ghost" onClick={() => setT({ id: null, name: '', body: '', categories: [] })}>Cancel</Button>}
          <p className="mt-2 text-xs text-slate-500">Editing an approved template withdraws its approval.</p>
        </Card>
        <div className="lg:col-span-2"><QueryView q={templates} isEmpty={(d) => d.length === 0} empty={<Empty title="No templates">Auto mode can only send approved templates.</Empty>}>
          {(rows) => <div className="space-y-3">{rows.map((x) => <Card key={x.id} title={<>{x.name} {x.isApproved ? <Badge color="green">approved</Badge> : <Badge color="yellow">not approved</Badge>}</>} actions={<><Button variant="ghost" onClick={() => setT({ id: x.id, name: x.name, body: x.body, categories: x.categories })}>Edit</Button><Button variant="secondary" onClick={() => approveT.mutate({ id: x.id, approve: !x.isApproved })}>{x.isApproved ? 'Withdraw approval' : 'Approve (manager)'}</Button><ConfirmButton variant="ghost" confirm="Delete template?" onConfirm={() => delT.mutate(x.id)}>Delete</ConfirmButton></>}><p className="mb-1 text-xs text-slate-500">{x.categories.join(', ') || 'no categories'}</p><div className="prose-email">{x.body}</div></Card>)}</div>}
        </QueryView></div>
      </div>}
    </>
  );
}
