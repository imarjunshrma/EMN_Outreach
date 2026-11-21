'use client';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Building2 } from 'lucide-react';
import { api, describeError } from '@/lib/api';
import { fmtDate, fmtDay } from '@/lib/format';
import { Badge, Button, Card, ConfirmButton, ErrorState, Field, Input, Loading, Modal, Notice, PageHeader, Select, Table, Tabs, TimezoneSelect } from '@/components/ui';
import { useToast } from '@/components/toast';
import { BillingPanel } from '@/components/org/billing-panel';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Me = { user: { id: string }; organizations: Array<{ id: string; role: string; name: string; status: string }> };
const ROLE_LABEL: Record<string, string> = { OWNER: 'Owner', ADMIN: 'Admin', BILLING: 'Billing', MEMBER: 'Member' };
const STATUS_COLOR: Record<string, 'green' | 'yellow' | 'red' | 'blue' | undefined> = { ACTIVE: 'green', TRIAL: 'blue', PAST_DUE: 'yellow', SUSPENDED: 'red', CANCELLED: 'red', DELETION_PENDING: 'red', PENDING_SETUP: 'yellow' };

function OrgInner() {
  const { orgId } = useParams<{ orgId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState(params.get('tab') ?? 'profile');
  useEffect(() => { const t = params.get('tab'); if (t) setTab(t); }, [params]);
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me') });
  const org = useQuery({ queryKey: ['org', orgId], queryFn: () => api<any>(`/orgs/${orgId}`) });
  if (org.isLoading || me.isLoading) return <Loading />;
  if (org.error || !org.data) return <div className="p-8"><ErrorState error={org.error} /></div>;
  const role = me.data?.organizations.find((o) => o.id === orgId)?.role ?? 'MEMBER';
  const manage = role === 'OWNER' || role === 'ADMIN';
  const o = org.data;
  const tabs = [{ id: 'profile', label: 'Profile' }, { id: 'members', label: 'Members' }, { id: 'workspaces', label: 'Workspaces' }, { id: 'billing', label: 'Billing' }, { id: 'usage', label: 'Usage' }, ...(manage ? [{ id: 'access', label: 'Support access log' }, { id: 'danger', label: 'Data & deletion' }] : [])];
  const go = (t: string) => { setTab(t); router.replace(`/org/${orgId}?tab=${t}`, { scroll: false }); };
  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-slate-200 bg-white"><div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-5"><Link href="/app" className="flex items-center gap-1.5 text-sm font-semibold text-slate-600 hover:text-ink"><ArrowLeft className="h-4 w-4" aria-hidden />Back to the app</Link></div></header>
      <main className="mx-auto max-w-6xl px-5 py-8">
        <PageHeader icon={Building2} title={o.name} subtitle={<span className="flex flex-wrap items-center gap-2">Organization settings <Badge color={STATUS_COLOR[o.status]}>{o.status.toLowerCase().replace(/_/g, ' ')}</Badge>{o.state?.plan && <Badge>{o.state.plan.name}</Badge>}<span className="text-slate-400">· your role: {ROLE_LABEL[role]}</span></span>}
          actions={manage ? <Link className="btn-site-ghost h-9" href={`/onboarding/${orgId}`}>Setup checklist</Link> : undefined} />
        {o.status === 'DELETION_PENDING' && <div className="mb-4"><Notice kind="danger">This organization will be permanently deleted on {fmtDay(o.deletionScheduledFor)}. {role === 'OWNER' ? 'You can cancel this under Data & deletion.' : 'Only the owner can cancel this.'}</Notice></div>}
        {o.state?.reason && o.status !== 'DELETION_PENDING' && <div className="mb-4"><Notice kind={o.state.operational ? 'warning' : 'danger'}>{o.state.reason}</Notice></div>}
        <Tabs tabs={tabs} active={tab} onChange={go} />
        <div className="mt-5">
          {tab === 'profile' && <Profile org={o} canEdit={manage} />}
          {tab === 'members' && <Members orgId={orgId} myRole={role} myId={me.data!.user.id} />}
          {tab === 'workspaces' && <Workspaces orgId={orgId} canManage={manage} />}
          {tab === 'billing' && <BillingPanel orgId={orgId} checkoutReturned={params.get('checkout') === 'success'} />}
          {tab === 'usage' && <Usage orgId={orgId} />}
          {tab === 'access' && manage && <AccessLog orgId={orgId} />}
          {tab === 'danger' && manage && <Danger org={o} isOwner={role === 'OWNER'} />}
        </div>
      </main>
    </div>
  );
}

function Profile({ org, canEdit }: { org: any; canEdit: boolean }) {
  const toast = useToast(); const qc = useQueryClient();
  const b = (org.branding ?? {}) as Record<string, string>;
  const [f, setF] = useState({ name: org.name, timezone: org.timezone ?? 'UTC', locale: org.locale ?? 'en', currency: org.currency ?? 'USD', displayName: b.displayName ?? '', website: b.website ?? '', logoUrl: b.logoUrl ?? '', primaryColor: b.primaryColor ?? '#d134a0' });
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api(`/orgs/${org.id}`, { method: 'PATCH', body: { name: f.name, timezone: f.timezone, locale: f.locale, currency: f.currency, branding: { displayName: f.displayName || undefined, website: f.website, logoUrl: f.logoUrl, primaryColor: f.primaryColor } } }); toast.success('Organization saved'); void qc.invalidateQueries({ queryKey: ['org', org.id] }); void qc.invalidateQueries({ queryKey: ['me'] }); }
    catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Organization">
        <fieldset disabled={!canEdit} className="space-y-0">
          <Field label="Name"><Input value={f.name} onChange={set('name')} /></Field>
          <Field label="Time zone" hint="Default for new workspaces and reports."><TimezoneSelect value={f.timezone} onChange={set('timezone')} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Language"><Select value={f.locale} onChange={set('locale')} options={[{ value: 'en', label: 'English' }, { value: 'en-IN', label: 'English (India)' }, { value: 'en-GB', label: 'English (UK)' }, { value: 'hi', label: 'Hindi' }]} /></Field>
            <Field label="Currency"><Select value={f.currency} onChange={set('currency')} options={['USD', 'INR', 'EUR', 'GBP', 'AUD']} /></Field>
          </div>
        </fieldset>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-500"><div>Created {fmtDate(org.createdAt)}</div><div>Id <code>{org.id.slice(0, 8)}</code></div></dl>
      </Card>
      <Card title="Branding" actions={canEdit ? <Button loading={busy} onClick={save}>Save changes</Button> : undefined}>
        <fieldset disabled={!canEdit}>
          <Field label="Display name" hint="Shown to your team in the app."><Input value={f.displayName} onChange={set('displayName')} placeholder={org.name} /></Field>
          <Field label="Website"><Input type="url" value={f.website} onChange={set('website')} placeholder="https://" /></Field>
          <Field label="Logo URL"><Input type="url" value={f.logoUrl} onChange={set('logoUrl')} placeholder="https://…/logo.png" /></Field>
          <Field label="Brand colour"><div className="flex items-center gap-2"><input type="color" value={f.primaryColor} onChange={set('primaryColor')} className="h-10 w-12 rounded border border-slate-300" aria-label="Brand colour" /><Input value={f.primaryColor} onChange={set('primaryColor')} /></div></Field>
        </fieldset>
        {!canEdit && <p className="text-xs text-slate-500">Only owners and admins can change organization settings.</p>}
      </Card>
    </div>
  );
}

function Members({ orgId, myRole, myId }: { orgId: string; myRole: string; myId: string }) {
  const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['org-members', orgId], queryFn: () => api<any[]>(`/orgs/${orgId}/members`) });
  const manage = myRole === 'OWNER' || myRole === 'ADMIN';
  async function setRole(userId: string, role: string) { try { await api(`/orgs/${orgId}/members/${userId}`, { method: 'PATCH', body: { role } }); toast.success('Role updated'); void qc.invalidateQueries({ queryKey: ['org-members', orgId] }); } catch (e) { toast.error(describeError(e)); } }
  async function remove(userId: string) { try { await api(`/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }); toast.success('Member removed from the organization'); void qc.invalidateQueries({ queryKey: ['org-members', orgId] }); } catch (e) { toast.error(describeError(e)); } }
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const roles = myRole === 'OWNER' ? ['OWNER', 'ADMIN', 'BILLING', 'MEMBER'] : ['ADMIN', 'BILLING', 'MEMBER'];
  return (
    <Card title={`${q.data!.length} member${q.data!.length === 1 ? '' : 's'}`}>
      <p className="mb-3 text-sm text-slate-600">To add someone, invite them from a workspace (Settings → Team). They join the organization as a member with access to that workspace only.</p>
      <Table head={['Person', 'Organization role', 'Workspaces', 'Security', '']}>
        {q.data!.map((m) => (
          <tr key={m.id}>
            <td className="td"><p className="font-semibold">{m.user.name}{m.user.id === myId && <span className="ml-1 text-xs text-slate-500">(you)</span>}</p><p className="text-xs text-slate-500">{m.user.email}</p></td>
            <td className="td">{manage && m.user.id !== myId && (myRole === 'OWNER' || m.role !== 'OWNER') ? <Select className="!h-9 !w-auto" value={m.role} onChange={(e) => setRole(m.user.id, e.target.value)} options={roles.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} aria-label={`Role of ${m.user.name}`} /> : ROLE_LABEL[m.role]}</td>
            <td className="td text-xs">{m.role === 'OWNER' || m.role === 'ADMIN' ? <span className="text-slate-500">All workspaces</span> : m.workspaces.length ? m.workspaces.map((w: any) => `${w.name} (${w.role.toLowerCase()})`).join(', ') : <span className="text-slate-400">None</span>}</td>
            <td className="td text-xs">{m.user.mfaEnabled ? <Badge color="green">2FA on</Badge> : <Badge>2FA off</Badge>}{!m.user.emailVerifiedAt && <span className="ml-1"><Badge color="yellow">unverified</Badge></span>}</td>
            <td className="td text-right">{manage && m.role !== 'OWNER' && m.user.id !== myId && <ConfirmButton variant="ghost" size="sm" confirm={`Remove ${m.user.name} from the organization and all its workspaces?`} onConfirm={() => remove(m.user.id)}>Remove</ConfirmButton>}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function Workspaces({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const toast = useToast(); const qc = useQueryClient(); const router = useRouter();
  const q = useQuery({ queryKey: ['org-workspaces', orgId], queryFn: () => api<any[]>(`/orgs/${orgId}/workspaces`) });
  const [open, setOpen] = useState(false); const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  async function create() {
    setBusy(true); setErr('');
    try { const ws = await api<{ id: string }>(`/orgs/${orgId}/workspaces`, { body: { name } }); void qc.invalidateQueries({ queryKey: ['me'] }); router.push(`/w/${ws.id}/settings/general`); }
    catch (e) { setErr(describeError(e)); } finally { setBusy(false); }
  }
  async function archive(id: string) { try { await api(`/orgs/${orgId}/workspaces/${id}/archive`, { method: 'POST' }); toast.success('Workspace archived'); void qc.invalidateQueries({ queryKey: ['org-workspaces', orgId] }); void qc.invalidateQueries({ queryKey: ['me'] }); } catch (e) { toast.error(describeError(e)); } }
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <Card title="Workspaces" actions={canManage ? <Button onClick={() => setOpen(true)}>Add workspace</Button> : undefined}>
      <p className="mb-3 text-sm text-slate-600">Each workspace keeps its own leads, campaigns, mailboxes, domains and AI settings. Agencies usually create one per client.</p>
      <Table head={['Workspace', 'Your role', '']}>
        {q.data!.map((w) => <tr key={w.id}><td className="td font-semibold"><Link className="hover:underline" href={`/w/${w.id}`}>{w.name}</Link></td><td className="td text-xs">{w.role.toLowerCase()}</td><td className="td text-right">{canManage && q.data!.length > 1 && <ConfirmButton variant="ghost" size="sm" confirm={`Archive “${w.name}”? Its data is kept but members can no longer open it.`} onConfirm={() => archive(w.id)}>Archive</ConfirmButton>}</td></tr>)}
      </Table>
      <Modal open={open} title="Add a workspace" onClose={() => setOpen(false)} footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy} disabled={name.trim().length < 2} onClick={create}>Create workspace</Button></>}>
        {err && <div className="mb-3"><Notice kind="danger">{err}</Notice></div>}
        <Field label="Name" hint="For example the client's or team's name."><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
      </Modal>
    </Card>
  );
}

const METRIC_LABEL: Record<string, string> = { email_sends: 'Emails sent', ai_requests: 'AI requests', ai_tokens: 'AI tokens', ai_cost_micro_usd: 'AI cost (USD)', enrichments: 'Verifications', api_calls: 'API calls', workflow_runs: 'Workflow runs', storage_bytes: 'Storage (MB)' };
const fmtMetric = (m: string, v: number) => (m === 'ai_cost_micro_usd' ? (v / 1e6).toFixed(2) : m === 'storage_bytes' ? (v / 1048576).toFixed(1) : v.toLocaleString());

function Usage({ orgId }: { orgId: string }) {
  const q = useQuery({ queryKey: ['org-usage', orgId], queryFn: () => api<{ current: { period: { start: string; end: string }; counts: Record<string, number>; metered: Record<string, number> }; history: Array<{ metric: string; periodStart: string; value: number }> }>(`/orgs/${orgId}/usage`) });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const { current, history } = q.data;
  const months = [...new Set(history.map((h) => h.periodStart))].sort().reverse();
  const metrics = Object.keys(METRIC_LABEL);
  return (
    <div className="grid gap-4">
      <Card title={`This period · ${fmtDay(current.period.start)} – ${fmtDay(current.period.end)}`}>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Object.entries(current.counts).map(([k, v]) => <div key={k} className="rounded-xl border border-slate-200 p-3"><p className="text-xs text-slate-500">{({ users: 'Members', workspaces: 'Workspaces', mailboxes: 'Mailboxes', runningCampaigns: 'Running campaigns', leads: 'Leads' } as Record<string, string>)[k] ?? k}</p><p className="mt-1 text-xl font-bold tnum">{v.toLocaleString()}</p></div>)}
        </div>
      </Card>
      <Card title="Monthly usage">
        {months.length === 0 ? <p className="text-sm text-slate-500">No metered usage yet. Usage appears here when emails are sent, AI runs, or addresses are verified.</p> : (
          <Table head={['Metric', ...months.map((m) => new Date(m).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }))]}>
            {metrics.filter((m) => history.some((h) => h.metric === m)).map((m) => <tr key={m}><td className="td font-semibold">{METRIC_LABEL[m]}</td>{months.map((p) => { const v = history.find((h) => h.metric === m && h.periodStart === p)?.value ?? 0; return <td key={p} className="td tnum">{fmtMetric(m, v)}</td>; })}</tr>)}
          </Table>
        )}
        <p className="mt-2 text-xs text-slate-500">An email counts when the provider accepts it; AI cost is estimated from provider token prices. Retries are never counted twice.</p>
      </Card>
    </div>
  );
}

function Danger({ org, isOwner }: { org: any; isOwner: boolean }) {
  const toast = useToast(); const qc = useQueryClient();
  const [confirm, setConfirm] = useState(''); const [busy, setBusy] = useState(false);
  async function exportAll() {
    setBusy(true);
    try {
      const csrf = document.cookie.match(/(?:^|;\s*)emn_csrf=([^;]+)/)?.[1] ?? '';
      const r = await fetch(`/api/v1/orgs/${org.id}/export`, { method: 'POST', headers: { 'x-csrf-token': decodeURIComponent(csrf) }, credentials: 'same-origin' });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message ?? `Export failed (${r.status})`);
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a'); a.href = url; a.download = `${org.slug}-export.json`; a.click(); URL.revokeObjectURL(url);
    } catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  async function del() { try { await api(`/orgs/${org.id}/deletion`, { body: { confirmName: confirm } }); toast.success('Deletion scheduled'); void qc.invalidateQueries({ queryKey: ['org', org.id] }); } catch (e) { toast.error(describeError(e)); } }
  async function undo() { try { await api(`/orgs/${org.id}/deletion`, { method: 'DELETE' }); toast.success('Deletion cancelled'); void qc.invalidateQueries({ queryKey: ['org', org.id] }); } catch (e) { toast.error(describeError(e)); } }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Export all data">
        <p className="text-sm text-slate-600">Download one JSON file with the organization and every workspace: leads, companies, campaigns, messages, settings and more. Passwords, tokens and API keys are never included.</p>
        <Button className="mt-3" variant="secondary" loading={busy} onClick={exportAll}>Download export</Button>
      </Card>
      <Card title="Delete organization">
        {org.status === 'DELETION_PENDING' ? (
          <>
            <Notice kind="danger">Scheduled for permanent deletion on {fmtDay(org.deletionScheduledFor)}.</Notice>
            {isOwner && <Button className="mt-3" onClick={undo}>Cancel deletion</Button>}
          </>
        ) : isOwner ? (
          <>
            <p className="text-sm text-slate-600">Campaigns pause now, the subscription is cancelled, and after 14 days every workspace, record and file is erased. You can cancel during those 14 days.</p>
            <Field label={`Type “${org.name}” to confirm`}><Input value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
            <ConfirmButton variant="danger" disabled={confirm !== org.name} confirm="Schedule permanent deletion of this organization?" onConfirm={del}>Delete organization</ConfirmButton>
          </>
        ) : <p className="text-sm text-slate-600">Only the organization owner can delete it.</p>}
      </Card>
    </div>
  );
}

function AccessLog({ orgId }: { orgId: string }) {
  const q = useQuery({ queryKey: ['org-support', orgId], queryFn: () => api<any[]>(`/orgs/${orgId}/support-access`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <Card title="When EMN support looked at your data">
      <p className="mb-3 text-sm text-slate-600">EMN staff can only open your workspaces read-only, for a limited time, with a written reason. Every page they open is recorded.</p>
      {q.data!.length === 0 ? <p className="text-sm text-slate-500">EMN support has never accessed this organization.</p> : (
        <Table head={['Started', 'Staff member', 'Reason', 'Pages viewed', 'Status']}>
          {q.data!.map((g) => <tr key={g.id}><td className="td text-xs">{fmtDate(g.createdAt)}</td><td className="td">{g.staffName}</td><td className="td text-sm">{g.reason}</td><td className="td tnum">{g.pagesViewed}</td><td className="td">{g.active ? <Badge color="red">active until {new Date(g.expiresAt).toLocaleTimeString()}</Badge> : <Badge>{g.revokedAt ? 'ended early' : 'expired'}</Badge>}</td></tr>)}
        </Table>
      )}
    </Card>
  );
}

export default function OrgSettings() { return <Suspense><OrgInner /></Suspense>; }
