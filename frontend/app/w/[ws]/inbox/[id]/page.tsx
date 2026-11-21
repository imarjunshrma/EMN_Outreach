'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate, fullName } from '@/lib/format';
import { REPLY_CATEGORIES } from '@/lib/constants';
import { Badge, Button, Card, ConfirmButton, Input, Notice, PageHeader, QueryView, Select, Textarea } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Conversation() {
  const ws = useWs();
  const { id } = useParams<{ id: string }>();
  const q = useWsQuery<any>(`/conversations/${id}`);
  const members = useWsQuery<{ members: Array<{ user: { id: string; name: string } }> }>('/members');
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [label, setLabel] = useState('');
  const [fwd, setFwd] = useState({ to: '', note: '' });
  const suggestions = useWsQuery<any[]>(`/reply-suggestions?conversationId=${id}`);
  const suggest = useWsMutation(() => ({ path: `/conversations/${id}/suggest`, body: {} }), { success: 'Reply assistant ran — see suggestions' });
  const approveS = useWsMutation<{ id: string; body?: string }>((b) => ({ path: `/reply-suggestions/${b.id}/approve`, body: { body: b.body } }), { success: 'Approved — sending from the original mailbox' });
  const dismissS = useWsMutation<string>((sid) => ({ path: `/reply-suggestions/${sid}/dismiss`, body: {} }), { success: 'Dismissed' });
  const forward = useWsMutation(() => ({ path: `/conversations/${id}/forward`, body: { to: fwd.to, note: fwd.note, idempotencyKey: `${id}-${fwd.to}-${fwd.note.length}` } }), { success: 'Forward queued', onSuccess: () => setFwd({ to: '', note: '' }) });
  const [summary, setSummary] = useState<{ summary: string; openQuestions: string[]; suggestedNextAction: string } | null>(null);
  const [draftCheck, setDraftCheck] = useState<{ passed: boolean; sentences: Array<{ text: string; verdict: string }> } | null>(null);
  const update = useWsMutation<Record<string, unknown>>((b) => ({ path: `/conversations/${id}`, method: 'PATCH', body: b }), { success: 'Updated' });
  const markRead = useWsMutation(() => ({ path: `/conversations/${id}`, method: 'PATCH', body: { isUnread: false } }));
  const send = useWsMutation(() => ({ path: `/conversations/${id}/reply`, body: { bodyText: reply, idempotencyKey: `${id}-${reply.length}-${reply.slice(0, 20)}` } }), { success: 'Reply queued — it will appear in the thread once sent', onSuccess: () => setReply('') });
  const addNote = useWsMutation(() => ({ path: `/conversations/${id}/notes`, body: { body: note } }), { success: 'Note added', onSuccess: () => setNote('') });
  const summarize = useWsMutation(() => ({ path: `/conversations/${id}/summary`, body: {} }), { onSuccess: (r: any) => setSummary(r) });
  const draft = useWsMutation(() => ({ path: `/conversations/${id}/draft`, body: {} }), { invalidate: false, success: 'Draft ready — review before sending', onSuccess: (r: any) => { setReply(r.body); setDraftCheck(r.factCheck); } });
  const createOpp = useWsMutation<{ leadId: string; title: string; campaignId?: string | null }>((b) => ({ path: '/opportunities', body: b }), { success: 'Opportunity created — see Pipeline' });
  const classify = useWsMutation<string>((mid) => ({ path: `/messages/${mid}/classify`, body: {} }), { success: (r: any) => `Classified: ${r?.category ?? 'n/a'}` });
  useEffect(() => { if (q.data?.isUnread) markRead.mutate(); }, [q.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <QueryView q={q}>
      {(c) => (
        <>
          <PageHeader title={c.subject ?? '(no subject)'} subtitle={<>{c.lead ? <Link className="underline" href={`/w/${ws}/leads/${c.lead.id}`}>{fullName(c.lead)}</Link> : 'Unknown contact'} · via {c.emailAccount.emailAddress} {c.campaign && <>· <Link className="underline" href={`/w/${ws}/campaigns/${c.campaign.id}`}>{c.campaign.name}</Link></>}</>}
            actions={<><Button variant="secondary" loading={summarize.isPending} onClick={() => summarize.mutate()}>AI summary</Button><Button variant="secondary" loading={draft.isPending} onClick={() => draft.mutate()}>AI reply draft</Button><Button variant="secondary" loading={suggest.isPending} onClick={() => suggest.mutate()}>Run reply assistant</Button><Button variant="ghost" onClick={() => update.mutate({ isStarred: !c.isStarred })}>{c.isStarred ? 'Starred' : 'Star'}</Button><Button variant="ghost" onClick={() => update.mutate({ isArchived: !c.isArchived })}>{c.isArchived ? 'Unarchive' : 'Archive'}</Button>{c.lead && <Button variant="secondary" loading={createOpp.isPending} onClick={() => createOpp.mutate({ leadId: c.lead.id, title: `${fullName(c.lead)} — ${c.subject ?? 'reply'}`.slice(0, 200), campaignId: c.campaignId ?? undefined })}>Create opportunity</Button>}</>} />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-3 lg:col-span-2">
              {(summary || c.summary) && <Notice><b>Summary:</b> {summary?.summary ?? c.summary}{summary && <>{summary.openQuestions.length > 0 && <div className="mt-1"><b>Open questions:</b> {summary.openQuestions.join(' · ')}</div>}<div className="mt-1"><b>Suggested next step:</b> {summary.suggestedNextAction}</div></>}</Notice>}
              {c.messages.map((m: any) => (
                <div key={m.id} className={`card p-4 ${m.direction === 'OUTBOUND' ? 'ml-8 border-brand-100 bg-brand-50/30' : 'mr-8'}`}>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                    <span><b className="text-slate-700">{m.fromName ?? m.fromAddress}</b> → {m.toAddresses.join(', ')}</span>
                    <span className="flex items-center gap-2">{m.isAutoReply && <Badge>auto-reply</Badge>}{m.isBounce && <Badge color="red">bounce</Badge>}{m.category && <Badge>{m.category}</Badge>}{m.sentiment && <Badge color="gray">{m.sentiment}</Badge>}{m.direction === 'INBOUND' && !m.isBounce && <button className="underline" onClick={() => classify.mutate(m.id)}>re-classify</button>}{fmtDate(m.sentAt)}</span>
                  </div>
                  {m.objection && <p className="mb-2 text-xs text-amber-700">Objection: {m.objection}</p>}
                  <div className="prose-email">{m.bodyText ?? '(no text body)'}</div>
                  {m.attachments.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{m.attachments.map((a: any) => a.storageKey ? <a key={a.id} className="rounded bg-slate-100 px-2 py-1 text-xs underline" href={`/api/v1/w/${ws}/attachments/${a.id}`}>{a.filename}</a> : <span key={a.id} className="rounded bg-slate-100 px-2 py-1 text-xs">{a.filename} (too large)</span>)}</div>}
                </div>
              ))}
              {(suggestions.data ?? []).filter((x) => x.status === 'PENDING').map((x) => (
                <Card key={x.id} title={<>AI suggested reply <Badge>{x.mode}</Badge></>} actions={<><Button variant="secondary" onClick={() => setReply(x.body)}>Use in editor</Button><ConfirmButton confirm="Send this reply now?" loading={approveS.isPending} onConfirm={() => approveS.mutate({ id: x.id })}>Approve & send</ConfirmButton><Button variant="ghost" onClick={() => dismissS.mutate(x.id)}>Dismiss</Button></>}>
                  <div className="prose-email">{x.body}</div>
                  {x.reason && <p className="mt-2 text-xs text-amber-700">{x.reason}</p>}
                </Card>
              ))}
              <Card title={`Reply from ${c.emailAccount.emailAddress}`}>
                {c.emailAccount.status !== 'CONNECTED' && <Notice kind="danger">This mailbox is {c.emailAccount.status.toLowerCase()}. Reconnect it to reply.</Notice>}
                <Textarea rows={7} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write your reply…" />
                {draftCheck && !draftCheck.passed && <div className="mt-2"><Notice kind="warning">The AI draft contains statements the fact-checker could not verify: {draftCheck.sentences.filter((s) => s.verdict === 'UNSUPPORTED').map((s) => `“${s.text}”`).join(' ')}. Edit before sending.</Notice></div>}
                <p className="mt-1 text-xs text-slate-500">Nothing is sent automatically. Review AI drafts carefully — pricing and commitments must come from you.</p>
                <Button className="mt-2" disabled={!reply.trim() || c.emailAccount.status !== 'CONNECTED'} loading={send.isPending} onClick={() => send.mutate()}>Send reply</Button>
              </Card>
            </div>
            <div className="space-y-4">
              <Card title="Manage">
                <label className="label">Category (AI or manual)</label>
                <Select value={c.category ?? ''} onChange={(e) => update.mutate({ category: e.target.value })} options={[{ value: '', label: '—' }, ...REPLY_CATEGORIES.map((x) => ({ value: x, label: x.toLowerCase().replace(/_/g, ' ') }))]} />
                <p className="mt-1 text-xs text-slate-500">Setting Unsubscribe or Complaint suppresses the contact and stops all sequences.</p>
                <label className="label mt-3">Status</label>
                <Select value={c.status} onChange={(e) => update.mutate({ status: e.target.value })} options={['OPEN', 'WAITING', 'CLOSED']} />
                <label className="label mt-3">Assignee</label>
                <Select value={c.assigneeId ?? ''} onChange={(e) => update.mutate({ assigneeId: e.target.value || null })} options={[{ value: '', label: 'Unassigned' }, ...(members.data?.members ?? []).map((m) => ({ value: m.user.id, label: m.user.name }))]} />
                <label className="label mt-3">Labels</label>
                <div className="flex flex-wrap gap-1">{c.labels.map((l: string) => <button key={l} onClick={() => update.mutate({ labels: c.labels.filter((x: string) => x !== l) })}><Badge color="purple">{l} ✕</Badge></button>)}</div>
                <div className="mt-2 flex gap-2"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="add label" /><Button variant="secondary" disabled={!label.trim()} onClick={() => { update.mutate({ labels: [...c.labels, label.trim()] }); setLabel(''); }}>Add</Button></div>
                <Button variant="ghost" className="mt-3" onClick={() => update.mutate({ isUnread: true })}>Mark unread</Button>
              </Card>
              <Card title="Forward">
                <Input type="email" value={fwd.to} onChange={(e) => setFwd({ ...fwd, to: e.target.value })} placeholder="colleague@company.com" />
                <Textarea rows={2} className="mt-2" value={fwd.note} onChange={(e) => setFwd({ ...fwd, note: e.target.value })} placeholder="Note (optional)" />
                <Button className="mt-2" variant="secondary" disabled={!/.+@.+\..+/.test(fwd.to) || c.emailAccount.status !== 'CONNECTED'} loading={forward.isPending} onClick={() => forward.mutate()}>Forward thread</Button>
                <p className="mt-1 text-xs text-slate-500">Sent from {c.emailAccount.emailAddress}. Suppressed addresses are refused.</p>
              </Card>
              <Card title="Internal notes">
                <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
                <Button className="mt-2" disabled={!note.trim()} onClick={() => addNote.mutate()}>Add note</Button>
                <ul className="mt-3 space-y-2">{c.notes.map((n: any) => <li key={n.id} className="rounded bg-amber-50 p-2 text-sm"><p className="whitespace-pre-wrap">{n.body}</p><p className="text-xs text-slate-400">{n.author?.name} · {fmtDate(n.createdAt)}</p></li>)}</ul>
              </Card>
            </div>
          </div>
        </>
      )}
    </QueryView>
  );
}
