'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Checkbox, Empty, QueryView, Select, Stat, Table } from '@/components/ui';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { PROVIDER_LABELS, STAGE_PROVIDERS, TASK_LABELS, shortProvider, type TaskType } from '@/lib/ai-workflows';
import { fmtWhen, useOwnerMutation } from './hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
const QUEUE_LABEL: Record<string, string> = { 'ai-sub-claude': 'Claude subscription', 'ai-sub-codex': 'Codex subscription', 'ai-workflow-api': 'API providers' };
const RUN_STATUS_LABEL: Record<string, string> = { QUEUED: 'Pending', RUNNING: 'Running', SUCCEEDED: 'Completed', FAILED: 'Failed', PAUSED: 'Paused', PAUSED_LIMIT: 'Paused — usage limit', CANCELLED: 'Cancelled' };
const leadName = (l: { email: string; firstName?: string | null; lastName?: string | null } | null | undefined) => (l ? [l.firstName, l.lastName].filter(Boolean).join(' ') || l.email : '—');

export function AiQueue() {
  const ws = useWs();
  const q = useWsQuery<any>('/ai-queue', { refetchInterval: 5000 });
  const pauseAll = useOwnerMutation((paused: boolean) => ({ path: paused ? '/ai-queue/pause' : '/ai-queue/resume' }), { success: (r: any) => (r.paused ? 'AI generation paused' : 'AI generation resumed') });
  return (
    <QueryView q={q}>
      {(d) => {
        const allPaused = d.queues.every((x: any) => x.paused);
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PAUSED', 'PAUSED_LIMIT'] as const).map((s) => <Stat key={s} label={RUN_STATUS_LABEL[s]} value={d.counts[s] ?? 0} />)}
            </div>
            <Card title="Queues" actions={<Button size="sm" variant={allPaused ? 'primary' : 'secondary'} loading={pauseAll.isPending} onClick={() => pauseAll.mutate(!allPaused)}>{allPaused ? 'Resume all AI generation' : 'Pause all AI generation'}</Button>}>
              <Table head={['Queue', 'State', 'Waiting', 'Active', 'Delayed', 'Failed']}>
                {d.queues.map((x: any) => (
                  <tr key={x.name}><td className="font-medium">{QUEUE_LABEL[x.name] ?? x.name}</td><td>{x.paused ? <Badge color="yellow">Paused</Badge> : <Badge color="green">Running</Badge>}</td><td>{x.waiting}</td><td>{x.active}</td><td>{x.delayed}</td><td>{x.failed}</td></tr>
                ))}
              </Table>
              <p className="mt-2 text-xs text-ink-500">Delayed jobs are waiting for their provider&apos;s spacing or a retry back-off. Subscription concurrency and spacing are set on each subscription card.</p>
            </Card>
            <Card title="Paused generations">
              {d.paused.length ? <ul className="divide-y divide-slate-100 dark:divide-slate-800">{d.paused.map((r: any) => <PausedRow key={r.id} r={r} ws={ws} />)}</ul> : <Empty title="Nothing is paused" />}
            </Card>
            <Card title="Execution log">
              {d.executions.length ? (
                <Table head={['When', 'Prospect', 'Workflow', 'Stage', 'Provider', 'Status', 'Duration', 'Attempt', 'Error']}>
                  {d.executions.map((e: any) => (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap text-xs">{fmtWhen(e.startedAt)}</td>
                      <td>{leadName(e.run.lead)}</td>
                      <td className="text-xs">{e.run.workflowName}</td>
                      <td><span className="font-medium">{e.stageName}</span><span className="block text-xs text-ink-500">{TASK_LABELS[e.taskType as TaskType] ?? e.taskType}</span></td>
                      <td className="text-xs">{shortProvider(e.provider)}{e.model ? <span className="block text-ink-500">{e.model}</span> : null}</td>
                      <td><Badge color={e.status === 'SUCCEEDED' ? 'green' : e.status === 'RUNNING' ? 'blue' : e.status === 'SKIPPED' ? 'gray' : e.status === 'PAUSED_LIMIT' ? 'yellow' : 'red'}>{e.status}</Badge></td>
                      <td className="tabular-nums">{e.durationMs != null ? `${(e.durationMs / 1000).toFixed(1)} s` : '—'}</td>
                      <td className="tabular-nums">{e.attempt}</td>
                      <td className="max-w-xs text-xs text-red-700 dark:text-red-300">{e.errorMessage ?? ''}</td>
                    </tr>
                  ))}
                </Table>
              ) : <Empty title="No AI generations yet">Open a lead and use “Generate emails”.</Empty>}
            </Card>
          </div>
        );
      }}
    </QueryView>
  );
}

function PausedRow({ r, ws }: { r: any; ws: string }) {
  const [provider, setProvider] = useState('');
  const resume = useWsMutation((b: Record<string, unknown>) => ({ path: `/ai-runs/${r.id}/resume`, body: b }), { success: 'Generation resumed' });
  const auto = useWsMutation((v: boolean) => ({ path: `/ai-runs/${r.id}/resume`, body: { autoResume: v } }), { success: (x: any) => (x.autoResume ? 'Will resume automatically when the limit resets' : 'Automatic resume turned off') });
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link className="font-semibold hover:underline" href={`/w/${ws}/leads/${r.leadId}?tab=ai`}>{leadName(r.lead)}</Link>
          <span className="ml-2 text-xs text-ink-500">{r.workflowName}</span>
          <p className="text-sm">{r.pausedReason}</p>
        </div>
        <Badge color="yellow">{RUN_STATUS_LABEL[r.status]}</Badge>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" loading={resume.isPending} onClick={() => resume.mutate({})}>{r.status === 'PAUSED_LIMIT' ? 'Retry now' : 'Resume'}</Button>
        <Select aria-label="Use another provider for the paused stage" value={provider} onChange={(e) => setProvider(e.target.value)} options={[{ value: '', label: 'Use another provider for this stage…' }, ...STAGE_PROVIDERS.filter((p) => p !== r.pausedProvider).map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))]} />
        <Button size="sm" variant="ghost" disabled={!provider} onClick={() => resume.mutate({ stageProvider: provider })}>Resume with it</Button>
        {r.status === 'PAUSED_LIMIT' && <Checkbox label="Resume automatically when the limit resets" checked={!!r.autoResume} onChange={(v) => auto.mutate(v)} />}
      </div>
    </li>
  );
}
