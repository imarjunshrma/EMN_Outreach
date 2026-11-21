'use client';

import Link from 'next/link';
import { useState } from 'react';
import { qs, type Paged } from '@/lib/api';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fullName } from '@/lib/format';
import { Badge, Button, Empty, Field, Input, Modal, Notice, Pagination, QueryView, Table, Textarea } from './ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Emails waiting for human approval (AI content or review-all campaigns). */
export function ReviewPanel({ campaignId }: { campaignId?: string }) {
  const ws = useWs();
  const [page, setPage] = useState(1);
  const q = useWsQuery<Paged<any>>(`/outbound${qs({ campaignId, awaitingApproval: 'true', page, pageSize: 25 })}`, { refetchInterval: 20_000 });
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      <QueryView q={q} isEmpty={(d) => d.total === 0} empty={<Empty title="Nothing waiting for review">AI-written emails appear here before they are sent.</Empty>}>
        {(d) => (
          <div className="card p-2">
            <Table head={['To', 'Campaign', 'Step', 'Subject', 'Fact-check', '']}>
              {d.data.map((o: any) => (
                <tr key={o.id}>
                  <td className="td"><Link className="text-brand-700 hover:underline" href={`/w/${ws}/leads/${o.enrollment.lead.id}`}>{fullName(o.enrollment.lead)}</Link><div className="text-xs text-slate-500">{o.toAddress}</div></td>
                  <td className="td text-sm">{o.campaign.name}</td><td className="td">{o.step.order}</td><td className="td max-w-xs truncate text-sm">{o.subject}</td>
                  <td className="td"><Badge>{o.factCheckStatus}</Badge></td>
                  <td className="td"><Button onClick={() => setOpenId(o.id)}>Review</Button></td>
                </tr>
              ))}
            </Table>
            <Pagination page={d.page} totalPages={d.totalPages} total={d.total} onPage={setPage} />
          </div>
        )}
      </QueryView>
      {openId && <ReviewModal id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function ReviewModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useWsQuery<any>(`/outbound/${id}`);
  const [subject, setSubject] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const review = useWsMutation<'approve' | 'reject'>((decision) => ({ path: `/outbound/${id}/review`, body: { decision, subject: subject ?? undefined, bodyText: body ?? undefined, reason: reason || undefined } }), { success: (r: any) => (r?.status === 'QUEUED' ? 'Approved and queued for sending' : 'Rejected'), onSuccess: onClose });
  return (
    <Modal open wide title="Review email" onClose={onClose} footer={<><Button variant="danger" loading={review.isPending} onClick={() => review.mutate('reject')}>Reject</Button><Button loading={review.isPending} onClick={() => review.mutate('approve')}>Approve & send</Button></>}>
      <QueryView q={q}>
        {(o) => (
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-sm text-slate-500">To <b>{o.toAddress}</b> from <b>{o.emailAccount.emailAddress}</b> · {o.campaign.name} step {o.step.order}</p>
              <Field label="Subject"><Input value={subject ?? o.subject ?? ''} onChange={(e) => setSubject(e.target.value)} /></Field>
              <Field label="Body (editing re-runs the fact-check)"><Textarea rows={16} value={body ?? o.bodyText ?? ''} onChange={(e) => setBody(e.target.value)} /></Field>
              <Field label="Reject reason (optional)"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            </div>
            <div className="space-y-3">
              {o.factCheckStatus === 'FAILED' && <Notice kind="danger">The fact-checker found statements it could not verify. Remove or rewrite them; approval is blocked until the check passes.</Notice>}
              <div>
                <p className="label">Fact-check</p>
                {(o.factCheckReport ?? []).length === 0 ? <p className="text-sm text-slate-500">Not required (template-only content).</p> : <ul className="space-y-1 text-sm">{(o.factCheckReport as any[]).map((s, i) => <li key={i}><Badge color={s.verdict === 'UNSUPPORTED' ? 'red' : s.verdict === 'SUPPORTED' ? 'green' : 'gray'}>{s.verdict}</Badge> {s.text}{s.verdict === 'UNSUPPORTED' && <span className="block text-xs text-red-600">{s.reason}</span>}</li>)}</ul>}
              </div>
              <div>
                <p className="label">Facts used (with sources)</p>
                {o.claims.length === 0 ? <p className="text-sm text-slate-500">No research facts used.</p> : <ul className="space-y-1 text-sm">{o.claims.map((c: any) => <li key={c.id}>{c.text} <a className="text-xs text-brand-700 underline" href={c.evidence.url} target="_blank" rel="noreferrer">source</a></li>)}</ul>}
              </div>
            </div>
          </div>
        )}
      </QueryView>
    </Modal>
  );
}
