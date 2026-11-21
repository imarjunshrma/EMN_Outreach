'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, describeError, qs } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { Button, Card, ErrorState, Field, Loading, Notice, PageHeader, Select, Table, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Support() {
  const toast = useToast(); const qc = useQueryClient();
  const grants = useQuery({ queryKey: ['platform-grants'], queryFn: () => api<any[]>('/platform/support/grants'), refetchInterval: 60_000 });
  const tenants = useQuery({ queryKey: ['platform-tenants-all'], queryFn: () => api<any>(`/platform/tenants${qs({ pageSize: 100 })}`) });
  const [f, setF] = useState({ organizationId: '', reason: '', minutes: 60 }); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  async function create() {
    setBusy(true); setErr('');
    try { await api('/platform/support/grants', { body: f }); toast.success('Read-only access opened'); setF({ organizationId: '', reason: '', minutes: 60 }); void qc.invalidateQueries({ queryKey: ['platform-grants'] }); }
    catch (e) { setErr(describeError(e)); } finally { setBusy(false); }
  }
  async function revoke(id: string) { try { await api(`/platform/support/grants/${id}`, { method: 'DELETE' }); void qc.invalidateQueries({ queryKey: ['platform-grants'] }); } catch (e) { toast.error(describeError(e)); } }
  return (
    <>
      <PageHeader title="Support access" subtitle="Time-limited, read-only access to one tenant's workspaces. The customer sees each grant in their audit log, and every page you open is recorded." />
      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Card title="Open access">
          {err && <div className="mb-3"><Notice kind="danger">{err}</Notice></div>}
          <Field label="Tenant">{tenants.isLoading ? <Loading /> : <Select value={f.organizationId} onChange={(e) => setF({ ...f, organizationId: e.target.value })} options={[{ value: '', label: 'Choose a tenant…' }, ...(tenants.data?.data ?? []).map((t: any) => ({ value: t.id, label: `${t.name} (${t.owner?.email ?? t.slug})` }))]} />}</Field>
          <Field label="Reason" hint="Ticket number and what you need to look at. At least 10 characters."><Textarea rows={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          <Field label="Duration"><Select value={String(f.minutes)} onChange={(e) => setF({ ...f, minutes: Number(e.target.value) })} options={[['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour'], ['120', '2 hours'], ['240', '4 hours']].map(([value, label]) => ({ value, label }))} /></Field>
          <Button loading={busy} disabled={!f.organizationId || f.reason.trim().length < 10} onClick={create}>Open read-only access</Button>
        </Card>
        <Card title="My active grants">
          {grants.isLoading ? <Loading /> : grants.error ? <ErrorState error={grants.error} /> : grants.data!.length === 0 ? <p className="text-sm text-slate-500">No active grants.</p> : (
            <Table head={['Tenant', 'Expires', 'Workspaces', '']}>
              {grants.data!.map((g) => <tr key={g.id}><td className="td"><b>{g.organization.name}</b><p className="text-xs text-slate-500">{g.reason}</p></td><td className="td text-xs">{fmtDate(g.expiresAt)}</td><td className="td text-xs">{g.organization.workspaces.map((w: any) => <Link key={w.id} className="mr-2 font-semibold text-brand-700 underline" href={`/w/${w.id}`}>{w.name}</Link>)}</td><td className="td text-right"><Button size="sm" variant="ghost" onClick={() => revoke(g.id)}>End now</Button></td></tr>)}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
