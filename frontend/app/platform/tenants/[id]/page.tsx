'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { api, describeError } from '@/lib/api';
import { fmtDate, fmtDay } from '@/lib/format';
import { Badge, Button, Card, ErrorState, Field, Input, Loading, Modal, Notice, PageHeader, Select, Table, Tabs, Textarea } from '@/components/ui';
import { TenantMembers } from '@/components/platform/tenant-members';
import { TenantModules } from '@/components/platform/tenant-modules';
import { useToast } from '@/components/toast';
import { usePlatform } from '@/components/platform/shell';
import { statusColor } from '@/components/platform/status';
import { LINK_BTN_SM, LoginAsButton } from '@/components/platform/login-as';
import { TenantData } from '@/components/platform/tenant-data';
import { Database, Pencil } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ACTIONS: Record<string, Array<{ id: string; label: string; danger?: boolean }>> = {
  PENDING_SETUP: [{ id: 'cancel', label: 'Cancel' }, { id: 'schedule_deletion', label: 'Schedule deletion', danger: true }],
  TRIAL: [{ id: 'suspend', label: 'Suspend' }, { id: 'cancel', label: 'Cancel' }, { id: 'schedule_deletion', label: 'Schedule deletion', danger: true }],
  ACTIVE: [{ id: 'suspend', label: 'Suspend' }, { id: 'cancel', label: 'Cancel' }, { id: 'schedule_deletion', label: 'Schedule deletion', danger: true }],
  PAST_DUE: [{ id: 'suspend', label: 'Suspend' }, { id: 'cancel', label: 'Cancel' }, { id: 'schedule_deletion', label: 'Schedule deletion', danger: true }],
  SUSPENDED: [{ id: 'reactivate', label: 'Reactivate' }, { id: 'cancel', label: 'Cancel' }, { id: 'schedule_deletion', label: 'Schedule deletion', danger: true }],
  CANCELLED: [{ id: 'reactivate', label: 'Reactivate' }, { id: 'schedule_deletion', label: 'Schedule deletion', danger: true }],
  DELETION_PENDING: [{ id: 'restore', label: 'Restore' }, { id: 'purge_now', label: 'Purge now', danger: true }],
  DELETED: [],
};

export default function TenantDetail() {
  const { id } = useParams<{ id: string }>();
  const me = usePlatform();
  const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform-tenant', id], queryFn: () => api<any>(`/platform/tenants/${id}`) });
  const [action, setAction] = useState<{ id: string; label: string; danger?: boolean } | null>(null);
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState(false);
  const [tab, setTab] = useState('overview');
  const [ov, setOv] = useState({ planCode: '', status: '', trialEndsAt: '', graceUntil: '', reason: '' });
  const [profile, setProfile] = useState<{ name: string; timezone: string; reason: string } | null>(null);
  const [wsEdit, setWsEdit] = useState<{ w: any; name: string; archived: boolean; reason: string } | null>(null);
  async function saveProfile() {
    if (!profile) return;
    setBusy(true);
    try { await api(`/platform/tenants/${id}/profile`, { method: 'PUT', body: profile }); toast.success('Organization updated'); setProfile(null); refresh(); }
    catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  async function saveWorkspace() {
    if (!wsEdit) return;
    setBusy(true);
    try { await api(`/platform/tenants/${id}/workspaces/${wsEdit.w.id}`, { method: 'PUT', body: { name: wsEdit.name, archived: wsEdit.archived, reason: wsEdit.reason } }); toast.success('Workspace updated'); setWsEdit(null); refresh(); }
    catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  const canLifecycle = me.permissions.includes('tenants:lifecycle');
  const canRefund = me.permissions.includes('billing:refund');
  const [refund, setRefund] = useState<{ invoice: any; amount: string; reason: string; cancel: boolean; key: string } | null>(null);
  async function doRefund() {
    if (!refund) return;
    setBusy(true);
    try {
      const cents = Math.round(Number(refund.amount) * 100);
      const full = cents >= refund.invoice.amountCents - refund.invoice.amountRefundedCents;
      const r = await api<any>(`/platform/tenants/${id}/refunds`, { body: { invoiceId: refund.invoice.id, amountCents: full ? undefined : cents, reason: refund.reason, cancelSubscription: refund.cancel, requestKey: refund.key } });
      toast.success(`Refund ${r.status === 'succeeded' ? 'completed' : 'requested — it completes when the provider confirms it'}`); setRefund(null); refresh();
    } catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['platform-tenant', id] }); void qc.invalidateQueries({ queryKey: ['platform-tenants'] }); };
  async function runAction() {
    setBusy(true);
    try { await api(`/platform/tenants/${id}/lifecycle`, { body: { action: action!.id, reason } }); toast.success(`${action!.label}: done`); setAction(null); setReason(''); refresh(); }
    catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  async function saveOverride() {
    setBusy(true);
    try {
      await api(`/platform/tenants/${id}/subscription`, { body: { planCode: ov.planCode || undefined, status: ov.status || undefined, trialEndsAt: ov.trialEndsAt ? new Date(ov.trialEndsAt).toISOString() : undefined, graceUntil: ov.graceUntil ? new Date(ov.graceUntil).toISOString() : undefined, reason: ov.reason } });
      toast.success('Subscription updated'); setOverride(false); refresh();
    } catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const d = q.data; const o = d.organization;
  const ent = d.state.entitlements;
  // Limits only mean something when they come from a plan, trial or grace period (not self-hosted, not blocked).
  const limited = ['plan', 'trial', 'grace'].includes(d.state.source);
  return (
    <>
      <Link href="/platform/tenants" className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-600 hover:text-ink"><ArrowLeft className="h-4 w-4" aria-hidden />All tenants</Link>
      <PageHeader title={o.name} subtitle={<span className="flex flex-wrap items-center gap-2"><Badge color={statusColor(o.status)}>{o.status.toLowerCase().replace(/_/g, ' ')}</Badge><code>{o.id}</code><span>created {fmtDate(o.createdAt)}</span></span>}
        actions={<>
          {o.status !== 'DELETED' && <LoginAsButton orgId={id} who={`${o.name} (owner)`} label="Log in as owner" size="md" variant="primary" />}
          {canLifecycle && o.status !== 'DELETED' && <Button variant="secondary" icon={Pencil} onClick={() => setProfile({ name: o.name, timezone: o.timezone ?? 'UTC', reason: '' })}>Edit</Button>}
          {canLifecycle && <>{(ACTIONS[o.status] ?? []).map((a) => <Button key={a.id} variant={a.danger ? 'danger' : 'secondary'} onClick={() => setAction(a)}>{a.label}</Button>)}<Button variant="ghost" onClick={() => setOverride(true)}>Override subscription</Button></>}
        </>} />
      {d.state.reason && <div className="mb-4"><Notice kind={d.state.operational ? 'warning' : 'danger'}>{d.state.reason}</Notice></div>}
      <Tabs tabs={[{ id: 'overview', label: 'Overview' }, { id: 'members', label: 'Members', count: d.members.length }, { id: 'modules', label: 'Modules & limits' }, ...(me.permissions.includes('data:read') ? [{ id: 'data', label: 'All data' }] : [])]} active={tab} onChange={setTab} />
      {tab === 'data' && <TenantData orgId={id} />}
      {tab === 'members' && <TenantMembers orgId={id} canChange={canLifecycle && o.status !== 'DELETED'} />}
      {tab === 'modules' && <TenantModules orgId={id} canChange={canLifecycle && o.status !== 'DELETED'} />}
      <div className={`grid gap-4 lg:grid-cols-3 ${tab === 'overview' ? '' : 'hidden'}`}>
        <Card title="Subscription">
          {o.subscription ? <dl className="space-y-1 text-sm">
            <div><span className="text-slate-500">Plan</span> <b>{o.subscription.plan.name}</b></div>
            <div><span className="text-slate-500">Status</span> {o.subscription.status.toLowerCase()} · {o.subscription.provider ?? 'no provider'} · per {o.subscription.interval}</div>
            {o.subscription.trialEndsAt && <div><span className="text-slate-500">Trial ends</span> {fmtDay(o.subscription.trialEndsAt)}</div>}
            {o.subscription.currentPeriodEnd && <div><span className="text-slate-500">Period ends</span> {fmtDay(o.subscription.currentPeriodEnd)}{o.subscription.cancelAtPeriodEnd && ' (cancels)'}</div>}
            {o.subscription.graceUntil && <div><span className="text-slate-500">Grace until</span> {fmtDay(o.subscription.graceUntil)}</div>}
            <div className="text-xs text-slate-500">Entitlements from: {d.state.source}</div>
          </dl> : <p className="text-sm text-slate-500">No subscription (self-hosted mode or not provisioned).</p>}
        </Card>
        <Card title="Usage now" className="lg:col-span-2" actions={!limited ? <span className="text-xs text-slate-500">{d.state.source === 'unlimited' ? 'Self-hosted: no limits' : 'No active entitlements'}</span> : undefined}>
          <Table head={['', 'Used', 'Limit']}>
            {[['Members', d.usage.counts.users, ent.maxUsers], ['Workspaces', d.usage.counts.workspaces, ent.maxWorkspaces], ['Mailboxes', d.usage.counts.mailboxes, ent.maxMailboxes], ['Running campaigns', d.usage.counts.runningCampaigns, ent.maxActiveCampaigns], ['Leads', d.usage.counts.leads, ent.maxLeads], ['Emails sent this month', d.usage.metered.email_sends ?? 0, ent.monthlyEmailSends], ['AI cost this month (USD)', ((d.usage.metered.ai_cost_micro_usd ?? 0) / 1e6).toFixed(2), ent.monthlyAiUsd]].map(([k, u, l]) => <tr key={k as string}><td className="td">{k}</td><td className="td tnum">{u}</td><td className="td tnum">{!limited ? '—' : (l as number) >= 1e9 ? 'Unlimited' : (l as number).toLocaleString()}</td></tr>)}
          </Table>
        </Card>
        <Card title="Workspaces" className="lg:col-span-2">
          <Table head={['Name', 'Leads', 'Campaigns', 'Mailboxes', 'Members', '']}>
            {d.workspaces.map((w: any) => <tr key={w.id}><td className="td font-semibold">{w.name}{w.archivedAt && <span className="ml-1 text-xs font-normal text-slate-500">(archived)</span>}</td><td className="td tnum">{w.counts.leads}</td><td className="td tnum">{w.counts.campaigns}</td><td className="td tnum">{w.counts.emailAccounts}</td><td className="td tnum">{w.counts.members}</td>
              <td className="td whitespace-nowrap text-right">
                {!w.archivedAt && o.status !== 'DELETED' && <LoginAsButton orgId={id} workspaceId={w.id} who={`${w.name} (owner)`} label="Open" variant="ghost" />}
                {me.permissions.includes('data:read') && <Link className={`${LINK_BTN_SM} !border-0 !shadow-none`} href={`/platform/data/Workspace/${w.id}`}><Database className="h-3.5 w-3.5" aria-hidden />Data</Link>}
                {canLifecycle && o.status !== 'DELETED' && <Button size="sm" variant="ghost" onClick={() => setWsEdit({ w, name: w.name, archived: !!w.archivedAt, reason: '' })}>Edit</Button>}
              </td></tr>)}
          </Table>
        </Card>
        <Card title="Members" actions={<button className="text-xs font-semibold text-brand-700 hover:underline" onClick={() => setTab('members')}>Manage</button>}>
          <ul className="space-y-2 text-sm">{d.members.map((m: any) => <li key={m.user.id}><b>{m.user.name}</b> <span className="text-xs text-slate-500">{m.role.toLowerCase()}</span><br /><span className="text-xs text-slate-500">{m.user.email}{m.user.mfaEnabled ? ' · 2FA' : ''}{!m.user.emailVerifiedAt ? ' · unverified' : ''}</span></li>)}</ul>
        </Card>
        <Card title="Integrations (status only)">
          {d.integrations.length + d.mailboxes.length === 0 ? <p className="text-sm text-slate-500">None configured.</p> : <ul className="space-y-1 text-sm">
            {d.mailboxes.map((m: any, i: number) => <li key={`m${i}`}>{m.provider.toLowerCase()} mailbox · <span className="text-slate-500">{m.status.toLowerCase()}</span></li>)}
            {d.integrations.map((x: any, i: number) => <li key={`i${i}`}>{x.type} · <span className="text-slate-500">{x.isEnabled ? 'enabled' : 'disabled'}{x.lastTestedAt ? ` · last test ${x.lastTestOk ? 'ok' : 'failed'}` : ''}</span></li>)}
          </ul>}
          <p className="mt-2 text-xs text-slate-500">Credentials are never shown here.</p>
        </Card>
        <Card title="Status history">
          <ul className="space-y-2 text-sm">{o.statusHistory.map((h: any) => <li key={h.id}><b>{(h.fromStatus ?? '—').toLowerCase()} → {h.toStatus.toLowerCase()}</b><br /><span className="text-xs text-slate-500">{fmtDate(h.createdAt)}{h.reason ? ` · ${h.reason}` : ''}</span></li>)}</ul>
        </Card>
        <Card title="Invoices">
          {d.invoices.length === 0 ? <p className="text-sm text-slate-500">No invoices.</p> : <Table head={['Date', 'Amount', 'Status', '']}>{d.invoices.map((i: any) => <tr key={i.id}><td className="td text-xs">{fmtDay(i.createdAt)}</td><td className="td tnum">{(i.amountCents / 100).toFixed(2)} {i.currency.toUpperCase()}{i.amountRefundedCents > 0 && <span className="block text-xs text-slate-500">refunded {(i.amountRefundedCents / 100).toFixed(2)}</span>}</td><td className="td text-xs">{i.status.replace(/_/g, ' ')}</td><td className="td text-right">{canRefund && ['paid', 'partially_refunded'].includes(i.status) && i.providerPaymentId && <Button size="sm" variant="ghost" onClick={() => setRefund({ invoice: i, amount: ((i.amountCents - i.amountRefundedCents) / 100).toFixed(2), reason: '', cancel: false, key: crypto.randomUUID() })}>Refund</Button>}</td></tr>)}</Table>}
        </Card>
        <Card title="Audit" className="lg:col-span-3">
          <Table head={['When', 'Action', 'Reason', 'Detail']}>{d.audit.map((a: any) => <tr key={a.id}><td className="td whitespace-nowrap text-xs">{fmtDate(a.createdAt)}</td><td className="td text-xs font-semibold">{a.action}</td><td className="td text-xs">{a.reason ?? ''}</td><td className="td max-w-[420px] truncate text-xs text-slate-500">{a.targetId ?? ''}</td></tr>)}</Table>
        </Card>
      </div>
      <Modal open={!!action} title={`${action?.label ?? ''} — ${o.name}`} onClose={() => setAction(null)} footer={<><Button variant="ghost" onClick={() => setAction(null)}>Back</Button><Button variant={action?.danger ? 'danger' : 'primary'} loading={busy} disabled={reason.trim().length < 5} onClick={runAction}>{action?.label}</Button></>}>
        {action?.id === 'purge_now' && <div className="mb-3"><Notice kind="danger">This permanently erases every workspace, record and file of this tenant. It cannot be undone.</Notice></div>}
        <Field label="Reason" hint="Required. Stored in the tenant's status history and the platform audit trail."><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
      <Modal open={!!refund} title={`Refund invoice of ${refund ? (refund.invoice.amountCents / 100).toFixed(2) : ''} ${refund?.invoice.currency.toUpperCase() ?? ''}`} onClose={() => setRefund(null)} footer={<><Button variant="ghost" onClick={() => setRefund(null)}>Back</Button><Button variant="danger" loading={busy} disabled={!refund || refund.reason.trim().length < 5 || !(Number(refund.amount) > 0)} onClick={doRefund}>Request refund</Button></>}>
        {refund && <>
          <Notice kind="warning">This asks {refund.invoice.provider} to return real money to the customer. It cannot be undone.</Notice>
          <Field label={`Amount (${refund.invoice.currency.toUpperCase()})`} hint="Up to what has not been refunded yet."><Input type="number" min={0.01} step="0.01" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} /></Field>
          <Field label="Reason" hint="Required; recorded in the audit trail."><Textarea rows={2} value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={refund.cancel} onChange={(e) => setRefund({ ...refund, cancel: e.target.checked })} />Also end the subscription now</label>
        </>}
      </Modal>
      <Modal open={!!profile} title={`Edit ${o.name}`} onClose={() => setProfile(null)} footer={<><Button variant="ghost" onClick={() => setProfile(null)}>Back</Button><Button loading={busy} disabled={!profile || profile.reason.trim().length < 5 || profile.name.trim().length < 2} onClick={saveProfile}>Save</Button></>}>
        {profile && <>
          <Field label="Organization name"><Input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></Field>
          <Field label="Time zone" hint="IANA name, for example Asia/Kolkata or America/New_York."><Input value={profile.timezone} onChange={(e) => setProfile({ ...profile, timezone: e.target.value })} /></Field>
          <Field label="Reason" hint="Required; recorded in the audit trail."><Textarea rows={2} value={profile.reason} onChange={(e) => setProfile({ ...profile, reason: e.target.value })} /></Field>
          <p className="text-xs text-slate-500">Anything else about this organization can be changed in the <Link className="underline" href={`/platform/data/Organization/${id}`}>data explorer</Link>.</p>
        </>}
      </Modal>
      <Modal open={!!wsEdit} title={`Edit workspace ${wsEdit?.w.name ?? ''}`} onClose={() => setWsEdit(null)} footer={<><Button variant="ghost" onClick={() => setWsEdit(null)}>Back</Button><Button loading={busy} disabled={!wsEdit || wsEdit.reason.trim().length < 5} onClick={saveWorkspace}>Save</Button></>}>
        {wsEdit && <>
          <Field label="Name"><Input value={wsEdit.name} onChange={(e) => setWsEdit({ ...wsEdit, name: e.target.value })} /></Field>
          <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={wsEdit.archived} onChange={(e) => setWsEdit({ ...wsEdit, archived: e.target.checked })} />Archived (hidden from members; data kept)</label>
          <Field label="Reason" hint="Required; recorded in the audit trail."><Textarea rows={2} value={wsEdit.reason} onChange={(e) => setWsEdit({ ...wsEdit, reason: e.target.value })} /></Field>
        </>}
      </Modal>
      <Modal open={override} title="Override subscription" onClose={() => setOverride(false)} footer={<><Button variant="ghost" onClick={() => setOverride(false)}>Back</Button><Button loading={busy} disabled={ov.reason.trim().length < 5} onClick={saveOverride}>Apply</Button></>}>
        <Field label="Plan code"><Input value={ov.planCode} onChange={(e) => setOv({ ...ov, planCode: e.target.value })} placeholder={o.subscription?.plan.code ?? 'growth'} /></Field>
        <Field label="Status"><Select value={ov.status} onChange={(e) => setOv({ ...ov, status: e.target.value })} options={[{ value: '', label: 'Unchanged' }, ...['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE'].map((s) => ({ value: s, label: s.toLowerCase() }))]} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Trial ends"><Input type="date" value={ov.trialEndsAt} onChange={(e) => setOv({ ...ov, trialEndsAt: e.target.value })} /></Field><Field label="Grace until"><Input type="date" value={ov.graceUntil} onChange={(e) => setOv({ ...ov, graceUntil: e.target.value })} /></Field></div>
        <Field label="Reason" hint="Required; recorded in the audit trail."><Textarea rows={2} value={ov.reason} onChange={(e) => setOv({ ...ov, reason: e.target.value })} /></Field>
      </Modal>
    </>
  );
}
