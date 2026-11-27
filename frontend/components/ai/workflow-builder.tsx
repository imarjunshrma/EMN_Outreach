'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, Trash2 } from 'lucide-react';
import { Badge, Button, Card, Checkbox, ConfirmButton, Empty, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { useWsQuery } from '@/lib/hooks';
import {
  CONDITIONS, CONDITION_LABELS, INPUT_SOURCE_LABELS, OUTPUT_FORMATS, OUTPUT_FORMAT_LABELS, PROVIDER_LABELS, STAGE_PROVIDERS, TASK_LABELS, TASK_TYPES, WEB_TASKS,
  isSubscription, newStage, newStageId, shortProvider, type Stage, type TaskType,
} from '@/lib/ai-workflows';
import { useOwnerMutation, useOwnerQuery } from './hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Workflow { id: string; name: string; description: string | null; presetKey: string | null; isDefault: boolean; version: number; stages: Stage[] }
interface Draft { id: string | null; name: string; description: string; stages: Stage[] }

const providerTone = (p: string) => (p === 'CLAUDE_SUBSCRIPTION' ? 'border-brand-300 bg-brand-50 text-brand-800 dark:border-brand-700 dark:bg-brand-950/40 dark:text-brand-200'
  : p === 'CODEX_SUBSCRIPTION' ? 'border-slate-400 bg-slate-100 text-slate-800 dark:border-slate-500 dark:bg-slate-800 dark:text-slate-100'
    : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200');

export function WorkflowBuilder() {
  const list = useOwnerQuery<{ workflows: Workflow[] }>('/ai-workflows');
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const workflows = useMemo(() => list.data?.workflows ?? [], [list.data]);
  useEffect(() => {
    if (!workflows.length || draft) return;
    const w = workflows.find((x) => x.isDefault) ?? workflows[0];
    setSelected(w.id); setDraft({ id: w.id, name: w.name, description: w.description ?? '', stages: w.stages });
  }, [workflows, draft]);
  const open = (w: Workflow) => { setSelected(w.id); setDraft({ id: w.id, name: w.name, description: w.description ?? '', stages: w.stages }); };
  const blank = () => { setSelected(null); setDraft({ id: null, name: 'New workflow', description: '', stages: [newStage('PROSPECT_RESEARCH'), { ...newStage('COLD_EMAIL_GENERATION'), inputs: ['prospect', 'playbook', 'previous'] }] }); };
  return (
    <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
      <nav aria-label="Workflows" className="space-y-1">
        <Button className="mb-2 w-full" variant="secondary" onClick={blank}>New workflow</Button>
        {workflows.map((w) => (
          <button key={w.id} type="button" onClick={() => open(w)} aria-current={selected === w.id ? 'true' : undefined}
            className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${selected === w.id ? 'border-brand-400 bg-brand-50 dark:border-brand-600 dark:bg-brand-950/40' : 'border-transparent hover:bg-slate-50 dark:hover:bg-slate-800/60'}`}>
            <span className="flex items-center justify-between gap-2"><span className="font-semibold">{w.name}</span>{w.isDefault && <Badge color="green">Active</Badge>}</span>
            <span className="mt-0.5 block truncate text-xs text-ink-500">{w.stages.filter((s) => s.enabled).map((s) => shortProvider(s.provider)).join(' → ')}</span>
          </button>
        ))}
      </nav>
      {draft ? <Editor key={draft.id ?? 'new'} draft={draft} setDraft={setDraft} current={workflows.find((w) => w.id === draft.id) ?? null} onSaved={(w) => { setSelected(w.id); setDraft({ id: w.id, name: w.name, description: w.description ?? '', stages: w.stages }); }} /> : <Empty title="No workflow selected" />}
    </div>
  );
}

function Editor({ draft, setDraft, current, onSaved }: { draft: Draft; setDraft: (d: Draft | null) => void; current: Workflow | null; onSaved: (w: Workflow) => void }) {
  const [openStage, setOpenStage] = useState<string | null>(null);
  const [addTask, setAddTask] = useState<TaskType>('EMAIL_HUMANIZATION');
  const [addProvider, setAddProvider] = useState('CODEX_SUBSCRIPTION');
  const templates = useOwnerQuery<{ templates: Array<{ id: string; name: string; stage: Stage }> }>('/ai-stage-templates');
  const conns = useOwnerQuery<{ connections: Array<{ provider: string; status: string }> }>('/ai-subscriptions/connections');
  const apiProviders = useWsQuery<{ providers: Array<{ provider: string; isEnabled: boolean }> }>('/ai/providers');
  const body = { name: draft.name, description: draft.description || null, stages: draft.stages };
  const save = useOwnerMutation(() => (draft.id ? { path: `/ai-workflows/${draft.id}`, method: 'PUT', body } : { path: '/ai-workflows', body }), { success: 'Workflow saved', onSuccess: (w: any) => onSaved(w) });
  const saveAsNew = useOwnerMutation(() => ({ path: '/ai-workflows', body: { ...body, name: `${draft.name} (copy)`.slice(0, 100) } }), { success: 'Saved as a new workflow', onSuccess: (w: any) => onSaved(w) });
  const activate = useOwnerMutation(() => ({ path: `/ai-workflows/${draft.id}/activate` }), { success: 'This workflow is now used for "Generate with selected workflow"' });
  const remove = useOwnerMutation(() => ({ path: `/ai-workflows/${draft.id}`, method: 'DELETE' }), { success: 'Workflow deleted', onSuccess: () => setDraft(null) });
  const saveTpl = useOwnerMutation((s: Stage) => ({ path: '/ai-stage-templates', body: { name: s.name, stage: s } }), { success: 'Stage saved as a template' });

  const setStages = (stages: Stage[]) => setDraft({ ...draft, stages });
  const update = (i: number, patch: Partial<Stage>) => setStages(draft.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) => { const a = [...draft.stages]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; setStages(a); };
  const duplicate = (i: number) => { const s = draft.stages[i]; const copy = { ...s, id: newStageId(), name: `${s.name} (copy)`.slice(0, 80) }; setStages([...draft.stages.slice(0, i + 1), copy, ...draft.stages.slice(i + 1)]); };
  const removeStage = (i: number) => { const gone = draft.stages[i].id; setStages(draft.stages.filter((_, j) => j !== i).map((s) => ({ ...s, inputs: s.inputs.filter((x) => x !== `stage:${gone}`) }))); };
  const addStage = (s: Stage) => { const st = { ...s, id: newStageId() }; setStages([...draft.stages, st]); setOpenStage(st.id); };

  const connStatus = (p: string) => conns.data?.connections.find((c) => c.provider === p)?.status ?? 'DISCONNECTED';
  const apiReady = (p: string) => apiProviders.data?.providers.some((x) => `API:${x.provider}` === p && x.isEnabled);
  const warnings = useMemo(() => {
    const w: string[] = [];
    const enabled = draft.stages.filter((s) => s.enabled);
    if (!enabled.length) w.push('Enable at least one stage.');
    for (const s of enabled) {
      if (isSubscription(s.provider) && connStatus(s.provider) !== 'CONNECTED') w.push(`"${s.name}" uses ${shortProvider(s.provider)}, which is ${connStatus(s.provider).toLowerCase().replace('_', ' ')}. The workflow will pause at this stage until it is connected${s.condition === 'skip_if_provider_unavailable' ? ' (or skip it, as configured)' : ''}.`);
      if (!isSubscription(s.provider) && !apiReady(s.provider)) w.push(`"${s.name}" uses ${PROVIDER_LABELS[s.provider]}, which is not configured in this workspace.`);
      const order = draft.stages.map((x) => x.id);
      for (const inp of s.inputs) if (inp.startsWith('stage:')) {
        const ref = draft.stages.find((x) => x.id === inp.slice(6));
        if (!ref || order.indexOf(ref.id) > order.indexOf(s.id)) w.push(`"${s.name}" reads from a stage that is not before it. Move it or remove that input.`);
        else if (!ref.enabled) w.push(`"${s.name}" reads from "${ref.name}", which is disabled.`);
      }
    }
    return w;
  }, [draft.stages, conns.data, apiProviders.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const paidStages = draft.stages.filter((s) => s.enabled && !isSubscription(s.provider)).length;
  const dirty = !current || JSON.stringify({ n: current.name, d: current.description ?? '', s: current.stages }) !== JSON.stringify({ n: draft.name, d: draft.description, s: draft.stages });

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
          <Field label="Workflow name"><Input value={draft.name} maxLength={100} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
          <Field label="Description"><Input value={draft.description} maxLength={500} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(undefined)}>{draft.id ? 'Save changes' : 'Create workflow'}</Button>
          {draft.id && <Button variant="secondary" loading={saveAsNew.isPending} onClick={() => saveAsNew.mutate(undefined)}>Save as new</Button>}
          {draft.id && !current?.isDefault && <Button variant="secondary" disabled={dirty} title={dirty ? 'Save your changes first' : undefined} loading={activate.isPending} onClick={() => activate.mutate(undefined)}>Activate</Button>}
          {draft.id && !current?.isDefault && <ConfirmButton variant="ghost" confirm="Delete this workflow? Past runs keep their own copy." onConfirm={() => remove.mutate(undefined)}>Delete</ConfirmButton>}
          {current?.isDefault && <span className="self-center text-xs text-ink-500">Active — used by “Generate with selected workflow”.</span>}
        </div>
      </Card>

      <Card title="Execution preview">
        <ol className="flex flex-wrap items-stretch gap-y-3" aria-label="Stages in run order">
          {draft.stages.map((s, i) => (
            <li key={s.id} className="flex items-center">
              {i > 0 && <span aria-hidden className={`mx-1.5 h-px w-5 ${s.enabled ? 'bg-slate-400' : 'bg-slate-200'}`} />}
              <span className={`rounded-lg border px-3 py-2 text-xs ${s.enabled ? providerTone(s.provider) : 'border-dashed border-slate-300 text-ink-400 line-through'}`}>
                <span className="block font-semibold">{i + 1}. {s.name}</span>
                <span className="block opacity-80">{shortProvider(s.provider)} · {TASK_LABELS[s.taskType]}{s.outputFormat === 'EMAIL_VARIANTS_JSON' && s.taskType === 'COLD_EMAIL_GENERATION' ? ` · ${s.variants} variants` : ''}</span>
              </span>
            </li>
          ))}
        </ol>
        {paidStages > 0 && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">{paidStages} stage{paidStages > 1 ? 's use' : ' uses'} a paid API provider. You chose this explicitly; subscriptions never fall back to it.</p>}
        {warnings.length > 0 && <div className="mt-3"><Notice kind="warning"><ul className="list-disc space-y-0.5 pl-4">{warnings.map((w) => <li key={w}>{w}</li>)}</ul></Notice></div>}
      </Card>

      <ol className="space-y-3">
        {draft.stages.map((s, i) => (
          <li key={s.id}>
            <StageCard stage={s} index={i} count={draft.stages.length} earlier={draft.stages.slice(0, i)} expanded={openStage === s.id}
              onToggle={() => setOpenStage(openStage === s.id ? null : s.id)} onChange={(p) => update(i, p)} onMove={(d) => move(i, d)}
              onDuplicate={() => duplicate(i)} onRemove={() => removeStage(i)} onTemplate={() => saveTpl.mutate(s)} />
          </li>
        ))}
      </ol>

      <Card title="Add a stage">
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Task"><Select value={addTask} onChange={(e) => setAddTask(e.target.value as TaskType)} options={TASK_TYPES.map((t) => ({ value: t, label: TASK_LABELS[t] }))} /></Field>
          <Field label="Provider"><Select value={addProvider} onChange={(e) => setAddProvider(e.target.value)} options={STAGE_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))} /></Field>
          <div className="mb-4"><Button variant="secondary" onClick={() => addStage({ ...newStage(addTask, addProvider), allowWebResearch: isSubscription(addProvider) && WEB_TASKS.includes(addTask) })}>Add stage</Button></div>
        </div>
        {!!templates.data?.templates.length && (
          <div className="flex flex-wrap items-center gap-2 text-sm"><span className="text-ink-500">From a template:</span>
            {templates.data.templates.map((t) => <Button key={t.id} size="sm" variant="ghost" onClick={() => addStage(t.stage)}>{t.name}</Button>)}
          </div>
        )}
      </Card>
    </div>
  );
}

function StageCard({ stage: s, index, count, earlier, expanded, onToggle, onChange, onMove, onDuplicate, onRemove, onTemplate }: {
  stage: Stage; index: number; count: number; earlier: Stage[]; expanded: boolean; onToggle: () => void; onChange: (p: Partial<Stage>) => void;
  onMove: (d: -1 | 1) => void; onDuplicate: () => void; onRemove: () => void; onTemplate: () => void;
}) {
  const sub = isSubscription(s.provider);
  const toggleInput = (k: string, on: boolean) => onChange({ inputs: on ? [...new Set([...s.inputs, k])] : s.inputs.filter((x) => x !== k) });
  const iconBtn = 'rounded-md p-1.5 text-ink-500 hover:bg-slate-100 hover:text-ink disabled:opacity-30 dark:hover:bg-slate-800';
  return (
    <div className={`rounded-xl border bg-white shadow-sm dark:bg-slate-900 ${s.enabled ? 'border-slate-200 dark:border-slate-700' : 'border-dashed border-slate-300 opacity-75 dark:border-slate-700'}`}>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}
          <span className="font-semibold">{index + 1}. {s.name}</span>
          <span className={`rounded-md border px-1.5 py-0.5 text-xs ${providerTone(s.provider)}`}>{shortProvider(s.provider)}</span>
          <span className="truncate text-xs text-ink-500">{TASK_LABELS[s.taskType]}</span>
        </button>
        <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" className="accent-brand-600" checked={s.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />Enabled</label>
        <button type="button" className={iconBtn} aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp className="h-4 w-4" /></button>
        <button type="button" className={iconBtn} aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown className="h-4 w-4" /></button>
        <button type="button" className={iconBtn} aria-label="Duplicate stage" onClick={onDuplicate}><Copy className="h-4 w-4" /></button>
        <button type="button" className={iconBtn} aria-label="Remove stage" disabled={count === 1} onClick={onRemove}><Trash2 className="h-4 w-4" /></button>
      </div>
      {expanded && (
        <div className="border-t border-slate-100 px-4 py-4 dark:border-slate-800">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Stage name"><Input value={s.name} maxLength={80} onChange={(e) => onChange({ name: e.target.value })} /></Field>
            <Field label="Provider"><Select value={s.provider} onChange={(e) => { const p = e.target.value; onChange({ provider: p, model: null, temperature: isSubscription(p) ? null : s.temperature, reasoningEffort: p === 'CODEX_SUBSCRIPTION' ? s.reasoningEffort : null, allowWebResearch: isSubscription(p) ? s.allowWebResearch : false }); }} options={STAGE_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))} /></Field>
            <Field label="Task"><Select value={s.taskType} onChange={(e) => { const t = e.target.value as TaskType; onChange({ taskType: t, outputFormat: newStage(t).outputFormat, allowWebResearch: sub && WEB_TASKS.includes(t) }); }} options={TASK_TYPES.map((t) => ({ value: t, label: TASK_LABELS[t] }))} /></Field>
          </div>
          <Field label="Custom instructions" hint="Added after the built-in task instructions and safety rules. The writing playbook is passed separately when selected as an input.">
            <Textarea rows={4} maxLength={8000} value={s.instructions} onChange={(e) => onChange({ instructions: e.target.value })} placeholder="e.g. Keep each email under 70 words. Mention the clinic's new service only if it is on their website." />
          </Field>
          <fieldset className="mb-4">
            <legend className="mb-1 text-sm font-semibold">Inputs</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {Object.entries(INPUT_SOURCE_LABELS).map(([k, label]) => <Checkbox key={k} label={label} checked={s.inputs.includes(k)} onChange={(v) => toggleInput(k, v)} />)}
              {earlier.map((e) => <Checkbox key={e.id} label={`Output of “${e.name}”`} checked={s.inputs.includes(`stage:${e.id}`)} onChange={(v) => toggleInput(`stage:${e.id}`, v)} />)}
            </div>
          </fieldset>
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Output format"><Select value={s.outputFormat} onChange={(e) => onChange({ outputFormat: e.target.value as Stage['outputFormat'] })} options={OUTPUT_FORMATS.map((f) => ({ value: f, label: OUTPUT_FORMAT_LABELS[f] }))} /></Field>
            <Field label="Variants"><Input type="number" min={1} max={5} value={s.variants} onChange={(e) => onChange({ variants: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })} /></Field>
            {s.provider === 'CODEX_SUBSCRIPTION' ? (
              <Field label="Reasoning effort" hint="Codex's supported creativity-like setting."><Select value={s.reasoningEffort ?? ''} onChange={(e) => onChange({ reasoningEffort: (e.target.value || null) as Stage['reasoningEffort'] })} options={[{ value: '', label: 'Default' }, { value: 'minimal', label: 'Minimal' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} /></Field>
            ) : s.provider === 'CLAUDE_SUBSCRIPTION' ? (
              <Field label="Creativity" hint="Not adjustable through the Claude subscription."><Input value="Default" disabled /></Field>
            ) : (
              <Field label="Temperature"><Input type="number" min={0} max={2} step={0.1} value={s.temperature ?? ''} placeholder="Default" onChange={(e) => onChange({ temperature: e.target.value === '' ? null : Math.max(0, Math.min(2, Number(e.target.value))) })} /></Field>
            )}
            <Field label="Model (optional)"><Input value={s.model ?? ''} maxLength={120} placeholder={sub ? 'Subscription default' : 'Provider default'} onChange={(e) => onChange({ model: e.target.value || null })} /></Field>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Attempts"><Input type="number" min={1} max={5} value={s.retry.maxAttempts} onChange={(e) => onChange({ retry: { ...s.retry, maxAttempts: Math.max(1, Math.min(5, Number(e.target.value) || 1)) } })} /></Field>
            <Field label="First retry after (s)" hint="Doubles each attempt."><Input type="number" min={1} max={3600} value={s.retry.backoffSec} onChange={(e) => onChange({ retry: { ...s.retry, backoffSec: Math.max(1, Math.min(3600, Number(e.target.value) || 1)) } })} /></Field>
            <Field label="Timeout (s)"><Input type="number" min={30} max={1800} value={s.timeoutSec} onChange={(e) => onChange({ timeoutSec: Math.max(30, Math.min(1800, Number(e.target.value) || 30)) })} /></Field>
            <Field label="Run condition"><Select value={s.condition} onChange={(e) => onChange({ condition: e.target.value as Stage['condition'] })} options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))} /></Field>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Checkbox label="Continue the workflow if this stage fails" checked={s.continueOnError} onChange={(v) => onChange({ continueOnError: v })} />
            {sub && WEB_TASKS.includes(s.taskType) && <Checkbox label="Allow read-only web research" checked={s.allowWebResearch} onChange={(v) => onChange({ allowWebResearch: v })} />}
            {!sub && WEB_TASKS.includes(s.taskType) && <span className="text-xs text-ink-500">API providers cannot browse; they use the prospect profile and saved research evidence.</span>}
            <Button size="sm" variant="ghost" onClick={onTemplate}>Save as template</Button>
          </div>
        </div>
      )}
    </div>
  );
}
