'use client';

import Link from 'next/link';
import { useWs, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Card, Empty, PageHeader, QueryView, Stat, Table } from '@/components/ui';

interface Mailbox {
  id: string; emailAddress: string; status: string; provider: string; sentToday: number;
  health: { status: string }; quota: { dailyLimit: number };
  policy: { target: number | null; blocked: boolean; reason: string | null };
}
interface Domain {
  id: string; name: string; spfStatus: string; dkimStatus: string; dmarcStatus: string;
  sendingHoldReason: string | null; lastCheckedAt: string | null; _count: { emailAccounts: number };
}

export default function IntelligentSending() {
  const ws = useWs();
  const mailboxes = useWsQuery<Mailbox[]>('/mailbox-health');
  const domains = useWsQuery<Domain[]>('/domains');
  return <>
    <PageHeader title="Intelligent Sending" subtitle="Review effective mailbox limits and domain holds before sending." />
    <QueryView q={mailboxes} empty={<Empty title="No mailboxes connected" />} isEmpty={rows => !rows.length}>{rows => <>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Connected mailboxes" value={rows.filter(row => row.status === 'CONNECTED').length} />
        <Stat label="Healthy mailboxes" value={rows.filter(row => row.health.status === 'Healthy' && !row.policy.blocked).length} />
        <Stat label="Mailboxes with domain holds" value={rows.filter(row => row.policy.blocked).length} />
        <Stat label="Mailboxes with campaign caps" value={rows.filter(row => row.policy.target !== null).length} />
      </div>
      <Card title="Mailbox sending capacity">
        <Table head={['Mailbox', 'Health', 'Accepted today', 'Mailbox cap', 'Sending policy']}>{rows.map(row => <tr key={row.id}>
          <td className="td">{row.emailAddress}<div className="text-xs">{row.provider}</div></td>
          <td className="td"><Badge>{row.health.status}</Badge></td>
          <td className="td">{row.sentToday}</td>
          <td className="td">{row.policy.blocked ? 0 : Math.min(row.quota.dailyLimit, row.policy.target ?? row.quota.dailyLimit)}/day</td>
          <td className="td">{row.policy.reason ?? 'Standard limits'}</td>
        </tr>)}</Table>
        <p className="my-2 text-xs">Campaign, workspace, hourly, and domain quotas can further limit sending.</p>
      </Card>
    </>}</QueryView>
    <Card title="Domain authentication">
      <QueryView q={domains} empty={<Empty title="No sending domains" />} isEmpty={rows => !rows.length}>{rows =>
        <Table head={['Domain', 'Authentication', 'Mailboxes', 'Checked', 'Hold']}>{rows.map(row => <tr key={row.id}>
          <td className="td"><Link className="underline" href={`/w/${ws}/domains/${row.id}`}>{row.name}</Link></td>
          <td className="td">SPF {row.spfStatus} · DKIM {row.dkimStatus} · DMARC {row.dmarcStatus}</td>
          <td className="td">{row._count.emailAccounts}</td><td className="td">{fmtDate(row.lastCheckedAt)}</td>
          <td className="td">{row.sendingHoldReason ?? '—'}</td>
        </tr>)}</Table>
      }</QueryView>
    </Card>
    <Card title="Sending operations">
      <ul className="flex flex-wrap gap-4">
        {[
          ['/campaigns', 'Campaign settings and mailbox assignments'], ['/mailbox-health', 'Mailbox health'],
          ['/mailbox-health/reconciliation', 'Uncertain submissions'], ['/settings/suppression', 'Suppression list'],
          ['/notifications', 'Notifications'], ['/settings/audit', 'Audit log'],
        ].map(([href, label]) => <li key={href}><Link className="text-sm underline" href={`/w/${ws}${href}`}>{label}</Link></li>)}
      </ul>
    </Card>
  </>;
}
