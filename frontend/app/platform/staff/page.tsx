'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { api, describeError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, ErrorState, Field, Input, Loading, Modal, Notice, PageHeader, Select, Table, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { usePlatform } from '@/components/platform/shell';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Staff = { id: string; email: string; name: string; platformRole: string; mfaEnabled: boolean; status: string; lastLoginAt: string | null };
type Data = { staff: Staff[]; roles: Array<{ role: string; permissions: string[] }> };

const label = (r: string) => r.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const PERM_LABEL: Record<string, string> = {
  'tenants:read': 'See tenants, users and usage', 'tenants:lifecycle': 'Create, suspend and change tenants and their members',
  'plans:write': 'Create and edit plans', 'billing:read': 'See invoices and payments', 'billing:refund': 'Issue refunds',
  'support:access': 'Open a customer workspace (read-only, time-limited)', 'audit:read': 'Read the platform audit trail',
  'metrics:read': 'See platform metrics and operations', 'staff:manage': 'Manage staff and their roles', 'settings:write': 'Change global settings',
  'users:manage': 'Edit accounts, reset two-factor, sign people out', 'impersonate': 'Log in as any customer user (full access, audited)',
  'data:read': 'Browse every table in the data explorer', 'data:write': 'Edit and delete records in the data explorer',
};

export default function StaffPage() {
  const toast = useToast(); const qc = useQueryClient();
  const mfaRequired = usePlatform().mfaRequired !== false;
  const q = useQuery({ queryKey: ['platform-staff'], queryFn: () => api<Data>('/platform/staff') });
  const [edit, setEdit] = useState<{ user?: Staff; email: string; role: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!edit) return;
    setBusy(true);
    try {
      if (edit.user) await api(`/platform/staff/${edit.user.id}`, { method: 'PUT', body: { role: edit.role || null, reason: edit.reason } });
      else await api('/platform/staff', { body: { email: edit.email, role: edit.role, reason: edit.reason } });
      toast.success(!edit.role ? 'Staff access removed and sessions signed out' : edit.user ? 'Role changed. They were signed out and must sign in again' : 'Staff member added');
      setEdit(null); void qc.invalidateQueries({ queryKey: ['platform-staff'] });
    } catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const roleOptions = q.data.roles.map((r) => ({ value: r.role, label: label(r.role) }));
  return (
    <>
      <PageHeader title="Staff & roles" subtitle="People who can open this console, and what each role may do. Changing a role signs the person out everywhere." actions={<Button icon={UserPlus} onClick={() => setEdit({ email: '', role: 'SUPPORT', reason: '' })}>Add staff member</Button>} />
      <Card title="Staff">
        <Table head={['Person', 'Role', 'Two-factor', 'Last sign-in', '']}>
          {q.data.staff.map((s) => (
            <tr key={s.id} data-testid={`staff-${s.email}`}>
              <td className="td"><b>{s.name}</b><p className="text-xs text-slate-500">{s.email}{s.status !== 'ACTIVE' ? ' · disabled' : ''}</p></td>
              <td className="td"><Badge color={s.platformRole === 'SUPER_ADMIN' ? 'red' : 'blue'}>{label(s.platformRole)}</Badge></td>
              <td className="td">{s.mfaEnabled ? <Badge color="green">on</Badge> : <Badge color="yellow">{mfaRequired ? 'off — console blocked' : 'off'}</Badge>}</td>
              <td className="td text-xs">{s.lastLoginAt ? fmtDate(s.lastLoginAt) : 'never'}</td>
              <td className="td text-right"><Button size="sm" variant="secondary" onClick={() => setEdit({ user: s, email: s.email, role: s.platformRole, reason: '' })}>Change role</Button></td>
            </tr>
          ))}
        </Table>
      </Card>
      <h2 className="font-display mb-3 mt-8 text-lg font-bold">What each role can do</h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm" data-testid="role-matrix">
          <thead><tr><th className="th text-left">Permission</th>{q.data.roles.map((r) => <th key={r.role} className="th text-center">{label(r.role)}</th>)}</tr></thead>
          <tbody>{Object.keys(PERM_LABEL).map((p) => (
            <tr key={p} className="border-t border-slate-100"><td className="td">{PERM_LABEL[p]}</td>{q.data!.roles.map((r) => <td key={r.role} className="td text-center">{r.permissions.includes(p) ? <span className="font-bold text-emerald-700" aria-label="allowed">✓</span> : <span className="text-slate-300" aria-label="not allowed">—</span>}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
      <Modal open={!!edit} title={edit?.user ? `Change role — ${edit.user.email}` : 'Add staff member'} onClose={() => setEdit(null)}
        footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Back</Button><Button variant={edit && !edit.role ? 'danger' : 'primary'} loading={busy} disabled={!edit || edit.reason.trim().length < 5 || (!edit.user && !edit.email.includes('@'))} onClick={save}>{edit && !edit.role ? 'Remove staff access' : edit?.user ? 'Save role' : 'Add staff member'}</Button></>}>
        {edit && <>
          {!edit.user && <Field label="Email" hint="The person needs an account already (sign up or be added to a tenant first)."><Input type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>}
          <Field label="Role"><Select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} options={[...roleOptions, ...(edit.user ? [{ value: '', label: 'No staff access' }] : [])]} /></Field>
          {edit.role && <p className="mb-3 text-xs text-slate-500">{(q.data!.roles.find((r) => r.role === edit.role)?.permissions ?? []).map((p) => PERM_LABEL[p] ?? p).join(' · ')}</p>}
          {edit.role && mfaRequired && <div className="mb-3"><Notice>Staff must turn on two-factor sign-in before the console opens for them.</Notice></div>}
          <Field label="Reason" hint="Required; recorded in the platform audit trail."><Textarea rows={2} value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></Field>
        </>}
      </Modal>
    </>
  );
}
