'use client';

import { useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, Checkbox, Field, Input, Notice, PageHeader, QueryView } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Integrations() {
  const ws = useWs();
  const q = useWsQuery<any[]>('/integrations');
  return (
    <>
      <PageHeader title="Provider integrations" subtitle="Licensed data providers, verification, web search, optional Smartlead export and booking webhooks. Secrets are encrypted and never displayed after saving. Select which providers are active in System settings." />
      <div className="mb-4"><Notice kind="warning">Each adapter is implemented against the provider’s public API and tested with mocks. Use “Test” after adding a real key; vendor endpoints can change, so verify against their current API documentation.</Notice></div>
      <QueryView q={q}>{(rows) => <div className="grid gap-4 lg:grid-cols-2">{rows.map((i) => <IntegrationCard key={i.type} i={i} ws={ws} />)}</div>}</QueryView>
    </>
  );
}

function IntegrationCard({ i, ws }: { i: any; ws: string }) {
  const [secret, setSecret] = useState('');
  const [pub, setPub] = useState<Record<string, string>>(i.publicConfig ?? {});
  const [enabled, setEnabled] = useState<boolean>(i.configured ? i.isEnabled : true);
  const save = useWsMutation(() => ({ path: '/integrations', method: 'PUT', body: { type: i.type, ...(secret ? { secret } : {}), publicConfig: pub, isEnabled: enabled } }), { success: 'Saved', onSuccess: () => setSecret('') });
  const test = useWsMutation(() => ({ path: `/integrations/${i.type}/test`, body: {} }), { success: (r: any) => (r.ok ? 'Connection OK' : `Failed: ${r.error}`) });
  const del = useWsMutation(() => ({ path: `/integrations/${i.type}`, method: 'DELETE' }), { success: 'Removed' });
  return (
    <Card title={<>{i.label} <span className="text-xs font-normal text-slate-500">· {i.category}</span> {i.configured ? <Badge color="green">configured</Badge> : <Badge>not configured</Badge>}</>}>
      <p className="mb-3 text-sm text-slate-600">{i.docs}</p>
      {i.type === 'booking' && <p className="mb-2 rounded bg-slate-50 p-2 font-mono text-xs">POST {typeof window !== 'undefined' ? window.location.origin : ''}/api/v1/hooks/booking/{ws}</p>}
      <Field label={i.configured ? `Replace ${i.secretLabel} (blank = keep)` : i.secretLabel}><Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>
      {i.publicFields.map((k: string) => <Field key={k} label={k} hint={k === 'searchPath' ? 'Default /mixed_people/api_search — change only if Apollo changes its endpoint' : undefined}><Input value={pub[k] ?? ''} onChange={(e) => setPub({ ...pub, [k]: e.target.value })} /></Field>)}
      <div className="mt-2"><Checkbox label="Enabled" checked={enabled} onChange={setEnabled} /></div>
      {i.lastTestedAt && <p className="mt-2 text-xs">{i.lastTestOk ? '✅' : '❌'} tested {fmtDate(i.lastTestedAt)} {i.lastError && <span className="text-red-600">{i.lastError}</span>}</p>}
      <div className="mt-3 flex gap-2"><Button disabled={!i.configured && !secret} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>{i.configured && <Button variant="secondary" loading={test.isPending} onClick={() => test.mutate()}>Test</Button>}{i.configured && <Button variant="ghost" onClick={() => window.confirm('Remove?') && del.mutate()}>Remove</Button>}</div>
    </Card>
  );
}
