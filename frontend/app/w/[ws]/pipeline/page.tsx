'use client';

import Link from 'next/link';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDay, fmtMoney, fullName } from '@/lib/format';
import { STAGES } from '@/lib/constants';
import { Badge, Button, Card, ConfirmButton, Notice, PageHeader, QueryView, Select, Stat } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Pipeline() {
  const ws = useWs();
  const q = useWsQuery<{ columns: Array<{ stage: string; count: number; valueCents: number; items: any[] }>; note: string }>('/pipeline');
  const fc = useWsQuery<any>('/crm/forecast');
  const move = useWsMutation<{ id: string; stage: string }>((b) => ({ path: `/opportunities/${b.id}`, method: 'PATCH', body: { stage: b.stage } }), { success: 'Stage updated' });
  const del = useWsMutation<string>((id) => ({ path: `/opportunities/${id}`, method: 'DELETE' }), { success: 'Deleted' });
  return (
    <>
      <PageHeader title="CRM pipeline" actions={<a href={`/api/v1/w/${ws}/crm/opportunities/export`}><Button variant="secondary">Export CSV</Button></a>} subtitle="Opportunities by stage. Create opportunities from a lead profile, a reply, or an automation rule. Moving to Meeting marks the lead as meeting booked; Won marks the lead as a customer and stops outreach." />
      {fc.data && (
        <div className="mb-4 grid gap-3 md:grid-cols-4" data-testid="forecast">
          <Stat label="Weighted open pipeline" value={fmtMoney(fc.data.weightedPipelineCents)} hint="value × stage probability" />
          <Stat label="Win rate" value={fc.data.winRate === null ? '—' : `${Math.round(fc.data.winRate * 100)}%`} hint="won ÷ (won + lost)" />
          <Card title="Expected to close (weighted)"><ul className="text-sm">{fc.data.expectedByMonth.length === 0 ? <li className="text-slate-500">No open deals</li> : fc.data.expectedByMonth.map((m: any) => <li key={m.month} className="flex justify-between"><span>{m.month}</span><span>{fmtMoney(m.weightedCents)}</span></li>)}</ul></Card>
          <Card title="Won by month"><ul className="text-sm">{fc.data.wonByMonth.length === 0 ? <li className="text-slate-500">Nothing won yet</li> : fc.data.wonByMonth.slice(-6).map((m: any) => <li key={m.month} className="flex justify-between"><span>{m.month}</span><span>{fmtMoney(m.cents)}</span></li>)}</ul></Card>
          <p className="text-xs text-slate-500 md:col-span-4">{fc.data.note} Stage probabilities are editable under Security & AI policies.</p>
        </div>
      )}
      <QueryView q={q}>
        {(d) => (
          <>
            <div className="mb-3"><Notice>{d.note}</Notice></div>
            <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
              {d.columns.map((col) => (
                <div key={col.stage} className="rounded-lg bg-slate-100 p-2">
                  <div className="mb-2 flex items-center justify-between px-1"><Badge>{col.stage}</Badge><span className="text-xs text-slate-500">{col.count} · {fmtMoney(col.valueCents)}</span></div>
                  <div className="space-y-2">
                    {col.items.length === 0 && <p className="px-1 text-xs text-slate-400">Empty</p>}
                    {col.items.map((o) => (
                      <div key={o.id} className="card p-2 text-sm">
                        <p className="font-medium">{o.title}</p>
                        <Link className="text-xs text-brand-700 hover:underline" href={`/w/${ws}/leads/${o.lead.id}`}>{fullName(o.lead)}</Link>
                        <p className="text-xs text-slate-500">{o.company?.name} · {fmtMoney(o.valueCents, o.currency)}{o.campaign && <> · via {o.campaign.name}</>}</p>
                        {o.expectedCloseAt && <p className="text-xs text-slate-400">close {fmtDay(o.expectedCloseAt)}</p>}
                        <div className="mt-1 flex items-center gap-1"><Select className="!h-8 !py-0 text-xs" value={o.stage} onChange={(e) => move.mutate({ id: o.id, stage: e.target.value })} options={STAGES} /><ConfirmButton variant="ghost" confirm="Delete opportunity?" onConfirm={() => del.mutate(o.id)}>✕</ConfirmButton></div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </QueryView>
    </>
  );
}
