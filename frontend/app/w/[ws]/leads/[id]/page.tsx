'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate, fmtMoney, fullName } from '@/lib/format';
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader, QueryView, Select, Table, Tabs, Textarea } from '@/components/ui';
import { LEAD_STATUSES } from '@/lib/constants';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function LeadDetail() {
  const ws = useWs();
  const { id } = useParams<{ id: string }>();
  const q = useWsQuery<any>(`/leads/${id}`);
  const check = useWsQuery<{ allowed: boolean; reasons: string[] }>(`/compliance/check/${id}`);
  const [tab, setTab] = useState('overview');
  const [note, setNote] = useState('');
  const research = useWsMutation(() => ({ path: `/leads/${id}/research`, body: { thenScore: true } }), { success: 'Research queued (results appear in a minute)' });
  const score = useWsMutation(() => ({ path: `/leads/${id}/score`, body: {} }), { success: (r: any) => `Score ${r.score} (${r.qualified ? 'qualified' : 'not qualified'})` });
  const verify = useWsMutation(() => ({ path: `/leads/${id}/verify-waterfall`, body: { force: true } }), { success: (r: any) => `Verification: ${r?.result ?? 'done'}${r?.steps?.length ? ` (${r.steps.map((s: any) => s.provider).join(' → ')})` : ''}` });
  const status = useWsMutation<string>((s) => ({ path: `/leads/${id}`, method: 'PATCH', body: { status: s } }), { success: 'Status updated' });
  const addNote = useWsMutation(() => ({ path: `/leads/${id}/notes`, body: { body: note } }), { success: 'Note added', onSuccess: () => setNote('') });
  const addTask = useWsMutation<{ title: string; dueAt: string }>((b) => ({ path: '/tasks', body: { ...b, leadId: id, dueAt: b.dueAt || null } }), { success: 'Reminder created' });
  const addOpp = useWsMutation<{ title: string; value: string }>((b) => ({ path: '/opportunities', body: { leadId: id, title: b.title, valueCents: Math.round(Number(b.value || 0) * 100) } }), { success: 'Opportunity created' });
  const stopEnr = useWsMutation<string>((eid) => ({ path: `/enrollments/${eid}/stop`, body: {} }), { success: 'Sequence stopped' });
  const [task, setTask] = useState({ title: 'Follow up', dueAt: '' });
  const [opp, setOpp] = useState({ title: '', value: '' });

  return (
    <QueryView q={q}>
      {(l) => (
        <>
          <PageHeader title={fullName(l)} subtitle={<>{l.email} · {l.title ?? 'No title'} {l.company && <>· <Link className="underline" href={`/w/${ws}/companies/${l.company.id}`}>{l.company.name}</Link></>}</>}
            actions={<>
              <Select value={l.status} onChange={(e) => status.mutate(e.target.value)} options={LEAD_STATUSES} className="w-44" />
              <Button variant="secondary" loading={verify.isPending} onClick={() => verify.mutate()}>Verify email</Button>
              <Button variant="secondary" loading={research.isPending} onClick={() => research.mutate()}>Research</Button>
              <Button loading={score.isPending} onClick={() => score.mutate()}>Score vs ICP</Button>
            </>} />
          {check.data && !check.data.allowed && <div className="mb-4"><Notice kind="warning"><b>Not currently contactable:</b> {check.data.reasons.join(' · ')}</Notice></div>}
          <Tabs active={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'research', label: 'Research', count: l.researchReports.length }, { id: 'activity', label: 'Activity', count: l.events.length }, { id: 'crm', label: 'CRM', count: l.notes.length + l.tasks.length + l.opportunities.length }, { id: 'history', label: 'Status history' }]} />
          {tab === 'overview' && (
            <div className="grid gap-4 lg:grid-cols-3">
              <Card title="Profile">
                <dl className="space-y-2 text-sm">
                  {[['Status', <Badge key="s">{l.status}</Badge>], ['Email verification', <Badge key="v">{l.emailVerificationStatus}</Badge>], ['Score', l.currentScore ?? '—'], ['Country', l.country ?? '—'], ['Time zone', l.timezone ?? '—'], ['Lawful basis', `${l.lawfulBasis}${l.lawfulBasisNote ? ` — ${l.lawfulBasisNote}` : ''}`], ['Source', l.source?.name ?? 'manual'], ['Owner', l.owner?.name ?? '—'], ['Tags', l.tags.join(', ') || '—'], ['LinkedIn', l.linkedinUrl ? <a key="li" className="underline" href={l.linkedinUrl} target="_blank" rel="noreferrer">profile</a> : '—'], ['Last contacted', fmtDate(l.lastContactedAt)], ['Last reply', fmtDate(l.lastRepliedAt)]].map(([k, v]) => (
                    <div key={String(k)} className="flex justify-between gap-2"><dt className="text-slate-500">{k}</dt><dd className="text-right">{v}</dd></div>
                  ))}
                </dl>
                {Object.keys(l.customFields ?? {}).length > 0 && <div className="mt-3 border-t pt-2 text-xs text-slate-600">{Object.entries(l.customFields).map(([k, v]) => <div key={k}><b>{k}:</b> {String(v)}</div>)}</div>}
              </Card>
              <Card title="Latest ICP score">
                {l.scores[0] ? (
                  <div className="text-sm">
                    <p className="text-3xl font-semibold">{l.scores[0].score}<span className="text-base text-slate-500"> /100 · tier {l.scores[0].tier}</span></p>
                    <p className="mt-1">{l.scores[0].qualified ? <Badge color="green">Qualified</Badge> : <Badge color="red">Not qualified</Badge>} <span className="text-xs text-slate-500">vs {l.scores[0].icp?.name}</span></p>
                    <ul className="mt-3 space-y-1">{(l.scores[0].reasons as any[]).map((r, i) => <li key={i}>{r.met ? '✅' : '❌'} <b>{r.criterion}</b>: {r.explanation}</li>)}</ul>
                    {(l.scores[0].risks as string[]).length > 0 && <p className="mt-2 text-xs text-amber-700">Risks: {(l.scores[0].risks as string[]).join('; ')}</p>}
                  </div>
                ) : <Empty title="Not scored yet">Run research first so the score can use verified facts.</Empty>}
              </Card>
              <Card title="Campaigns & conversations">
                {l.enrollments.length === 0 && <p className="text-sm text-slate-500">Not enrolled in any campaign.</p>}
                <ul className="space-y-2 text-sm">
                  {l.enrollments.map((e: any) => <li key={e.id}><Link className="font-medium hover:underline" href={`/w/${ws}/campaigns/${e.campaign.id}`}>{e.campaign.name}</Link> <Badge>{e.status}</Badge><div className="text-xs text-slate-500">from {e.emailAccount.emailAddress} · step {e.currentStepOrder} {e.nextActionAt && `· next ${fmtDate(e.nextActionAt)}`}</div>{['ACTIVE', 'PAUSED'].includes(e.status) && <button className="text-xs text-red-600 underline" onClick={() => stopEnr.mutate(e.id)}>Stop sequence</button>}</li>)}
                </ul>
                <div className="mt-3 border-t pt-2">{l.conversations.map((c: any) => <Link key={c.id} href={`/w/${ws}/inbox/${c.id}`} className="block text-sm hover:underline">{c.subject ?? '(no subject)'} {c.category && <Badge>{c.category}</Badge>}</Link>)}</div>
              </Card>
            </div>
          )}
          {tab === 'research' && (
            l.researchReports.length === 0 ? <Empty title="No research yet" action={<Button onClick={() => research.mutate()}>Research now</Button>}>Research reads the company website (and a web-search API if configured) and keeps only facts backed by a quote from the source.</Empty> :
            <div className="space-y-4">{l.researchReports.map((r: any) => (
              <Card key={r.id} title={<>Report {fmtDate(r.createdAt)} <Badge>{r.status}</Badge></>} actions={<Link className="text-sm text-brand-700" href={`/w/${ws}/research/${r.id}`}>Open</Link>}>
                {r.summary && <p className="mb-2 text-sm">{r.summary}</p>}
                {r.error && <p className="mb-2 text-xs text-amber-700">{r.error}</p>}
                <ul className="space-y-1 text-sm">{r.claims.map((c: any) => <li key={c.id}><Badge>{c.status}</Badge> {c.text} <a className="text-xs text-brand-700 underline" href={c.evidence.url} target="_blank" rel="noreferrer">source</a></li>)}</ul>
              </Card>
            ))}</div>
          )}
          {tab === 'activity' && (
            <Card title="Email events">
              {l.events.length === 0 ? <p className="text-sm text-slate-500">No email activity yet.</p> : <Table head={['When', 'Event', 'Details']}>{l.events.map((e: any) => <tr key={e.id}><td className="td text-xs">{fmtDate(e.occurredAt)}</td><td className="td"><Badge>{e.type}</Badge></td><td className="td text-xs text-slate-500">{JSON.stringify(e.metadata) === '{}' ? '' : JSON.stringify(e.metadata)}</td></tr>)}</Table>}
            </Card>
          )}
          {tab === 'crm' && (
            <div className="grid gap-4 lg:grid-cols-3">
              <Card title="Notes">
                <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Internal note…" />
                <Button className="mt-2" disabled={!note.trim()} loading={addNote.isPending} onClick={() => addNote.mutate()}>Add note</Button>
                <ul className="mt-3 space-y-2">{l.notes.map((n: any) => <li key={n.id} className="rounded bg-slate-50 p-2 text-sm"><p className="whitespace-pre-wrap">{n.body}</p><p className="text-xs text-slate-400">{n.author?.name ?? 'system'} · {fmtDate(n.createdAt)}</p></li>)}</ul>
              </Card>
              <Card title="Tasks & reminders">
                <Field label="Title"><Input value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} /></Field>
                <Field label="Due"><Input type="datetime-local" value={task.dueAt} onChange={(e) => setTask({ ...task, dueAt: e.target.value })} /></Field>
                <Button className="mt-2" loading={addTask.isPending} onClick={() => addTask.mutate({ title: task.title, dueAt: task.dueAt ? new Date(task.dueAt).toISOString() : '' })}>Add reminder</Button>
                <ul className="mt-3 space-y-1 text-sm">{l.tasks.map((t: any) => <li key={t.id}>{t.status === 'DONE' ? '✅' : '⬜'} {t.title} <span className="text-xs text-slate-500">{fmtDate(t.dueAt)}</span></li>)}</ul>
              </Card>
              <Card title="Opportunities">
                <Field label="Title"><Input value={opp.title} onChange={(e) => setOpp({ ...opp, title: e.target.value })} /></Field>
                <Field label="Value (USD)"><Input type="number" value={opp.value} onChange={(e) => setOpp({ ...opp, value: e.target.value })} /></Field>
                <Button className="mt-2" disabled={!opp.title} loading={addOpp.isPending} onClick={() => addOpp.mutate(opp)}>Create opportunity</Button>
                <ul className="mt-3 space-y-1 text-sm">{l.opportunities.map((o: any) => <li key={o.id}>{o.title} <Badge>{o.stage}</Badge> {fmtMoney(o.valueCents, o.currency)}</li>)}</ul>
              </Card>
            </div>
          )}
          {tab === 'history' && (
            <Card title="Status history">
              <Table head={['When', 'From', 'To', 'Reason']}>{l.statusChanges.map((s: any) => <tr key={s.id}><td className="td text-xs">{fmtDate(s.createdAt)}</td><td className="td">{s.fromStatus ? <Badge>{s.fromStatus}</Badge> : '—'}</td><td className="td"><Badge>{s.toStatus}</Badge></td><td className="td text-sm">{s.reason}</td></tr>)}</Table>
            </Card>
          )}
        </>
      )}
    </QueryView>
  );
}
