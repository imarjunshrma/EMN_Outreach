'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type DragEvent } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { LEAD_STATUSES, ROLES } from '@/lib/constants';
import { ACTION_HELP, ACTION_PARAMS, ACTIONS, CONDITION_FIELDS, FIELD_LABELS, OP_LABELS, OPS, TRIGGER_LABELS, WORKFLOW_TRIGGERS, newId, type Block, type Condition } from '@/lib/workflow';
import { Badge, Button, Card, ConfirmButton, Field, Input, Notice, PageHeader, Select, Tabs, Textarea } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ctx = { campaigns: Array<{ id: string; name: string }>; members: Array<{ id: string; name: string }> };

function ConditionRow({ c, onChange, onRemove }: { c: Condition; onChange: (c: Condition) => void; onRemove: () => void }) {
  const multi = c.op === 'in' || c.op === 'not_in';
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Select className="!w-44 !h-8 !py-0 text-xs" value={c.field} onChange={(e) => onChange({ ...c, field: e.target.value })} options={CONDITION_FIELDS.map((f) => ({ value: f, label: FIELD_LABELS[f] }))} />
      <Select className="!w-24 !h-8 !py-0 text-xs" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value })} options={OPS.map((o) => ({ value: o, label: OP_LABELS[o] }))} />
      {c.op !== 'exists' && <Input className="!w-44 !h-8 !py-0 text-xs" value={Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '')} placeholder={multi ? 'US, UK, IN' : 'value'} onChange={(e) => onChange({ ...c, value: multi ? e.target.value.split(',').map((x) => x.trim()).filter(Boolean) : e.target.value })} />}
      <button className="text-xs text-slate-400 hover:text-red-600" onClick={onRemove} aria-label="Remove condition">✕</button>
    </div>
  );
}

function BlockList({ blocks, onChange, ctx, depth, label }: { blocks: Block[]; onChange: (b: Block[]) => void; ctx: Ctx; depth: number; label?: string }) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const set = (i: number, b: Block) => onChange(blocks.map((x, j) => (j === i ? b : x)));
  const move = (from: number, to: number) => { if (to < 0 || to >= blocks.length) return; const a = [...blocks]; const [x] = a.splice(from, 1); a.splice(to, 0, x); onChange(a); };
  const add = (kind: 'action' | 'condition') => onChange([...blocks, kind === 'action' ? { id: newId(), kind: 'action', action: 'add_tag', params: { tag: '' } } : { id: newId(), kind: 'condition', all: [{ field: 'lead.country', op: 'eq', value: '' }], then: [], else: [] }]);
  const paramInput = (b: Extract<Block, { kind: 'action' }>, i: number, p: { key: string; label: string; kind?: string }) => {
    const v = b.params[p.key] ?? '';
    const upd = (val: string) => set(i, { ...b, params: { ...b.params, [p.key]: val } });
    if (p.kind === 'status') return <Select className="!h-8 !py-0 text-xs" value={v} onChange={(e) => upd(e.target.value)} options={[{ value: '', label: '—' }, ...LEAD_STATUSES.map((s) => ({ value: s, label: s }))]} />;
    if (p.kind === 'campaign') return <Select className="!h-8 !py-0 text-xs" value={v} onChange={(e) => upd(e.target.value)} options={[{ value: '', label: 'Campaign from the event' }, ...ctx.campaigns.map((c) => ({ value: c.id, label: c.name }))]} />;
    if (p.kind === 'member') return <Select className="!h-8 !py-0 text-xs" value={v} onChange={(e) => upd(e.target.value)} options={[{ value: '', label: '—' }, ...ctx.members.map((m) => ({ value: m.id, label: m.name }))]} />;
    if (p.kind === 'role') return <Select className="!h-8 !py-0 text-xs" value={v || 'MEMBER'} onChange={(e) => upd(e.target.value)} options={ROLES.filter((r) => r !== 'VIEWER')} />;
    return <Input className="!h-8 !py-0 text-xs" type={p.kind === 'number' ? 'number' : 'text'} value={v} onChange={(e) => upd(e.target.value)} />;
  };
  return (
    <div className={`space-y-2 ${depth > 0 ? 'border-l-2 border-slate-200 pl-3' : ''}`}>
      {label && <p className="text-xs font-semibold uppercase text-slate-400">{label}</p>}
      {blocks.length === 0 && <p className="text-xs text-slate-400">No steps.</p>}
      {blocks.map((b, i) => (
        <div key={b.id} data-testid={`block-${b.kind}`} draggable onDragStart={() => setDragIdx(i)} onDragOver={(e: DragEvent) => e.preventDefault()} onDrop={(e: DragEvent) => { e.stopPropagation(); if (dragIdx !== null) move(dragIdx, i); setDragIdx(null); }}
          className={`rounded-md border p-2 ${b.kind === 'condition' ? 'border-brand-200 bg-brand-50/40' : 'border-slate-200 bg-white'}`}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="cursor-move text-xs font-semibold text-slate-500">⋮⋮ {b.kind === 'condition' ? 'IF (all of)' : 'DO'}</span>
            <span className="flex gap-1 text-xs"><button onClick={() => move(i, i - 1)} aria-label="Move up">↑</button><button onClick={() => move(i, i + 1)} aria-label="Move down">↓</button><button className="text-red-600" onClick={() => onChange(blocks.filter((_, j) => j !== i))} aria-label="Delete step">delete</button></span>
          </div>
          {b.kind === 'condition' ? (
            <>
              <div className="space-y-1">{b.all.map((c, ci) => <ConditionRow key={ci} c={c} onChange={(nc) => set(i, { ...b, all: b.all.map((x, k) => (k === ci ? nc : x)) })} onRemove={() => set(i, { ...b, all: b.all.filter((_, k) => k !== ci) })} />)}</div>
              <button className="mt-1 text-xs text-brand-700" onClick={() => set(i, { ...b, all: [...b.all, { field: 'lead.status', op: 'eq', value: '' }] })}>+ Add condition</button>
              {depth < 3 ? <div className="mt-2 grid gap-2 md:grid-cols-2">
                <BlockList label="Then" blocks={b.then} onChange={(t) => set(i, { ...b, then: t })} ctx={ctx} depth={depth + 1} />
                <BlockList label="Else" blocks={b.else} onChange={(t) => set(i, { ...b, else: t })} ctx={ctx} depth={depth + 1} />
              </div> : <p className="text-xs text-amber-700">Maximum nesting reached.</p>}
            </>
          ) : (
            <>
              <Select className="!h-8 !py-0 text-xs" value={b.action} onChange={(e) => set(i, { ...b, action: e.target.value as any, params: {} })} options={ACTIONS.map((a) => ({ value: a, label: a.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) }))} />
              <div className="mt-1 grid gap-1 md:grid-cols-2">{ACTION_PARAMS[b.action].map((p) => <label key={p.key} className="text-xs"><span className="text-slate-500">{p.label}</span>{paramInput(b, i, p)}</label>)}</div>
              {ACTION_HELP[b.action] && <p className="mt-1 text-xs text-slate-500">{ACTION_HELP[b.action]}</p>}
            </>
          )}
        </div>
      ))}
      <div className="flex gap-2"><Button variant="secondary" size="sm" onClick={() => add('action')}>Add action</Button>{depth < 3 && <Button variant="secondary" size="sm" onClick={() => add('condition')}>Add if / else</Button>}</div>
    </div>
  );
}

export default function WorkflowEditor() {
  const ws = useWs();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const q = useWsQuery<any>(isNew ? null : `/workflows/${id}`);
  const runs = useWsQuery<any[]>(isNew ? null : `/workflows/${id}/runs`, { refetchInterval: 15_000 });
  const campaigns = useWsQuery<any[]>('/campaigns');
  const members = useWsQuery<{ members: Array<{ user: { id: string; name: string } }> }>('/members');
  const ctx: Ctx = { campaigns: (campaigns.data ?? []).map((c) => ({ id: c.id, name: c.name })), members: (members.data?.members ?? []).map((m) => ({ id: m.user.id, name: m.user.name })) };
  const [f, setF] = useState({ name: '', trigger: 'reply.categorized', maxRunsPerDay: 1000, changeNote: '' });
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [tab, setTab] = useState('build');
  const [payload, setPayload] = useState('{\n  "leadId": ""\n}');
  const [testResult, setTestResult] = useState<any>(null);
  const [hook, setHook] = useState<any>(null);
  useEffect(() => {
    if (!q.data) return;
    setF({ name: q.data.name, trigger: q.data.trigger, maxRunsPerDay: q.data.maxRunsPerDay, changeNote: '' });
    const active = q.data.versions.find((v: any) => v.id === q.data.activeVersionId) ?? q.data.versions[0];
    if (active) setBlocks(active.graph.blocks);
  }, [q.data]);
  const save = useWsMutation(() => ({ path: isNew ? '/workflows' : `/workflows/${id}`, method: isNew ? 'POST' : 'PUT', body: { ...f, changeNote: f.changeNote || undefined, graph: { blocks } } }), { success: 'Saved as a new version', onSuccess: (r: any) => { if (isNew) router.replace(`/w/${ws}/workflows/${r.id}`); } });
  const activate = useWsMutation<boolean>((active) => ({ path: `/workflows/${id}/active`, body: { active } }), { success: 'Updated' });
  const restore = useWsMutation<string>((vid) => ({ path: `/workflows/${id}/versions/${vid}/restore`, body: {} }), { success: 'Version restored' });
  const del = useWsMutation(() => ({ path: `/workflows/${id}`, method: 'DELETE' }), { success: 'Deleted', onSuccess: () => router.replace(`/w/${ws}/workflows`) });
  const run = useWsMutation<boolean>((testMode) => { let p = {}; try { p = JSON.parse(payload); } catch { /* invalid JSON → empty */ } return { path: `/workflows/${id}/run`, body: { testMode, payload: p } }; }, { onSuccess: (r: any) => setTestResult(r) });
  const token = useWsMutation(() => ({ path: `/workflows/${id}/webhook-token`, body: {} }), { invalidate: false, onSuccess: (r: any) => setHook(r) });
  const wf = q.data;
  return (
    <>
      <PageHeader title={isNew ? 'New workflow' : f.name || 'Workflow'} subtitle={wf ? <>{wf.isActive ? <Badge color="green">active</Badge> : <Badge color="gray">inactive</Badge>} · {wf.versions.length} versions</> : 'Build: trigger, then conditions and actions. Save creates a version.'}
        actions={<>{!isNew && wf && <Button variant="secondary" onClick={() => activate.mutate(!wf.isActive)}>{wf.isActive ? 'Deactivate' : 'Activate'}</Button>}<Button loading={save.isPending} disabled={!f.name || blocks.length === 0} onClick={() => save.mutate()}>Save version</Button>{!isNew && <ConfirmButton variant="ghost" confirm="Delete this workflow and its history?" onConfirm={() => del.mutate()}>Delete</ConfirmButton>}</>} />
      {!isNew && <Tabs active={tab} onChange={setTab} tabs={[{ id: 'build', label: 'Builder' }, { id: 'test', label: 'Test run' }, { id: 'runs', label: 'Execution log', count: runs.data?.length }, { id: 'versions', label: 'Versions', count: wf?.versions.length }]} />}
      {tab === 'build' && (
        <div className="grid gap-4 lg:grid-cols-4">
          <Card title="Trigger">
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="When"><Select value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })} options={WORKFLOW_TRIGGERS.map((t) => ({ value: t, label: TRIGGER_LABELS[t] }))} /></Field>
            <Field label="Max runs per day"><Input type="number" min={1} value={f.maxRunsPerDay} onChange={(e) => setF({ ...f, maxRunsPerDay: Number(e.target.value) })} /></Field>
            <Field label="Change note (optional)"><Input value={f.changeNote} onChange={(e) => setF({ ...f, changeNote: e.target.value })} /></Field>
            {f.trigger === 'webhook.received' && !isNew && <div className="mt-3"><Button variant="secondary" onClick={() => token.mutate()}>Generate webhook token</Button>{hook && <Notice kind="warning">POST JSON to <code className="break-all">{hook.url}</code> with header <code>{hook.header}: {hook.token}</code>. Shown once.</Notice>}</div>}
            <p className="mt-3 text-xs text-slate-500">Each event runs a workflow at most once. Failed runs retry automatically and notify managers.</p>
          </Card>
          <div className="lg:col-span-3"><Card title="Steps"><BlockList blocks={blocks} onChange={setBlocks} ctx={ctx} depth={0} /></Card></div>
        </div>
      )}
      {tab === 'test' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Event payload (JSON)">
            <Textarea rows={8} value={payload} onChange={(e) => setPayload(e.target.value)} />
            <p className="mt-1 text-xs text-slate-500">Use a real leadId to evaluate lead conditions. Test mode changes nothing; it logs what each action would do.</p>
            <div className="mt-2 flex gap-2"><Button loading={run.isPending} onClick={() => run.mutate(true)}>Run test (dry run)</Button>{wf?.isActive && <ConfirmButton variant="secondary" confirm="Run for real? Actions will change data." onConfirm={() => run.mutate(false)}>Run live</ConfirmButton>}</div>
          </Card>
          <Card title="Result">{testResult ? <><p className="mb-2"><Badge>{testResult.status ?? 'SKIPPED'}</Badge> {testResult.skipped}</p><ul className="space-y-1 text-xs" data-testid="test-log">{(testResult.log ?? []).map((l: any, i: number) => <li key={i}><Badge color={l.ok ? 'gray' : 'red'}>{l.kind}</Badge> {l.detail}</li>)}</ul></> : <p className="text-sm text-slate-500">Run a test to see the execution path.</p>}</Card>
        </div>
      )}
      {tab === 'runs' && <Card title="Recent runs">{(runs.data ?? []).length === 0 ? <p className="text-sm text-slate-500">No runs yet.</p> : <ul className="space-y-2">{runs.data!.map((r) => <li key={r.id} className="rounded border border-slate-200 p-2 text-sm"><div className="flex flex-wrap items-center gap-2"><Badge>{r.status}</Badge>{r.testMode && <Badge color="blue">test</Badge>}<span className="text-xs text-slate-500">{fmtDate(r.startedAt)} · attempts {r.attempts}</span>{r.error && <span className="text-xs text-red-700">{r.error}</span>}</div><details className="mt-1 text-xs"><summary className="cursor-pointer text-slate-500">log</summary><ul>{(r.log as any[]).map((l, i) => <li key={i}>{l.kind}: {l.detail}</li>)}</ul></details></li>)}</ul>}</Card>}
      {tab === 'versions' && wf && <Card title="Versions"><ul className="space-y-1 text-sm">{wf.versions.map((v: any) => <li key={v.id} className="flex items-center justify-between gap-2"><span>v{v.version} · {fmtDate(v.createdAt)} {v.changeNote && <span className="text-slate-500">— {v.changeNote}</span>} {v.id === wf.activeVersionId && <Badge color="green">active</Badge>}</span>{v.id !== wf.activeVersionId && <Button variant="ghost" onClick={() => restore.mutate(v.id)}>Make active</Button>}</li>)}</ul></Card>}
    </>
  );
}
