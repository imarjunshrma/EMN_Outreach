'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { Badge, Button, Card, ConfirmButton, Empty, Notice, PageHeader, QueryView, Textarea } from '@/components/ui';
import { EMPTY, IcpEditor, LIST_FIELDS, type Criteria, type Icp } from '@/components/icp-editor';

export default function Icps() {
  const ws = useWs();
  const q = useWsQuery<Icp[]>('/icps');
  const [draft, setDraft] = useState({ name: '', description: '', criteria: EMPTY, minScore: 60, isActive: true });
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [assumptions, setAssumptions] = useState<string[]>([]);
  const fromText = useWsMutation(() => ({ path: '/icps/from-text', body: { description: text } }), {
    invalidate: false, success: 'Draft created from your description — review before saving',
    onSuccess: (r: unknown) => { const x = r as { name: string; criteria: Criteria; assumptions: string[] }; setDraft({ ...draft, name: x.name, description: text, criteria: x.criteria }); setAssumptions(x.assumptions); setEditing(null); },
  });
  const save = useWsMutation(() => ({ path: editing ? `/icps/${editing}` : '/icps', method: editing ? 'PUT' : 'POST', body: { ...draft, description: draft.description || null } }), { success: 'ICP saved', onSuccess: () => { setEditing(null); setDraft({ name: '', description: '', criteria: EMPTY, minScore: 60, isActive: true }); setAssumptions([]); } });
  const del = useWsMutation<string>((id) => ({ path: `/icps/${id}`, method: 'DELETE' }), { success: 'Deleted' });
  return (
    <>
      <PageHeader title="Ideal customer profile" subtitle="Describe who you want to reach. The ICP drives prospect searches and AI scoring (with an explanation per criterion)."
        actions={<Link className="inline-flex h-10 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold hover:border-brand-500 dark:border-slate-700" href={`/w/${ws}/ai-studio/imports`}>Import ICPs</Link>} />
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Card title="Describe your ideal customer (AI)">
            <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Find established business consultants, fractional executives, enterprise advisors, podcast hosts and founders in the UK and USA who regularly publish content and offer consulting or advisory services." />
            <Button className="mt-2" disabled={text.trim().length < 10} loading={fromText.isPending} onClick={() => fromText.mutate()}>Convert to filters</Button>
            {assumptions.length > 0 && <div className="mt-3"><Notice>AI assumptions to check: {assumptions.join(' · ')}</Notice></div>}
          </Card>
          <Card title={editing ? 'Edit ICP' : 'New ICP'}>
            <IcpEditor value={draft} onChange={setDraft} />
            <div className="mt-4 flex gap-2"><Button disabled={!draft.name.trim()} loading={save.isPending} onClick={() => save.mutate()}>{editing ? 'Save changes' : 'Create ICP'}</Button>{editing && <Button variant="secondary" onClick={() => { setEditing(null); setDraft({ name: '', description: '', criteria: EMPTY, minScore: 60, isActive: true }); }}>Cancel</Button>}</div>
          </Card>
        </div>
        <div className="lg:col-span-2">
          <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No ICPs yet">Create one to enable scoring.</Empty>}>
            {(rows) => (
              <div className="space-y-3">{rows.map((i) => (
                <Card key={i.id} title={<>{i.name} {i.isActive ? <Badge color="green">active</Badge> : <Badge>inactive</Badge>}</>} actions={<><Button variant="ghost" onClick={() => { setEditing(i.id); setDraft({ name: i.name, description: i.description ?? '', criteria: { ...EMPTY, ...i.criteria }, minScore: i.minScore, isActive: i.isActive }); }}>Edit</Button><ConfirmButton variant="ghost" confirm="Delete ICP?" onConfirm={() => del.mutate(i.id)}>Delete</ConfirmButton></>}>
                  <dl className="space-y-1 text-sm">{LIST_FIELDS.map(([k, label]) => (i.criteria[k] as string[])?.length ? <div key={k}><dt className="inline text-slate-500">{label}: </dt><dd className="inline">{(i.criteria[k] as string[]).join(', ')}</dd></div> : null)}
                    <div><span className="text-slate-500">Employees:</span> {i.criteria.employeeMin ?? '—'} – {i.criteria.employeeMax ?? '—'} · <span className="text-slate-500">Qualifies at</span> {i.minScore}+</div></dl>
                </Card>
              ))}</div>
            )}
          </QueryView>
        </div>
      </div>
    </>
  );
}
