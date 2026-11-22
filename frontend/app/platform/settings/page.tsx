'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, describeError } from '@/lib/api';
import { Button, Card, Checkbox, ErrorState, Field, Input, Loading, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { usePlatform } from '@/components/platform/shell';

type Ann = { enabled: boolean; level: 'info' | 'warning' | 'danger'; message: string };
type Values = {
  signupMode: 'env' | 'open' | 'closed';
  announcement: Ann;
  maintenance: { enabled: boolean; message: string };
  security: { passwordMinLength: number; sessionIdleDays: number; requireMfaForAllUsers: boolean; impersonationMaxMinutes: number };
  signups: { defaultPlanCode: string; maxOrgsPerUser: number | null };
  branding: { appName: string; supportEmail: string };
};
type Data = Values & {
  defaults: Values; plans: Array<{ code: string; name: string }>;
  effective: { registrationOpen: boolean; envRegistration: string | null; envMaxOrgsPerUser: number; billingEnabled: boolean; platformMfaRequired: boolean };
};
const KEYS = ['signupMode', 'announcement', 'maintenance', 'security', 'signups', 'branding'] as const;
const SECTIONS = [
  { id: 'general', label: 'Branding' }, { id: 'signups', label: 'Sign-ups' }, { id: 'security', label: 'Security' },
  { id: 'banners', label: 'Announcement & maintenance' },
];

export default function PlatformSettings() {
  const me = usePlatform(); const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform-settings'], queryFn: () => api<Data>('/platform/settings') });
  const [f, setF] = useState<Values | null>(null);
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data && !f) setF(pick(q.data)); }, [q.data, f]);
  const canWrite = me.permissions.includes('settings:write');
  const dirty = useMemo(() => (f && q.data ? KEYS.filter((k) => JSON.stringify(f[k]) !== JSON.stringify(q.data![k])) : []), [f, q.data]);

  async function save() {
    if (!f) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { reason };
      for (const k of dirty) body[k] = f[k];
      const r = await api<Data>('/platform/settings', { method: 'PUT', body });
      qc.setQueryData(['platform-settings'], r); setF(pick(r)); setReason('');
      void qc.invalidateQueries({ queryKey: ['announcement'] }); void qc.invalidateQueries({ queryKey: ['public-config'] });
      toast.success('Settings saved');
    } catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  if (q.isLoading || (!f && !q.error)) return <Loading />;
  if (q.error || !q.data || !f) return <ErrorState error={q.error} />;
  const d = q.data; const a = f.announcement; const s = f.security;
  const set = <K extends keyof Values>(k: K, v: Values[K]) => setF({ ...f, [k]: v });
  const num = (v: string) => (v === '' ? 0 : Number(v));

  return (
    <>
      <PageHeader title="Global settings" subtitle="Settings for every tenant on this installation. Change any group, give a reason, and save; every change is recorded with the old and new values." />
      <nav className="mb-4 flex flex-wrap gap-2 text-sm">{SECTIONS.map((x) => <a key={x.id} href={`#${x.id}`} className="rounded-lg bg-slate-100 px-3 py-1.5 font-semibold hover:bg-slate-200 dark:bg-slate-800">{x.label}</a>)}</nav>
      <div className="grid max-w-3xl gap-4 pb-28">
        <div id="general" />
        <Card title="Branding">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Product name" hint="Shown in the console, banners and system emails."><Input disabled={!canWrite} value={f.branding.appName} onChange={(e) => set('branding', { ...f.branding, appName: e.target.value })} /></Field>
            <Field label="Support email" hint="Shown to customers on maintenance and error notices. Leave empty to hide."><Input disabled={!canWrite} type="email" value={f.branding.supportEmail} onChange={(e) => set('branding', { ...f.branding, supportEmail: e.target.value })} placeholder="support@yourdomain.com" /></Field>
          </div>
        </Card>

        <div id="signups" />
        <Card title="New sign-ups">
          <Field label="Who can create a new organization" hint="Staff can always create tenants from Tenants → New tenant, whatever this says.">
            <Select disabled={!canWrite} value={f.signupMode} onChange={(e) => set('signupMode', e.target.value as Values['signupMode'])} options={[
              { value: 'env', label: `Use the server setting (REGISTRATION_OPEN=${d.effective.envRegistration ?? 'not set'})` },
              { value: 'open', label: 'Anyone can sign up' },
              { value: 'closed', label: 'Closed: invitations and staff-created tenants only' },
            ]} />
          </Field>
          <p className="mb-3 text-sm text-slate-600">Right now sign-up is <b data-testid="signup-state">{d.effective.registrationOpen ? 'open' : 'closed'}</b>.</p>
          {f.signupMode === 'open' && <div className="mb-3"><Notice kind="warning">With sign-up open, the Claude and Codex subscription connection switches back to owner-only, because subscription logins can’t be offered to outside customers.</Notice></div>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Plan for new organizations" hint={d.effective.billingEnabled ? 'Used when someone signs up without choosing a plan.' : 'Only used when billing is on (BILLING_ENABLED=true).'}>
              <Select disabled={!canWrite} value={f.signups.defaultPlanCode} onChange={(e) => set('signups', { ...f.signups, defaultPlanCode: e.target.value })} options={[{ value: '', label: 'Starter (default)' }, ...d.plans.map((p) => ({ value: p.code, label: p.name }))]} />
            </Field>
            <Field label="Organizations one person may own" hint={`Empty = server setting (${d.effective.envMaxOrgsPerUser}). Staff are exempt.`}>
              <Input disabled={!canWrite} type="number" min={1} max={1000} value={f.signups.maxOrgsPerUser ?? ''} onChange={(e) => set('signups', { ...f.signups, maxOrgsPerUser: e.target.value === '' ? null : num(e.target.value) })} />
            </Field>
          </div>
        </Card>

        <div id="security" />
        <Card title="Security">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Minimum password length" hint="8–128. Applies to new passwords; existing ones keep working."><Input disabled={!canWrite} type="number" min={8} max={128} value={s.passwordMinLength} onChange={(e) => set('security', { ...s, passwordMinLength: num(e.target.value) })} /></Field>
            <Field label="Sign out after this many idle days" hint="1–90. Applies from each person’s next sign-in."><Input disabled={!canWrite} type="number" min={1} max={90} value={s.sessionIdleDays} onChange={(e) => set('security', { ...s, sessionIdleDays: num(e.target.value) })} /></Field>
            <Field label="Longest “log in as” session (minutes)" hint="5–480. Caps every super admin “log in as”."><Input disabled={!canWrite} type="number" min={5} max={480} value={s.impersonationMaxMinutes} onChange={(e) => set('security', { ...s, impersonationMaxMinutes: num(e.target.value) })} /></Field>
          </div>
          <Checkbox label="Everyone must use two-factor sign-in" hint="People without it are sent to set it up before they can open any workspace." checked={s.requireMfaForAllUsers} onChange={(v) => canWrite && set('security', { ...s, requireMfaForAllUsers: v })} />
          <p className="mt-2 text-xs text-slate-500">Staff two-factor is {d.effective.platformMfaRequired ? 'required (PLATFORM_MFA_REQUIRED)' : 'not required on this install (PLATFORM_MFA_REQUIRED=false)'}.</p>
        </Card>

        <div id="banners" />
        <Card title="Announcement banner">
          <Checkbox label="Show a banner to every signed-in user" checked={a.enabled} onChange={(v) => canWrite && set('announcement', { ...a, enabled: v })} />
          <Field label="Style"><Select disabled={!canWrite} value={a.level} onChange={(e) => set('announcement', { ...a, level: e.target.value as Ann['level'] })} options={[{ value: 'info', label: 'Information' }, { value: 'warning', label: 'Warning' }, { value: 'danger', label: 'Urgent' }]} /></Field>
          <Field label="Message" hint={`${a.message.length}/500. Plain text, for example planned maintenance times.`}><Textarea disabled={!canWrite} rows={3} maxLength={500} value={a.message} onChange={(e) => set('announcement', { ...a, message: e.target.value })} /></Field>
          {a.enabled && a.message && <div className="mt-1"><p className="mb-1 text-xs font-semibold text-slate-500">Preview</p><Notice kind={a.level}>{a.message}</Notice></div>}
        </Card>
        <Card title="Maintenance mode">
          <Checkbox label="Pause changes for customers" hint="Customers can still sign in and look around, but cannot change, send or import anything. Staff, and staff using “log in as”, are not blocked. Sending queues and webhooks keep running." checked={f.maintenance.enabled} onChange={(v) => canWrite && set('maintenance', { ...f.maintenance, enabled: v })} />
          <Field label="Maintenance notice" hint="What customers see. Leave empty for a standard notice."><Textarea disabled={!canWrite} rows={2} maxLength={500} value={f.maintenance.message} onChange={(e) => set('maintenance', { ...f.maintenance, message: e.target.value })} placeholder="We’re upgrading. Changes are paused until 10:00 IST." /></Field>
          {f.maintenance.enabled && <Notice kind="warning">Customers will get “changes are paused” on every save until you turn this off.</Notice>}
        </Card>
      </div>

      {canWrite ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-slate-700 dark:bg-slate-950/95 lg:left-60 lg:px-8">
          <div className="flex max-w-3xl flex-wrap items-center gap-3">
            <span className="text-sm text-slate-600">{dirty.length ? <>Changed: <b>{dirty.join(', ')}</b></> : 'No changes yet.'}</span>
            <div className="min-w-[240px] flex-1"><Input aria-label="Reason for the change" placeholder="Reason for the change (required, recorded)" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            {dirty.length > 0 && <Button variant="ghost" onClick={() => setF(pick(d))}>Undo</Button>}
            <Button loading={busy} disabled={!dirty.length || reason.trim().length < 5} onClick={save}>Save settings</Button>
          </div>
        </div>
      ) : <div className="max-w-3xl"><Notice>Only super admins can change these settings.</Notice></div>}
    </>
  );
}

function pick(d: Values): Values {
  return { signupMode: d.signupMode, announcement: d.announcement, maintenance: d.maintenance, security: d.security, signups: d.signups, branding: d.branding };
}
