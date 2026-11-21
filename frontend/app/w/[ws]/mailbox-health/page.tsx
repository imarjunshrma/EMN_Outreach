'use client';

import Link from 'next/link';
import { useWs, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Empty, Notice, PageHeader, QueryView, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function MailboxHealth() {
  const ws = useWs();
  const q = useWsQuery<any[]>('/mailbox-health', { refetchInterval: 60_000 });
  const registry = useWsQuery<any[]>('/provider-registry');
  return (
    <>
      <PageHeader title="Mailbox health" subtitle="Connection, authentication, sync and sending signals for every mailbox (last 30 days). Only measured data is shown — inbox placement is not estimated." />
      <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No mailboxes connected" action={<Link className="underline" href={`/w/${ws}/email-accounts`}>Connect a mailbox</Link>} />}>
        {(rows) => (
          <div className="card p-2"><Table head={['Mailbox', 'Status', 'Auth', 'Last sync', 'Last sent', 'Last received', 'Sent today / limit', 'Sent 30d', 'Bounce %', 'Complaints', 'Domain', 'Last error']}>
            {rows.map((a) => (
              <tr key={a.id}>
                <td className="td text-xs">{a.emailAddress}<div className="text-slate-400">{a.provider}</div></td>
                <td className="td"><Badge>{a.status}</Badge></td>
                <td className="td text-xs">{a.authStatus}</td>
                <td className="td text-xs">{fmtDate(a.lastSyncedAt)}</td>
                <td className="td text-xs">{fmtDate(a.lastSentAt)}</td>
                <td className="td text-xs">{fmtDate(a.lastReceivedAt)}</td>
                <td className="td text-xs">{a.sentToday} / {a.quota.dailyLimit}</td>
                <td className="td text-xs">{a.sent30d}</td>
                <td className="td">{a.bounceRatePct === null ? '—' : <Badge color={a.bounceRatePct >= 5 ? 'red' : a.bounceRatePct >= 2 ? 'yellow' : 'green'}>{`${a.bounceRatePct}%`}</Badge>}</td>
                <td className="td">{a.complaints30d > 0 ? <Badge color="red">{String(a.complaints30d)}</Badge> : '0'}</td>
                <td className="td text-xs">{a.domain ? <>{a.domain.name} <Badge>{a.domain.healthStatus}</Badge></> : '—'}</td>
                <td className="td max-w-xs text-xs text-red-700">{a.lastError ? `${a.lastError} (${fmtDate(a.lastErrorAt)})` : ''}</td>
              </tr>
            ))}
          </Table></div>
        )}
      </QueryView>
      <div className="mt-4"><Notice>Daily limits come from your mailbox settings — Google and Microsoft do not expose remaining sending quota. Keep volumes conservative; this platform does not rotate mailboxes or run warm-up networks.</Notice></div>
      <h2 className="mb-2 mt-6 text-sm font-semibold">Provider automation status</h2>
      <QueryView q={registry}>{(rows) => <div className="card p-2"><Table head={['Provider', 'Kind', 'DNS write', 'Mailbox create', 'Mailbox status', 'Notes']}>{rows.map((p) => <tr key={p.id}><td className="td">{p.name}</td><td className="td text-xs">{p.kind.replace(/_/g, ' ')}</td><td className="td"><Badge color={p.capabilities.dnsWrite === 'implemented' ? 'green' : 'gray'}>{p.capabilities.dnsWrite}</Badge></td><td className="td"><Badge color={p.capabilities.mailboxCreate === 'implemented' ? 'green' : 'gray'}>{p.capabilities.mailboxCreate}</Badge></td><td className="td"><Badge color={p.capabilities.mailboxStatus === 'implemented' ? 'green' : 'gray'}>{p.capabilities.mailboxStatus}</Badge></td><td className="td text-xs">{p.notes}</td></tr>)}</Table></div>}</QueryView>
    </>
  );
}
