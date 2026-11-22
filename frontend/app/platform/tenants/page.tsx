'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building, Search } from 'lucide-react';
import { api, describeError, qs } from '@/lib/api';
import { useToast } from '@/components/toast';
import { usePlatform } from '@/components/platform/shell';
import { SetupLinkNotice, type SetupResult } from '@/components/platform/setup-link';
import { fmtDate } from '@/lib/format';
import { STATUSES, statusColor } from '@/components/platform/status';
import { Badge, Button, ErrorState, Field, Input, Loading, Modal, PageHeader, Pagination, Select, Table, Textarea } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function Tenants() {
  const me = usePlatform();
  const [f, setF] = useState({ q: '', status: '', plan: '', page: 1 });
  const q = useQuery({ queryKey: ['platform-tenants', f], queryFn: () => api<any>(`/platform/tenants${qs({ q: f.q, status: f.status, plan: f.plan, page: f.page })}`) });
  return (
    <>
      <PageHeader title="Tenants" subtitle="Every customer organization. Opening a tenant is recorded in the platform audit trail." actions={me.permissions.includes('tenants:lifecycle') ? <NewTenant /> : undefined} />
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="min-w-[240px] flex-1"><Input icon={Search} placeholder="Name, slug or owner email" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} aria-label="Search tenants" /></div>
        <Select className="!w-auto" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} options={[{ value: '', label: 'All statuses (not deleted)' }, ...STATUSES.map((s) => ({ value: s, label: s.toLowerCase().replace(/_/g, ' ') }))]} aria-label="Status" />
        <Input className="!w-36" placeholder="Plan code" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value, page: 1 })} aria-label="Plan code" />
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : (
        <>
          <Table head={['Organization', 'Status', 'Plan', 'Owner', 'Members', 'Workspaces', 'Created']}>
            {q.data.data.map((t: any) => (
              <tr key={t.id}>
                <td className="td"><Link className="font-semibold hover:underline" href={`/platform/tenants/${t.id}`}>{t.name}</Link><p className="text-xs text-slate-500">{t.slug}</p></td>
                <td className="td"><Badge color={statusColor(t.status)}>{t.status.toLowerCase().replace(/_/g, ' ')}</Badge></td>
                <td className="td text-xs">{t.plan ?? '—'}{t.subscriptionStatus && <span className="block text-slate-500">{t.subscriptionStatus.toLowerCase()}</span>}</td>
                <td className="td text-xs">{t.owner?.email ?? '—'}</td>
                <td className="td tnum">{t.members}</td><td className="td tnum">{t.workspaces}</td>
                <td className="td text-xs">{fmtDate(t.createdAt)}</td>
              </tr>
            ))}
          </Table>
          {q.data.data.length === 0 && <p className="mt-4 text-center text-sm text-slate-500">No tenants match these filters.</p>}
          <div className="mt-3"><Pagination page={q.data.page} totalPages={q.data.totalPages} total={q.data.total} onPage={(page) => setF({ ...f, page })} /></div>
        </>
      )}
    </>
  );
}

/** Staff-created tenant: works even when public sign-up is closed. A new owner gets a set-password link. */
function NewTenant() {
  const router = useRouter(); const toast = useToast(); const qc = useQueryClient();
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ organizationName: '', ownerEmail: '', ownerName: '', planCode: '', reason: '' });
  const [done, setDone] = useState<{ organizationId: string; ownerCreated: boolean; setup: SetupResult } | null>(null);
  const plans = useQuery({ queryKey: ['platform-plans'], queryFn: () => api<any[]>('/platform/plans'), enabled: open });
  const close = () => { setOpen(false); setDone(null); setF({ organizationName: '', ownerEmail: '', ownerName: '', planCode: '', reason: '' }); };
  async function create() {
    setBusy(true);
    try {
      const r = await api<any>('/platform/tenants', { body: { ...f, ownerName: f.ownerName || undefined, planCode: f.planCode || undefined } });
      void qc.invalidateQueries({ queryKey: ['platform-tenants'] });
      if (r.setup && !r.setup.mailed) setDone(r); else { toast.success(r.ownerCreated ? 'Tenant created and the owner was emailed a set-password link' : 'Tenant created for the existing account'); close(); router.push(`/platform/tenants/${r.organizationId}`); }
    } catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <Button icon={Building} onClick={() => setOpen(true)}>New tenant</Button>
      <Modal open={open} title={done ? 'Tenant created' : 'New tenant'} onClose={close}
        footer={done ? <><Button variant="ghost" onClick={close}>Close</Button><Button onClick={() => { const id = done.organizationId; close(); router.push(`/platform/tenants/${id}`); }}>Open tenant</Button></>
          : <><Button variant="ghost" onClick={close}>Back</Button><Button loading={busy} disabled={f.organizationName.trim().length < 2 || !f.ownerEmail.includes('@') || f.reason.trim().length < 5} onClick={create}>Create tenant</Button></>}>
        {done ? <SetupLinkNotice setup={done.setup} email={f.ownerEmail} /> : <>
          <Field label="Organization name"><Input value={f.organizationName} onChange={(e) => setF({ ...f, organizationName: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Owner email" hint="An existing account becomes owner; otherwise we create one."><Input type="email" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} /></Field>
            <Field label="Owner name (optional)"><Input value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></Field>
          </div>
          <Field label="Plan" hint="Only used when billing is on."><Select value={f.planCode} onChange={(e) => setF({ ...f, planCode: e.target.value })} options={[{ value: '', label: 'Default trial plan' }, ...(plans.data ?? []).filter((p) => !p.archivedAt).map((p) => ({ value: p.code, label: p.name }))]} /></Field>
          <Field label="Reason" hint="Required; recorded in the platform audit trail."><Textarea rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        </>}
      </Modal>
    </>
  );
}
