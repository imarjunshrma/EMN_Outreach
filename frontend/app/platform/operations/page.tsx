'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, describeError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, ErrorState, Field, Loading, Modal, PageHeader, Table, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { usePlatform } from '@/components/platform/shell';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Operations() {
  const me = usePlatform(); const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform-ops'], queryFn: () => api<any>('/platform/operations'), refetchInterval: 30_000 });
  const [retry, setRetry] = useState<any | null>(null); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  async function doRetry() {
    setBusy(true);
    try { await api('/platform/operations/retry', { body: { queue: retry.queue, jobId: retry.id, reason } }); toast.success('Job queued again'); setRetry(null); setReason(''); void qc.invalidateQueries({ queryKey: ['platform-ops'] }); }
    catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  return (
    <>
      <PageHeader title="Operations" subtitle="Live queue depths, jobs that failed every retry (dead letters) and failure counters for the last 24 hours. Refreshes every 30 seconds." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Queues" className="lg:col-span-2">
          <Table head={['Queue', 'Waiting', 'Active', 'Delayed', 'Failed', '']}>
            {d.queues.map((x: any) => <tr key={x.name}><td className="td font-semibold">{x.name}</td><td className="td tnum">{x.counts.waiting}</td><td className="td tnum">{x.counts.active}</td><td className="td tnum">{x.counts.delayed}</td><td className="td tnum">{x.counts.failed > 0 ? <Badge color="red">{x.counts.failed}</Badge> : 0}</td><td className="td text-xs">{x.isPaused ? 'paused' : ''}</td></tr>)}
          </Table>
        </Card>
        <Card title="Last 24 hours">
          <dl className="space-y-2 text-sm">
            {d.last24h.failuresByQueue.map((f: any) => <div key={f.queue} className="flex justify-between"><dt>{f.queue} attempts failed</dt><dd className="tnum font-bold">{f.failed}</dd></div>)}
            <div className="flex justify-between"><dt>Customer webhook deliveries failed</dt><dd className="tnum font-bold">{d.last24h.outboundWebhookFailures}</dd></div>
            <div className="flex justify-between"><dt>Payment events arriving out of order</dt><dd className="tnum font-bold">{d.last24h.staleBillingEvents}</dd></div>
            <div className="flex justify-between"><dt>Billing reconciliation failures</dt><dd className="tnum font-bold">{d.last24h.billingReconcileFailures}</dd></div>
          </dl>
        </Card>
        <Card title="Dead letters (failed after every retry)" className="lg:col-span-3">
          {d.deadLetters.length === 0 ? <p className="text-sm text-slate-500">No dead-lettered jobs.</p> : (
            <Table head={['When', 'Queue / job', 'Attempts', 'Reason', '']}>
              {d.deadLetters.map((j: any) => <tr key={`${j.queue}-${j.id}`}><td className="td text-xs">{j.finishedOn ? fmtDate(new Date(j.finishedOn).toISOString()) : ''}</td><td className="td text-xs"><b>{j.queue}</b> / {j.name}</td><td className="td tnum">{j.attemptsMade}</td><td className="td max-w-[480px] break-words text-xs">{j.failedReason}</td><td className="td text-right">{me.permissions.includes('tenants:lifecycle') && <Button size="sm" variant="secondary" onClick={() => setRetry(j)}>Retry</Button>}</td></tr>)}
            </Table>
          )}
        </Card>
      </div>
      <Modal open={!!retry} title={`Retry ${retry?.queue}/${retry?.name}`} onClose={() => setRetry(null)} footer={<><Button variant="ghost" onClick={() => setRetry(null)}>Cancel</Button><Button loading={busy} disabled={reason.trim().length < 5} onClick={doRetry}>Retry job</Button></>}>
        <Field label="Reason" hint="Recorded in the audit trail. Retry only after the cause is fixed."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </>
  );
}
