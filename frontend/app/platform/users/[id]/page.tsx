'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Database, KeyRound, LogOut, Pencil, ShieldOff } from 'lucide-react';
import { api, describeError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, Checkbox, ErrorState, Field, Input, Loading, Modal, Notice, PageHeader, Table, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { usePlatform } from '@/components/platform/shell';
import { LINK_BTN, LoginAsButton } from '@/components/platform/login-as';
import { SetupLinkNotice, type SetupResult } from '@/components/platform/setup-link';
import { statusColor } from '@/components/platform/status';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Action =
  | { kind: 'edit'; name: string; email: string; locale: string; emailVerified: boolean }
  | { kind: 'mfa' } | { kind: 'signout' } | { kind: 'status' } | { kind: 'reset' } | { kind: 'session'; id: string };

const TITLES: Record<Action['kind'], string> = { edit: 'Edit account', mfa: 'Turn off two-factor', signout: 'Sign out everywhere', status: '', reset: 'Reset password', session: 'End this session' };

export default function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const me = usePlatform(); const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform-user', id], queryFn: () => api<any>(`/platform/users/${id}`) });
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<SetupResult>(null);
  const can = (p: string) => me.permissions.includes(p);

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const d = q.data; const u = d.user;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['platform-user', id] }); void qc.invalidateQueries({ queryKey: ['platform-users'] }); };

  async function run() {
    if (!action) return;
    setBusy(true);
    try {
      if (action.kind === 'edit') {
        await api(`/platform/users/${id}`, { method: 'PUT', body: { name: action.name, email: action.email, locale: action.locale || null, emailVerified: action.emailVerified, reason } });
        toast.success('Account updated');
      }
      if (action.kind === 'mfa') { await api(`/platform/users/${id}/mfa-reset`, { body: { reason } }); toast.success('Two-factor turned off. They were signed out and can set it up again.'); }
      if (action.kind === 'signout') { const r = await api<{ revoked: number }>(`/platform/users/${id}/sessions/revoke`, { body: { reason } }); toast.success(`Signed out of ${r.revoked} session${r.revoked === 1 ? '' : 's'}`); }
      if (action.kind === 'session') { await api(`/platform/sessions/${action.id}/revoke`, { body: { reason } }); toast.success('Session ended'); }
      if (action.kind === 'status') { await api(`/platform/users/${id}/status`, { body: { status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE', reason } }); toast.success(u.status === 'ACTIVE' ? 'Account disabled and signed out everywhere' : 'Account enabled'); }
      if (action.kind === 'reset') {
        const r = await api<{ mailed: boolean; link: string | null }>(`/platform/users/${id}/password-reset`, { body: { reason } });
        if (r.mailed) toast.success(`Reset link emailed to ${u.email}`); else setSetup(r);
      }
      setAction(null); setReason(''); refresh();
    } catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }

  const title = action?.kind === 'status' ? (u.status === 'ACTIVE' ? 'Disable account' : 'Enable account') : action ? TITLES[action.kind] : '';
  return (
    <>
      <Link href="/platform/users" className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-600 hover:text-ink"><ArrowLeft className="h-4 w-4" aria-hidden />User accounts</Link>
      <PageHeader title={u.name} subtitle={<span className="flex flex-wrap items-center gap-2">
        <span>{u.email}</span>
        {u.status === 'ACTIVE' ? <Badge color="green">active</Badge> : <Badge color="red">disabled</Badge>}
        {u.platformRole && <Badge color="purple">staff: {u.platformRole.replace('_', ' ').toLowerCase()}</Badge>}
        {u.mfaEnabled ? <Badge color="green"><>2FA on</></Badge> : <Badge><>no 2FA</></Badge>}
        {u.emailVerifiedAt ? <Badge color="blue"><>email verified</></Badge> : <Badge color="yellow"><>email not verified</></Badge>}
        <code className="text-xs">{u.id}</code>
      </span>}
        actions={<>
          {!u.platformRole && u.status === 'ACTIVE' && <LoginAsButton userId={u.id} who={u.email} size="md" variant="primary" />}
          {can('data:read') && <Link href={`/platform/data/User/${u.id}`} className={LINK_BTN}><Database className="h-4 w-4" aria-hidden />Raw record</Link>}
        </>} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Profile" actions={can('users:manage') ? <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setAction({ kind: 'edit', name: u.name, email: u.email, locale: u.locale ?? '', emailVerified: !!u.emailVerifiedAt })}>Edit</Button> : undefined}>
          <dl className="space-y-1.5 text-sm">
            {[['Created', fmtDate(u.createdAt)], ['Last sign-in', u.lastLoginAt ? fmtDate(u.lastLoginAt) : 'never'], ['Language', u.locale ?? 'default'], ['Two-factor since', u.mfaEnabledAt ? fmtDate(u.mfaEnabledAt) : '—'], ['Terms accepted', u.termsAcceptedAt ? `${fmtDate(u.termsAcceptedAt)}${u.termsVersion ? ` (v${u.termsVersion})` : ''}` : '—'], ['Leads owned', d.counts.leadsOwned ?? '—'], ['Open tasks assigned', d.counts.tasksAssigned ?? '—'], ['Notes written', d.counts.notes ?? '—']].map(([k, v]) => <div key={k as string} className="flex justify-between gap-3"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium">{v as string}</dd></div>)}
          </dl>
        </Card>
        <Card title="Account controls" className="lg:col-span-2">
          <div className="flex flex-wrap gap-2">
            {can('tenants:lifecycle') && u.status === 'ACTIVE' && <Button variant="secondary" icon={KeyRound} onClick={() => setAction({ kind: 'reset' })}>Send password reset link</Button>}
            {can('users:manage') && u.mfaEnabled && <Button variant="secondary" icon={ShieldOff} onClick={() => setAction({ kind: 'mfa' })}>Turn off two-factor</Button>}
            {can('users:manage') && <Button variant="secondary" icon={LogOut} disabled={!d.sessions.length} onClick={() => setAction({ kind: 'signout' })}>Sign out everywhere</Button>}
            {can('tenants:lifecycle') && <Button variant={u.status === 'ACTIVE' ? 'danger' : 'primary'} onClick={() => setAction({ kind: 'status' })}>{u.status === 'ACTIVE' ? 'Disable account' : 'Enable account'}</Button>}
          </div>
          <p className="mt-3 text-xs text-slate-500">Every action needs a reason and is recorded in the platform audit trail. Disabling keeps their organizations and data; it only blocks sign-in.</p>
        </Card>

        <Card title={`Organizations (${u.orgMemberships.length})`}>
          {u.orgMemberships.length === 0 ? <p className="text-sm text-slate-500">None.</p> : <ul className="space-y-2 text-sm">{u.orgMemberships.map((m: any) => <li key={m.organization.id} className="flex items-center justify-between gap-2">
            <span><Link className="font-semibold hover:underline" href={`/platform/tenants/${m.organization.id}`}>{m.organization.name}</Link><span className="block text-xs text-slate-500">{m.role.toLowerCase()}{m.organization.ownerId === u.id ? ' · account owner' : ''}</span></span>
            <Badge color={statusColor(m.organization.status)}>{m.organization.status.toLowerCase().replace(/_/g, ' ')}</Badge></li>)}</ul>}
        </Card>
        <Card title={`Workspace memberships (${u.memberships.length})`} className="lg:col-span-2">
          {u.memberships.length === 0 ? <p className="text-sm text-slate-500">None directly (owners and admins reach every workspace of their organization).</p> : <Table head={['Workspace', 'Role', 'Since', '']}>
            {u.memberships.map((m: any) => <tr key={m.workspace.id}><td className="td font-semibold">{m.workspace.name}{m.workspace.archivedAt && <span className="ml-1 text-xs text-slate-500">(archived)</span>}</td><td className="td text-xs">{m.role.toLowerCase()}</td><td className="td text-xs">{fmtDate(m.createdAt)}</td>
              <td className="td text-right">{!u.platformRole && u.status === 'ACTIVE' && !m.workspace.archivedAt && <LoginAsButton userId={u.id} orgId={m.workspace.organizationId} workspaceId={m.workspace.id} who={u.email} label="Log in here" variant="ghost" />}</td></tr>)}
          </Table>}
        </Card>

        <Card title={`Signed-in sessions (${d.sessions.length})`} className="lg:col-span-3">
          {d.sessions.length === 0 ? <p className="text-sm text-slate-500">Not signed in anywhere.</p> : <Table head={['Started', 'Last seen', 'Ends', 'Device', 'IP', '']}>
            {d.sessions.map((s: any) => <tr key={s.id}><td className="td text-xs">{fmtDate(s.createdAt)}{s.impersonatorId && <Badge color="red">staff “log in as”</Badge>}</td><td className="td text-xs">{fmtDate(s.lastSeenAt)}</td><td className="td text-xs">{fmtDate(s.expiresAt)}</td>
              <td className="td max-w-[320px] truncate text-xs text-slate-500" title={s.userAgent ?? ''}>{s.userAgent ?? '—'}</td><td className="td text-xs">{s.ipAddress ?? '—'}</td>
              <td className="td text-right">{can('users:manage') && <Button size="sm" variant="ghost" onClick={() => setAction({ kind: 'session', id: s.id })}>End</Button>}</td></tr>)}
          </Table>}
        </Card>

        {d.apiKeys.length > 0 && <Card title={`API keys they created (${d.apiKeys.length})`} className="lg:col-span-3">
          <Table head={['Name', 'Key', 'Role', 'Last used', 'Expires']}>{d.apiKeys.map((k: any) => <tr key={k.id}><td className="td font-semibold">{k.name}</td><td className="td text-xs"><code>emn_{k.prefix}_…</code></td><td className="td text-xs">{k.role.toLowerCase()}</td><td className="td text-xs">{k.lastUsedAt ? fmtDate(k.lastUsedAt) : 'never'}</td><td className="td text-xs">{k.expiresAt ? fmtDate(k.expiresAt) : 'never'}</td></tr>)}</Table>
        </Card>}

        <Card title="What they did recently" className="lg:col-span-2">
          {d.activity.length === 0 ? <p className="text-sm text-slate-500">No recorded activity.</p> : <Table head={['When', 'Action', 'Record', 'IP']}>
            {d.activity.map((a: any) => <tr key={a.id}><td className="td whitespace-nowrap text-xs">{fmtDate(a.createdAt)}</td><td className="td text-xs font-semibold">{a.action}{a.metadata?.impersonatedBy && <span className="ml-1 font-normal text-red-700">(by staff)</span>}</td><td className="td text-xs text-slate-500">{a.entityType ? `${a.entityType} ${String(a.entityId ?? '').slice(0, 8)}` : '—'}</td><td className="td text-xs">{a.ipAddress ?? ''}</td></tr>)}
          </Table>}
        </Card>
        <Card title="Staff actions on this account">
          {d.platformAudit.length === 0 ? <p className="text-sm text-slate-500">None.</p> : <ul className="space-y-2 text-sm">{d.platformAudit.map((a: any) => <li key={a.id}><b className="text-xs">{a.action}</b><span className="block text-xs text-slate-500">{fmtDate(a.createdAt)} · {a.actor?.email ?? 'system'}{a.reason ? ` · ${a.reason}` : ''}</span></li>)}</ul>}
        </Card>
      </div>

      <Modal open={!!action} title={title} onClose={() => setAction(null)}
        footer={<><Button variant="ghost" onClick={() => setAction(null)}>Back</Button><Button variant={action?.kind === 'status' && u.status === 'ACTIVE' ? 'danger' : 'primary'} loading={busy} disabled={reason.trim().length < 5} onClick={run}>{title}</Button></>}>
        {action?.kind === 'edit' && <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={action.name} onChange={(e) => setAction({ ...action, name: e.target.value })} /></Field>
            <Field label="Email" hint="They sign in with the new address from now on."><Input type="email" value={action.email} onChange={(e) => setAction({ ...action, email: e.target.value })} /></Field>
          </div>
          <Field label="Language" hint="Leave empty for the default."><Input value={action.locale} onChange={(e) => setAction({ ...action, locale: e.target.value })} placeholder="en" /></Field>
          <Checkbox label="Email address is verified" checked={action.emailVerified} onChange={(v) => setAction({ ...action, emailVerified: v })} />
        </>}
        {action?.kind === 'mfa' && <Notice kind="warning">Use this when they lost their authenticator. They are signed out and can sign in with just their password, then set up two-factor again.</Notice>}
        {action?.kind === 'signout' && <Notice>Every browser they are signed in on is signed out, including any staff “log in as” sessions.</Notice>}
        {action?.kind === 'status' && u.status === 'ACTIVE' && <Notice kind="danger">They are signed out everywhere and cannot sign in. Their organizations and data stay as they are.</Notice>}
        <div className="mt-3"><Field label="Reason" hint="Required; recorded in the platform audit trail."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
      </Modal>
      <Modal open={!!setup} title="Share the link" onClose={() => setSetup(null)} footer={<Button onClick={() => setSetup(null)}>Done</Button>}>
        {setup && <SetupLinkNotice setup={setup} email={u.email} />}
      </Modal>
    </>
  );
}

