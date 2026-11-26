'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, Checkbox, Empty, Input, PageHeader, QueryView, Table } from '@/components/ui';

export default function Profiles() {
  const ws = useWs();
  const [archived, setArchived] = useState(false);
  const [filter, setFilter] = useState('');
  const q = useWsQuery<any[]>(`/ai-studio/profiles?archived=${archived}`);
  const [name, setName] = useState('');
  const create = useWsMutation(() => ({ path: '/ai-studio/profiles', body: { name } }), { success: 'Profile created', onSuccess: (r: any) => { window.location.href = `/w/${ws}/ai-studio/profiles/${r.id}`; } });
  const imp = useWsMutation<any>((body) => ({ path: '/ai-studio/profiles-import', body }), { success: (r: any) => `Imported ${r.created}${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}` });
  const exportAll = async () => {
    const data = await api(`/w/${ws}/ai-studio/profiles-export`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'prompt-profiles.json'; a.click(); URL.revokeObjectURL(url);
  };
  const onImport = async (f: File | undefined) => { if (f) imp.mutate(JSON.parse(await f.text())); };
  return (
    <>
      <PageHeader title="Prompt library" subtitle="Reusable personalization prompts with variables, conditions and version history." actions={<><Button variant="secondary" onClick={exportAll}>Export JSON</Button><label className="inline-flex cursor-pointer items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">Import JSON<input type="file" accept=".json" className="hidden" onChange={(e) => onImport(e.target.files?.[0])} /></label></>} />
      <Card title="New profile">
        <div className="flex gap-2"><Input placeholder="e.g. Consulting founders — first touch" value={name} onChange={(e) => setName(e.target.value)} className="w-96" /><Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create</Button></div>
        <p className="mt-2 text-xs text-slate-500">New profiles start from an example prompt you can edit.</p>
      </Card>
      <div className="mt-4">
        <Card title="Profiles" actions={<div className="flex items-center gap-3"><Input placeholder="Filter by name, folder or tag" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-64" /><Checkbox label="Show archived" checked={archived} onChange={setArchived} /></div>}>
          <QueryView q={q} isEmpty={(d) => !d.length} empty={<Empty title="No prompt profiles yet" />}>
            {(d) => {
              const f = filter.toLowerCase();
              const rows = d.filter((p: any) => !f || p.name.toLowerCase().includes(f) || (p.folder ?? '').toLowerCase().includes(f) || p.tags.some((t: string) => t.toLowerCase().includes(f)));
              const folders = [...new Set(rows.map((p: any) => p.folder ?? ''))].sort();
              return <>{folders.map((folder) => (
                <div key={folder} className="mb-4">
                  <h3 className="mb-1 text-sm font-semibold text-slate-600">📁 {folder || 'No folder'}</h3>
                  <Table head={['Name', 'Version', 'Tags', 'Used by', 'Updated']}>{rows.filter((p: any) => (p.folder ?? '') === folder).map((p: any) => (
                    <tr key={p.id}><td><Link className="underline" href={`/w/${ws}/ai-studio/profiles/${p.id}`}>{p.name}</Link> {p.isApproved && <Badge color="green">approved</Badge>} {p.isArchived && <Badge>archived</Badge>}<div className="text-xs text-slate-500">{p.description}</div></td><td>v{p.activeVersion ?? '—'} ({p._count.versions})</td><td>{p.tags.map((t: string) => <Badge key={t}>{t}</Badge>)}</td><td>{p._count.campaigns} campaign(s)</td><td>{fmtDate(p.updatedAt)}</td></tr>
                  ))}</Table>
                </div>
              ))}</>;
            }}
          </QueryView>
        </Card>
      </div>
    </>
  );
}
