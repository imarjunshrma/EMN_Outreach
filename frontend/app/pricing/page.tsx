'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Minus } from 'lucide-react';
import { api } from '@/lib/api';
import { SiteShell, Section } from '@/components/site/site-shell';

type Ent = { maxUsers: number; maxWorkspaces: number; maxMailboxes: number; maxActiveCampaigns: number; maxLeads: number; monthlyEmailSends: number; monthlyAiUsd: number; monthlyEnrichments: number; monthlyApiCalls: number; monthlyWorkflowRuns: number; features: Record<string, boolean> };
type Plan = { id: string; code: string; name: string; description: string | null; priceMonthlyCents: number; priceYearlyCents: number; currency: string; trialDays: number; entitlements: Ent };

const n = (v: number) => (v >= 1e9 ? 'Unlimited' : v.toLocaleString('en-US'));
const money = (cents: number, cur: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(cents / 100);

const ROWS: Array<[string, (e: Ent) => string | boolean]> = [
  ['Team members', (e) => n(e.maxUsers)],
  ['Workspaces', (e) => n(e.maxWorkspaces)],
  ['Connected mailboxes', (e) => n(e.maxMailboxes)],
  ['Running campaigns', (e) => n(e.maxActiveCampaigns)],
  ['Leads stored', (e) => n(e.maxLeads)],
  ['Emails sent per month', (e) => n(e.monthlyEmailSends)],
  ['AI usage per month', (e) => (e.monthlyAiUsd >= 1e9 ? 'Unlimited' : `$${e.monthlyAiUsd} of model cost`)],
  ['Email verifications per month', (e) => n(e.monthlyEnrichments)],
  ['API calls per month', (e) => n(e.monthlyApiCalls)],
  ['AI Copilot', (e) => e.features.copilot],
  ['Visual workflows', (e) => e.features.workflows],
  ['Reply assistant auto modes', (e) => e.features.autoReply],
  ['Verification waterfall', (e) => e.features.waterfall],
  ['API & webhooks', (e) => e.features.apiAccess],
  ['Client workspaces (agency)', (e) => e.features.agencyWorkspaces],
];

export default function Pricing() {
  const q = useQuery({ queryKey: ['public-plans'], queryFn: () => api<{ billingEnabled: boolean; plans: Plan[] }>('/public/plans') });
  const [yearly, setYearly] = useState(false);
  const plans = q.data?.plans ?? [];
  return (
    <SiteShell>
      <Section className="pb-12 pt-16 text-center lg:pt-20">
        <h1 className="font-display text-[44px] font-bold leading-[1.05] tracking-[-0.04em] sm:text-[54px]">Pricing that grows with your outreach</h1>
        <p className="mx-auto mt-5 max-w-xl text-[17px] text-slate-600">Every plan starts with a free trial. You bring your own mailboxes and AI provider keys, so you pay those providers directly — never a markup.</p>
        <div className="mt-8 inline-flex rounded-xl border border-slate-200 bg-paper p-1" role="group" aria-label="Billing period">
          {[false, true].map((y) => <button key={String(y)} onClick={() => setYearly(y)} aria-pressed={yearly === y} className={`rounded-lg px-4 py-2 text-sm font-bold ${yearly === y ? 'bg-white text-ink shadow-sm' : 'text-slate-500'}`}>{y ? 'Yearly · 2 months free' : 'Monthly'}</button>)}
        </div>
      </Section>

      <Section className="pb-16">
        {q.isLoading && <p className="text-center text-slate-500">Loading plans…</p>}
        {q.error && <p className="text-center text-slate-500">Plans could not be loaded right now. Please refresh, or write to info@elitemedianetworks.com.</p>}
        <div className={`grid gap-5 ${plans.length >= 3 ? 'lg:grid-cols-3' : 'md:grid-cols-2'}`}>
          {plans.map((p, i) => {
            const featured = plans.length >= 3 && i === 1;
            const price = yearly ? p.priceYearlyCents / 12 : p.priceMonthlyCents;
            return (
              <div key={p.id} className={`flex flex-col rounded-2xl border p-7 ${featured ? 'border-ink bg-ink text-white shadow-pop' : 'border-slate-200 bg-white'}`} data-testid={`plan-${p.code}`}>
                <p className="font-display text-[22px] font-bold">{p.name}</p>
                <p className={`mt-1 min-h-[44px] text-[14px] ${featured ? 'text-ink-300' : 'text-slate-600'}`}>{p.description}</p>
                <p className="mt-5"><span className="font-display text-[42px] font-bold tracking-[-0.03em] tnum">{money(price, p.currency)}</span><span className={`text-sm ${featured ? 'text-ink-300' : 'text-slate-500'}`}> / month{yearly ? ', billed yearly' : ''}</span></p>
                <ul className={`mt-6 flex-1 space-y-2.5 text-[14px] ${featured ? 'text-ink-100' : 'text-slate-700'}`}>
                  <li>{n(p.entitlements.maxUsers)} team members · {n(p.entitlements.maxWorkspaces)} workspace{p.entitlements.maxWorkspaces === 1 ? '' : 's'}</li>
                  <li>{n(p.entitlements.maxMailboxes)} mailboxes · {n(p.entitlements.monthlyEmailSends)} emails / month</li>
                  <li>{n(p.entitlements.maxLeads)} leads</li>
                  {p.entitlements.features.agencyWorkspaces && <li className="font-semibold">A workspace for every client</li>}
                </ul>
                <Link href={`/signup?plan=${p.code}`} className={`mt-7 inline-flex h-11 items-center justify-center rounded-xl text-[14px] font-bold ${featured ? 'bg-white text-ink hover:bg-brand-100' : 'bg-ink text-white hover:bg-brand-700'}`}>Start {p.trialDays}-day trial</Link>
              </div>
            );
          })}
        </div>
      </Section>

      {plans.length > 0 && (
        <Section className="pb-24">
          <h2 className="font-display text-[28px] font-bold tracking-[-0.03em]">Compare plans</h2>
          <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-200">
            <table className="w-full min-w-[640px] text-left text-[14px]">
              <thead><tr className="border-b border-slate-200 bg-paper"><th className="px-5 py-3 font-semibold text-slate-500" scope="col"><span className="sr-only">Limit</span></th>{plans.map((p) => <th key={p.id} scope="col" className="px-5 py-3 font-bold">{p.name}</th>)}</tr></thead>
              <tbody>
                {ROWS.map(([label, get]) => (
                  <tr key={label} className="border-b border-slate-100 last:border-0">
                    <th scope="row" className="px-5 py-3 font-semibold text-slate-700">{label}</th>
                    {plans.map((p) => { const v = get(p.entitlements); return <td key={p.id} className="px-5 py-3 tnum">{typeof v === 'boolean' ? (v ? <Check className="h-4 w-4 text-brand-600" aria-label="Included" /> : <Minus className="h-4 w-4 text-slate-300" aria-label="Not included" />) : v}</td>; })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {[
              ['What happens when the trial ends?', 'You choose a plan and pay through Stripe or Razorpay. If you do not, your data stays read-only for you to export — nothing is deleted without notice.'],
              ['What counts as an email sent?', 'Each email a mailbox provider accepts for delivery. Drafts, previews and test sends to yourself do not count.'],
              ['Can I change plans?', 'Yes, at any time from Organization settings → Billing. Upgrades apply as soon as the payment provider confirms them.'],
            ].map(([qq, a]) => <div key={qq}><p className="font-bold">{qq}</p><p className="mt-2 text-[15px] leading-relaxed text-slate-600">{a}</p></div>)}
          </div>
        </Section>
      )}
    </SiteShell>
  );
}
