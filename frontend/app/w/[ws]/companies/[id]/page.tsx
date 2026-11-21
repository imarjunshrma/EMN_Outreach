'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate, fmtMoney, fullName } from '@/lib/format';
import { Badge, Button, Card, Field, Input, PageHeader, QueryView, Table, Textarea } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function CompanyDetail() {
  const ws = useWs();
  const { id } = useParams<{ id: string }>();
  const q = useWsQuery<any>(`/companies/${id}`);
  const [f, setF] = useState({ name: '', website: '', industry: '', employeeCount: '', country: '', city: '', description: '' });
  const [note, setNote] = useState('');
  useEffect(() => { if (q.data) setF({ name: q.data.name ?? '', website: q.data.website ?? '', industry: q.data.industry ?? '', employeeCount: q.data.employeeCount?.toString() ?? '', country: q.data.country ?? '', city: q.data.city ?? '', description: q.data.description ?? '' }); }, [q.data]);
  const save = useWsMutation(() => ({ path: `/companies/${id}`, method: 'PATCH', body: { ...f, employeeCount: f.employeeCount ? Number(f.employeeCount) : null, website: f.website || null, industry: f.industry || null, country: f.country || null, city: f.city || null, description: f.description || null } }), { success: 'Saved' });
  const research = useWsMutation(() => ({ path: `/companies/${id}/research`, body: {} }), { success: 'Research queued' });
  const addNote = useWsMutation(() => ({ path: `/companies/${id}/notes`, body: { body: note } }), { success: 'Note added', onSuccess: () => setNote('') });
  return (
    <QueryView q={q}>
      {(c) => (
        <>
          <PageHeader title={c.name} subtitle={c.domain ?? 'No domain'} actions={<Button variant="secondary" loading={research.isPending} onClick={() => research.mutate()}>Research company</Button>} />
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Profile" className="lg:col-span-2">
              <div className="grid gap-3 md:grid-cols-2">
                {(['name', 'website', 'industry', 'employeeCount', 'country', 'city'] as const).map((k) => <Field key={k} label={k}><Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}
              </div>
              <Field label="Description"><Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
              {c.services?.length > 0 && <p className="mt-2 text-sm"><b>Services (from research):</b> {c.services.join(', ')}</p>}
              {c.audience && <p className="text-sm"><b>Audience:</b> {c.audience}</p>}
              {c.businessModel && <p className="text-sm"><b>Business model:</b> {c.businessModel}</p>}
              <Button className="mt-3" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
            </Card>
            <Card title="Notes">
              <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
              <Button className="mt-2" disabled={!note.trim()} onClick={() => addNote.mutate()}>Add note</Button>
              <ul className="mt-3 space-y-2">{c.notes.map((n: any) => <li key={n.id} className="rounded bg-slate-50 p-2 text-sm">{n.body}<p className="text-xs text-slate-400">{n.author?.name} · {fmtDate(n.createdAt)}</p></li>)}</ul>
            </Card>
            <Card title={`Contacts (${c.leads.length})`} className="lg:col-span-2">
              <Table head={['Name', 'Title', 'Status', 'Score']}>{c.leads.map((l: any) => <tr key={l.id}><td className="td"><Link className="text-brand-700 hover:underline" href={`/w/${ws}/leads/${l.id}`}>{fullName(l)}</Link><div className="text-xs text-slate-500">{l.email}</div></td><td className="td">{l.title ?? '—'}</td><td className="td"><Badge>{l.status}</Badge></td><td className="td">{l.currentScore ?? '—'}</td></tr>)}</Table>
            </Card>
            <Card title="Research & opportunities">
              {c.researchReports.map((r: any) => <div key={r.id} className="mb-2 text-sm"><Link className="text-brand-700 underline" href={`/w/${ws}/research/${r.id}`}>Report {fmtDate(r.createdAt)}</Link> <Badge>{r.status}</Badge> · {r.claims.length} claims</div>)}
              {c.opportunities.map((o: any) => <div key={o.id} className="text-sm">{o.title} <Badge>{o.stage}</Badge> {fmtMoney(o.valueCents, o.currency)}</div>)}
              {c.researchReports.length + c.opportunities.length === 0 && <p className="text-sm text-slate-500">Nothing yet.</p>}
            </Card>
          </div>
        </>
      )}
    </QueryView>
  );
}
