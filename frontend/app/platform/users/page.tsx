'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, describeError, qs } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Field, Input, Loading, Modal, PageHeader, Table, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { usePlatform } from '@/components/platform/shell';
import { SetupLinkNotice, type SetupResult } from '@/components/platform/setup-link';
import { LoginAsButton } from '@/components/platform/login-as';
import Link from 'next/link';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Users() {
  const me = usePlatform(); const toast = useToast(); const qc = useQueryClient();
  const [term, setTerm] = useState('');
  const q = useQuery({ queryKey: ['platform-users', term], queryFn: () => api<{ data: any[] }>(`/platform/users${qs({ q: term })}`), enabled: term.trim().length >= 2 });
  const [reset, setReset] = useState<{ user: any; reason: string; result: SetupResult } | null>(null);
  const [target, setTarget] = useState<any | null>(null); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const canChange = me.permissions.includes('tenants:lifecycle');
  async function apply() {
    setBusy(true);
    try { await api(`/platform/users/${target.id}/status`, { body: { status: target.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE', reason } }); toast.success(target.status === 'ACTIVE' ? 'Account disabled and signed out everywhere' : 'Account enabled'); setTarget(null); setReason(''); void qc.invalidateQueries({ queryKey: ['platform-users'] }); }
    catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  async function doReset() {
    if (!reset) return;
    setBusy(true);
    try { const r = await api<{ mailed: boolean; link: string | null }>(`/platform/users/${reset.user.id}/password-reset`, { body: { reason: reset.reason } }); if (r.mailed) { toast.success(`Reset link emailed to ${reset.user.email}`); setReset(null); } else setReset({ ...reset, result: r }); }
    catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHeader title="User accounts" subtitle="Find a person across all organizations. Disabling an account signs it out everywhere and blocks sign-in; their organizations and data are untouched." />
      <OpenSessions />
      <div className="mb-4 max-w-md"><Input icon={Search} placeholder="Email or name (at least 2 characters)" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Search users" /></div>
      {term.trim().length < 2 ? <p className="text-sm text-slate-500">Type to search.</p> : q.isLoading ? <Loading /> : (
        <Table head={['Person', 'Organizations', 'Security', 'Last sign-in', 'Status', '']}>
          {(q.data?.data ?? []).map((u) => (
            <tr key={u.id}>
              <td className="td"><Link href={`/platform/users/${u.id}`} className="font-bold text-brand-700 hover:underline">{u.name}</Link><p className="text-xs text-slate-500">{u.email}{u.platformRole ? ` · staff: ${u.platformRole.toLowerCase()}` : ''}</p></td>
              <td className="td text-xs">{u.orgMemberships.map((m: any) => `${m.organization.name} (${m.role.toLowerCase()})`).join(', ') || '—'}</td>
              <td className="td text-xs">{u.mfaEnabled ? <Badge color="green">2FA</Badge> : <Badge>no 2FA</Badge>} {!u.emailVerifiedAt && <Badge color="yellow">unverified</Badge>}</td>
              <td className="td text-xs">{u.lastLoginAt ? fmtDate(u.lastLoginAt) : 'never'}</td>
              <td className="td">{u.status === 'ACTIVE' ? <Badge color="green">active</Badge> : <Badge color="red">disabled</Badge>}</td>
              <td className="td whitespace-nowrap text-right">{!u.platformRole && u.status === 'ACTIVE' && <LoginAsButton userId={u.id} who={u.email} variant="ghost" />}{canChange && u.status === 'ACTIVE' && <Button size="sm" variant="ghost" onClick={() => setReset({ user: u, reason: '', result: null })}>Reset password</Button>}{canChange && <Button size="sm" variant={u.status === 'ACTIVE' ? 'danger' : 'secondary'} onClick={() => setTarget(u)}>{u.status === 'ACTIVE' ? 'Disable' : 'Enable'}</Button>}</td>
            </tr>
          ))}
        </Table>
      )}
      <Modal open={!!target} title={`${target?.status === 'ACTIVE' ? 'Disable' : 'Enable'} ${target?.email ?? ''}`} onClose={() => setTarget(null)} footer={<><Button variant="ghost" onClick={() => setTarget(null)}>Back</Button><Button variant={target?.status === 'ACTIVE' ? 'danger' : 'primary'} loading={busy} disabled={reason.trim().length < 5} onClick={apply}>{target?.status === 'ACTIVE' ? 'Disable account' : 'Enable account'}</Button></>}>
        <Field label="Reason" hint="Required; recorded in the platform audit trail."><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
      <Modal open={!!reset} title={`Reset password for ${reset?.user.email ?? ''}`} onClose={() => setReset(null)}
        footer={reset?.result ? <Button onClick={() => setReset(null)}>Done</Button> : <><Button variant="ghost" onClick={() => setReset(null)}>Back</Button><Button loading={busy} disabled={!reset || reset.reason.trim().length < 5} onClick={doReset}>Create reset link</Button></>}>
        {reset && (reset.result ? <SetupLinkNotice setup={reset.result} email={reset.user.email} /> : <>
          <p className="mb-3 text-sm text-slate-600">We email a single-use link (valid 7 days). If system email isn’t set up, you get the link to pass on yourself.</p>
          <Field label="Reason" hint="Required; recorded in the platform audit trail."><Textarea rows={2} value={reset.reason} onChange={(e) => setReset({ ...reset, reason: e.target.value })} /></Field>
        </>)}
      </Modal>
    </>
  );
}

/** "Log in as" sessions that are open right now, by any super admin. */
function OpenSessions() {
  const me = usePlatform(); const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform-impersonations'], queryFn: () => api<any[]>('/platform/impersonations'), enabled: me.permissions.includes('impersonate'), refetchInterval: 60_000 });
  if (!q.data?.length) return null;
  return (
    <div className="card mb-4 border-red-200 p-4" data-testid="open-impersonations">
      <p className="mb-2 text-sm font-bold text-red-800">Open “log in as” sessions ({q.data.length})</p>
      <Table head={['Signed in as', 'By', 'Reason', 'Ends', '']}>
        {q.data.map((s) => <tr key={s.id}><td className="td text-xs"><Link className="font-semibold hover:underline" href={`/platform/users/${s.user.id}`}>{s.user.email}</Link></td><td className="td text-xs">{s.impersonator?.email ?? '—'}</td><td className="td max-w-[280px] truncate text-xs">{s.impersonationReason}</td><td className="td text-xs">{fmtDate(s.expiresAt)}</td>
          <td className="td text-right"><Button size="sm" variant="ghost" onClick={async () => { try { await api(`/platform/impersonations/${s.id}`, { method: 'DELETE' }); toast.success('Session ended'); void qc.invalidateQueries({ queryKey: ['platform-impersonations'] }); } catch (e) { toast.error(describeError(e)); } }}>End</Button></td></tr>)}
      </Table>
    </div>
  );
}
