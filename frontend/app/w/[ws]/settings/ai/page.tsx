'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { SubscriptionCards } from '@/components/ai/subscription-cards';
import { AiSourceCard } from '@/components/ai/ai-source-card';
import { WorkflowBuilder } from '@/components/ai/workflow-builder';
import { PlaybookEditor } from '@/components/ai/playbook-editor';
import { AiQueue } from '@/components/ai/ai-queue';
import { useAiOwner } from '@/components/ai/hooks';
import { qs, type Paged } from '@/lib/api';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate, fmtUsd } from '@/lib/format';
import { AI_TASKS } from '@/lib/constants';
import { Badge, Button, Card, Checkbox, Field, Input, Notice, PageHeader, Pagination, QueryView, Select, Table, Tabs, Textarea } from '@/components/ui';

const AI_PROVIDERS = [
  ['OPENAI', 'OpenAI'], ['ANTHROPIC', 'Anthropic Claude'], ['GOOGLE', 'Google Gemini'], ['OPENROUTER', 'OpenRouter'],
  ['GROQ', 'Groq'], ['TOGETHER', 'Together AI'], ['DEEPSEEK', 'DeepSeek'], ['MISTRAL', 'Mistral'],
  ['OLLAMA', 'Ollama (local)'], ['CUSTOM_OPENAI', 'Custom OpenAI-compatible'],
] as const;

function useProviderModels(configured: any[] | undefined) {
  const enabled = (id: string) => configured?.some((p) => p.provider === id);
  const openai = useWsQuery<{ models: string[]; warning: string | null }>(enabled('OPENAI') ? '/ai/providers/OPENAI/models' : null);
  const anthropic = useWsQuery<{ models: string[]; warning: string | null }>(enabled('ANTHROPIC') ? '/ai/providers/ANTHROPIC/models' : null);
  const google = useWsQuery<{ models: string[]; warning: string | null }>(enabled('GOOGLE') ? '/ai/providers/GOOGLE/models' : null);
  const openrouter = useWsQuery<{ models: string[]; warning: string | null }>(enabled('OPENROUTER') ? '/ai/providers/OPENROUTER/models' : null);
  const groq = useWsQuery<{ models: string[]; warning: string | null }>(enabled('GROQ') ? '/ai/providers/GROQ/models' : null);
  const together = useWsQuery<{ models: string[]; warning: string | null }>(enabled('TOGETHER') ? '/ai/providers/TOGETHER/models' : null);
  const deepseek = useWsQuery<{ models: string[]; warning: string | null }>(enabled('DEEPSEEK') ? '/ai/providers/DEEPSEEK/models' : null);
  const mistral = useWsQuery<{ models: string[]; warning: string | null }>(enabled('MISTRAL') ? '/ai/providers/MISTRAL/models' : null);
  const ollama = useWsQuery<{ models: string[]; warning: string | null }>(enabled('OLLAMA') ? '/ai/providers/OLLAMA/models' : null);
  const custom = useWsQuery<{ models: string[]; warning: string | null }>(enabled('CUSTOM_OPENAI') ? '/ai/providers/CUSTOM_OPENAI/models' : null);
  return { OPENAI: openai.data, ANTHROPIC: anthropic.data, GOOGLE: google.data, OPENROUTER: openrouter.data, GROQ: groq.data, TOGETHER: together.data, DEEPSEEK: deepseek.data, MISTRAL: mistral.data, OLLAMA: ollama.data, CUSTOM_OPENAI: custom.data };
}

function modelChoices(models: string[] | undefined, current: string) {
  const choices = (models ?? []).map((model) => ({ value: model, label: model }));
  if (current && !choices.some((m) => m.value === current)) choices.unshift({ value: current, label: `${current} (saved)` });
  return [{ value: '', label: 'Choose a model…' }, ...choices, { value: '__custom__', label: 'Enter model ID manually…' }];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function AiSettings() { return <Suspense><AiSettingsInner /></Suspense>; }

function AiSettingsInner() {
  const params = useSearchParams();
  const owner = useAiOwner();
  const [tab, setTab] = useState(params.get('tab') ?? 'providers');
  const ownerTabs = owner.allowed ? [{ id: 'workflows', label: 'AI Workflow Builder' }, { id: 'playbook', label: 'Writing Playbook' }, { id: 'queue', label: 'AI queue' }] : [];
  const ownerOnly = ['workflows', 'playbook', 'queue'];
  const shown = ownerOnly.includes(tab) && !owner.allowed ? 'providers' : tab;
  return (
    <>
      <PageHeader title="AI providers" subtitle="Choose where AI runs (API keys or your Claude / Codex subscription), connect providers, and route each task. Keys are encrypted at rest." />
      <Tabs active={shown} onChange={setTab} tabs={[{ id: 'providers', label: 'Providers & keys' }, ...ownerTabs, { id: 'routes', label: 'Model routing' }, { id: 'prompts', label: 'Prompt versions' }, { id: 'logs', label: 'AI response logs' }, { id: 'prices', label: 'Prices' }]} />
      {shown === 'providers' && <><AiSourceCard />{owner.allowed && <SubscriptionCards />}{owner.allowed && <h2 className="mb-3 text-base font-semibold text-ink">API providers</h2>}<Providers /></>}
      {shown === 'workflows' && owner.allowed && <WorkflowBuilder />}
      {shown === 'playbook' && owner.allowed && <PlaybookEditor />}
      {shown === 'queue' && owner.allowed && <AiQueue />}
      {shown === 'routes' && <Routes />}
      {shown === 'prompts' && <Prompts />}
      {shown === 'logs' && <Logs />}
      {shown === 'prices' && <Prices />}
    </>
  );
}

function Providers() {
  const q = useWsQuery<{ providers: any[]; suggestions: Record<string, { fast: string; quality: string }>; defaultProvider: string | null }>('/ai/providers');
  const modelLists = useProviderModels(q.data?.providers);
  const [forms, setForms] = useState<Record<string, { apiKey: string; defaultModel: string; baseUrl: string; isEnabled: boolean }>>({});
  const [customModels, setCustomModels] = useState<Record<string, boolean>>({});
  useEffect(() => { if (q.data) { const next: typeof forms = {}; for (const [id] of AI_PROVIDERS) { const p = q.data.providers.find((x) => x.provider === id); next[id] = { apiKey: '', defaultModel: p?.defaultModel ?? q.data.suggestions[id]?.quality ?? '', baseUrl: p?.baseUrl ?? '', isEnabled: p?.isEnabled ?? true }; } setForms(next); } }, [q.data]);
  const save = useWsMutation<string>((p) => ({ path: '/ai/providers', method: 'PUT', body: { provider: p, defaultModel: forms[p].defaultModel, baseUrl: forms[p].baseUrl || null, isEnabled: forms[p].isEnabled, ...(forms[p].apiKey ? { apiKey: forms[p].apiKey } : {}) } }), { success: 'Saved', onSuccess: () => setForms((f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { ...v, apiKey: '' }]))) });
  const test = useWsMutation<string>((p) => ({ path: `/ai/providers/${p}/test`, body: {} }), { success: (r: any) => (r.ok ? 'Connection OK' : `Failed: ${r.error}`) });
  const del = useWsMutation<string>((p) => ({ path: `/ai/providers/${p}`, method: 'DELETE' }), { success: 'Removed' });
  const setDefault = useWsMutation<{ provider: string | null; applyToAll: boolean }>((body) => ({ path: '/ai/default-provider', method: 'PUT', body }), { success: 'Workspace default saved' });
  const [defaultChoice, setDefaultChoice] = useState('');
  const [applyDefault, setApplyDefault] = useState(false);
  useEffect(() => { if (q.data) setDefaultChoice(q.data.defaultProvider ?? ''); }, [q.data?.defaultProvider]);
  return (
    <QueryView q={q}>
      {(d) => (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="lg:col-span-2" title="Workspace default provider">
            <p className="mb-3 text-sm text-slate-600">Choose the provider new task routes should inherit. Existing task routes stay as they are unless you apply this default to all of them.</p>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Default AI provider"><Select value={defaultChoice} onChange={(e) => setDefaultChoice(e.target.value)} options={[{ value: '', label: 'No workspace default' }, ...d.providers.filter((p) => p.isEnabled).map((p) => ({ value: p.provider, label: AI_PROVIDERS.find(([id]) => id === p.provider)?.[1] ?? p.provider }))]} /></Field>
              <Checkbox label="Apply to all current task routes" checked={applyDefault} onChange={setApplyDefault} />
              <Button disabled={!!defaultChoice && !d.providers.some((p) => p.provider === defaultChoice && p.isEnabled)} loading={setDefault.isPending} onClick={() => setDefault.mutate({ provider: defaultChoice || null, applyToAll: applyDefault })}>Save default</Button>
            </div>
            <p className="mt-2 text-xs text-slate-500">When enabled, tasks use this provider’s configured default model. Individual tasks can switch back to an explicit provider under Model routing.</p>
          </Card>
          {AI_PROVIDERS.map(([p, label]) => {
            const cur = d.providers.find((x) => x.provider === p);
            const f = forms[p] ?? { apiKey: '', defaultModel: '', baseUrl: '', isEnabled: true };
            return (
              <Card key={p} title={<>{label} {cur ? <Badge color="green">configured{cur.keyLast4 ? ` ••••${cur.keyLast4}` : ''}</Badge> : <Badge>not configured</Badge>}</>}>
                {p !== 'OLLAMA' && p !== 'CUSTOM_OPENAI' && <Field label={cur ? 'Replace API key (leave blank to keep)' : 'API key'}><Input type="password" autoComplete="off" value={f.apiKey} onChange={(e) => setForms({ ...forms, [p]: { ...f, apiKey: e.target.value } })} /></Field>}
                {(p === 'OLLAMA' || p === 'CUSTOM_OPENAI') && <Field label="OpenAI-compatible base URL" hint={p === 'OLLAMA' ? 'For Docker, try http://host.docker.internal:11434/v1; local/private HTTP endpoints are allowed.' : 'Examples: https://api.example.com/v1 or a local OpenAI-compatible server.'}><Input value={f.baseUrl} placeholder={p === 'OLLAMA' ? 'http://host.docker.internal:11434/v1' : 'https://your-endpoint.example/v1'} onChange={(e) => setForms({ ...forms, [p]: { ...f, baseUrl: e.target.value } })} /></Field>}
                {p === 'CUSTOM_OPENAI' && <Field label="API key (optional for local endpoints)"><Input type="password" autoComplete="off" value={f.apiKey} onChange={(e) => setForms({ ...forms, [p]: { ...f, apiKey: e.target.value } })} /></Field>}
                <Field label="Default model" hint={modelLists[p]?.warning ?? (modelLists[p]?.models.length ? 'Choose a model returned by your provider, or enter a custom model ID.' : d.suggestions[p]?.quality ? `Suggested: ${d.suggestions[p].quality} (quality), ${d.suggestions[p].fast} (fast)` : 'Save the provider first to load its model list.') }>
                  {cur && modelLists[p]?.models.length && !customModels[p]
                    ? <Select value={f.defaultModel} onChange={(e) => { if (e.target.value === '__custom__') setCustomModels({ ...customModels, [p]: true }); else setForms({ ...forms, [p]: { ...f, defaultModel: e.target.value } }); }} options={modelChoices(modelLists[p]?.models, f.defaultModel)} />
                    : <Input value={f.defaultModel} onChange={(e) => setForms({ ...forms, [p]: { ...f, defaultModel: e.target.value } })} placeholder="Enter model ID" />}
                </Field>
                {customModels[p] && <Button className="-mt-2 mb-3" variant="ghost" onClick={() => setCustomModels({ ...customModels, [p]: false })}>Choose from the model list</Button>}
                <div className="mt-2"><Checkbox label="Enabled" checked={f.isEnabled} onChange={(v) => setForms({ ...forms, [p]: { ...f, isEnabled: v } })} /></div>
                {cur?.lastTestedAt && <p className="mt-2 text-xs">{cur.lastTestOk ? '✅' : '❌'} tested {fmtDate(cur.lastTestedAt)} {cur.lastTestError && <span className="text-red-600">{cur.lastTestError}</span>}</p>}
                <div className="mt-3 flex gap-2"><Button disabled={!f.defaultModel || (!cur && !f.apiKey && p !== 'OLLAMA' && p !== 'CUSTOM_OPENAI') || ((p === 'OLLAMA' || p === 'CUSTOM_OPENAI') && !f.baseUrl)} loading={save.isPending} onClick={() => save.mutate(p)}>Save</Button>{cur && <Button variant="secondary" loading={test.isPending} onClick={() => test.mutate(p)}>Test connection</Button>}{cur && <Button variant="ghost" onClick={() => window.confirm('Remove this provider?') && del.mutate(p)}>Remove</Button>}</div>
              </Card>
            );
          })}
          <div className="lg:col-span-2"><Notice>OpenAI-compatible endpoints support OpenRouter, Groq, Together AI, DeepSeek, Mistral, Ollama, vLLM and compatible servers. Each task can select any configured provider and fallback. Image, audio, and embedding workflows are not part of this text generation interface.</Notice></div>
        </div>
      )}
    </QueryView>
  );
}

function Routes() {
  const q = useWsQuery<any[]>('/ai/routes');
  const providers = useWsQuery<{ providers: any[]; defaultProvider: string | null }>('/ai/providers');
  const modelLists = useProviderModels(providers.data?.providers);
  const providerChoices = (providers.data?.providers ?? []).map((p) => ({ value: p.provider, label: AI_PROVIDERS.find(([id]) => id === p.provider)?.[1] ?? p.provider }));
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [customModels, setCustomModels] = useState<Record<string, boolean>>({});
  const save = useWsMutation<string>((task) => ({ path: '/ai/routes', method: 'PUT', body: { task, ...edits[task], monthlyBudgetUsd: edits[task].monthlyBudgetUsd === '' || edits[task].monthlyBudgetUsd === null ? null : Number(edits[task].monthlyBudgetUsd) } }), { success: 'Route saved' });
  return (
    <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Notice>Add an AI provider first; default routes are created automatically.</Notice>}>
      {(rows) => (
        <>
        {providers.data?.defaultProvider && rows.some((r) => !r.useWorkspaceDefault) && <Notice>Workspace default is <strong>{providers.data.defaultProvider}</strong>, but {rows.filter((r) => !r.useWorkspaceDefault).length} task route(s) still use their saved provider overrides. In Providers &amp; keys, choose “Apply to all current task routes” to make the default effective for them.</Notice>}
        <div className="card mt-3 p-2"><Table head={['Task', 'Provider', 'Model', 'Fallback', 'Fallback model', 'Max tokens', 'Monthly budget $', '']}>
          {AI_TASKS.map((t) => {
            const r = rows.find((x) => x.task === t);
            const e = edits[t] ?? { provider: r?.provider ?? 'ANTHROPIC', model: r?.model ?? '', useWorkspaceDefault: r?.useWorkspaceDefault ?? false, fallbackProvider: r?.fallbackProvider ?? null, fallbackModel: r?.fallbackModel ?? '', maxOutputTokens: r?.maxOutputTokens ?? 1500, monthlyBudgetUsd: r?.monthlyBudgetUsd ?? '' };
            const models = modelLists[e.provider as keyof typeof modelLists]?.models;
            const fallbackModels = modelLists[e.fallbackProvider as keyof typeof modelLists]?.models;
            const inheritedProvider = providers.data?.providers.find((p) => p.provider === providers.data?.defaultProvider);
            const set = (k: string, v: unknown) => setEdits({ ...edits, [t]: { ...e, [k]: v } });
            return (
              <tr key={t}><td className="td text-xs font-medium">{t}</td>
                <td className="td"><Checkbox label="Use workspace default" checked={e.useWorkspaceDefault} onChange={(v) => set('useWorkspaceDefault', v)} />{e.useWorkspaceDefault
                  ? <p className="mt-2 text-xs font-medium text-green-700">Effective provider: {providers.data?.defaultProvider ?? 'not set'}</p>
                  : <><div className="mt-2"><Select value={e.provider} onChange={(x) => set('provider', x.target.value)} options={providerChoices} /></div>{providers.data?.defaultProvider && <p className="mt-1 text-xs text-amber-700">Explicit override; workspace default ({providers.data.defaultProvider}) is not used for this task.</p>}</>}</td>
                <td className="td">{e.useWorkspaceDefault
                  ? <span className="text-xs text-green-700">{inheritedProvider?.defaultModel ?? 'Workspace default has no configured model'}</span>
                  : models?.length && !customModels[t]
                  ? <Select value={e.model} onChange={(x) => { if (x.target.value === '__custom__') setCustomModels({ ...customModels, [t]: true }); else set('model', x.target.value); }} options={modelChoices(models, e.model)} />
                  : <Input value={e.model} placeholder="Model ID" onChange={(x) => set('model', x.target.value)} />}{!e.useWorkspaceDefault && customModels[t] && <button className="mt-1 text-xs text-brand-700" onClick={() => setCustomModels({ ...customModels, [t]: false })}>Choose from model list</button>}</td>
                <td className="td"><Select value={e.fallbackProvider ?? ''} onChange={(x) => set('fallbackProvider', x.target.value || null)} options={[{ value: '', label: 'none' }, ...providerChoices]} /></td>
                <td className="td">{fallbackModels?.length && !customModels[`${t}-fallback`]
                  ? <Select value={e.fallbackModel ?? ''} onChange={(x) => { if (x.target.value === '__custom__') setCustomModels({ ...customModels, [`${t}-fallback`]: true }); else set('fallbackModel', x.target.value); }} options={modelChoices(fallbackModels, e.fallbackModel ?? '')} />
                  : <Input value={e.fallbackModel ?? ''} placeholder="Fallback model ID" onChange={(x) => set('fallbackModel', x.target.value)} />}{customModels[`${t}-fallback`] && <button className="mt-1 text-xs text-brand-700" onClick={() => setCustomModels({ ...customModels, [`${t}-fallback`]: false })}>Choose from model list</button>}</td>
                <td className="td w-24"><Input type="number" value={e.maxOutputTokens} onChange={(x) => set('maxOutputTokens', Number(x.target.value))} /></td>
                <td className="td w-28"><Input type="number" value={e.monthlyBudgetUsd ?? ''} onChange={(x) => set('monthlyBudgetUsd', x.target.value)} /></td>
                <td className="td"><Button variant="secondary" disabled={!e.model} onClick={() => { setEdits({ ...edits, [t]: e }); save.mutate(t); }}>Save</Button></td>
              </tr>
            );
          })}
        </Table></div>
        </>
      )}
    </QueryView>
  );
}

function Prompts() {
  const [task, setTask] = useState(AI_TASKS[0]);
  const q = useWsQuery<any[]>(`/ai/prompts?task=${task}`);
  const [draft, setDraft] = useState<{ systemPrompt: string; userPromptTemplate: string; changeNote: string } | null>(null);
  const create = useWsMutation<boolean>((activate) => ({ path: '/ai/prompts', body: { task, ...draft, activate } }), { success: 'New version saved', onSuccess: () => setDraft(null) });
  const activate = useWsMutation<string>((id) => ({ path: `/ai/prompts/${id}/activate`, body: {} }), { success: 'Activated' });
  return (
    <>
      <Select className="mb-3 w-72" value={task} onChange={(e) => { setTask(e.target.value); setDraft(null); }} options={AI_TASKS} />
      <Notice>Prompts are versioned and never edited in place. Untrusted content (websites, emails, uploads) is always wrapped in &lt;untrusted_content&gt; tags by the system — keep the instruction that tells the model to ignore instructions inside them.</Notice>
      <QueryView q={q}>
        {(rows) => (
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">{rows.map((p) => (
              <Card key={p.id} title={<>v{p.version} {p.isActive && <Badge color="green">active</Badge>}</>} actions={<><Button variant="ghost" onClick={() => setDraft({ systemPrompt: p.systemPrompt, userPromptTemplate: p.userPromptTemplate, changeNote: '' })}>Copy to new version</Button>{!p.isActive && <Button variant="secondary" onClick={() => activate.mutate(p.id)}>Activate</Button>}</>}>
                <p className="text-xs text-slate-500">{p.changeNote} · {fmtDate(p.createdAt)}</p>
                <details className="mt-2 text-xs"><summary className="cursor-pointer">Show prompt</summary><pre className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2">{p.systemPrompt}{'\n\n---\n'}{p.userPromptTemplate}</pre></details>
              </Card>
            ))}</div>
            {draft && (
              <Card title="New version">
                <Field label="System prompt"><Textarea rows={10} value={draft.systemPrompt} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })} /></Field>
                <Field label="User prompt template" hint="Keep the {{placeholders}}"><Textarea rows={6} value={draft.userPromptTemplate} onChange={(e) => setDraft({ ...draft, userPromptTemplate: e.target.value })} /></Field>
                <Field label="Change note"><Input value={draft.changeNote} onChange={(e) => setDraft({ ...draft, changeNote: e.target.value })} /></Field>
                <div className="mt-3 flex gap-2"><Button loading={create.isPending} onClick={() => create.mutate(true)}>Save & activate</Button><Button variant="secondary" onClick={() => create.mutate(false)}>Save as draft</Button></div>
              </Card>
            )}
          </div>
        )}
      </QueryView>
    </>
  );
}

function Logs() {
  const [f, setF] = useState({ task: '', status: '', page: 1 });
  const q = useWsQuery<Paged<any>>(`/ai/executions${qs({ ...f, pageSize: 30 })}`);
  return (
    <>
      <div className="mb-3 flex gap-2"><Select className="w-64" value={f.task} onChange={(e) => setF({ ...f, task: e.target.value, page: 1 })} options={[{ value: '', label: 'All tasks' }, ...AI_TASKS.map((t) => ({ value: t, label: t }))]} /><Select className="w-48" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} options={[{ value: '', label: 'All statuses' }, ...['SUCCEEDED', 'FAILED', 'SCHEMA_INVALID', 'BLOCKED'].map((s) => ({ value: s, label: s }))]} /></div>
      <QueryView q={q}>
        {(d) => (
          <div className="card p-2">
            <Table head={['When', 'Task', 'Provider / model', 'Generation', 'Status', 'Tokens in/out', 'Cost', 'Latency', 'Details']}>
              {d.data.map((e: any) => <tr key={e.id}><td className="td text-xs">{fmtDate(e.createdAt)}</td><td className="td text-xs">{e.task}</td><td className="td text-xs">{e.provider} · {e.model}{e.usedFallback && <Badge color="yellow">route fallback</Badge>}</td><td className="td text-xs"><Badge color={e.generationMode === 'structured' ? 'green' : 'yellow'}>{e.generationMode ?? 'legacy'}</Badge></td><td className="td"><Badge>{e.status}</Badge></td><td className="td text-xs">{e.inputTokens}/{e.outputTokens}</td><td className="td text-xs">{fmtUsd(Number(e.costUsd))}{e.costIsEstimate && '*'}</td><td className="td text-xs">{e.latencyMs ?? '—'} ms</td>
                <td className="td text-xs"><details><summary className="cursor-pointer">view</summary>{e.errorMessage && <p className="text-red-600">{e.errorMessage}</p>}<pre className="max-w-md whitespace-pre-wrap">{e.output ? JSON.stringify(e.output, null, 2).slice(0, 3000) : '(output removed by retention or none)'}</pre></details></td></tr>)}
            </Table>
            <Pagination page={d.page} totalPages={d.totalPages} total={d.total} onPage={(p) => setF({ ...f, page: p })} />
            <p className="mt-1 text-xs text-slate-500">* model has no configured price — cost shown as estimate 0.</p>
          </div>
        )}
      </QueryView>
    </>
  );
}

function Prices() {
  const q = useWsQuery<any[]>('/ai/prices');
  const [f, setF] = useState({ provider: 'OPENAI', model: '', inputPerMTokUsd: '', outputPerMTokUsd: '', cachedInputPerMTokUsd: '' });
  const add = useWsMutation(() => ({ path: '/ai/prices', body: { provider: f.provider, model: f.model, inputPerMTokUsd: Number(f.inputPerMTokUsd), outputPerMTokUsd: Number(f.outputPerMTokUsd), cachedInputPerMTokUsd: f.cachedInputPerMTokUsd ? Number(f.cachedInputPerMTokUsd) : null } }), { success: 'Price added' });
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Add / update price (owner)">
        <Notice kind="warning">Check prices on the provider’s pricing page. Cost reports are estimates based on this table.</Notice>
        <Field label="Provider"><Select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} options={AI_PROVIDERS.map(([id, label]) => ({ value: id, label }))} /></Field>
        <Field label="Model id"><Input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
        <Field label="Input $ / 1M tokens"><Input type="number" step="0.001" value={f.inputPerMTokUsd} onChange={(e) => setF({ ...f, inputPerMTokUsd: e.target.value })} /></Field>
        <Field label="Output $ / 1M tokens"><Input type="number" step="0.001" value={f.outputPerMTokUsd} onChange={(e) => setF({ ...f, outputPerMTokUsd: e.target.value })} /></Field>
        <Field label="Cached input $ / 1M (optional)"><Input type="number" step="0.001" value={f.cachedInputPerMTokUsd} onChange={(e) => setF({ ...f, cachedInputPerMTokUsd: e.target.value })} /></Field>
        <Button className="mt-3" disabled={!f.model || !f.inputPerMTokUsd || !f.outputPerMTokUsd} loading={add.isPending} onClick={() => add.mutate()}>Save price</Button>
      </Card>
      <div className="lg:col-span-2"><QueryView q={q}>{(rows) => <div className="card p-2"><Table head={['Provider', 'Model', 'Input', 'Output', 'Cached input', 'Effective from']}>{rows.map((p) => <tr key={p.id}><td className="td">{p.provider}</td><td className="td">{p.model}</td><td className="td">${Number(p.inputPerMTokUsd)}</td><td className="td">${Number(p.outputPerMTokUsd)}</td><td className="td">{p.cachedInputPerMTokUsd ? `$${Number(p.cachedInputPerMTokUsd)}` : '—'}</td><td className="td text-xs">{fmtDate(p.effectiveFrom)}</td></tr>)}</Table></div>}</QueryView></div>
    </div>
  );
}
