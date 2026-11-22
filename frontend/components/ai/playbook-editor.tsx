'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, Card, ConfirmButton, Field, Input, Notice, QueryView, Tabs, Textarea } from '@/components/ui';
import { Markdown } from '@/lib/markdown';
import { fmtWhen, useOwnerMutation, useOwnerQuery } from './hooks';

interface Version { id: string; version: number; note: string | null; isCurrent: boolean; createdAt: string }
interface Overview { current: Version & { content: string }; versions: Version[] }

export function PlaybookEditor() {
  const q = useOwnerQuery<Overview>('/ai-playbook');
  return <QueryView q={q}>{(d) => <Editor key={d.current.id} data={d} />}</QueryView>;
}

function Editor({ data }: { data: Overview }) {
  const [content, setContent] = useState(data.current.content);
  const [note, setNote] = useState('');
  const [view, setView] = useState('edit');
  const [viewing, setViewing] = useState<string | null>(null);
  useEffect(() => { setContent(data.current.content); }, [data.current.content]);
  const save = useOwnerMutation(() => ({ path: '/ai-playbook', body: { content, note: note || null } }), { success: (r: { unchanged?: boolean; version?: { version: number } }) => (r.unchanged ? 'No changes to save' : `Saved as version ${r.version?.version}`), onSuccess: () => setNote('') });
  const restore = useOwnerMutation((id: string) => ({ path: `/ai-playbook/versions/${id}/restore` }), { success: (r: { version?: { version: number } }) => `Restored as version ${r.version?.version}`, onSuccess: () => setViewing(null) });
  const old = useOwnerQuery<{ id: string; version: number; content: string; note: string | null; createdAt: string }>(viewing ? `/ai-playbook/versions/${viewing}` : null);
  const dirty = content.trim() !== data.current.content.trim();
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
      <Card title={<>Writing playbook <Badge color="green">{`Version ${data.current.version}`}</Badge></>} actions={<span className="text-xs text-ink-500">{words} words</span>}>
        <p className="mb-3 text-sm text-ink-600 dark:text-slate-300">One source of truth for your cold-email style. Every stage that has “Writing playbook” as an input receives the current version; each run records the version it used. The shipped starting point is <code>ai/playbook/cold-email.md</code>.</p>
        <Tabs active={view} onChange={setView} tabs={[{ id: 'edit', label: 'Edit' }, { id: 'preview', label: 'Preview' }, { id: 'model', label: 'What the model receives' }]} />
        {view === 'edit' && <Textarea aria-label="Playbook (Markdown)" rows={26} className="font-mono text-[13px] leading-relaxed" value={content} onChange={(e) => setContent(e.target.value)} spellCheck />}
        {view === 'preview' && <div className="prose-sm max-h-[38rem] overflow-y-auto rounded-lg border border-slate-200 p-4 dark:border-slate-700"><Markdown source={content} /></div>}
        {view === 'model' && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-700 dark:bg-slate-900">
            <p className="mb-2 text-ink-600 dark:text-slate-300">Stages that use the playbook get it as a section of their input, after the built-in safety rules:</p>
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap font-mono text-xs">{`## Writing playbook (follow it)\n${content}`}</pre>
          </div>
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Change note (optional)"><Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Shorter closings" /></Field>
          <div className="mb-4 flex gap-2">
            <Button variant="ghost" disabled={!dirty} onClick={() => setContent(data.current.content)}>Discard</Button>
            <Button disabled={!dirty || content.trim().length < 20} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save new version</Button>
          </div>
        </div>
        {dirty && <Notice kind="info">Unsaved changes. Generations keep using version {data.current.version} until you save.</Notice>}
      </Card>
      <Card title="Version history">
        <ol className="space-y-1">
          {data.versions.map((v) => (
            <li key={v.id}>
              <button type="button" onClick={() => setViewing(viewing === v.id ? null : v.id)} aria-expanded={viewing === v.id} className={`w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60 ${viewing === v.id ? 'bg-slate-50 dark:bg-slate-800/60' : ''}`}>
                <span className="flex items-center justify-between"><span className="font-semibold">Version {v.version}</span>{v.isCurrent && <Badge color="green">Current</Badge>}</span>
                <span className="block text-xs text-ink-500">{fmtWhen(v.createdAt)}{v.note ? ` — ${v.note}` : ''}</span>
              </button>
              {viewing === v.id && old.data && (
                <div className="mx-1 mb-2 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{old.data.content}</pre>
                  {!v.isCurrent && <ConfirmButton className="mt-2" size="sm" variant="secondary" confirm={`Restore version ${v.version}? It becomes a new version; nothing is deleted.`} onConfirm={() => restore.mutate(v.id)}>Restore this version</ConfirmButton>}
                </div>
              )}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
