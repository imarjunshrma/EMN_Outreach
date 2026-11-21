'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, describeError } from '@/lib/api';
import { Badge, Button, Checkbox, ErrorState, Field, Input, Loading, Modal, Notice, PageHeader, Select, Table, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { usePlatform } from '@/components/platform/shell';

/* eslint-disable @typescript-eslint/no-explicit-any */
const LIMITS: Array<[string, string]> = [['maxUsers', 'Members'], ['maxWorkspaces', 'Workspaces'], ['maxMailboxes', 'Mailboxes'], ['maxActiveCampaigns', 'Running campaigns'], ['maxLeads', 'Leads'], ['monthlyEmailSends', 'Emails / month'], ['monthlyAiUsd', 'AI USD / month'], ['monthlyEnrichments', 'Verifications / month'], ['monthlyApiCalls', 'API calls / month'], ['monthlyWorkflowRuns', 'Workflow runs / month'], ['storageMb', 'Storage MB'], ['apiRequestsPerMinute', 'API requests / minute']];
const FEATURES: Array<[string, string]> = [['copilot', 'AI Copilot'], ['workflows', 'Visual workflows'], ['autoReply', 'Narrow auto-reply'], ['waterfall', 'Verification waterfall'], ['apiAccess', 'API & webhooks'], ['agencyWorkspaces', 'Agency workspaces']];
const PRICE_IDS = ['stripe_month', 'stripe_year', 'razorpay_month', 'razorpay_year'];
const BIG = 1_000_000_000;
const blank = () => ({ id: null as string | null, code: '', name: '', description: '', priceMonthly: '0', priceYearly: '0', currency: 'USD', trialDays: 14, isPublic: true, isActive: true, sortOrder: 0, providerPriceIds: {} as Record<string, string>, entitlements: { ...Object.fromEntries(LIMITS.map(([k]) => [k, k === 'maxWorkspaces' || k === 'apiRequestsPerMinute' ? 1 : 0])), features: Object.fromEntries(FEATURES.map(([k]) => [k, false])), integrations: [] as string[] } as any });

export default function Plans() {
  const me = usePlatform(); const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform-plans'], queryFn: () => api<any[]>('/platform/plans') });
  const [edit, setEdit] = useState<ReturnType<typeof blank> | null>(null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const canWrite = me.permissions.includes('plans:write');
  const open = (p?: any) => { setErr(''); setEdit(p ? { id: p.id, code: p.code, name: p.name, description: p.description ?? '', priceMonthly: (p.priceMonthlyCents / 100).toString(), priceYearly: (p.priceYearlyCents / 100).toString(), currency: p.currency, trialDays: p.trialDays, isPublic: p.isPublic, isActive: p.isActive, sortOrder: p.sortOrder, providerPriceIds: { ...(p.providerPriceIds ?? {}) }, entitlements: structuredClone(p.entitlements) } : blank()); };
  async function save() {
    if (!edit) return;
    setBusy(true); setErr('');
    const priceIds = Object.fromEntries(Object.entries(edit.providerPriceIds).filter(([, v]) => v.trim()));
    const body = { code: edit.code, name: edit.name, description: edit.description, priceMonthlyCents: Math.round(Number(edit.priceMonthly) * 100), priceYearlyCents: Math.round(Number(edit.priceYearly) * 100), currency: edit.currency, trialDays: Number(edit.trialDays), isPublic: edit.isPublic, isActive: edit.isActive, sortOrder: Number(edit.sortOrder), providerPriceIds: priceIds, entitlements: edit.entitlements };
    try { await api(edit.id ? `/platform/plans/${edit.id}` : '/platform/plans', { method: edit.id ? 'PUT' : 'POST', body }); toast.success('Plan saved'); setEdit(null); void qc.invalidateQueries({ queryKey: ['platform-plans'] }); }
    catch (e) { setErr(describeError(e)); } finally { setBusy(false); }
  }
  async function archive(p: any) { try { await api(`/platform/plans/${p.id}/archive`, { body: { archived: !p.archivedAt } }); void qc.invalidateQueries({ queryKey: ['platform-plans'] }); } catch (e) { toast.error(describeError(e)); } }
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const setEnt = (k: string, v: unknown) => setEdit((e) => e && { ...e, entitlements: { ...e.entitlements, [k]: v } });
  return (
    <>
      <PageHeader title="Plans" subtitle="The plan catalogue shown on the pricing page and enforced by the server. Changes apply to existing subscribers immediately." actions={canWrite ? <Button onClick={() => open()}>New plan</Button> : undefined} />
      <Table head={['Plan', 'Monthly', 'Yearly', 'Trial', 'Subscribers', 'Visibility', '']}>
        {q.data!.map((p) => (
          <tr key={p.id} className={p.archivedAt ? 'opacity-60' : ''}>
            <td className="td"><b>{p.name}</b> <code className="text-xs">{p.code}</code><p className="text-xs text-slate-500">{p.description}</p></td>
            <td className="td tnum">{(p.priceMonthlyCents / 100).toFixed(2)} {p.currency}</td>
            <td className="td tnum">{(p.priceYearlyCents / 100).toFixed(2)} {p.currency}</td>
            <td className="td tnum">{p.trialDays} d</td>
            <td className="td tnum">{p.subscribers}</td>
            <td className="td">{p.archivedAt ? <Badge>archived</Badge> : p.isPublic ? <Badge color="green">public</Badge> : <Badge>hidden</Badge>}</td>
            <td className="td text-right">{canWrite && <><Button size="sm" variant="ghost" onClick={() => open(p)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => archive(p)}>{p.archivedAt ? 'Unarchive' : 'Archive'}</Button></>}</td>
          </tr>
        ))}
      </Table>
      <Modal wide open={!!edit} title={edit?.id ? `Edit ${edit.name}` : 'New plan'} onClose={() => setEdit(null)} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy} onClick={save}>Save plan</Button></>}>
        {edit && <>
          {err && <div className="mb-3"><Notice kind="danger">{err}</Notice></div>}
          <div className="grid gap-x-4 sm:grid-cols-3">
            <Field label="Code" hint="Lowercase, used in links and the API."><Input value={edit.code} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field>
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Currency"><Input value={edit.currency} maxLength={3} onChange={(e) => setEdit({ ...edit, currency: e.target.value.toUpperCase() })} /></Field>
            <Field label="Monthly price"><Input type="number" min={0} step="0.01" value={edit.priceMonthly} onChange={(e) => setEdit({ ...edit, priceMonthly: e.target.value })} /></Field>
            <Field label="Yearly price"><Input type="number" min={0} step="0.01" value={edit.priceYearly} onChange={(e) => setEdit({ ...edit, priceYearly: e.target.value })} /></Field>
            <Field label="Trial days"><Input type="number" min={0} max={90} value={edit.trialDays} onChange={(e) => setEdit({ ...edit, trialDays: Number(e.target.value) })} /></Field>
          </div>
          <Field label="Description"><Textarea rows={2} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          <div className="flex gap-6"><Checkbox label="Show on pricing page" checked={edit.isPublic} onChange={(v) => setEdit({ ...edit, isPublic: v })} /><Checkbox label="Available for new subscriptions" checked={edit.isActive} onChange={(v) => setEdit({ ...edit, isActive: v })} /></div>
          <p className="mb-2 mt-4 text-sm font-bold">Limits <span className="font-normal text-slate-500">— {BIG.toLocaleString()} or more means unlimited</span></p>
          <div className="grid gap-x-4 sm:grid-cols-3">{LIMITS.map(([k, l]) => <Field key={k} label={l}><Input type="number" min={0} value={edit.entitlements[k]} onChange={(e) => setEnt(k, Number(e.target.value))} /></Field>)}</div>
          <Field label="How monthly allowances apply to yearly billing" hint="Pooled: 12 months of allowance usable at any time during the paid year. Monthly billing always resets each month.">
            <Select value={edit.entitlements.allowancePeriod ?? 'monthly'} onChange={(e) => setEnt('allowancePeriod', e.target.value)} options={[{ value: 'monthly', label: 'Reset every calendar month' }, { value: 'annual_pooled', label: 'Pooled across the paid year' }]} />
          </Field>
          <p className="mb-2 mt-2 text-sm font-bold">Features</p>
          <div className="grid gap-2 sm:grid-cols-3">{FEATURES.map(([k, l]) => <Checkbox key={k} label={l} checked={!!edit.entitlements.features[k]} onChange={(v) => setEnt('features', { ...edit.entitlements.features, [k]: v })} />)}</div>
          <Field label="Allowed integrations" hint="Comma-separated provider ids, or * for all (e.g. openai, anthropic, millionverifier)."><Input value={(edit.entitlements.integrations ?? []).join(', ')} onChange={(e) => setEnt('integrations', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} /></Field>
          <p className="mb-2 mt-2 text-sm font-bold">Payment provider price ids</p>
          <div className="grid gap-x-4 sm:grid-cols-2">{PRICE_IDS.map((k) => <Field key={k} label={k.replace('_', ' · ')}><Input value={edit.providerPriceIds[k] ?? ''} placeholder={k.startsWith('stripe') ? 'price_…' : 'plan_…'} onChange={(e) => setEdit({ ...edit, providerPriceIds: { ...edit.providerPriceIds, [k]: e.target.value } })} /></Field>)}</div>
        </>}
      </Modal>
    </>
  );
}
