'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader, QueryView, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Enrichment() {
  const ws = useWs();
  const settings = useWsQuery<any>('');
  const stats = useWsQuery<any[]>('/enrichment/stats?days=90');
  const [f, setF] = useState({ firstName: '', lastName: '', domain: '' });
  const [found, setFound] = useState<any>(null);
  const find = useWsMutation(() => ({ path: '/enrichment/find-email', body: f }), { invalidate: false, onSuccess: (r: any) => setFound(r) });
  const s = settings.data?.settings;
  return (
    <>
      <PageHeader title="Verification & enrichment" subtitle="Email verification runs through a waterfall of providers until one gives a definitive answer. Recently verified leads are skipped to save credits." actions={<Link href={`/w/${ws}/settings/policies`}><Button variant="secondary">Change provider order</Button></Link>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Current waterfall">
          {s ? <ol className="list-decimal space-y-1 pl-5 text-sm">{s.verifierOrder.map((v: string) => <li key={v}>{v}</li>)}</ol> : null}
          <p className="mt-2 text-xs text-slate-500">Disposable-domain addresses are rejected before any paid check. Bulk: select leads on the Leads page and choose “Verify”. Single lead: “Verify email” on the lead profile.</p>
          <p className="mt-1 text-xs text-slate-500">Keys are added under <Link className="underline" href={`/w/${ws}/settings/integrations`}>Integrations</Link>.</p>
        </Card>
        <Card title="Find an email address" className="lg:col-span-2">
          <div className="grid gap-2 md:grid-cols-3">
            <Field label="First name"><Input value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></Field>
            <Field label="Last name"><Input value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Field>
            <Field label="Company domain"><Input value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} placeholder="clinic.com" /></Field>
          </div>
          <Button className="mt-2" disabled={!f.firstName || !f.lastName || !f.domain} loading={find.isPending} onClick={() => find.mutate()}>Find</Button>
          {found && <div className="mt-3">{found.email ? <Notice><b>{found.email}</b> — {found.confidence}% confidence via {found.source}. {found.note}</Notice> : <Notice kind="warning">No address found ({found.attempts?.map((a: any) => `${a.provider}: ${a.outcome ?? a.error ?? 'none'}`).join(', ') || 'no finder configured'}).</Notice>}</div>}
        </Card>
        <Card title="Provider comparison (last 90 days)" className="lg:col-span-3">
          <QueryView q={stats} isEmpty={(d) => d.length === 0} empty={<Empty title="No verifications yet" />}>
            {(rows) => <Table head={['Provider', 'Checks', 'Definitive', 'Credits', 'Results']}>{rows.map((p) => <tr key={p.provider}><td className="td">{p.provider}</td><td className="td">{p.checks}</td><td className="td">{p.definitiveRatePct}%</td><td className="td">{p.credits}</td><td className="td text-xs">{Object.entries(p.results).map(([k, v]) => <span key={k} className="mr-2"><Badge>{k}</Badge> {String(v)}</span>)}</td></tr>)}</Table>}
          </QueryView>
        </Card>
      </div>
    </>
  );
}
