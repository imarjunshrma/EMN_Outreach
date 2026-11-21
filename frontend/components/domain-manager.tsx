'use client';

import { useState } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate, fmtDay } from '@/lib/format';
import { Badge, Button, Card, Checkbox, ConfirmButton, Field, Input, Notice, Select, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Ownership verification, propagation check, recommended records (+ one-click apply via Cloudflare) and renewal tracking. */
export function DomainManager({ domain: d }: { domain: any }) {
  const [ver, setVer] = useState<any>(null);
  const [prop, setProp] = useState<any>(d.propagation ?? null);
  const rec = useWsQuery<any>(`/domains/${d.id}/recommended-records`);
  const integrations = useWsQuery<any[]>('/integrations');
  const cfConnected = (integrations.data ?? []).some((i: any) => i.type === 'cloudflare' && i.configured);
  const start = useWsMutation(() => ({ path: `/domains/${d.id}/verification`, body: {} }), { onSuccess: (r: any) => setVer(r) });
  const check = useWsMutation(() => ({ path: `/domains/${d.id}/verification/check`, body: {} }), { success: (r: any) => (r.verified ? 'Domain verified' : 'TXT record not found yet — DNS can take up to an hour') });
  const propagate = useWsMutation(() => ({ path: `/domains/${d.id}/propagation`, body: {} }), { onSuccess: (r: any) => setProp(r) });
  const apply = useWsMutation<{ type: string; name: string; content: string }>((b) => ({ path: `/domains/${d.id}/dns-records`, body: b }), { success: 'Record created at Cloudflare' });
  const [ren, setRen] = useState({ registrar: d.registrar ?? '', expiresAt: d.expiresAt ? String(d.expiresAt).slice(0, 10) : '', autoRenew: !!d.autoRenew });
  const registrarOptions = ['Cloudflare', 'GoDaddy', 'Namecheap', 'Squarespace Domains', 'Porkbun', 'Amazon Route 53', 'Other'];
  const [customRegistrar, setCustomRegistrar] = useState(!!d.registrar && !registrarOptions.slice(0, -1).includes(d.registrar));
  const saveRen = useWsMutation(() => ({ path: `/domains/${d.id}/renewal`, method: 'PATCH', body: { registrar: ren.registrar || null, expiresAt: ren.expiresAt || null, autoRenew: ren.autoRenew } }), { success: 'Renewal details saved' });
  return (
    <div className="mb-4 grid gap-4 lg:grid-cols-3">
      <Card title={<>Ownership {d.verifiedAt ? <Badge color="green">verified</Badge> : <Badge color="yellow">not verified</Badge>}</>}>
        {d.verifiedAt ? <p className="text-sm">Verified {fmtDate(d.verifiedAt)}.</p> : (
          <>
            {ver ? <Notice>Add <b>TXT</b> <code className="break-all">{ver.record.name}</code> with value <code className="break-all">{ver.record.value}</code>, then click Verify.</Notice> : <p className="text-sm text-slate-600">Prove this workspace controls {d.name} with a DNS TXT record.</p>}
            <div className="mt-2 flex gap-2"><Button variant="secondary" loading={start.isPending} onClick={() => start.mutate()}>{ver ? 'Show record again' : 'Start verification'}</Button><Button loading={check.isPending} onClick={() => check.mutate()}>Verify</Button></div>
          </>
        )}
      </Card>
      <Card title="DNS propagation" actions={<Button variant="secondary" loading={propagate.isPending} onClick={() => propagate.mutate()}>Check now</Button>}>
        {prop ? (
          <>
            <p className="mb-2 text-xs text-slate-500">Checked {fmtDate(prop.checkedAt)} · SPF {prop.spfConsistent ? <Badge color="green">consistent</Badge> : <Badge color="yellow">differs</Badge>} DMARC {prop.dmarcConsistent ? <Badge color="green">consistent</Badge> : <Badge color="yellow">differs</Badge>}</p>
            <ul className="space-y-1 text-xs">{prop.results.map((r: any) => <li key={r.resolver}><b>{r.resolver}</b>: SPF {r.spf ? '✓' : '—'} · DMARC {r.dmarc ? '✓' : '—'} · verify {r.verification ? '✓' : '—'}</li>)}</ul>
          </>
        ) : <p className="text-sm text-slate-600">Compare what Cloudflare, Google and Quad9 resolvers see.</p>}
      </Card>
      <Card title="Registrar & renewal">
        <Field label="Registrar"><Select value={customRegistrar ? '__other__' : ren.registrar} onChange={(e) => { if (e.target.value === '__other__') { setCustomRegistrar(true); if (!customRegistrar) setRen({ ...ren, registrar: '' }); } else { setCustomRegistrar(false); setRen({ ...ren, registrar: e.target.value }); } }} options={[{ value: '', label: 'Choose a registrar…' }, ...registrarOptions.slice(0, -1).map((x) => ({ value: x, label: x })), { value: '__other__', label: 'Other' }]} />{customRegistrar && <Input className="mt-2" value={ren.registrar} onChange={(e) => setRen({ ...ren, registrar: e.target.value })} placeholder="Enter registrar name" />}</Field>
        <Field label="Expires on"><Input type="date" value={ren.expiresAt} onChange={(e) => setRen({ ...ren, expiresAt: e.target.value })} /></Field>
        <Checkbox label="Auto-renew is on at the registrar" checked={ren.autoRenew} onChange={(v) => setRen({ ...ren, autoRenew: v })} />
        <Button className="mt-2" variant="secondary" loading={saveRen.isPending} onClick={() => saveRen.mutate()}>Save</Button>
        <p className="mt-1 text-xs text-slate-500">Admins are reminded weekly in the 30 days before expiry unless auto-renew is on. {d.expiresAt && <>Expires {fmtDay(d.expiresAt)}.</>}</p>
      </Card>
      <Card title="Recommended DNS records" className="lg:col-span-3">
        {!cfConnected && <div className="mb-2"><Notice>Add these at your DNS provider. Connect Cloudflare under Integrations to create them from here, one at a time, with your confirmation.</Notice></div>}
        {rec.data && <Table head={['Type', 'Name', 'Value', 'Purpose', '']}>{rec.data.records.map((r: any) => {
          const placeholder = r.value.startsWith('(') || r.value.includes('<');
          return <tr key={`${r.type}-${r.name}`}><td className="td">{r.type}</td><td className="td break-all font-mono text-xs">{r.name}</td><td className="td break-all font-mono text-xs">{r.value}</td><td className="td text-xs">{r.purpose}</td><td className="td">{cfConnected && !placeholder && <ConfirmButton variant="secondary" confirm={`Create ${r.type} ${r.name} at Cloudflare?`} onConfirm={() => apply.mutate({ type: r.type, name: r.name, content: r.value })}>Create</ConfirmButton>}</td></tr>;
        })}</Table>}
      </Card>
    </div>
  );
}
