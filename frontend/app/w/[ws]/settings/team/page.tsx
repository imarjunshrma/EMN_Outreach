'use client';

import { useState } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { ROLES } from '@/lib/constants';
import { Badge, Button, Card, ConfirmButton, Field, Input, Notice, PageHeader, QueryView, Select, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROLE_HELP: Record<string, string> = { OWNER: 'Everything, incl. ownership & full export', ADMIN: 'Mailboxes, AI keys, integrations, team, logs', MANAGER: 'Approve/start campaigns, ICPs, automations', MEMBER: 'Leads, research, drafts, replies', VIEWER: 'Read-only' };

export default function Team() {
  const q = useWsQuery<{ members: any[]; invitations: any[] }>('/members');
  const [inv, setInv] = useState({ email: '', role: 'MEMBER' });
  const [link, setLink] = useState<string | null>(null);
  const invite = useWsMutation(() => ({ path: '/invitations', body: inv }), { onSuccess: (r: any) => { setLink(r.inviteUrl); setInv({ email: '', role: 'MEMBER' }); } });
  const role = useWsMutation<{ id: string; role: string }>((b) => ({ path: `/members/${b.id}`, method: 'PATCH', body: { role: b.role } }), { success: 'Role updated' });
  const remove = useWsMutation<string>((id) => ({ path: `/members/${id}`, method: 'DELETE' }), { success: 'Removed' });
  const revoke = useWsMutation<string>((id) => ({ path: `/invitations/${id}`, method: 'DELETE' }), { success: 'Invitation revoked' });
  return (
    <>
      <PageHeader title="Team & users" subtitle="Invite teammates and set their role. Invitations produce a link you share yourself (no system mailer needed)." />
      {link && <div className="mb-4"><Notice kind="warning"><b>Share this invitation link (valid 7 days):</b> <code className="break-all">{link}</code> <Button variant="ghost" onClick={() => { void navigator.clipboard.writeText(link); }}>Copy</Button></Notice></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Invite">
          <Field label="Email"><Input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></Field>
          <Field label="Role" hint={ROLE_HELP[inv.role]}><Select value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })} options={ROLES} /></Field>
          <Button className="mt-3" disabled={!inv.email} loading={invite.isPending} onClick={() => invite.mutate()}>Create invitation</Button>
          <ul className="mt-4 space-y-1 text-xs text-slate-500">{ROLES.map((r) => <li key={r}><b>{r}</b>: {ROLE_HELP[r]}</li>)}</ul>
        </Card>
        <div className="space-y-4 lg:col-span-2">
          <QueryView q={q}>
            {(d) => (
              <>
                <div className="card p-2"><Table head={['Member', 'Role', 'Last login', '']}>{d.members.map((m) => <tr key={m.id}><td className="td"><b>{m.user.name}</b><div className="text-xs text-slate-500">{m.user.email}</div></td><td className="td w-44"><Select value={m.role} onChange={(e) => role.mutate({ id: m.id, role: e.target.value })} options={ROLES} /></td><td className="td text-xs">{fmtDate(m.user.lastLoginAt)}</td><td className="td"><ConfirmButton variant="ghost" confirm="Remove this member?" onConfirm={() => remove.mutate(m.id)}>Remove</ConfirmButton></td></tr>)}</Table></div>
                {d.invitations.length > 0 && <Card title="Pending invitations"><Table head={['Email', 'Role', 'Expires', '']}>{d.invitations.map((i) => <tr key={i.id}><td className="td">{i.email}</td><td className="td"><Badge>{i.role}</Badge></td><td className="td text-xs">{fmtDate(i.expiresAt)}</td><td className="td"><Button variant="ghost" onClick={() => revoke.mutate(i.id)}>Revoke</Button></td></tr>)}</Table></Card>}
              </>
            )}
          </QueryView>
        </div>
      </div>
    </>
  );
}
