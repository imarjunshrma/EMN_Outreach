'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink } from 'lucide-react';
import { Badge, Button, Card, Empty, Field, Input, Notice, Select, Table, Textarea } from '@/components/ui';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import type { Paged } from '@/lib/api';
import { PROVIDER_LABELS, STAGE_PROVIDERS, TASK_LABELS, shortProvider, type Stage, type TaskType } from '@/lib/ai-workflows';
import { fmtWhen, useCopy, useOwnerQuery } from './hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ACTIVE = new Set(['QUEUED', 'RUNNING']);
const STATUS_LABEL: Record<string, string> = { QUEUED: 'Queued', RUNNING: 'Running', SUCCEEDED: 'Done', FAILED: 'Failed', PAUSED: 'Paused', PAUSED_LIMIT: 'Paused — usage limit', CANCELLED: 'Cancelled' };

/** "Generate emails" on a prospect: research, three variants, edit/select/regenerate/copy/draft. Never sends. */
export function GeneratePanel({ leadId, defaultCampaignId }: { leadId: string; defaultCampaignId?: string | null }) {
  const ws = useWs();
  const workflows = useOwnerQuery<{ workflows: Array<{ id: string; name: string; isDefault: boolean }> }>('/ai-workflows');
  const campaigns = useWsQuery<any>('/campaigns');
  const history = useWsQuery<Paged<any>>(`/ai-runs?leadId=${leadId}&pageSize=20`);
  const [runId, setRunId] = useState<string | null>(null);
  const [workflowId, setWorkflowId] = useState('');
  const [campaignId, setCampaignId] = useState(defaultCampaignId ?? '');
  const [instructions, setInstructions] = useState('');
  useEffect(() => { if (!runId && history.data?.data.length) setRunId(history.data.data[0].id); }, [history.data, runId]);
  const create = useWsMutation((b: Record<string, unknown>) => ({ path: '/ai-runs', body: { leadId, campaignId: campaignId || null, ...(instructions.trim() ? { instructions: instructions.trim() } : {}), ...b } }), { success: 'Generation queued', onSuccess: (r: any) => setRunId(r.id) });
  const active = workflows.data?.workflows.find((w) => w.isDefault);
  const campaignList: Array<{ id: string; name: string }> = Array.isArray(campaigns.data) ? campaigns.data : campaigns.data?.data ?? campaigns.data?.campaigns ?? [];
  return (
    <div className="space-y-4">
      <Card>
        <div className="mb-3"><Field label="Extra instructions for this email (optional)" hint="Only for this generation, on top of your Writing Playbook. E.g. “mention their new clinic in Austin”, “keep it under 60 words”, “offer a free content audit”."><Textarea rows={2} maxLength={2000} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Angle, tone, offer, length…" /></Field></div>
        <div className="flex flex-wrap items-end gap-3">
          <Button loading={create.isPending} onClick={() => create.mutate({ mode: 'workflow' })} title={active ? `Uses “${active.name}”` : undefined}>Generate with selected workflow</Button>
          <Button variant="secondary" loading={create.isPending} onClick={() => create.mutate({ mode: 'claude' })}>Generate with Claude</Button>
          <Button variant="secondary" loading={create.isPending} onClick={() => create.mutate({ mode: 'codex' })}>Generate with Codex</Button>
          <span className="mx-1 hidden h-8 w-px bg-slate-200 sm:block dark:bg-slate-700" aria-hidden />
          <div className="min-w-52"><Field label="Saved workflow"><Select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} options={[{ value: '', label: 'Choose a workflow…' }, ...(workflows.data?.workflows ?? []).map((w) => ({ value: w.id, label: `${w.name}${w.isDefault ? ' (active)' : ''}` }))]} /></Field></div>
          <div className="mb-4"><Button variant="secondary" disabled={!workflowId} loading={create.isPending} onClick={() => create.mutate({ mode: 'workflow', workflowId })}>Generate with this workflow</Button></div>
          <div className="min-w-44"><Field label="Campaign (optional)"><Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} options={[{ value: '', label: 'No campaign' }, ...campaignList.map((c) => ({ value: c.id, label: c.name }))]} /></Field></div>
        </div>
        <p className="text-xs text-ink-500">Generation is queued and runs on the providers each stage names. Nothing is sent from here — review, edit and save a draft. <Link className="underline" href={`/w/${ws}/settings/ai?tab=workflows`}>Edit workflows</Link> · <Link className="underline" href={`/w/${ws}/settings/ai?tab=queue`}>Queue</Link></p>
      </Card>
      {history.data && history.data.data.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-500">History:</span>
          {history.data.data.map((r: any) => (
            <button key={r.id} type="button" onClick={() => setRunId(r.id)} aria-pressed={runId === r.id} className={`rounded-md border px-2 py-1 text-xs ${runId === r.id ? 'border-brand-400 bg-brand-50 dark:border-brand-600 dark:bg-brand-950/40' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'}`}>
              {fmtWhen(r.createdAt)} · {r.workflowName} · {STATUS_LABEL[r.status] ?? r.status}{r.draftSavedAt ? ' · draft' : ''}
            </button>
          ))}
        </div>
      )}
      {runId ? <RunView runId={runId} /> : <Empty title="No generations for this prospect yet">Choose how to generate above.</Empty>}
    </div>
  );
}

function RunView({ runId }: { runId: string }) {
  const [poll, setPoll] = useState(true);
  const [pollUntil, setPollUntil] = useState(0);
  const q = useWsQuery<any>(`/ai-runs/${runId}`, { refetchInterval: poll || Date.now() < pollUntil ? 3000 : undefined });
  const r = q.data;
  useEffect(() => { if (r) setPoll(ACTIVE.has(r.status)); }, [r]);
  const pause = useWsMutation(() => ({ path: `/ai-runs/${runId}/pause` }), { success: 'Paused' });
  const cancel = useWsMutation(() => ({ path: `/ai-runs/${runId}/cancel` }), { success: 'Cancelled' });
  const resume = useWsMutation((b: Record<string, unknown>) => ({ path: `/ai-runs/${runId}/resume`, body: b }), { success: 'Resumed', onSuccess: () => setPoll(true) });
  const draft = useWsMutation((i: number) => ({ path: `/ai-runs/${runId}/draft`, body: { index: i } }), { success: 'Saved as a draft — nothing was sent' });
  const [provider, setProvider] = useState('');
  if (!r) return null;
  const stages: Stage[] = r.stages ?? [];
  return (
    <div className="space-y-4">
      <Card title={<>{r.workflowName} <Badge color={r.status === 'SUCCEEDED' ? 'green' : ACTIVE.has(r.status) ? 'blue' : r.status.startsWith('PAUSED') ? 'yellow' : 'red'}>{STATUS_LABEL[r.status] ?? r.status}</Badge></>}
        actions={<div className="flex gap-2">{ACTIVE.has(r.status) && <><Button size="sm" variant="secondary" loading={pause.isPending} onClick={() => pause.mutate(undefined)}>Pause</Button><Button size="sm" variant="ghost" onClick={() => cancel.mutate(undefined)}>Cancel</Button></>}</div>}>
        <ol className="flex flex-wrap gap-2" aria-label="Stages">
          {stages.map((s, i) => {
            const out = r.stageOutputs?.[s.id];
            const st = out?.status ?? (i === r.currentStage && ACTIVE.has(r.status) ? (r.status === 'RUNNING' ? 'RUNNING' : 'QUEUED') : i === r.currentStage && r.status.startsWith('PAUSED') ? 'PAUSED' : 'WAITING');
            const tone = st === 'SUCCEEDED' ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30' : st === 'RUNNING' || st === 'QUEUED' ? 'border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30' : st === 'PAUSED' ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30' : st === 'FAILED' ? 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30' : 'border-slate-200 dark:border-slate-700';
            return (
              <li key={s.id} className={`rounded-lg border px-3 py-1.5 text-xs ${tone}`}>
                <span className="font-semibold">{i + 1}. {s.name}</span> <span className="text-ink-500">· {shortProvider(out?.provider ?? s.provider)}{out?.model ? ` (${out.model})` : ''}</span>
                <span className="ml-1">{st === 'SUCCEEDED' ? <Check className="inline h-3.5 w-3.5 text-emerald-600" aria-label="done" /> : <span className="text-ink-500">{st.toLowerCase()}</span>}</span>
              </li>
            );
          })}
        </ol>
        {r.status.startsWith('PAUSED') && (
          <div className="mt-3"><Notice kind="warning">
            <p className="font-semibold">{r.pausedReason}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => resume.mutate({})}>{r.status === 'PAUSED_LIMIT' ? 'Retry now' : 'Resume'}</Button>
              <Select aria-label="Use another provider for this stage" value={provider} onChange={(e) => setProvider(e.target.value)} options={[{ value: '', label: 'Use another provider for this stage…' }, ...STAGE_PROVIDERS.filter((p) => p !== r.pausedProvider).map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))]} />
              <Button size="sm" variant="ghost" disabled={!provider} onClick={() => resume.mutate({ stageProvider: provider })}>Resume with it</Button>
              {r.status === 'PAUSED_LIMIT' && <Button size="sm" variant="ghost" onClick={() => resume.mutate({ autoResume: !r.autoResume })}>{r.autoResume ? 'Don’t resume automatically' : 'Resume automatically when the limit resets'}</Button>}
            </div>
          </Notice></div>
        )}
        {r.status === 'FAILED' && <div className="mt-3"><Notice kind="danger">{r.error} <Button size="sm" variant="secondary" className="ml-2" onClick={() => resume.mutate({})}>Retry failed stage</Button></Notice></div>}
        {ACTIVE.has(r.status) && r.error && <p className="mt-2 text-xs text-ink-500">{r.error}</p>}
      </Card>

      {r.research && <ResearchCard research={r.research} />}

      {r.variants?.length > 0 && (
        <section aria-label="Email variants" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-semibold">Email variants</h3>
            {r.draftSavedAt && <span className="text-xs text-ink-500">Draft saved {fmtWhen(r.draftSavedAt)} (variant {(r.draft?.variantIndex ?? 0) + 1})</span>}
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            {r.variants.map((v: any, i: number) => <VariantCard key={`${i}-${v.subject}`} run={r} v={v} i={i} onDraft={() => draft.mutate(i)} onRegenerate={() => setPollUntil(Date.now() + 180_000)} />)}
          </div>
        </section>
      )}

      <Card title="Execution history">
        {r.executions?.length ? (
          <Table head={['Stage', 'Provider', 'Status', 'Attempt', 'Duration', 'Error']}>
            {r.executions.map((e: any) => (
              <tr key={e.id}><td>{e.stageName}<span className="block text-xs text-ink-500">{TASK_LABELS[e.taskType as TaskType] ?? e.taskType}</span></td><td className="text-xs">{shortProvider(e.provider)}{e.model ? ` · ${e.model}` : ''}</td><td><Badge color={e.status === 'SUCCEEDED' ? 'green' : e.status === 'RUNNING' ? 'blue' : e.status === 'SKIPPED' ? 'gray' : e.status === 'PAUSED_LIMIT' ? 'yellow' : 'red'}>{e.status}</Badge></td><td>{e.attempt}</td><td className="tabular-nums">{e.durationMs != null ? `${(e.durationMs / 1000).toFixed(1)} s` : '—'}</td><td className="max-w-xs text-xs">{e.errorMessage}</td></tr>
            ))}
          </Table>
        ) : <p className="text-sm text-ink-500">Waiting for the first stage to start…</p>}
      </Card>
    </div>
  );
}

function ResearchCard({ research: x }: { research: any }) {
  const verified = (x.observations ?? []).filter((o: any) => o.verified);
  const unverified = (x.observations ?? []).filter((o: any) => !o.verified);
  return (
    <Card title="Prospect research">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2 text-sm">
          <p>{x.prospect_summary}</p>
          {x.business_model && <p><span className="font-semibold">Business model:</span> {x.business_model}</p>}
          <div className="rounded-lg border-l-4 border-brand-500 bg-brand-50/60 px-3 py-2 dark:bg-brand-950/30"><span className="block text-xs font-semibold text-brand-800 dark:text-brand-200">Pain point</span>{x.pain_point}</div>
          {x.business_opportunity && <p><span className="font-semibold">Opportunity:</span> {x.business_opportunity}</p>}
          {x.personalization_angle && <p><span className="font-semibold">Personalization angle:</span> {x.personalization_angle}</p>}
        </div>
        <div className="space-y-3 text-sm">
          <div>
            <h4 className="mb-1 text-xs font-semibold text-ink-500">Verified observations (with a source)</h4>
            {verified.length ? <ul className="space-y-1">{verified.map((o: any, i: number) => <li key={i} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden /><span>{o.text} <a className="inline-flex items-center gap-0.5 text-xs text-brand-700 underline dark:text-brand-300" href={o.source} target="_blank" rel="noreferrer noopener">source<ExternalLink className="h-3 w-3" aria-hidden /></a></span></li>)}</ul> : <p className="text-ink-500">None — treat the email&apos;s personal details with care.</p>}
          </div>
          {(unverified.length > 0 || x.assumptions?.length > 0) && (
            <div>
              <h4 className="mb-1 text-xs font-semibold text-ink-500">Assumptions (not verified)</h4>
              <ul className="list-disc space-y-0.5 pl-5 text-ink-600 dark:text-slate-300">{[...unverified.map((o: any) => o.text), ...(x.assumptions ?? [])].map((t: string, i: number) => <li key={i}>{t}</li>)}</ul>
            </div>
          )}
          {x.research_sources?.length > 0 && <p className="text-xs text-ink-500">Sources: {x.research_sources.map((s: string, i: number) => <a key={i} className="mr-2 underline" href={s} target="_blank" rel="noreferrer noopener">{(() => { try { return new URL(s).hostname; } catch { return s; } })()}</a>)}</p>}
        </div>
      </div>
    </Card>
  );
}

function VariantCard({ run, v, i, onDraft, onRegenerate }: { run: any; v: any; i: number; onDraft: () => void; onRegenerate: () => void }) {
  const copy = useCopy();
  const [subject, setSubject] = useState(v.subject);
  const [body, setBody] = useState(v.body);
  const [showEarlier, setShowEarlier] = useState(false);
  useEffect(() => { setSubject(v.subject); setBody(v.body); }, [v.subject, v.body]);
  const save = useWsMutation(() => ({ path: `/ai-runs/${run.id}/variants/${i}`, method: 'PUT', body: { subject, body } }), { success: 'Variant updated' });
  const select = useWsMutation(() => ({ path: `/ai-runs/${run.id}/variants/${i}/select` }), { success: `Variant ${i + 1} selected` });
  const regen = useWsMutation(() => ({ path: `/ai-runs/${run.id}/variants/${i}/regenerate` }), { success: 'Regenerating this variant…', onSuccess: onRegenerate });
  const earlier = useMemo(() => {
    const stages: Stage[] = run.stages ?? [];
    return stages.filter((s) => s.id !== v.stageId && run.stageOutputs?.[s.id]?.output?.variants?.[i]).map((s) => ({ stage: s, provider: run.stageOutputs[s.id].provider, variant: run.stageOutputs[s.id].output.variants[i] }));
  }, [run, v.stageId, i]);
  const dirty = subject !== v.subject || body !== v.body;
  const selected = run.selectedVariant === i;
  const checks = v.checks;
  return (
    <article className={`flex flex-col rounded-xl border bg-white p-4 shadow-sm dark:bg-slate-900 ${selected ? 'border-brand-400 ring-2 ring-brand-200 dark:border-brand-600 dark:ring-brand-900' : 'border-slate-200 dark:border-slate-700'}`} aria-label={`Variant ${i + 1}`}>
      <header className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">Variant {i + 1}{selected ? <span className="ml-2 text-xs font-semibold text-brand-700 dark:text-brand-300">Preferred</span> : null}</span>
        <span className="text-xs text-ink-500">{shortProvider(v.provider)}{v.edited ? ' · edited' : ''}</span>
      </header>
      {v.angle && <p className="mb-2 text-xs text-ink-500">Angle: {v.angle}</p>}
      <Field label="Subject"><Input value={subject} maxLength={300} onChange={(e) => setSubject(e.target.value)} /></Field>
      <Field label="Body"><Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      {v.pain_point && <p className="mb-2 text-xs"><span className="font-semibold">Pain point:</span> {v.pain_point}</p>}
      {checks && (
        <ul className="mb-2 flex flex-wrap gap-1" aria-label="Quality checks">
          {[['genuine_observation', 'Genuine observation'], ['relevant_pain_point', 'Relevant pain point'], ['sounds_human', 'Sounds human'], ['concise', 'Concise'], ['soft_question_ending', 'Soft question'], ['follows_playbook', 'Follows playbook']].map(([k, label]) => <li key={k}><Badge color={checks[k] ? 'green' : 'red'}>{label}</Badge></li>)}
          {checks.invented_personalization && <li><Badge color="red">Invented personalization</Badge></li>}
        </ul>
      )}
      {checks?.issues?.length > 0 && <ul className="mb-2 list-disc pl-5 text-xs text-amber-800 dark:text-amber-300">{checks.issues.map((x: string, k: number) => <li key={k}>{x}</li>)}</ul>}
      {v.reasoning && <details className="mb-2 text-xs text-ink-500"><summary className="cursor-pointer">Why this version</summary><p className="mt-1">{v.reasoning}</p></details>}
      {(earlier.length > 0 || v.history?.length > 0) && (
        <div className="mb-2">
          <button type="button" className="text-xs font-semibold text-brand-700 underline dark:text-brand-300" aria-expanded={showEarlier} onClick={() => setShowEarlier(!showEarlier)}>{showEarlier ? 'Hide' : 'Show'} original and earlier versions</button>
          {showEarlier && (
            <div className="mt-2 space-y-2">
              {earlier.map((e) => <div key={e.stage.id} className="rounded-lg bg-slate-50 p-2 text-xs dark:bg-slate-800"><p className="font-semibold">{e.stage.name} · {shortProvider(e.provider)}</p><p className="mt-1 font-medium">{e.variant.subject}</p><p className="whitespace-pre-wrap">{e.variant.body}</p></div>)}
              {(v.history ?? []).map((h: any, k: number) => <div key={k} className="rounded-lg bg-slate-50 p-2 text-xs dark:bg-slate-800"><p className="font-semibold">Before {h.reason} · {fmtWhen(h.at)}</p><p className="mt-1 font-medium">{h.subject}</p><p className="whitespace-pre-wrap">{h.body}</p></div>)}
            </div>
          )}
        </div>
      )}
      <div className="mt-auto flex flex-wrap gap-2 pt-2">
        {dirty && <Button size="sm" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save edit</Button>}
        {!selected && <Button size="sm" variant="secondary" loading={select.isPending} onClick={() => select.mutate(undefined)}>Select</Button>}
        <Button size="sm" variant="secondary" onClick={() => copy(`Subject: ${subject}\n\n${body}`, 'Email copied')}>Copy</Button>
        <Button size="sm" variant="ghost" disabled={run.status !== 'SUCCEEDED'} loading={regen.isPending} onClick={() => regen.mutate(undefined)}>Regenerate</Button>
        <Button size="sm" variant="ghost" disabled={dirty} title={dirty ? 'Save your edit first' : undefined} onClick={onDraft}>Save as draft</Button>
      </div>
    </article>
  );
}
