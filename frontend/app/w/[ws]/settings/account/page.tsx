'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, describeError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { Button, Card, Field, Input, Notice, PageHeader, QueryView, Table } from '@/components/ui';
import { useToast } from '@/components/toast';
import { AppearanceCard, MfaCard } from '@/components/security';

export default function Account() {
  const toast = useToast();
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<Array<{ id: string; ipAddress: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string }>>('/auth/sessions') });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  async function change() {
    if (pw.newPassword !== pw.confirm) return toast.error('Passwords do not match');
    setBusy(true);
    try { await api('/auth/password', { body: { currentPassword: pw.currentPassword, newPassword: pw.newPassword } }); toast.success('Password changed. Other sessions were signed out.'); setPw({ currentPassword: '', newPassword: '', confirm: '' }); void qc.invalidateQueries({ queryKey: ['sessions'] }); }
    catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  async function revoke(id: string) { await api(`/auth/sessions/${id}`, { method: 'DELETE' }); void qc.invalidateQueries({ queryKey: ['sessions'] }); toast.success('Session revoked'); }
  return (
    <>
      <PageHeader title="My account" />
      {typeof window !== 'undefined' && window.location.search.includes('mfa=required') && <div className="mb-4"><Notice kind="warning">This workspace requires two-factor authentication. Set it up below to continue.</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Change password">
          <Field label="Current password"><Input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label="New password" hint="At least 12 characters with letters and numbers"><Input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
          <Field label="Confirm new password"><Input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
          <Button className="mt-3" loading={busy} disabled={!pw.currentPassword || pw.newPassword.length < 12} onClick={change}>Change password</Button>
        </Card>
        <MfaCard />
        <AppearanceCard />
        <Card title="Active sessions" className="lg:col-span-2">
          <Notice>Sessions expire after 7 days of inactivity.</Notice>
          <QueryView q={sessions}>{(rows) => <Table head={['Device', 'IP', 'Last seen', '']}>{rows.map((s) => <tr key={s.id}><td className="td max-w-xs truncate text-xs">{s.userAgent}</td><td className="td text-xs">{s.ipAddress}</td><td className="td text-xs">{fmtDate(s.lastSeenAt)}</td><td className="td"><Button variant="ghost" onClick={() => revoke(s.id)}>Revoke</Button></td></tr>)}</Table>}</QueryView>
        </Card>
      </div>
    </>
  );
}
