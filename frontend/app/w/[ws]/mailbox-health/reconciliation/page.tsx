'use client';

import { useState } from 'react';
import { useWsQuery, useWsMutation } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Card, ConfirmButton, Empty, Notice, PageHeader, Pagination, QueryView } from '@/components/ui';

const decisions = {
  STILL_UNCERTAIN: 'Still uncertain',
  CONFIRMED_ACCEPTED: 'Confirmed accepted or submitted',
  CONFIRMED_NOT_SUBMITTED: 'Confirmed not submitted',
  MANUALLY_CLOSED: 'Close with insufficient provider evidence',
};
type Decision = keyof typeof decisions;
interface Review { decision: Decision; reason: string; evidence: string | null; reviewedAt: string; reviewedBy: string }
interface Attempt {
  id: string;
  attempts: number;
  sendStartedAt: string | null;
  uncertainAt: string | null;
  resolvedAt: string | null;
  reconciliation: Review | null;
  providerMessageId: string | null;
  internetMessageId: string;
  lastError: string | null;
  campaign: { name: string };
  emailAccount: { provider: string; emailAddress: string };
  enrollment: { lead: { email: string } };
  history: { action: string; createdAt: string; actorUserId: string | null; metadata: Record<string, unknown> }[];
}

function AttemptCard({ attempt }: { attempt: Attempt }) {
  const [decision, setDecision] = useState<Decision>('STILL_UNCERTAIN');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const save = useWsMutation<{ decision: Decision; reason: string; evidence?: string; confirmed: true }>(
    body => ({ path: `/outbound-reconciliation/${attempt.id}`, body }),
    { success: 'Reconciliation decision recorded', onSuccess: () => { setReason(''); setEvidence(''); } },
  );
  const review = attempt.reconciliation;
  return <Card title={attempt.enrollment.lead.email}>
    <div className="space-y-2 text-sm">
      <p>{attempt.campaign.name} · {attempt.emailAccount.emailAddress} · {attempt.emailAccount.provider}</p>
      <p>Attempt {attempt.id}/{attempt.attempts} · started {fmtDate(attempt.sendStartedAt)} · held {fmtDate(attempt.uncertainAt)}</p>
      <p>Message-ID {attempt.internetMessageId}{attempt.providerMessageId ? ` · Provider reference ${attempt.providerMessageId}` : ''}</p>
      <p>{attempt.lastError}</p>
      {review && <p>{decisions[review.decision]} · {fmtDate(review.reviewedAt)} · operator {review.reviewedBy}. {review.reason} {review.evidence}</p>}
      {attempt.history.length > 0 && <details><summary>Retry and reconciliation history</summary>
        <ul className="space-y-1">{attempt.history.map((event, index) => <li key={index}>{fmtDate(event.createdAt)} · {String(event.metadata.retryDecision ?? event.action)} · {String(event.metadata.submission ?? event.metadata.decision ?? '')}{event.metadata.providerStatus ? ` · HTTP ${String(event.metadata.providerStatus)}` : ''}{event.metadata.suppressed === true ? ' · recipient suppressed' : ''}</li>)}</ul>
      </details>}
      {!attempt.resolvedAt && <div className="grid gap-2 sm:max-w-xl">
        <label className="grid gap-1">Decision<select className="input" value={decision} onChange={event => setDecision(event.target.value as Decision)}>
          {Object.entries(decisions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label className="grid gap-1">Reason<textarea className="input" maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
        <label className="grid gap-1">Redacted provider evidence reference<input className="input" maxLength={500} value={evidence} onChange={event => setEvidence(event.target.value)} /></label>
        <ConfirmButton confirm="Record this decision? The attempt will remain blocked from resending." loading={save.isPending}
          disabled={reason.trim().length < 10 || (decision.startsWith('CONFIRMED_') && !evidence.trim())}
          onConfirm={() => save.mutate({ decision, reason, evidence: evidence.trim() || undefined, confirmed: true })}>Record decision</ConfirmButton>
      </div>}
    </div>
  </Card>;
}

export default function ReconciliationPage() {
  const [page, setPage] = useState(1);
  const [resolved, setResolved] = useState(false);
  const q = useWsQuery<{ data: Attempt[]; total: number; totalPages: number; page: number }>(
    `/outbound-reconciliation?page=${page}&pageSize=20&resolved=${resolved}`, { refetchInterval: 30_000 },
  );
  return <>
    <PageHeader title="Send reconciliation" subtitle="Review attempts whose submission could not be determined." />
    <Notice kind="warning">A review decision never resends a message, resumes its sequence, or confirms recipient delivery.</Notice>
    <label className="my-4 flex items-center gap-2"><input type="checkbox" checked={resolved} onChange={event => { setResolved(event.target.checked); setPage(1); }} /> Show closed reviews</label>
    <QueryView q={q} isEmpty={result => result.total === 0} empty={<Empty title="No sends to review" />}>
      {result => <div className="space-y-3">{result.data.map(attempt => <AttemptCard key={attempt.id} attempt={attempt} />)}
        <Pagination page={result.page} total={result.total} totalPages={result.totalPages} onPage={setPage} />
      </div>}
    </QueryView>
  </>;
}
