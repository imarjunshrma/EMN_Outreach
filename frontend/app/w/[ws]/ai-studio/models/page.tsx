'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { Button, Card, Field, Input, Notice, PageHeader, QueryView, Table } from '@/components/ui';

export default function Models() {
  const ws = useWs();
  const w = useWsQuery<any>('');
  const routes = useWsQuery<any[]>('/ai/routes');
  const usage = useWsQuery<any>('/ai/usage?days=30');
  const [b, setB] = useState<any>(null);
  useEffect(() => { if (w.data) setB({ aiMonthlyBudgetUsd: w.data.settings?.aiMonthlyBudgetUsd ?? '', aiMaxCostPerLeadUsd: w.data.settings?.aiMaxCostPerLeadUsd ?? '' }); }, [w.data]);
  const save = useWsMutation(() => ({ path: '', method: 'PATCH', body: { settings: { aiMonthlyBudgetUsd: b.aiMonthlyBudgetUsd === '' ? null : Number(b.aiMonthlyBudgetUsd), aiMaxCostPerLeadUsd: b.aiMaxCostPerLeadUsd === '' ? null : Number(b.aiMaxCostPerLeadUsd) } } }), { success: 'Budgets saved' });
  const route = useWsMutation<any>((r) => ({ path: '/ai/routes', method: 'PUT', body: r }), { success: 'Route saved' });
  const [edits, setEdits] = useState<Record<string, any>>({});
  return (
    <>
      <PageHeader title="Models & budgets" subtitle="Which model handles research, writing, classification and fact-checking — and how much AI may cost." actions={<Link className="text-sm underline" href={`/w/${ws}/settings/ai`}>Provider keys, prompts & prices →</Link>} />
      {b && (
        <Card title="Budgets" actions={<Button loading={save.isPending} onClick={() => save.mutate()}>Save budgets</Button>}>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Workspace monthly AI budget (USD)" hint="All AI calls stop when reached (reply classification keeps running so opt-outs are never missed). Blank = no limit."><Input type="number" step="1" min={0} value={b.aiMonthlyBudgetUsd} onChange={(e) => setB({ ...b, aiMonthlyBudgetUsd: e.target.value })} /></Field>
            <Field label="Default maximum AI cost per lead per campaign (USD)" hint="Campaigns can set their own. Checked before every call using an upper-bound estimate."><Input type="number" step="0.01" min={0} value={b.aiMaxCostPerLeadUsd} onChange={(e) => setB({ ...b, aiMaxCostPerLeadUsd: e.target.value })} /></Field>
          </div>
        </Card>
      )}
      <div className="mt-4">
        <Card title="Model per task (with fallback, token limits and per-task budget)">
          <QueryView q={routes} isEmpty={(d) => !d.length} empty={<Notice>Add an AI model provider in AI settings first.</Notice>}>
            {(d) => <Table head={['Task', 'Provider / model', 'Fallback', 'Max input tokens', 'Max output tokens', 'Monthly budget $', '']}>{d.map((r: any) => {
              const e = edits[r.task] ?? r;
              const set = (k: string, v: any) => setEdits({ ...edits, [r.task]: { ...e, [k]: v } });
              return (
                <tr key={r.task}>
                  <td className="text-xs font-medium">{r.task}</td>
                  <td><Input className="w-28" value={e.provider} onChange={(x) => set('provider', x.target.value)} /><Input className="mt-1 w-44" value={e.model} onChange={(x) => set('model', x.target.value)} /></td>
                  <td><Input className="w-28" value={e.fallbackProvider ?? ''} placeholder="none" onChange={(x) => set('fallbackProvider', x.target.value || null)} /><Input className="mt-1 w-44" value={e.fallbackModel ?? ''} onChange={(x) => set('fallbackModel', x.target.value || null)} /></td>
                  <td><Input className="w-24" type="number" value={e.maxInputTokens ?? ''} placeholder="none" onChange={(x) => set('maxInputTokens', x.target.value === '' ? null : Number(x.target.value))} /></td>
                  <td><Input className="w-24" type="number" value={e.maxOutputTokens} onChange={(x) => set('maxOutputTokens', Number(x.target.value))} /></td>
                  <td><Input className="w-24" type="number" value={e.monthlyBudgetUsd ?? ''} placeholder="none" onChange={(x) => set('monthlyBudgetUsd', x.target.value === '' ? null : Number(x.target.value))} /></td>
                  <td>{edits[r.task] && <Button variant="secondary" onClick={() => route.mutate({ task: r.task, provider: e.provider, model: e.model, fallbackProvider: e.fallbackProvider || null, fallbackModel: e.fallbackModel || null, temperature: e.temperature ?? null, maxOutputTokens: Number(e.maxOutputTokens), maxInputTokens: e.maxInputTokens ?? null, monthlyBudgetUsd: e.monthlyBudgetUsd === null || e.monthlyBudgetUsd === undefined ? null : Number(e.monthlyBudgetUsd) })}>Save</Button>}</td>
                </tr>
              );
            })}</Table>}
          </QueryView>
          <p className="mt-2 text-xs text-slate-500">Research uses FACT_EXTRACTION, writing uses PERSONALIZATION / EMAIL_WRITING / FOLLOWUP_WRITING, classification uses REPLY_CLASSIFICATION, fact-checking uses FACT_CHECK. Model responses are logged with emails, phone numbers and keys redacted from the stored prompt preview.</p>
        </Card>
      </div>
      <div className="mt-4">
        <Card title="Last 30 days">
          <QueryView q={usage}>{(u) => <><Table head={['Task', 'Model', 'Calls', 'Tokens in/out', 'Cost']}>{u.byTask.map((r: any) => <tr key={`${r.task}${r.model}`}><td>{r.task}</td><td>{r.provider} {r.model}</td><td>{r.calls}</td><td>{r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}</td><td>${r.costUsd.toFixed(4)}</td></tr>)}</Table><p className="mt-1 text-xs text-slate-500">{u.note}</p></>}</QueryView>
        </Card>
      </div>
    </>
  );
}
