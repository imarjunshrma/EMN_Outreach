'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, ErrorState, Loading, PageHeader, Table } from '@/components/ui';
import { usePlatform } from '@/components/platform/shell';

/* eslint-disable @typescript-eslint/no-explicit-any */
const money = (cents: number, cur: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(cents / 100);
const perCur = (o: Record<string, number>) => (Object.keys(o).length ? Object.entries(o).map(([c, v]) => money(v, c)).join(' · ') : '—');
const METRIC: Record<string, string> = { email_sends: 'Emails sent', ai_requests: 'AI requests', ai_tokens: 'AI tokens', ai_cost_micro_usd: 'AI cost (micro-USD)', enrichments: 'Verifications', api_calls: 'API calls', workflow_runs: 'Workflow runs', storage_bytes: 'Storage bytes' };

export default function PlatformOverview() {
  const me = usePlatform();
  const q = useQuery({ queryKey: ['platform-metrics'], queryFn: () => api<any>('/platform/metrics'), enabled: me.permissions.includes('metrics:read') });
  if (!me.permissions.includes('metrics:read')) return <PageHeader title="Overview" subtitle="Your role does not include SaaS metrics. Use Tenants or Support access." />;
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const m = q.data;
  const t = m.tenants;
  const tiles: Array<[string, number | string]> = [['Tenants', t.total], ['Active', t.active], ['Trial', t.trial], ['Paying', t.paying], ['Past due', t.pastDue], ['Suspended', t.suspended], ['Cancelled', t.cancelled], ['Deletion pending', t.deletionPending]];
  return (
    <>
      <PageHeader title="SaaS overview" subtitle="Computed live from the database at the moment you open this page. Definitions are listed below." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8" data-testid="platform-tiles">
        {tiles.map(([k, v]) => <div key={k} className="card p-4"><p className="text-xs font-semibold text-slate-500">{k}</p><p className="mt-1 text-2xl font-bold tnum">{v}</p></div>)}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Revenue">
          <dl className="space-y-3 text-sm">
            <div title={m.definitions.mrr}><dt className="text-slate-500">MRR</dt><dd className="text-lg font-bold">{perCur(m.revenue.mrrCents)}</dd></div>
            <div><dt className="text-slate-500">ARR (MRR × 12)</dt><dd className="font-bold">{perCur(m.revenue.arrCents)}</dd></div>
            <div><dt className="text-slate-500">Manual subscriptions (not in MRR)</dt><dd className="font-bold">{perCur(m.revenue.manualMrrCents)}</dd></div>
            <div><dt className="text-slate-500">Collected, last 30 days</dt><dd className="font-bold">{perCur(m.revenue.collectedLast30dCents)}</dd></div>
          </dl>
        </Card>
        <Card title="Last 30 days">
          <dl className="space-y-3 text-sm">
            <div><dt className="text-slate-500">New tenants</dt><dd className="text-lg font-bold tnum">{m.movement30d.newTenants}</dd></div>
            <div title={m.definitions.newPaid}><dt className="text-slate-500">New paid subscriptions</dt><dd className="font-bold tnum">{m.movement30d.newPaidSubscriptions}</dd></div>
            <div title={m.definitions.churn}><dt className="text-slate-500">Churned tenants</dt><dd className="font-bold tnum">{m.movement30d.churnedTenants} {m.movement30d.churnRatePct !== null && <span className="font-normal text-slate-500">({m.movement30d.churnRatePct}%)</span>}</dd></div>
          </dl>
        </Card>
        <Card title="Operations, last 24 h">
          <dl className="space-y-3 text-sm">
            <div><dt className="text-slate-500">Failed background jobs</dt><dd className="text-lg font-bold tnum">{m.operations.failedJobs24h}</dd></div>
            <div><dt className="text-slate-500">Errors logged</dt><dd className="font-bold tnum">{m.operations.errors24h}</dd></div>
          </dl>
        </Card>
        <Card title="Plan distribution">
          {m.planDistribution?.length ? <Table head={['Plan', 'Subscription', 'Tenants']}>{m.planDistribution.map((p: any) => <tr key={`${p.plan}-${p.status}`}><td className="td">{p.plan}</td><td className="td text-xs">{String(p.status).toLowerCase()}</td><td className="td tnum">{p.tenants}</td></tr>)}</Table> : <p className="text-sm text-slate-500">No subscriptions yet.</p>}
        </Card>
        <Card title="Usage this month" className="lg:col-span-2">
          {m.usageThisMonth?.length ? <Table head={['Metric', 'Total', 'Tenants using it']}>{m.usageThisMonth.map((u: any) => <tr key={u.metric}><td className="td">{METRIC[u.metric] ?? u.metric}</td><td className="td tnum">{u.total.toLocaleString()}</td><td className="td tnum">{u.tenants}</td></tr>)}</Table> : <p className="text-sm text-slate-500">No metered usage this month.</p>}
        </Card>
      </div>
      <Card title="Definitions" className="mt-4"><dl className="grid gap-3 text-sm md:grid-cols-2">{Object.entries(m.definitions).map(([k, v]) => <div key={k}><dt className="font-semibold">{k}</dt><dd className="text-slate-600">{String(v)}</dd></div>)}</dl></Card>
    </>
  );
}
