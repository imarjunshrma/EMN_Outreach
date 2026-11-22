'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, describeError } from '@/lib/api';
import { Button, Card, Checkbox, ErrorState, Field, Loading, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { usePlatform } from '@/components/platform/shell';

type Ann = { enabled: boolean; level: 'info' | 'warning' | 'danger'; message: string };
type Data = { signupMode: 'env' | 'open' | 'closed'; announcement: Ann; effective: { registrationOpen: boolean; envRegistration: string | null } };

export default function PlatformSettings() {
  const me = usePlatform(); const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform-settings'], queryFn: () => api<Data>('/platform/settings') });
  const [f, setF] = useState<{ signupMode: Data['signupMode']; announcement: Ann; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data && !f) setF({ signupMode: q.data.signupMode, announcement: q.data.announcement, reason: '' }); }, [q.data, f]);
  const canWrite = me.permissions.includes('settings:write');
  async function save() {
    if (!f) return;
    setBusy(true);
    try { const r = await api<Data>('/platform/settings', { method: 'PUT', body: f }); qc.setQueryData(['platform-settings'], r); void qc.invalidateQueries({ queryKey: ['announcement'] }); setF({ ...f, reason: '' }); toast.success('Settings saved'); }
    catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  if (q.isLoading || (!f && !q.error)) return <Loading />;
  if (q.error || !q.data || !f) return <ErrorState error={q.error} />;
  const a = f.announcement;
  return (
    <>
      <PageHeader title="Global settings" subtitle="Settings that apply to every tenant on this installation." />
      <div className="grid max-w-3xl gap-4">
        <Card title="New sign-ups">
          <Field label="Who can create a new organization" hint="Staff can always create tenants from Tenants → New tenant, whatever this says.">
            <Select disabled={!canWrite} value={f.signupMode} onChange={(e) => setF({ ...f, signupMode: e.target.value as Data['signupMode'] })} options={[
              { value: 'env', label: `Use the server setting (REGISTRATION_OPEN=${q.data.effective.envRegistration ?? 'not set'})` },
              { value: 'open', label: 'Anyone can sign up' },
              { value: 'closed', label: 'Closed: invitations and staff-created tenants only' },
            ]} />
          </Field>
          <p className="text-sm text-slate-600">Right now sign-up is <b data-testid="signup-state">{q.data.effective.registrationOpen ? 'open' : 'closed'}</b>.</p>
          {f.signupMode === 'open' && <div className="mt-3"><Notice kind="warning">With sign-up open, the Claude and Codex subscription connection switches back to owner-only, because subscription logins can’t be offered to outside customers.</Notice></div>}
        </Card>
        <Card title="Announcement banner">
          <Checkbox label="Show a banner to every signed-in user" checked={a.enabled} onChange={(v) => setF({ ...f, announcement: { ...a, enabled: v } })} />
          <Field label="Style"><Select disabled={!canWrite} value={a.level} onChange={(e) => setF({ ...f, announcement: { ...a, level: e.target.value as Ann['level'] } })} options={[{ value: 'info', label: 'Information' }, { value: 'warning', label: 'Warning' }, { value: 'danger', label: 'Urgent' }]} /></Field>
          <Field label="Message" hint={`${a.message.length}/500. Plain text, for example planned maintenance times.`}><Textarea disabled={!canWrite} rows={3} maxLength={500} value={a.message} onChange={(e) => setF({ ...f, announcement: { ...a, message: e.target.value } })} /></Field>
          {a.enabled && a.message && <div className="mt-1"><p className="mb-1 text-xs font-semibold text-slate-500">Preview</p><Notice kind={a.level}>{a.message}</Notice></div>}
        </Card>
        {canWrite ? <Card>
          <Field label="Reason for the change" hint="Required; recorded in the platform audit trail."><Textarea rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          <Button loading={busy} disabled={f.reason.trim().length < 5} onClick={save}>Save settings</Button>
        </Card> : <Notice>Only super admins can change these settings.</Notice>}
      </div>
    </>
  );
}
