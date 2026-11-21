'use client';

import Link from 'next/link';
import { useWs, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Empty, PageHeader, QueryView, Table } from '@/components/ui';
import { TRIGGER_LABELS } from '@/lib/workflow';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Workflows() {
  const ws = useWs();
  const q = useWsQuery<any[]>('/workflows');
  return (
    <>
      <PageHeader title="Workflow builder" subtitle="Trigger → conditions → actions, with branches, versions, test runs and an execution log. Workflows cannot send prospecting email; reply drafts follow your reply-approval mode." actions={<Link href={`/w/${ws}/workflows/new`}><Button>New workflow</Button></Link>} />
      <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No workflows yet" action={<Link href={`/w/${ws}/workflows/new`}><Button>Create your first workflow</Button></Link>}>For example: when a reply is categorised as interested and the lead is in the US, create an opportunity and notify the sales team.</Empty>}>
        {(rows) => <div className="card p-2"><Table head={['Name', 'Trigger', 'Status', 'Versions', 'Runs', 'Updated']}>{rows.map((w) => <tr key={w.id}><td className="td"><Link className="font-medium text-brand-700 hover:underline" href={`/w/${ws}/workflows/${w.id}`}>{w.name}</Link></td><td className="td text-sm">{TRIGGER_LABELS[w.trigger as keyof typeof TRIGGER_LABELS] ?? w.trigger}</td><td className="td">{w.isActive ? <Badge color="green">active</Badge> : <Badge color="gray">inactive</Badge>}</td><td className="td">{w._count.versions}</td><td className="td">{w._count.runs}</td><td className="td text-xs">{fmtDate(w.updatedAt)}</td></tr>)}</Table></div>}
      </QueryView>
    </>
  );
}
