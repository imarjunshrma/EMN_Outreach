'use client';

import Link from 'next/link';
import { qs, type Paged } from '@/lib/api';
import { useWs, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Card, Empty, PageHeader, QueryView, Table } from '@/components/ui';
import { ReviewPanel } from '@/components/review-panel';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function FollowUps() {
  const ws = useWs();
  const queued = useWsQuery<Paged<any>>(`/outbound${qs({ status: 'QUEUED', pageSize: 50 })}`, { refetchInterval: 30_000 });
  const tasks = useWsQuery<any[]>('/tasks?due=overdue');
  return (
    <>
      <PageHeader title="Review & follow-ups" subtitle="Approve AI-written emails, see what is scheduled next, and handle overdue follow-up reminders." />
      <div className="space-y-5">
        <Card title="Awaiting your approval"><ReviewPanel /></Card>
        <Card title="Queued to send (respecting windows & limits)">
          <QueryView q={queued} isEmpty={(d) => d.total === 0} empty={<Empty title="Nothing queued" />}>
            {(d) => <Table head={['To', 'Campaign', 'Step', 'Not before', 'Note']}>{d.data.map((o: any) => <tr key={o.id}><td className="td text-sm">{o.toAddress}</td><td className="td"><Link className="text-brand-700 hover:underline" href={`/w/${ws}/campaigns/${o.campaign.id}`}>{o.campaign.name}</Link></td><td className="td">{o.step.order}</td><td className="td text-xs">{fmtDate(o.scheduledFor)}</td><td className="td text-xs text-slate-500">{o.lastError}</td></tr>)}</Table>}
          </QueryView>
        </Card>
        <Card title="Overdue reminders" actions={<Link className="text-sm text-brand-700" href={`/w/${ws}/tasks`}>All tasks</Link>}>
          <QueryView q={tasks} isEmpty={(d) => d.length === 0} empty={<p className="text-sm text-slate-500">No overdue tasks.</p>}>
            {(rows) => <ul className="space-y-1 text-sm">{rows.map((t) => <li key={t.id}><Badge>{t.priority}</Badge> {t.title} {t.lead && <Link className="text-brand-700 underline" href={`/w/${ws}/leads/${t.lead.id}`}>{t.lead.email}</Link>} <span className="text-xs text-red-600">due {fmtDate(t.dueAt)}</span></li>)}</ul>}
          </QueryView>
        </Card>
      </div>
    </>
  );
}
