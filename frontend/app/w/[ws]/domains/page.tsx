'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, ConfirmButton, Empty, Field, Input, PageHeader, QueryView, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Domains() {
  const ws = useWs();
  const q = useWsQuery<any[]>('/domains');
  const [name, setName] = useState('');
  const [sel, setSel] = useState('');
  const add = useWsMutation(() => ({ path: '/domains', body: { name, dkimSelectors: sel ? sel.split(',').map((s) => s.trim()).filter(Boolean) : undefined } }), { success: 'Domain added — check running', onSuccess: () => setName('') });
  const check = useWsMutation<string>((id) => ({ path: `/domains/${id}/check`, body: {} }), { success: 'Check complete' });
  const del = useWsMutation<string>((id) => ({ path: `/domains/${id}`, method: 'DELETE' }), { success: 'Removed' });
  return (
    <>
      <PageHeader title="Sending domains" subtitle="SPF, DKIM, DMARC and MX checks for the domains you send from. These are configuration checks; passing them does not guarantee inbox placement." />
      <div className="grid gap-4 lg:grid-cols-4">
        <Card title="Add domain">
          <Field label="Domain"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="yourdomain.com" /></Field>
          <Field label="DKIM selectors (optional)" hint="Google: google · Microsoft: selector1, selector2"><Input value={sel} onChange={(e) => setSel(e.target.value)} /></Field>
          <Button className="mt-3" disabled={!name.trim()} loading={add.isPending} onClick={() => add.mutate()}>Add & check</Button>
        </Card>
        <div className="lg:col-span-3">
          <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No domains">Domains are added automatically when you connect a mailbox.</Empty>}>
            {(rows) => <div className="card p-2"><Table head={['Domain', 'Health', 'SPF', 'DKIM', 'DMARC', 'MX', 'Mailboxes', 'Checked', '']}>{rows.map((d) => <tr key={d.id}><td className="td"><Link className="font-medium text-brand-700 hover:underline" href={`/w/${ws}/domains/${d.id}`}>{d.name}</Link></td><td className="td"><Badge>{d.healthStatus}</Badge></td><td className="td"><Badge>{d.spfStatus}</Badge></td><td className="td"><Badge>{d.dkimStatus}</Badge></td><td className="td"><Badge>{d.dmarcStatus}</Badge></td><td className="td"><Badge>{d.mxStatus}</Badge></td><td className="td">{d._count.emailAccounts}</td><td className="td text-xs">{fmtDate(d.lastCheckedAt)}</td><td className="td whitespace-nowrap"><Button variant="ghost" loading={check.isPending} onClick={() => check.mutate(d.id)}>Check now</Button><ConfirmButton variant="ghost" confirm="Remove domain?" onConfirm={() => del.mutate(d.id)}>✕</ConfirmButton></td></tr>)}</Table></div>}
          </QueryView>
        </div>
      </div>
    </>
  );
}
