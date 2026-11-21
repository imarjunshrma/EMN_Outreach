'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, describeError } from '@/lib/api';
import { fmtDate, fmtDay } from '@/lib/format';
import { Badge, Button, Card, ConfirmButton, ErrorState, Loading, Notice, Select, Table } from '@/components/ui';
import { useToast } from '@/components/toast';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const money = (cents: number, cur = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(cents / 100);
export const lim = (n: number) => (n >= 1e9 ? 'Unlimited' : n.toLocaleString());

/** The organization's subscription, limits, usage, plans and invoices. Used by Organization → Billing and the workspace shortcut. */
export function BillingPanel({ orgId, checkoutReturned }: { orgId: string; checkoutReturned?: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['org-billing', orgId], queryFn: () => api<any>(`/orgs/${orgId}/billing`) });
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [provider, setProvider] = useState<'stripe' | 'razorpay'>('stripe');
  const [busy, setBusy] = useState<string | null>(null);
  async function run(key: string, path: string, body: unknown, after?: (r: any) => void) {
    setBusy(key);
    try { const r = await api<any>(`/orgs/${orgId}/billing/${path}`, { body }); if (after) after(r); else { toast.success('Saved'); void qc.invalidateQueries({ queryKey: ['org-billing', orgId] }); } }
    catch (e) { toast.error(describeError(e)); } finally { setBusy(null); }
  }
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const b = q.data;
  if (b.mode === 'self_hosted') return <Card title="Self-hosted mode"><p className="text-sm">Billing is turned off on this installation (<code>BILLING_ENABLED</code> is not <code>true</code>), so no plan limits apply. Tenant status, roles and audit still work as usual.</p></Card>;
  const canBill = b.canManageBilling;
  const sub = b.subscription;
  const usageRows: Array<[string, number | string, number]> = [
    ['Members', b.usage.users, b.entitlements.maxUsers], ['Workspaces', b.usage.workspaces, b.entitlements.maxWorkspaces], ['Mailboxes', b.usage.mailboxes, b.entitlements.maxMailboxes],
    ['Running campaigns', b.usage.runningCampaigns, b.entitlements.maxActiveCampaigns], ['Leads', b.usage.leads, b.entitlements.maxLeads],
    ['Emails sent this month', b.usage.email_sends ?? 0, b.entitlements.monthlyEmailSends], ['AI spend this month (USD)', (b.usage.aiUsdThisMonth ?? 0).toFixed(2), b.entitlements.monthlyAiUsd],
    ['Verifications this month', b.usage.enrichments ?? 0, b.entitlements.monthlyEnrichments], ['API calls this month', b.usage.api_calls ?? 0, b.entitlements.monthlyApiCalls], ['Workflow runs this month', b.usage.workflow_runs ?? 0, b.entitlements.monthlyWorkflowRuns],
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-3" data-testid="billing-panel">
      {checkoutReturned && <div className="lg:col-span-3"><Notice>Thanks — the payment page has closed. Your plan changes as soon as the payment provider confirms the payment to us, usually within a minute. Refresh this page to see it.</Notice></div>}
      {b.reason && <div className="lg:col-span-3"><Notice kind={b.active ? 'warning' : 'danger'}>{b.reason}</Notice></div>}
      <Card title="Subscription">
        <p className="text-lg font-bold">{b.plan?.name ?? 'No plan'} {b.status && <Badge>{String(b.status).toLowerCase().replace(/_/g, ' ')}</Badge>}</p>
        {sub && <dl className="mt-2 space-y-1 text-sm">
          {sub.trialEndsAt && b.status === 'TRIALING' && <div>Trial ends {fmtDay(sub.trialEndsAt)}</div>}
          {sub.currentPeriodEnd && <div>{sub.cancelAtPeriodEnd ? 'Ends' : 'Renews'} {fmtDay(sub.currentPeriodEnd)}</div>}
          {sub.graceUntil && <div>Grace period until {fmtDay(sub.graceUntil)}</div>}
          {sub.provider && <div className="text-xs text-slate-500">Paid through {sub.provider === 'manual' ? 'an arrangement with EMN' : sub.provider} · billed per {sub.interval}</div>}
        </dl>}
        {canBill ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {sub?.provider === 'stripe' && <Button variant="secondary" loading={busy === 'portal'} onClick={() => run('portal', 'portal', {}, (r) => { window.location.href = r.url; })}>Payment method & invoices</Button>}
            {sub && sub.provider !== 'manual' && b.status !== 'CANCELED' && !sub.cancelAtPeriodEnd && b.status !== 'TRIALING' && <ConfirmButton variant="ghost" confirm="Cancel at the end of the paid period? You keep full access until then." onConfirm={() => run('cancel', 'cancel', { atPeriodEnd: true })}>Cancel subscription</ConfirmButton>}
            {sub?.cancelAtPeriodEnd && sub.provider === 'stripe' && <Button variant="secondary" loading={busy === 'resume'} onClick={() => run('resume', 'resume', {})}>Keep my subscription</Button>}
          </div>
        ) : <p className="mt-3 text-xs text-slate-500">Only the owner or a billing manager can change the plan or see invoices.</p>}
      </Card>
      <Card title="Usage and limits" className="lg:col-span-2">
        <Table head={['', 'Used', 'Plan limit']}>
          {usageRows.map(([k, u, l]) => <tr key={k}><td className="td">{k}</td><td className="td tnum">{typeof u === 'number' ? u.toLocaleString() : u}</td><td className="td tnum">{b.source === 'none' ? '—' : lim(l)}</td></tr>)}
        </Table>
        <p className="mt-2 text-xs text-slate-500">Monthly allowances reset on the 1st (UTC). Limits are enforced by the server.</p>
      </Card>
      {canBill && (
        <Card title="Plans" className="lg:col-span-3" actions={<><Select className="!w-auto" value={interval} onChange={(e) => setInterval(e.target.value as any)} options={[{ value: 'month', label: 'Monthly' }, { value: 'year', label: 'Yearly' }]} /><Select className="!w-auto" value={provider} onChange={(e) => setProvider(e.target.value as any)} options={[{ value: 'stripe', label: `Card (Stripe)${b.gateways.stripe ? '' : ' — not configured'}` }, { value: 'razorpay', label: `India (Razorpay)${b.gateways.razorpay ? '' : ' — not configured'}` }]} /></>}>
          {!b.gateways[provider] && <div className="mb-3"><Notice kind="warning">{provider === 'stripe' ? 'Stripe' : 'Razorpay'} is not configured on this server yet, so checkout is unavailable. Contact EMN at info@elitemedianetworks.com.</Notice></div>}
          <div className="grid gap-3 md:grid-cols-3">{b.plans.map((p: any) => (
            <div key={p.id} className="rounded-xl border border-slate-200 p-4">
              <p className="font-bold">{p.name} {b.plan?.code === p.code && <Badge color="blue">current</Badge>}</p>
              <p className="mt-1 text-2xl font-bold tnum">{money(interval === 'month' ? p.priceMonthlyCents : p.priceYearlyCents, p.currency)}<span className="text-sm font-normal text-slate-500">/{interval}</span></p>
              <ul className="mt-2 space-y-0.5 text-xs text-slate-600"><li>{lim(p.entitlements.maxUsers)} members · {lim(p.entitlements.maxWorkspaces)} workspaces</li><li>{lim(p.entitlements.maxMailboxes)} mailboxes · {lim(p.entitlements.monthlyEmailSends)} emails / month</li><li>${p.entitlements.monthlyAiUsd} AI / month</li></ul>
              <Button className="mt-3 w-full" disabled={!b.gateways[provider]} loading={busy === p.code} onClick={() => run(p.code, 'checkout', { planCode: p.code, interval, provider }, (r) => { window.location.href = r.url; })}>{b.plan?.code === p.code && b.status === 'ACTIVE' ? 'Change billing' : 'Choose plan'}</Button>
            </div>
          ))}</div>
        </Card>
      )}
      {canBill && <Card title="Invoices" className="lg:col-span-3">{b.invoices.length === 0 ? <p className="text-sm text-slate-500">No invoices yet.</p> : <Table head={['Date', 'Amount', 'Status', 'Period', '']}>{b.invoices.map((i: any) => <tr key={i.id}><td className="td text-xs">{fmtDate(i.createdAt)}</td><td className="td tnum">{money(i.amountCents, i.currency)}</td><td className="td"><Badge>{i.status}</Badge></td><td className="td text-xs">{i.periodStart ? `${fmtDay(i.periodStart)} – ${fmtDay(i.periodEnd)}` : ''}</td><td className="td">{i.hostedUrl && <a className="underline" href={i.hostedUrl} target="_blank" rel="noreferrer">View</a>}</td></tr>)}</Table>}</Card>}
    </div>
  );
}
