'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Button, Card, ConfirmButton, Field, Input, PageHeader, QueryView, Select, Table, Textarea } from '@/components/ui';

import { WarmupConfiguration } from '@/components/warmup-configuration';

interface Program {
  status: string; reason: string | null; dailyTarget: number; nextAt: string | null;
  emailAccount: { emailAddress: string; status: string; provider: string; domain: { id?: string; name?: string; lastCheckedAt?: string | null; spfStatus: string; dkimStatus: string; dmarcStatus: string } | null };
  config: { subject: string; body: string; durationDays: number; maximumTarget: number; observationDays: number; window: { timezone: string; days: number[]; start: string; end: string } };
  recipients: { id: string; email: string; dailyLimit: number; enabled: boolean; authorizedAt: string }[];
  messages: { id: string; status: string; reservedAt: string; resolvedAt: string | null; reason: string | null; providerMessageId: string | null; recipient: { email: string } }[];
  daily: { day: string; status: string; bounced: boolean; replied: boolean; count: number }[];
  history: { id: string; action: string; createdAt: string }[];
}

function Review({ programId, messageId }: { programId: string; messageId: string }) {
  const [decision, setDecision] = useState('STILL_UNCERTAIN');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const review = useWsMutation<unknown>(() => ({
    path: `/warmup/${programId}/messages/${messageId}/reconcile`, body: { decision, reason, evidence: evidence.trim() || undefined, confirmed: true },
  }), { success: 'Submission review recorded' });
  return <details className="space-y-2"><summary>Review ambiguous submission</summary>
    <Select aria-label="Submission decision" value={decision} onChange={e => setDecision(e.target.value)} options={[
      { value: 'STILL_UNCERTAIN', label: 'Still uncertain' }, { value: 'CONFIRMED_ACCEPTED', label: 'Confirmed submitted' },
      { value: 'CONFIRMED_NOT_SUBMITTED', label: 'Confirmed not submitted' }, { value: 'MANUALLY_CLOSED', label: 'Close with insufficient evidence' },
    ]} />
    <Input aria-label="Review reason" placeholder="Reason" value={reason} onChange={e => setReason(e.target.value)} />
    <Input aria-label="Provider evidence reference" placeholder="Redacted evidence reference" value={evidence} onChange={e => setEvidence(e.target.value)} />
    <ConfirmButton confirm="Record decision without resending?" onConfirm={() => review.mutate({})} disabled={reason.trim().length < 10 || (decision.startsWith('CONFIRMED_') && !evidence.trim())} loading={review.isPending}>Record decision</ConfirmButton>
  </details>;
}

export default function WarmupProgramPage() {
  const ws = useWs();
  const checkDomain = useWsMutation<string>(domainId => ({ path: `/domains/${domainId}/check`, body: {} }), { success: 'Domain check complete' });
  const { id } = useParams<{ id: string }>();
  const q = useWsQuery<Program>(`/warmup/${id}`, { refetchInterval: 30_000 });
  const [emails, setEmails] = useState('');
  const [evidence, setEvidence] = useState('');
  const [limit, setLimit] = useState(1);
  const [days, setDays] = useState('30');
  const action = useWsMutation<string>(value => ({ path: `/warmup/${id}/actions`, body: { action: value, confirmed: true } }), { success: 'Program updated' });
  const revoke = useWsMutation<string>(recipient => ({ path: `/warmup/${id}/recipients/${recipient}`, method: 'DELETE' }), { success: 'Authorization withdrawn' });
  const add = useWsMutation<unknown>(() => ({ path: `/warmup/${id}/recipients`, body: {
    recipients: [...new Set(emails.split(/[\n,]+/).map(e => e.trim()).filter(Boolean))].map(email => ({ email, evidence, dailyLimit: limit, authorized: true })),
  } }), { success: 'Recipients authorized', onSuccess: () => { setEmails(''); setEvidence(''); } });
  return <QueryView q={q}>{p => <>
    <PageHeader title={p.emailAccount.emailAddress} subtitle={`Warm-up · ${p.emailAccount.provider} · ${p.status.replaceAll('_', ' ')}`} />
    <Card title="Schedule and progression">
      <p className="text-sm">{p.config.window.start}–{p.config.window.end} {p.config.window.timezone} · weekdays {p.config.window.days.join(', ')} · {p.config.durationDays} days</p>
      <p className="text-sm">{p.dailyTarget} daily target · {p.config.maximumTarget} maximum · {p.config.observationDays} observation days · next review {fmtDate(p.nextAt)}</p>
      <p className="text-sm">{p.reason}</p>
      <details className="my-2"><summary>Reviewed message</summary><p>{p.config.subject}</p><p className="whitespace-pre-wrap">{p.config.body}</p></details>
      <div className="flex flex-wrap gap-2">
        {(p.status === 'READY_TO_START' ? ['START', 'STOP'] : p.status === 'ACTIVE' ? ['PAUSE', 'STOP'] : ['PAUSED', 'HEALTH_HOLD', 'AUTH_REQUIRED'].includes(p.status) ? ['RESUME', 'STOP'] : []).map(value =>
          <ConfirmButton key={value} confirm={`${value.toLowerCase()} this controlled warm-up program?`} loading={action.isPending} onConfirm={() => action.mutate(value)}>{value[0] + value.slice(1).toLowerCase()} warm-up</ConfirmButton>,
        )}
      </div>
    </Card>
    {p.status === 'READY_TO_START' && <WarmupConfiguration program={{ id, config: p.config }} />}
    <Card title="Authentication and mailbox health">
      <p>Connection {p.emailAccount.status} · SPF {p.emailAccount.domain?.spfStatus ?? 'UNKNOWN'} · DKIM {p.emailAccount.domain?.dkimStatus ?? 'UNKNOWN'} · DMARC {p.emailAccount.domain?.dmarcStatus ?? 'UNKNOWN'}</p>
      <p className="text-sm">Warm-up requires SPF, DKIM and DMARC to pass on a domain check from the past three days.</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="text-sm">Last checked {fmtDate(p.emailAccount.domain?.lastCheckedAt ?? null)}</span>
        {p.emailAccount.domain?.id && <Button variant="secondary" loading={checkDomain.isPending} onClick={() => {
          const domainId = p.emailAccount.domain?.id;
          if (domainId) checkDomain.mutate(domainId);
        }}>Check now</Button>}
        <Link className="text-sm underline" href={`/w/${ws}/domains${p.emailAccount.domain?.id ? `/${p.emailAccount.domain.id}` : ''}`}>Open domain settings</Link>
      </div>
    </Card>
    <Card title="Authorized recipients">
      <Field label="Recipient addresses, separated by newline or comma"><Textarea value={emails} onChange={e => setEmails(e.target.value)} /></Field>
      <Field label="Authorization evidence reference"><Input value={evidence} onChange={e => setEvidence(e.target.value)} /></Field>
      <Field label="Daily limit per recipient"><Input type="number" min={1} max={5} value={limit} onChange={e => setLimit(Number(e.target.value))} /></Field>
      <ConfirmButton confirm="Confirm every listed recipient has explicitly agreed to receive these messages." disabled={!emails.trim() || evidence.trim().length < 10} loading={add.isPending} onConfirm={() => add.mutate({})}>Authorize recipients</ConfirmButton>
      <ul>{p.recipients.map(r => <li key={r.id} className="my-2 flex flex-wrap items-center gap-2">{r.email} · {r.dailyLimit}/day · {r.enabled ? 'Authorized' : 'Withdrawn'} · {fmtDate(r.authorizedAt)}{r.enabled && <ConfirmButton variant="ghost" confirm="Withdraw this recipient’s authorization?" onConfirm={() => revoke.mutate(r.id)}>Withdraw</ConfirmButton>}</li>)}</ul>
    </Card>
    <Card title="Activity and analytics">
      <p className="text-sm">Provider acceptance records submission. Inbox placement is not measured.</p>
      <Select aria-label="Analytics date range" value={days} onChange={e => setDays(e.target.value)} options={[{ value: '1', label: 'Last day' }, { value: '7', label: 'Last week' }, { value: '30', label: 'Last month' }]} />
      <Table head={['UTC date', 'Outcome', 'Bounce', 'Observed reply', 'Count']}>{p.daily.filter(row => Date.parse(row.day) >= Date.now() - Number(days) * 86_400_000).map((row, i) => <tr key={i}><td className="td">{row.day}</td><td className="td">{row.status}</td><td className="td">{row.bounced ? 'Yes' : '—'}</td><td className="td">{row.replied ? 'Yes' : '—'}</td><td className="td">{row.count}</td></tr>)}</Table>
      <ul className="mt-3 space-y-2">{p.messages.map(m => <li key={m.id} className="text-sm">{fmtDate(m.reservedAt)} · {m.recipient.email} · {m.status} {m.reason} {m.providerMessageId}{m.status === 'UNCERTAIN' && (m.resolvedAt ? ' · Reviewed' : <Review programId={id} messageId={m.id} />)}</li>)}</ul>
      {!p.messages.length && <p className="text-sm">No controlled submissions yet.</p>}
    </Card>
    <Card title="Program history"><ul>{p.history.map(event => <li key={event.id}>{fmtDate(event.createdAt)} · {event.action.replaceAll('_', ' ')}</li>)}</ul></Card>
  </>}</QueryView>;
}
