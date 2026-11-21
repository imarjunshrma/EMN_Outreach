'use client';

import { useState } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { ROLES } from '@/lib/constants';
import { Badge, Button, Card, ConfirmButton, Empty, Field, Input, Notice, PageHeader, QueryView, Select, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function ApiKeys() {
  const q = useWsQuery<any[]>('/api-keys');
  const [f, setF] = useState({ name: '', role: 'MEMBER', expiresInDays: '', scopes: '' });
  const [token, setToken] = useState<string | null>(null);
  const create = useWsMutation(() => ({ path: '/api-keys', body: { name: f.name, role: f.role, expiresInDays: f.expiresInDays ? Number(f.expiresInDays) : undefined, scopes: f.scopes.trim() ? f.scopes.split(/[\s,]+/).filter(Boolean) : undefined } }), { onSuccess: (r: any) => { setToken(r.token); setF({ ...f, name: '', scopes: '' }); } });
  const revoke = useWsMutation<string>((id) => ({ path: `/api-keys/${id}`, method: 'DELETE' }), { success: 'Revoked' });
  return (
    <>
      <PageHeader title="API keys" subtitle="Keys let other systems call the EMN API (Authorization: Bearer emn_…). A key acts with the role you give it, only inside this workspace. See API_DOCUMENTATION.md and /api/v1/openapi.json." />
      {token && <div className="mb-4"><Notice kind="warning"><b>Copy this key now — it will not be shown again:</b><div className="mt-1 break-all rounded bg-white p-2 font-mono text-xs">{token}</div><Button variant="secondary" className="mt-2" onClick={() => { void navigator.clipboard.writeText(token); }}>Copy</Button> <Button variant="ghost" onClick={() => setToken(null)}>Done</Button></Notice></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Create key">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Zapier" /></Field>
          <Field label="Role"><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} options={ROLES.filter((r) => r !== 'OWNER')} /></Field>
          <Field label="Scopes (optional)" hint="Limit the key further than its role, e.g. leads:read campaigns:write. Format <area>:read|write, *:read or *. Blank = everything the role allows."><Input value={f.scopes} onChange={(e) => setF({ ...f, scopes: e.target.value })} placeholder="leads:read inbox:read" /></Field>
          <Field label="Expires in days (optional)"><Input type="number" value={f.expiresInDays} onChange={(e) => setF({ ...f, expiresInDays: e.target.value })} /></Field>
          <Button className="mt-3" disabled={!f.name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create key</Button>
        </Card>
        <div className="lg:col-span-2"><QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No API keys" />}>
          {(rows) => <div className="card p-2"><Table head={['Name', 'Prefix', 'Role', 'Scopes', 'Last used', 'Expires', 'Status', '']}>{rows.map((k) => <tr key={k.id}><td className="td">{k.name}</td><td className="td font-mono text-xs">emn_{k.prefix}_…</td><td className="td"><Badge>{k.role}</Badge></td><td className="td text-xs">{k.scopes?.length ? k.scopes.join(' ') : 'all (role)'}</td><td className="td text-xs">{fmtDate(k.lastUsedAt)}</td><td className="td text-xs">{fmtDate(k.expiresAt)}</td><td className="td">{k.revokedAt ? <Badge color="red">revoked</Badge> : <Badge color="green">active</Badge>}</td><td className="td">{!k.revokedAt && <ConfirmButton variant="ghost" confirm="Revoke this key?" onConfirm={() => revoke.mutate(k.id)}>Revoke</ConfirmButton>}</td></tr>)}</Table></div>}
        </QueryView></div>
      </div>
    </>
  );
}
