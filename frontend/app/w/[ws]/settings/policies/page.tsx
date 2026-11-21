'use client';

import { useEffect, useState } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { Button, Card, Checkbox, Field, Input, Notice, PageHeader, QueryView, Select } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const AUTO_OK = ['INTERESTED', 'WANTS_MEETING', 'NEEDS_INFO', 'WRONG_PERSON'];
const VERIFIERS = ['millionverifier', 'zerobounce', 'neverbounce'];

export default function Policies() {
  const q = useWsQuery<any>('');
  const [s, setS] = useState<any>(null);
  useEffect(() => { if (q.data) setS(q.data.settings); }, [q.data]);
  const save = useWsMutation(() => ({ path: '', method: 'PATCH', body: { settings: { requireMfa: s.requireMfa, replyMode: s.replyMode, autoReplyCategories: s.autoReplyCategories, verifierOrder: s.verifierOrder, finderOrder: s.finderOrder, stageProbabilities: s.stageProbabilities, aiMonthlyBudgetUsd: s.aiMonthlyBudgetUsd, aiMaxCostPerLeadUsd: s.aiMaxCostPerLeadUsd } } }), { success: 'Policies saved' });
  const set = (k: string, v: unknown) => setS({ ...s, [k]: v });
  const move = (arr: string[], i: number, d: number) => { const a = [...arr]; const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; };
  return (
    <QueryView q={q}>
      {() => !s ? null : (
        <>
          <PageHeader title="Security & AI policies" subtitle="Workspace-wide rules for sign-in, AI replies, verification order and forecasting." actions={<Button loading={save.isPending} onClick={() => save.mutate()}>Save policies</Button>} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Sign-in security">
              <Checkbox label="Require two-factor authentication for every member" hint="Members without 2FA can still sign in but can only open My account until they set it up." checked={!!s.requireMfa} onChange={(v) => set('requireMfa', v)} />
            </Card>
            <Card title="AI reply permission mode">
              <Field label="When a reply arrives"><Select value={s.replyMode} onChange={(e) => set('replyMode', e.target.value)} options={[{ value: 'suggest', label: 'Suggest — show a suggested reply only' }, { value: 'draft', label: 'Draft for approval (default) — a person approves every send' }, { value: 'auto_narrow', label: 'Auto-send approved templates for narrow categories' }]} /></Field>
              {s.replyMode === 'auto_narrow' && (
                <div className="mt-3 space-y-2">
                  <Notice kind="warning">Auto mode only sends a <b>manager-approved reply template</b>, at most once per conversation, and only for the categories below. Pricing, objections, complaints, unsubscribes and anything else are always drafted for a human.</Notice>
                  {AUTO_OK.map((c) => <Checkbox key={c} label={c.toLowerCase().replace(/_/g, ' ')} checked={s.autoReplyCategories.includes(c)} onChange={(v) => set('autoReplyCategories', v ? [...s.autoReplyCategories, c] : s.autoReplyCategories.filter((x: string) => x !== c))} />)}
                </div>
              )}
            </Card>
            <Card title="Email verification waterfall">
              <p className="mb-2 text-sm text-slate-600">Providers are tried in this order until one gives a definitive result. Only providers with keys under Integrations are used.</p>
              <ol className="space-y-1">{s.verifierOrder.map((v: string, i: number) => <li key={v} className="flex items-center gap-2 text-sm"><span className="w-5 text-slate-400">{i + 1}.</span><span className="flex-1">{v}</span><Button variant="ghost" onClick={() => set('verifierOrder', move(s.verifierOrder, i, -1))}>↑</Button><Button variant="ghost" onClick={() => set('verifierOrder', move(s.verifierOrder, i, 1))}>↓</Button><Button variant="ghost" onClick={() => set('verifierOrder', s.verifierOrder.filter((x: string) => x !== v))}>✕</Button></li>)}</ol>
              <div className="mt-2 flex flex-wrap gap-2">{VERIFIERS.filter((v) => !s.verifierOrder.includes(v)).map((v) => <Button key={v} variant="secondary" onClick={() => set('verifierOrder', [...s.verifierOrder, v])}>Add {v}</Button>)}</div>
              <div className="mt-3"><Checkbox label="Use Hunter.io for email discovery" checked={s.finderOrder.includes('hunter')} onChange={(v) => set('finderOrder', v ? ['hunter'] : [])} /></div>
            </Card>
            <Card title="AI cost limits">
              <Field label="Monthly AI budget (USD, blank = none)"><Input type="number" step="0.01" value={s.aiMonthlyBudgetUsd ?? ''} onChange={(e) => set('aiMonthlyBudgetUsd', e.target.value === '' ? null : Number(e.target.value))} /></Field>
              <Field label="Maximum AI cost per lead (USD, blank = none)"><Input type="number" step="0.001" value={s.aiMaxCostPerLeadUsd ?? ''} onChange={(e) => set('aiMaxCostPerLeadUsd', e.target.value === '' ? null : Number(e.target.value))} /></Field>
            </Card>
            <Card title="Forecast stage probabilities" className="lg:col-span-2">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{(['NEW', 'QUALIFIED', 'MEETING', 'PROPOSAL'] as const).map((k) => <Field key={k} label={`${k[0]}${k.slice(1).toLowerCase()} (0–1)`}><Input type="number" min={0} max={1} step={0.05} value={s.stageProbabilities?.[k] ?? ''} placeholder={{ NEW: '0.1', QUALIFIED: '0.25', MEETING: '0.4', PROPOSAL: '0.6' }[k]} onChange={(e) => { const sp = { ...(s.stageProbabilities ?? {}) }; if (e.target.value === '') delete sp[k]; else sp[k] = Number(e.target.value); set('stageProbabilities', sp); }} /></Field>)}</div>
            </Card>
          </div>
        </>
      )}
    </QueryView>
  );
}
