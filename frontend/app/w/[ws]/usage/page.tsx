'use client';

import { useState } from 'react';
import { useWsQuery } from '@/lib/hooks';
import { fmtUsd } from '@/lib/format';
import { Card, Notice, PageHeader, QueryView, Select, Stat, Table } from '@/components/ui';
import { SimpleBars } from '@/components/charts';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Usage() {
  const [days, setDays] = useState(30);
  const ai = useWsQuery<any>(`/ai/usage?days=${days}`);
  const prov = useWsQuery<any>(`/analytics/providers?days=${days}`);
  return (
    <>
      <PageHeader title="Usage & cost" subtitle="AI token usage and estimated cost, plus data-provider calls (search, enrichment, verification)." actions={<Select className="w-40" value={String(days)} onChange={(e) => setDays(Number(e.target.value))} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />} />
      <QueryView q={ai}>
        {(u) => {
          const total = u.byTask.reduce((s: number, r: any) => s + r.costUsd, 0);
          const calls = u.byTask.reduce((s: number, r: any) => s + r.calls, 0);
          const tokens = u.byTask.reduce((s: number, r: any) => s + r.inputTokens + r.outputTokens, 0);
          return (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label="AI cost (estimate)" value={fmtUsd(total)} /><Stat label="AI calls" value={calls} /><Stat label="Tokens" value={tokens.toLocaleString()} /><Stat label="Failed / invalid AI calls" value={u.failures} /></div>
              <Notice>{u.note}</Notice>
              <Card title="Daily AI cost"><SimpleBars rows={u.daily.map((d: any) => ({ label: d.day.slice(5), cost: Number(d.costUsd.toFixed(4)), calls: d.calls }))} keys={[{ key: 'calls', label: 'Calls', color: '#a59cad' }]} /></Card>
              <Card title="By task and model">
                <Table head={['Task', 'Provider', 'Model', 'Calls', 'Input tokens', 'Output tokens', 'Cost (est.)']}>{u.byTask.map((r: any) => <tr key={`${r.task}${r.model}`}><td className="td">{r.task}</td><td className="td">{r.provider}</td><td className="td">{r.model}</td><td className="td">{r.calls}</td><td className="td">{r.inputTokens.toLocaleString()}</td><td className="td">{r.outputTokens.toLocaleString()}</td><td className="td">{fmtUsd(r.costUsd)}</td></tr>)}</Table>
              </Card>
            </div>
          );
        }}
      </QueryView>
      <div className="mt-5"><Card title="Data provider usage">
        <QueryView q={prov}>{(p) => <>{p.rows.length === 0 ? <p className="text-sm text-slate-500">No provider calls in this period.</p> : <Table head={['Provider', 'Kind', 'Calls', 'Units']}>{p.rows.map((r: any) => <tr key={r.provider + r.kind}><td className="td">{r.provider}</td><td className="td">{r.kind}</td><td className="td">{r.calls}</td><td className="td">{r.units}</td></tr>)}</Table>}<p className="mt-2 text-xs text-slate-500">{p.note}</p></>}</QueryView>
      </Card></div>
    </>
  );
}
