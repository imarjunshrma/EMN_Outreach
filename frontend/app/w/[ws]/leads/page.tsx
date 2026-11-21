'use client';

import Link from 'next/link';
import { useState } from 'react';
import { SavedFilters } from '@/components/saved-filters';
import { qs, type Paged } from '@/lib/api';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDay, fullName } from '@/lib/format';
import { Badge, Button, Empty, Field, Input, Modal, PageHeader, Pagination, QueryView, Select, Table } from '@/components/ui';

import { LEAD_STATUSES, LAWFUL_BASES as BASES } from '@/lib/constants';

interface Lead { id: string; email: string; firstName: string | null; lastName: string | null; title: string | null; status: string; emailVerificationStatus: string; currentScore: number | null; country: string | null; createdAt: string; company: { id: string; name: string } | null; source: { name: string } | null; tags: string[] }

export default function LeadsPage() {
  const ws = useWs();
  const [f, setF] = useState({ q: '', status: '', listId: '', verification: '', minScore: '', country: '', sort: 'createdAt', page: 1 });
  const [selected, setSelected] = useState<string[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [bulk, setBulk] = useState({ action: 'add_to_list', listId: '', tag: '', status: 'QUALIFIED', lawfulBasis: 'LEGITIMATE_INTEREST', icpId: '' });
  const query = qs({ ...f, pageSize: 50 });
  const q = useWsQuery<Paged<Lead>>(`/leads${query}`);
  const lists = useWsQuery<Array<{ id: string; name: string; memberCount: number }>>('/lists');
  const icps = useWsQuery<Array<{ id: string; name: string }>>('/icps');
  const run = useWsMutation<void, { affected?: number; queued?: number }>(() => ({ path: '/leads/bulk', body: { ids: selected, ...bulk, listId: bulk.listId || undefined, icpId: bulk.icpId || undefined } }), {
    success: (r) => (r.queued !== undefined ? `${r.queued} queued` : `${r.affected ?? 0} updated`), onSuccess: () => setSelected([]),
  });
  const set = (k: keyof typeof f, v: string | number) => setF({ ...f, [k]: v, page: k === 'page' ? Number(v) : 1 });

  return (
    <>
      <PageHeader title="Leads" subtitle="Your contact database. Filter, research, score, verify and add leads to lists for campaigns."
        actions={<><Link className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" href={`/w/${ws}/leads/lists`}>Lists</Link><a className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" href={`/api/v1/w/${ws}/leads/export${query}`}>Export CSV</a><Link className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" href={`/w/${ws}/leads/import`}>Import CSV</Link><Button onClick={() => setShowNew(true)}>Add lead</Button></>} />
      <div className="card mb-4 grid gap-3 p-3 md:grid-cols-7">
        <Input placeholder="Search name, email, company" value={f.q} onChange={(e) => set('q', e.target.value)} className="md:col-span-2" />
        <Select value={f.status} onChange={(e) => set('status', e.target.value)} options={[{ value: '', label: 'Any status' }, ...LEAD_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ').toLowerCase() }))]} />
        <Select value={f.listId} onChange={(e) => set('listId', e.target.value)} options={[{ value: '', label: 'Any list' }, ...(lists.data ?? []).map((l) => ({ value: l.id, label: `${l.name} (${l.memberCount})` }))]} />
        <Select value={f.verification} onChange={(e) => set('verification', e.target.value)} options={[{ value: '', label: 'Any verification' }, ...['UNVERIFIED', 'VALID', 'INVALID', 'RISKY', 'CATCH_ALL', 'UNKNOWN'].map((s) => ({ value: s, label: s.toLowerCase() }))]} />
        <Input placeholder="Min score" type="number" value={f.minScore} onChange={(e) => set('minScore', e.target.value)} />
        <Select value={f.sort} onChange={(e) => set('sort', e.target.value)} options={[{ value: 'createdAt', label: 'Newest' }, { value: 'score', label: 'Highest score' }, { value: 'lastRepliedAt', label: 'Last reply' }, { value: 'email', label: 'Email A–Z' }]} />
        <div className="md:col-span-7"><SavedFilters entity="leads" current={f} onApply={(q) => setF({ q: '', status: '', listId: '', verification: '', minScore: '', country: '', sort: 'createdAt', ...q, page: 1 })} /></div>
      </div>
      {selected.length > 0 && (
        <div className="card mb-4 flex flex-wrap items-end gap-3 p-3">
          <span className="text-sm font-medium">{selected.length} selected</span>
          <Select value={bulk.action} onChange={(e) => setBulk({ ...bulk, action: e.target.value })} className="w-48" options={[{ value: 'add_to_list', label: 'Add to list' }, { value: 'remove_from_list', label: 'Remove from list' }, { value: 'research', label: 'Research (AI)' }, { value: 'score', label: 'Score vs ICP (AI)' }, { value: 'verify', label: 'Verify emails' }, { value: 'add_tag', label: 'Add tag' }, { value: 'set_status', label: 'Set status' }, { value: 'set_lawful_basis', label: 'Set lawful basis' }, { value: 'delete', label: 'Delete' }]} />
          {(bulk.action === 'add_to_list' || bulk.action === 'remove_from_list') && <Select className="w-48" value={bulk.listId} onChange={(e) => setBulk({ ...bulk, listId: e.target.value })} options={[{ value: '', label: 'Choose list…' }, ...(lists.data ?? []).map((l) => ({ value: l.id, label: l.name }))]} />}
          {bulk.action === 'add_tag' && <Input className="w-40" placeholder="tag" value={bulk.tag} onChange={(e) => setBulk({ ...bulk, tag: e.target.value })} />}
          {bulk.action === 'set_status' && <Select className="w-48" value={bulk.status} onChange={(e) => setBulk({ ...bulk, status: e.target.value })} options={LEAD_STATUSES} />}
          {bulk.action === 'set_lawful_basis' && <Select className="w-56" value={bulk.lawfulBasis} onChange={(e) => setBulk({ ...bulk, lawfulBasis: e.target.value })} options={BASES} />}
          {bulk.action === 'score' && <Select className="w-48" value={bulk.icpId} onChange={(e) => setBulk({ ...bulk, icpId: e.target.value })} options={[{ value: '', label: 'Default ICP' }, ...(icps.data ?? []).map((i) => ({ value: i.id, label: i.name }))]} />}
          <Button variant={bulk.action === 'delete' ? 'danger' : 'primary'} loading={run.isPending} onClick={() => (bulk.action !== 'delete' || window.confirm(`Delete ${selected.length} leads?`)) && run.mutate()}>Apply</Button>
          <Button variant="ghost" onClick={() => setSelected([])}>Clear</Button>
        </div>
      )}
      <QueryView q={q} isEmpty={(d) => d.total === 0} empty={<Empty title="No leads match" action={<Link className="text-brand-700 underline" href={`/w/${ws}/prospecting`}>Discover prospects</Link>}>Import a CSV, add a lead manually or search a connected data provider.</Empty>}>
        {(d) => (
          <div className="card p-2">
            <Table head={[<input key="all" type="checkbox" aria-label="Select all" checked={d.data.length > 0 && d.data.every((l) => selected.includes(l.id))} onChange={(e) => setSelected(e.target.checked ? d.data.map((l) => l.id) : [])} />, 'Name', 'Company', 'Status', 'Email', 'Score', 'Country', 'Source', 'Added']}>
              {d.data.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50">
                  <td className="td"><input type="checkbox" aria-label={`Select ${l.email}`} checked={selected.includes(l.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, l.id] : selected.filter((x) => x !== l.id))} /></td>
                  <td className="td"><Link className="font-medium text-brand-700 hover:underline" href={`/w/${ws}/leads/${l.id}`}>{fullName(l)}</Link><div className="text-xs text-slate-500">{l.email}</div>{l.title && <div className="text-xs text-slate-400">{l.title}</div>}</td>
                  <td className="td">{l.company ? <Link className="hover:underline" href={`/w/${ws}/companies/${l.company.id}`}>{l.company.name}</Link> : '—'}</td>
                  <td className="td"><Badge>{l.status}</Badge></td>
                  <td className="td"><Badge>{l.emailVerificationStatus}</Badge></td>
                  <td className="td">{l.currentScore ?? '—'}</td>
                  <td className="td">{l.country ?? '—'}</td>
                  <td className="td text-xs">{l.source?.name ?? 'manual'}</td>
                  <td className="td text-xs">{fmtDay(l.createdAt)}</td>
                </tr>
              ))}
            </Table>
            <Pagination page={d.page} totalPages={d.totalPages} total={d.total} onPage={(p) => set('page', p)} />
          </div>
        )}
      </QueryView>
      <NewLead open={showNew} onClose={() => setShowNew(false)} />
    </>
  );
}

function NewLead({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [f, setF] = useState({ email: '', firstName: '', lastName: '', title: '', companyName: '', companyDomain: '', country: '', timezone: '', lawfulBasis: 'LEGITIMATE_INTEREST', lawfulBasisNote: '' });
  const m = useWsMutation(() => ({ path: '/leads', body: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')) }), { success: 'Lead created', onSuccess: () => { onClose(); setF({ ...f, email: '', firstName: '', lastName: '' }); } });
  const field = (k: keyof typeof f, label: string, hint?: string) => <Field label={label} hint={hint}><Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>;
  return (
    <Modal open={open} onClose={onClose} title="Add lead" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {field('email', 'Email *')}{field('title', 'Title')}{field('firstName', 'First name')}{field('lastName', 'Last name')}
        {field('companyName', 'Company')}{field('companyDomain', 'Company domain')}{field('country', 'Country (ISO-2)', 'e.g. US, GB, IN — drives compliance rules')}{field('timezone', 'Time zone', 'IANA, e.g. America/New_York')}
        <Field label="Lawful basis"><Select value={f.lawfulBasis} onChange={(e) => setF({ ...f, lawfulBasis: e.target.value })} options={BASES} /></Field>
        {field('lawfulBasisNote', 'Basis note', 'Why you may contact this person')}
      </div>
    </Modal>
  );
}
