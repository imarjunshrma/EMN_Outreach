'use client';

import { TrackingTotals } from '@/components/tracking-totals';

import Link from 'next/link';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Empty, Notice, PageHeader, QueryView, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function MailboxHealth() {
  const ws = useWs();
  const q = useWsQuery<any[]>('/mailbox-health', { refetchInterval: 60_000 });
  const registry = useWsQuery<any[]>('/provider-registry');
  const readinessSave = useWsMutation<{ id: string; readiness: any }, any>((v) => ({ path: `/email-accounts/${v.id}`, method: 'PATCH', body: { readiness: v.readiness } }), { success: 'Mailbox readiness settings saved' });
  return (
    <>
      <PageHeader actions={<><Link className="mr-4 underline" href={`/w/${ws}/warmup`}>Warm-up</Link><Link className="underline" href={`/w/${ws}/mailbox-health/reconciliation`}>Send reconciliation</Link></>} title="Mailbox health" subtitle="Connection, authentication, sync and sending signals for every mailbox (last 30 days). Only measured data is shown — inbox placement is not estimated." />
      <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No mailboxes connected" action={<Link className="underline" href={`/w/${ws}/email-accounts`}>Connect a mailbox</Link>} />}>
        {(rows) => (
          <div className="card p-2"><Table head={['Mailbox', 'Health', 'Status', 'SMTP', 'IMAP', 'Auth', 'Last sync', 'Last accepted (30d)', 'Last received', 'Readiness cap', 'Accepted today / hour', 'Accepted 30d', 'Bounce %', 'Complaints in replies', 'Tracking (all dates)', 'Domain', 'Last error and history']}>
            {rows.map((a) => (
              <tr key={a.id}>
                <td className="td text-xs">{a.emailAddress}<div className="text-slate-400">{a.provider}</div></td>
                <td className="td"><Badge color={a.health.status === 'Healthy' ? 'green' : a.health.status === 'Warning' || a.health.status === 'Disconnected' ? 'red' : a.health.status === 'Paused' ? 'gray' : 'yellow'}>{a.health.status}</Badge>{a.health.reasons.length > 0 && <div className="mt-1 max-w-xs text-xs text-slate-500" title={a.health.reasons.join('\n')}>{a.health.reasons[0]}</div>}</td>
                <td className="td"><Badge>{a.status}</Badge>
                  {a.statusReason && <div className="text-xs text-slate-600">{a.statusReason}</div>}
                  {a.policy?.blocked && <div className="text-xs text-red-700">{a.policy.reason}</div>}
                  {a.policy?.target != null && <div className="text-xs text-slate-600">Campaign policy ceiling {a.policy.target}/day · {a.policy.reason}</div>}
                  {a.autoPauseUntil && <div className="text-xs text-slate-600">Cooldown until {fmtDate(a.autoPauseUntil)}</div>}
                </td>
                <td className="td text-xs">{a.provider === 'SMTP_IMAP' ? <Badge color={a.smtpConnection?.ok ? 'green' : a.smtpConnection ? 'red' : 'gray'}>{a.smtpConnection?.ok ? 'OK' : a.smtpConnection ? 'Error' : 'Not tested'}</Badge> : 'OAuth'}</td>
                <td className="td text-xs">{a.provider === 'SMTP_IMAP' ? <Badge color={a.imapConnection?.ok ? 'green' : a.imapConnection ? 'red' : 'gray'}>{a.imapConnection?.ok ? 'OK' : a.imapConnection ? 'Error' : 'Not tested'}</Badge> : 'OAuth'}</td>
                <td className="td text-xs">{a.authStatus}</td>
                <td className="td text-xs">{fmtDate(a.lastSyncedAt)}</td>
                <td className="td text-xs">{fmtDate(a.lastAcceptedAt)}</td>
                <td className="td text-xs">{fmtDate(a.lastReceivedAt)}</td>
                <td className="td text-xs"><Badge color={a.readiness?.enabled ? (a.readiness.globallyEnabled ? 'green' : 'yellow') : 'gray'}>{a.readiness?.enabled ? (a.readiness.globallyEnabled ? a.readiness.status : 'Global control off') : 'Off'}</Badge>{a.readiness?.enabled && <div className="mt-1">Cap {a.readiness.currentDailyCap ?? a.readiness.initialDailyCap} / {a.dailySendLimit}</div>}{a.readiness?.holdReason && <div className="max-w-40 text-amber-700">{a.readiness.holdReason}</div>}<Button variant="ghost" onClick={() => readinessSave.mutate({ id: a.id, readiness: { enabled: !a.readiness?.enabled, initialDailyCap: a.readiness?.initialDailyCap ?? 5, dailyIncrease: a.readiness?.dailyIncrease ?? 5, reviewIntervalDays: a.readiness?.reviewIntervalDays ?? 7 } })}>{a.readiness?.enabled ? 'Disable' : 'Enable'}</Button>{a.readiness?.globallyEnabled && a.readiness?.status === 'READY_FOR_REVIEW' && <Button variant="ghost" onClick={() => {
                  const entered = window.prompt('Set the reviewed daily cap. It cannot exceed the mailbox daily limit.', String(a.readiness.currentDailyCap));
                  const cap = Number(entered);
                  if (!entered || !Number.isInteger(cap) || cap < 1 || cap > a.dailySendLimit) return;
                  readinessSave.mutate({ id: a.id, readiness: { enabled: true, initialDailyCap: a.readiness.initialDailyCap, dailyIncrease: a.readiness.dailyIncrease, reviewIntervalDays: a.readiness.reviewIntervalDays, approvedDailyCap: cap } });
                }}>Set reviewed cap</Button>}</td>
                <td className="td text-xs">{a.sentToday} / {a.quota.dailyLimit} today<div>{a.sentLastHour} / {a.hourlyLimit ?? "—"} last hour</div></td>
                <td className="td text-xs">{a.sent30d}</td>
                <td className="td">{a.bounceRatePct === null ? '—' : <Badge color={a.bounceRatePct >= 5 ? 'red' : a.bounceRatePct >= 2 ? 'yellow' : 'green'}>{`${a.bounceRatePct}%`}</Badge>}</td>
                <td className="td">{a.complaints30d > 0 ? <Badge color="red">{String(a.complaints30d)}</Badge> : '0'}</td>
                <td className="td"><TrackingTotals totals={a.lifetimeTracking} /></td>
                <td className="td text-xs">{a.domain ? <>{a.domain.name} <Badge>{a.domain.healthStatus}</Badge></> : '—'}</td>
                <td className="td max-w-xs text-xs">
                  {a.lastError && <div className="text-red-700">{a.lastError} ({fmtDate(a.lastErrorAt)})</div>}
                  <div>{a.failed30d} failed sends · {a.softBounces30d} soft bounces in 30 days</div>
                  {!!a.healthHistory?.length && <details><summary>Recent status history</summary><ul>{a.healthHistory.map((event: any, index: number) =>
                    <li key={index}>{event.action.split('.').at(-1)?.replaceAll('_', ' ')} · {fmtDate(event.createdAt)}</li>
                  )}</ul></details>}
                </td>
              </tr>
            ))}
          </Table></div>
        )}
      </QueryView>
      <div className="mt-4"><Notice>Readiness management applies conservative caps to real campaign sends. After an observation period, an administrator can review and set the cap based on actual volume, bounces, complaints, and domain health. It never sends warm-up messages or manufactures engagement. This dashboard does not measure spam placement or guarantee deliverability.</Notice></div>
      <h2 className="mb-2 mt-6 text-sm font-semibold">Provider automation status</h2>
      <QueryView q={registry}>{(rows) => <div className="card p-2"><Table head={['Provider', 'Kind', 'DNS write', 'Mailbox create', 'Mailbox status', 'Notes']}>{rows.map((p) => <tr key={p.id}><td className="td">{p.name}</td><td className="td text-xs">{p.kind.replace(/_/g, ' ')}</td><td className="td"><Badge color={p.capabilities.dnsWrite === 'implemented' ? 'green' : 'gray'}>{p.capabilities.dnsWrite}</Badge></td><td className="td"><Badge color={p.capabilities.mailboxCreate === 'implemented' ? 'green' : 'gray'}>{p.capabilities.mailboxCreate}</Badge></td><td className="td"><Badge color={p.capabilities.mailboxStatus === 'implemented' ? 'green' : 'gray'}>{p.capabilities.mailboxStatus}</Badge></td><td className="td text-xs">{p.notes}</td></tr>)}</Table></div>}</QueryView>
    </>
  );
}
