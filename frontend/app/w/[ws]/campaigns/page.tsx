'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDay } from '@/lib/format';
import { Badge, Button, Empty, Field, Input, Modal, PageHeader, QueryView, Select, Table } from '@/components/ui';

interface Campaign { id: string; name: string; status: string; createdAt: string; pauseReason: string | null; folder: string | null; tags: string[]; stats: { enrolled: number; sent: number; replied: number; bounced: number; unsubscribed: number } }

export default function Campaigns() {
  const ws = useWs();
  const router = useRouter();
  const q = useWsQuery<Campaign[]>('/campaigns');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [tag, setTag] = useState('');
  const [org, setOrg] = useState<{ id: string; folder: string; tags: string } | null>(null);
  const organize = useWsMutation(() => ({ path: `/campaigns/${org!.id}/organize`, method: 'PATCH', body: { folder: org!.folder.trim() || null, tags: org!.tags.split(',').map((t) => t.trim()).filter(Boolean) } }), { success: 'Saved', onSuccess: () => setOrg(null) });
  const create = useWsMutation(() => ({ path: '/campaigns', body: { name } }), { success: 'Campaign created', onSuccess: (r: unknown) => router.push(`/w/${ws}/campaigns/${(r as { id: string }).id}`) });
  return (
    <>
      <PageHeader title="Campaigns & sequences" subtitle="Build a sequence, pick lists and mailboxes, submit for approval. Nothing is sent until a manager approves the exact content." actions={<Button onClick={() => setOpen(true)}>New campaign</Button>} />
      <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No campaigns yet" action={<Button onClick={() => setOpen(true)}>Create your first campaign</Button>} />}>
        {(all) => {
          const folders = [...new Set(all.map((c) => c.folder).filter(Boolean))] as string[];
          const tags = [...new Set(all.flatMap((c) => c.tags ?? []))];
          const rows = all.filter((c) => (!folder || (folder === '__none' ? !c.folder : c.folder === folder)) && (!tag || c.tags?.includes(tag)));
          return (
          <div className="card p-2">
            <div className="mb-2 flex flex-wrap gap-2"><Select className="!w-48" value={folder} onChange={(e) => setFolder(e.target.value)} options={[{ value: '', label: 'All folders' }, { value: '__none', label: 'No folder' }, ...folders.map((f) => ({ value: f, label: `📁 ${f}` }))]} /><Select className="!w-48" value={tag} onChange={(e) => setTag(e.target.value)} options={[{ value: '', label: 'Any tag' }, ...tags.map((t) => ({ value: t, label: `#${t}` }))]} /></div>
            <Table head={['Campaign', 'Status', 'Enrolled', 'Sent', 'Replies', 'Reply rate', 'Bounces', 'Unsubs', 'Created']}>
              {rows.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="td"><Link className="font-medium text-brand-700 hover:underline" href={`/w/${ws}/campaigns/${c.id}`}>{c.name}</Link>{c.pauseReason && <div className="text-xs text-amber-700">{c.pauseReason}</div>}<div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-slate-500">{c.folder && <span>📁 {c.folder}</span>}{c.tags?.map((t) => <Badge key={t} color="purple">{t}</Badge>)}<button className="underline" onClick={() => setOrg({ id: c.id, folder: c.folder ?? '', tags: (c.tags ?? []).join(', ') })}>organize</button></div></td>
                  <td className="td"><Badge>{c.status}</Badge></td><td className="td">{c.stats.enrolled}</td><td className="td">{c.stats.sent}</td><td className="td">{c.stats.replied}</td>
                  <td className="td">{c.stats.sent ? `${Math.round((c.stats.replied / c.stats.sent) * 1000) / 10}%` : '—'}</td><td className="td">{c.stats.bounced}</td><td className="td">{c.stats.unsubscribed}</td><td className="td text-xs">{fmtDay(c.createdAt)}</td>
                </tr>
              ))}
            </Table>
          </div>
          );
        }}
      </QueryView>
      <Modal open={!!org} onClose={() => setOrg(null)} title="Folder & tags" footer={<Button loading={organize.isPending} onClick={() => organize.mutate()}>Save</Button>}>
        {org && <><Field label="Folder"><Input value={org.folder} onChange={(e) => setOrg({ ...org, folder: e.target.value })} placeholder="Q1 — US doctors" /></Field><Field label="Tags (comma separated)"><Input value={org.tags} onChange={(e) => setOrg({ ...org, tags: e.target.value })} /></Field><p className="mt-2 text-xs text-slate-500">Organising does not change the campaign’s approval.</p></>}
      </Modal>
      <Modal open={open} onClose={() => setOpen(false)} title="New campaign" footer={<Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create</Button>}>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="UK consultants — podcast growth" /></Field>
      </Modal>
    </>
  );
}
