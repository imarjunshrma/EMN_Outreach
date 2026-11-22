'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { api, describeError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, ErrorState, Field, Input, Loading, Modal, Notice, Select, Table, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { SetupLinkNotice, type SetupResult } from '@/components/platform/setup-link';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Member = { id: string; role: string; user: { id: string; name: string; email: string; mfaEnabled: boolean; emailVerifiedAt: string | null; lastLoginAt: string | null; status?: string; platformRole?: string | null }; workspaces: Array<{ id: string; name: string; role: string }> };
type Data = { members: Member[]; workspaces: Array<{ id: string; name: string }>; orgRoles: string[]; workspaceRoles: string[] };
type Pending =
  | { kind: 'role'; m: Member; role: string }
  | { kind: 'remove'; m: Member }
  | { kind: 'reset'; m: Member };

const label = (r: string) => r.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const ROLE_HINT: Record<string, string> = { OWNER: 'full control, including billing and deletion', ADMIN: 'manages members, workspaces and settings', BILLING: 'billing and invoices only', MEMBER: 'only the workspaces they are added to' };

export function TenantMembers({ orgId, canChange }: { orgId: string; canChange: boolean }) {
  const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform-tenant-members', orgId], queryFn: () => api<Data>(`/platform/tenants/${orgId}/members`) });
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<{ email: string; setup: SetupResult } | null>(null);
  const [add, setAdd] = useState<{ email: string; name: string; role: string; workspaceId: string; workspaceRole: string; reason: string } | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['platform-tenant-members', orgId] }); void qc.invalidateQueries({ queryKey: ['platform-tenant', orgId] }); };

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === 'role') { await api(`/platform/tenants/${orgId}/members/${pending.m.user.id}`, { method: 'PUT', body: { role: pending.role, reason } }); toast.success(pending.role === 'OWNER' ? `${pending.m.user.email} is now an owner` : 'Role changed'); }
      if (pending.kind === 'remove') { await api(`/platform/tenants/${orgId}/members/${pending.m.user.id}/remove`, { body: { reason } }); toast.success('Member removed from the organization and its workspaces'); }
      if (pending.kind === 'reset') {
        const r = await api<{ mailed: boolean; link: string | null }>(`/platform/users/${pending.m.user.id}/password-reset`, { body: { reason } });
        if (r.mailed) toast.success(`Reset link emailed to ${pending.m.user.email}`); else setSetup({ email: pending.m.user.email, setup: r });
      }
      setPending(null); setReason(''); refresh();
    } catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  async function addMember() {
    if (!add) return;
    setBusy(true);
    try {
      const r = await api<{ created: boolean; setup: SetupResult }>(`/platform/tenants/${orgId}/members`, { body: { email: add.email, name: add.name || undefined, role: add.role, workspaceId: add.workspaceId || undefined, workspaceRole: add.workspaceRole, reason: add.reason } });
      refresh();
      if (r.setup && !r.setup.mailed) { setSetup({ email: add.email, setup: r.setup }); setAdd(null); }
      else { toast.success(r.created ? 'Account created and a set-password link was emailed' : 'Member added'); setAdd(null); }
    } catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const d = q.data;
  const owners = d.members.filter((m) => m.role === 'OWNER').length;
  const title = !pending ? '' : pending.kind === 'role' ? `Make ${pending.m.user.email} ${label(pending.role).toLowerCase()}` : pending.kind === 'remove' ? `Remove ${pending.m.user.email}` : `Reset password for ${pending.m.user.email}`;
  return (
    <>
      <Card title={`Members (${d.members.length})`} actions={canChange ? <Button size="sm" icon={UserPlus} onClick={() => setAdd({ email: '', name: '', role: 'MEMBER', workspaceId: d.workspaces[0]?.id ?? '', workspaceRole: 'MEMBER', reason: '' })}>Add member</Button> : undefined}>
        <Table head={['Person', 'Organization role', 'Workspaces', 'Security', 'Last sign-in', '']}>
          {d.members.map((m) => (
            <tr key={m.id} data-testid={`member-${m.user.email}`}>
              <td className="td"><b>{m.user.name}</b><p className="text-xs text-slate-500">{m.user.email}{m.user.status && m.user.status !== 'ACTIVE' ? ' · disabled' : ''}</p></td>
              <td className="td">{canChange
                ? <Select className="!w-36 !py-1.5 text-sm" aria-label={`Role of ${m.user.email}`} value={m.role} onChange={(e) => setPending({ kind: 'role', m, role: e.target.value })} options={d.orgRoles.map((r) => ({ value: r, label: label(r) }))} />
                : <Badge>{label(m.role)}</Badge>}</td>
              <td className="td text-xs">{m.workspaces.length ? m.workspaces.map((w) => `${w.name} (${w.role.toLowerCase()})`).join(', ') : m.role === 'OWNER' || m.role === 'ADMIN' ? 'All, through organization role' : 'None'}</td>
              <td className="td text-xs">{m.user.mfaEnabled ? <Badge color="green">2FA</Badge> : <Badge>no 2FA</Badge>} {!m.user.emailVerifiedAt && <Badge color="yellow">unverified</Badge>}</td>
              <td className="td text-xs">{m.user.lastLoginAt ? fmtDate(m.user.lastLoginAt) : 'never'}</td>
              <td className="td whitespace-nowrap text-right">{canChange && <>
                <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'reset', m })}>Reset password</Button>
                <Button size="sm" variant="ghost" disabled={m.role === 'OWNER' && owners <= 1} title={m.role === 'OWNER' && owners <= 1 ? 'Make someone else owner first' : undefined} onClick={() => setPending({ kind: 'remove', m })}>Remove</Button>
              </>}</td>
            </tr>
          ))}
        </Table>
        <p className="mt-3 text-xs text-slate-500">Roles: {Object.entries(ROLE_HINT).map(([r, h]) => `${label(r)}: ${h}`).join('. ')}. Every change is recorded with your reason.</p>
      </Card>

      <Modal open={!!pending} title={title} onClose={() => setPending(null)}
        footer={<><Button variant="ghost" onClick={() => setPending(null)}>Back</Button><Button variant={pending?.kind === 'remove' ? 'danger' : 'primary'} loading={busy} disabled={reason.trim().length < 5} onClick={confirm}>{pending?.kind === 'remove' ? 'Remove member' : pending?.kind === 'reset' ? 'Create reset link' : 'Change role'}</Button></>}>
        {pending?.kind === 'role' && pending.m.role === 'OWNER' && owners <= 1 && <div className="mb-3"><Notice kind="warning">This is the only owner. Make someone else owner first, or the change will be refused.</Notice></div>}
        {pending?.kind === 'remove' && <div className="mb-3"><Notice kind="warning">They lose access to this organization and all its workspaces. Their account and other organizations are untouched.</Notice></div>}
        {pending?.kind === 'reset' && <div className="mb-3"><Notice>Their current password stops working only once they choose a new one. The link works once and expires in 7 days.</Notice></div>}
        <Field label="Reason" hint="Required; recorded in the platform audit trail."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>

      <Modal open={!!add} title="Add member" onClose={() => setAdd(null)}
        footer={<><Button variant="ghost" onClick={() => setAdd(null)}>Back</Button><Button loading={busy} disabled={!add || !add.email.includes('@') || add.reason.trim().length < 5} onClick={addMember}>Add member</Button></>}>
        {add && <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Email" hint="An existing account is added; otherwise we create one."><Input type="email" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} /></Field>
            <Field label="Name (new accounts)"><Input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} /></Field>
          </div>
          <Field label="Organization role"><Select value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })} options={d.orgRoles.filter((r) => r !== 'OWNER').map((r) => ({ value: r, label: `${label(r)}: ${ROLE_HINT[r] ?? ''}` }))} /></Field>
          {d.workspaces.length > 0 && <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Workspace"><Select value={add.workspaceId} onChange={(e) => setAdd({ ...add, workspaceId: e.target.value })} options={[{ value: '', label: 'No workspace' }, ...d.workspaces.map((w) => ({ value: w.id, label: w.name }))]} /></Field>
            <Field label="Workspace role"><Select disabled={!add.workspaceId} value={add.workspaceRole} onChange={(e) => setAdd({ ...add, workspaceRole: e.target.value })} options={d.workspaceRoles.map((r) => ({ value: r, label: label(r) }))} /></Field>
          </div>}
          <Field label="Reason" hint="Required; recorded in the platform audit trail."><Textarea rows={2} value={add.reason} onChange={(e) => setAdd({ ...add, reason: e.target.value })} /></Field>
        </>}
      </Modal>

      <Modal open={!!setup} title="Share the link" onClose={() => setSetup(null)} footer={<Button onClick={() => setSetup(null)}>Done</Button>}>
        {setup && <SetupLinkNotice setup={setup.setup} email={setup.email} />}
      </Modal>
    </>
  );
}
