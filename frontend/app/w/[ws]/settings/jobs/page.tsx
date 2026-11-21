'use client';

import { useState } from 'react';
import { qs, type Paged } from '@/lib/api';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, Empty, PageHeader, Pagination, QueryView, Select, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Jobs() {
  const queues = useWsQuery<any[]>('/jobs/queues', { refetchInterval: 10_000 });
  const [queue, setQueue] = useState('send');
  const failed = useWsQuery<any[]>(`/jobs/failed?queue=${queue}`);
  const [page, setPage] = useState(1);
  const history = useWsQuery<Paged<any>>(`/jobs/history${qs({ page, pageSize: 30 })}`);
  const retry = useWsMutation<string>((jobId) => ({ path: '/jobs/retry', body: { queue, jobId } }), { success: 'Retried' });
  return (
    <>
      <PageHeader title="Background jobs" subtitle="Redis/BullMQ queue health. Scheduler, sending, mailbox sync, AI, research, imports and webhooks all run in the worker process." />
      <Card title="Queues (live)">
        <QueryView q={queues}>{(rows) => <Table head={['Queue', 'Waiting', 'Active', 'Delayed', 'Failed', 'Completed (kept)']}>{rows.map((r) => <tr key={r.name}><td className="td font-medium">{r.name}</td><td className="td">{r.counts.waiting}</td><td className="td">{r.counts.active}</td><td className="td">{r.counts.delayed}</td><td className={`td ${r.counts.failed ? 'font-semibold text-red-600' : ''}`}>{r.counts.failed}</td><td className="td">{r.counts.completed}</td></tr>)}</Table>}</QueryView>
        <p className="mt-2 text-xs text-slate-500">If “waiting” grows and “active” stays 0, the worker is not running: <code>systemctl status emn-worker</code>.</p>
      </Card>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Failed jobs (this workspace)" actions={<Select className="w-48" value={queue} onChange={(e) => setQueue(e.target.value)} options={(queues.data ?? []).map((q) => q.name)} />}>
          <QueryView q={failed} isEmpty={(d) => d.length === 0} empty={<Empty title="No failed jobs" />}>{(rows) => <Table head={['Job', 'Attempts', 'Reason', '']}>{rows.map((j) => <tr key={j.id}><td className="td text-xs">{j.name}<div className="text-slate-400">{fmtDate(new Date(j.timestamp))}</div></td><td className="td">{j.attemptsMade}</td><td className="td max-w-xs text-xs text-red-700">{j.failedReason}</td><td className="td"><Button variant="secondary" onClick={() => retry.mutate(j.id)}>Retry</Button></td></tr>)}</Table>}</QueryView>
        </Card>
        <Card title="Job history">
          <QueryView q={history} isEmpty={(d) => d.total === 0} empty={<Empty title="No job runs recorded yet" />}>{(d) => <><Table head={['When', 'Queue / job', 'Status', 'Duration', 'Error']}>{d.data.map((j: any) => <tr key={j.id}><td className="td text-xs">{fmtDate(j.createdAt)}</td><td className="td text-xs">{j.queue} / {j.jobName}</td><td className="td"><Badge>{j.status}</Badge></td><td className="td text-xs">{j.durationMs ?? '—'} ms</td><td className="td max-w-xs text-xs text-red-700">{j.error}</td></tr>)}</Table><Pagination page={d.page} totalPages={d.totalPages} total={d.total} onPage={setPage} /></>}</QueryView>
        </Card>
      </div>
    </>
  );
}
