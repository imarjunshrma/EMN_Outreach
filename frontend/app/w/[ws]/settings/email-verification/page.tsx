'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { Button, Card, Field, Input, Notice, PageHeader, QueryView, Select } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function EmailVerificationSettings() {
  const ws = useWs();
  const q = useWsQuery<any>('');
  const [s, setS] = useState<any>(null);
  useEffect(() => { if (q.data?.settings) setS(q.data.settings); }, [q.data]);
  const save = useWsMutation(() => ({ path: '', method: 'PATCH', body: { settings: s } }), { success: 'Email verification settings saved' });
  const set = (key: string, value: unknown) => setS({ ...s, [key]: value });
  return <QueryView q={q}>{() => !s ? null : <>
    <PageHeader title="Email verification" subtitle="Campaign sending requires a fresh, eligible result. The EMN engine uses syntax, DNS and risk signals; SMTP probing is optional and inconclusive acceptance never proves a mailbox exists." actions={<Button loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button>} />
    <div className="mb-4"><Notice kind="warning">Unknown and risky addresses are held by default. The first-party engine cannot confirm that a specific mailbox exists from DNS alone. SMTP probing is disabled unless both this setting and the server environment allow it.</Notice></div>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Automatic verification">
        <Field label="Provider mode" hint="Custom uses only the EMN first-party engine. External uses the selected provider configured in Integrations. Disabled performs no automatic lookup; prospects still need a current eligible result to enter a campaign."><Select value={s.emailVerificationMode} onChange={(e) => set('emailVerificationMode', e.target.value)} options={[{ value: 'custom', label: 'Custom Verification (EMN Engine)' }, { value: 'external', label: 'External configured provider' }, { value: 'disabled', label: 'Disable automatic verification' }]} /></Field>
        <Field label="Verification result freshness (days)"><Input type="number" min={1} max={365} value={s.verificationFreshnessDays} onChange={(e) => set('verificationFreshnessDays', Number(e.target.value))} /></Field>
        <Field label="External provider"><Select value={s.verifierProvider} onChange={(e) => set('verifierProvider', e.target.value)} options={[{ value: 'none', label: 'None configured' }, { value: 'millionverifier', label: 'MillionVerifier' }]} /></Field>
        {s.emailVerificationMode === 'external' && <div className="mt-2"><Notice kind="warning">External mode uses only configured provider credentials and the selected verifier waterfall. Configure providers under <Link className="underline" href={`/w/${ws}/settings/integrations`}>Integrations</Link> and <Link className="underline" href={`/w/${ws}/settings/policies`}>Security & AI policies</Link>. If no verifier credential is available, prospects remain held.</Notice></div>}
      </Card>
      <Card title="Eligibility rules">
        <Field label="Unknown result"><Select value={s.verificationUnknownPolicy} onChange={(e) => set('verificationUnknownPolicy', e.target.value)} options={[{ value: 'hold', label: 'Hold for review (recommended)' }, { value: 'allow', label: 'Allow explicitly' }]} /></Field>
        <Field label="Disposable address"><Select value={s.verificationDisposablePolicy} onChange={(e) => set('verificationDisposablePolicy', e.target.value)} options={[{ value: 'block', label: 'Block (recommended)' }, { value: 'allow', label: 'Allow explicitly' }]} /></Field>
        <Field label="Role-based address"><Select value={s.verificationRolePolicy} onChange={(e) => set('verificationRolePolicy', e.target.value)} options={[{ value: 'review', label: 'Hold for review (recommended)' }, { value: 'block', label: 'Block' }, { value: 'allow', label: 'Allow explicitly' }]} /></Field>
      </Card>
      <Card title="Optional SMTP probe">
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={s.verificationSmtpProbeEnabled} onChange={(e) => set('verificationSmtpProbeEnabled', e.target.checked)} />Allow SMTP probing for this workspace</label>
        <p className="mt-3 text-xs text-slate-500">The server must also have EMAIL_VERIFY_SMTP_ENABLED=true and a configured EMAIL_VERIFY_MAIL_FROM. To distinguish a recipient-specific acceptance from catch-all behavior, the operator must additionally set EMAIL_VERIFY_CATCH_ALL_ENABLED=true on the API and worker. A recipient is marked VALID only when the MX accepts it and rejects one randomized control; if both are accepted it is marked CATCH_ALL (suspected from one probe). Without that control, acceptance remains UNKNOWN. Provider policy, rate limits and timeouts still apply. No DATA command or test email is sent.</p>
      </Card>
      <Card title="Bulk and individual checks">
        <p className="text-sm text-slate-600">CSV batches, individual checks, progress, retries and exports are available under <Link className="underline" href={`/w/${ws}/enrichment`}>Verification</Link>. Campaign enrollment queues a check when the result is missing or stale and keeps the prospect out of the send queue until eligible.</p>
      </Card>
    </div>
  </>}</QueryView>;
}
