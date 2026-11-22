'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, describeError } from '@/lib/api';
import { Button, Card, ErrorState, Field, Input, Loading, Notice, Select, Table, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Data = {
  mode: 'saas' | 'self_hosted'; plan: { code: string; name: string } | null;
  base: Record<string, any> | null; overrides: Record<string, any>; effective: Record<string, any>;
  featureKeys: string[]; limitKeys: string[];
};

const FEATURE: Record<string, [string, string]> = {
  copilot: ['AI Copilot', 'Chat assistant that drafts and analyses inside the app'],
  workflows: ['Workflows', 'Automations triggered by replies, stages and schedules'],
  autoReply: ['Automatic AI replies', 'Replies sent without a person approving them'],
  waterfall: ['Enrichment waterfall', 'Tries several data providers in turn'],
  apiAccess: ['API access', 'API keys and programmatic access'],
  agencyWorkspaces: ['Multiple workspaces', 'Separate workspaces for clients or brands'],
};
const LIMIT: Record<string, string> = {
  maxUsers: 'Members', maxWorkspaces: 'Workspaces', maxMailboxes: 'Mailboxes', maxActiveCampaigns: 'Running campaigns', maxLeads: 'Leads',
  monthlyEmailSends: 'Emails sent per month', monthlyAiUsd: 'AI spend per month (USD)', monthlyEnrichments: 'Enrichments per month',
  monthlyApiCalls: 'API calls per month', monthlyWorkflowRuns: 'Workflow runs per month', storageMb: 'File storage (MB)', apiRequestsPerMinute: 'API requests per minute',
};
const fmt = (n: unknown) => typeof n !== 'number' ? '—' : n >= 1e9 ? 'Unlimited' : n.toLocaleString();

export function TenantModules({ orgId, canChange }: { orgId: string; canChange: boolean }) {
  const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform-tenant-modules', orgId], queryFn: () => api<Data>(`/platform/tenants/${orgId}/modules`) });
  const [features, setFeatures] = useState<Record<string, '' | 'on' | 'off'>>({});
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    const o = q.data.overrides;
    setFeatures(Object.fromEntries(q.data.featureKeys.map((k) => [k, o.features?.[k] === true ? 'on' : o.features?.[k] === false ? 'off' : ''])));
    setLimits(Object.fromEntries(q.data.limitKeys.map((k) => [k, typeof o[k] === 'number' ? String(o[k]) : ''])));
  }, [q.data]);

  async function save() {
    if (!q.data) return;
    setBusy(true);
    try {
      const body = {
        features: Object.fromEntries(q.data.featureKeys.map((k) => [k, features[k] === 'on' ? true : features[k] === 'off' ? false : null])),
        limits: Object.fromEntries(q.data.limitKeys.map((k) => [k, limits[k]?.trim() ? Number(limits[k]) : null])),
        integrations: null, reason,
      };
      const r = await api<Data>(`/platform/tenants/${orgId}/modules`, { method: 'PUT', body });
      qc.setQueryData(['platform-tenant-modules', orgId], r); void qc.invalidateQueries({ queryKey: ['platform-tenant', orgId] });
      setReason(''); toast.success('Modules and limits saved. They apply immediately');
    } catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const d = q.data;
  const from = d.mode === 'self_hosted' ? 'Self-hosted (no limits)' : d.plan ? `${d.plan.name} plan` : 'No plan';
  const badLimit = Object.values(limits).some((v) => v.trim() && !(Number(v) >= 0));
  return (
    <div className="grid gap-4">
      <Notice>Choose “Inherit” to use what the {d.mode === 'self_hosted' ? 'installation allows' : 'plan includes'}, or switch a module on or off for this tenant only. Changes take effect on the tenant’s next request.</Notice>
      <Card title="Modules">
        <Table head={['Module', `From ${from}`, 'This tenant', 'Now']}>
          {d.featureKeys.map((k) => (
            <tr key={k} data-testid={`module-${k}`}>
              <td className="td"><b>{FEATURE[k]?.[0] ?? k}</b><p className="text-xs text-slate-500">{FEATURE[k]?.[1]}</p></td>
              <td className="td text-sm">{d.base ? (d.base.features?.[k] ? 'Included' : 'Not included') : '—'}</td>
              <td className="td"><Select disabled={!canChange} className="!w-32 !py-1.5 text-sm" aria-label={`${FEATURE[k]?.[0] ?? k} setting`} value={features[k] ?? ''} onChange={(e) => setFeatures({ ...features, [k]: e.target.value as '' | 'on' | 'off' })} options={[{ value: '', label: 'Inherit' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} /></td>
              <td className="td text-sm font-semibold">{d.effective.features?.[k] ? <span className="text-emerald-700">On</span> : <span className="text-slate-500">Off</span>}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Limits">
        <Table head={['Limit', `From ${from}`, 'This tenant', 'Now']}>
          {d.limitKeys.map((k) => (
            <tr key={k}>
              <td className="td">{LIMIT[k] ?? k}</td>
              <td className="td tnum text-sm">{d.base ? fmt(d.base[k]) : '—'}</td>
              <td className="td"><Input disabled={!canChange} className="!w-36 !py-1.5 text-sm" type="number" min={0} placeholder="Inherit" aria-label={`${LIMIT[k] ?? k} override`} value={limits[k] ?? ''} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} /></td>
              <td className="td tnum text-sm font-semibold">{fmt(d.effective[k])}</td>
            </tr>
          ))}
        </Table>
        <p className="mt-2 text-xs text-slate-500">Leave a box empty to inherit. Lowering a limit below current usage blocks new additions; nothing existing is deleted.</p>
      </Card>
      {canChange && <Card>
        <Field label="Reason" hint="Required; recorded in the platform audit trail."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Button loading={busy} disabled={reason.trim().length < 5 || badLimit} onClick={save}>Save modules and limits</Button>
      </Card>}
    </div>
  );
}
