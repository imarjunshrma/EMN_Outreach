'use client';

import { useEffect, useState } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { Button, Card, Checkbox, Field, Input, Notice, PageHeader, QueryView, Select, Textarea, TimezoneSelect } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function General() {
  const q = useWsQuery<any>('');
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (q.data) setF({ name: q.data.name, timezone: q.data.timezone, senderLegalName: q.data.senderLegalName ?? '', postalAddress: q.data.postalAddress ?? '', settings: q.data.settings }); }, [q.data]);
  const save = useWsMutation(() => ({ path: '', method: 'PATCH', body: { ...f, senderLegalName: f.senderLegalName || null, postalAddress: f.postalAddress || null, settings: { ...f.settings, bookingLink: f.settings.bookingLink || null, trackingBaseUrl: f.settings.trackingBaseUrl || null } } }), { success: 'Settings saved' });
  const s = f?.settings;
  const setS = (k: string, v: unknown) => setF({ ...f, settings: { ...s, [k]: v } });
  return (
    <QueryView q={q}>
      {() => !f ? null : (
        <>
          <PageHeader title="System settings" subtitle="Sender identity, compliance footer, providers in use, AI context and data retention." actions={<Button loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button>} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Workspace & sender identity">
              <Field label="Workspace name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
              <Field label="Default time zone (IANA)"><TimezoneSelect value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field>
              <Field label="Legal sender name" hint="Shown in every email footer"><Input value={f.senderLegalName} onChange={(e) => setF({ ...f, senderLegalName: e.target.value })} placeholder="Elite Media Networks" /></Field>
              <Field label="Physical postal address" hint="Required in the footer of commercial emails in several countries"><Textarea rows={3} value={f.postalAddress} onChange={(e) => setF({ ...f, postalAddress: e.target.value })} /></Field>
              <Field label="Workspace campaign sends per day" hint="Blank means no workspace cap. This stacks with each mailbox and campaign limit; it counts campaign sends only."><Input type="number" min={1} max={100000} value={s.dailyEmailSendLimit ?? ''} onChange={(e) => setS('dailyEmailSendLimit', e.target.value === '' ? null : Number(e.target.value))} /></Field>
              <Field label="Auto-pause mailbox at hard-bounce rate (%)" hint="Uses the last 30 days after at least the minimum number of sent messages. Blank disables this mailbox-level rule; campaign protections still apply."><Input type="number" min={0.5} max={50} step={0.5} value={s.mailboxAutoPauseBounceRatePct ?? ''} onChange={(e) => setS('mailboxAutoPauseBounceRatePct', e.target.value === '' ? null : Number(e.target.value))} /></Field>
              <Field label="Minimum sent messages before mailbox bounce check"><Input type="number" min={5} max={10000} value={s.mailboxAutoPauseMinSends} onChange={(e) => setS('mailboxAutoPauseMinSends', Number(e.target.value))} /></Field>
              <Field label="Maximum soft-bounce rate for readiness progression (%)" hint="A mailbox above this threshold will not receive a readiness cap increase. It does not override provider limits or automatically resume a mailbox paused for another reason."><Input type="number" min={0.5} max={50} step={0.5} value={s.mailboxReadinessSoftBounceRatePct ?? ''} onChange={(e) => setS('mailboxReadinessSoftBounceRatePct', e.target.value === '' ? null : Number(e.target.value))} /></Field>
            </Card>
            <Card title="Providers in use">
              <Field label="Lead data provider"><Select value={s.leadProvider} onChange={(e) => setS('leadProvider', e.target.value)} options={[{ value: 'none', label: 'None (CSV import only)' }, { value: 'apollo', label: 'Apollo.io' }]} /></Field>
              <Field label="Email verifier"><Select value={s.verifierProvider} onChange={(e) => setS('verifierProvider', e.target.value)} options={[{ value: 'none', label: 'None' }, { value: 'millionverifier', label: 'MillionVerifier' }]} /></Field>
              <Field label="Web search for research"><Select value={s.searchProvider} onChange={(e) => setS('searchProvider', e.target.value)} options={[{ value: 'none', label: 'None (company website only)' }, { value: 'brave', label: 'Brave Search API' }, { value: 'serper', label: 'Serper.dev' }]} /></Field>
              <p className="mt-2 text-xs text-slate-500">Add the keys for selected providers under Integrations.</p>
              <Field label="Booking link (optional)" hint="Available as {{bookingLink}} and offered in AI reply drafts"><Input value={s.bookingLink ?? ''} onChange={(e) => setS('bookingLink', e.target.value)} placeholder="https://cal.com/you/intro" /></Field>
              <Checkbox label="Allow campaign open and click tracking" checked={s.trackingEnabled !== false} onChange={(enabled) => setS('trackingEnabled', enabled)} />
              <Field label="Tracking base URL (optional)" hint="Only used when a campaign enables open/click tracking"><Input value={s.trackingBaseUrl ?? ''} onChange={(e) => setS('trackingBaseUrl', e.target.value)} /></Field>
            </Card>
            <Card title="Facts about your offer (trusted AI context)">
              <Textarea rows={8} value={s.offerFacts} onChange={(e) => setS('offerFacts', e.target.value)} placeholder="We are Elite Media Networks, a content and performance marketing agency. We produce short-form video and podcasts clips for founders and consultants, and run Meta ads. Typical engagement starts at …" />
              <p className="mt-2 text-xs text-slate-500">The AI may state these facts about your own business. It may only state facts about prospects that come from verified research.</p>
            </Card>
            <Card title="Data retention">
              <div className="grid grid-cols-2 gap-3">
                {([['aiOutputs', 'AI outputs (days)'], ['importFiles', 'Uploaded CSV files (days)'], ['domainChecks', 'Domain check history (days)'], ['auditLogs', 'Audit logs (days)']] as const).map(([k, label]) => (
                  <Field key={k} label={label}><Input type="number" value={s.retentionDays[k]} onChange={(e) => setS('retentionDays', { ...s.retentionDays, [k]: Number(e.target.value) })} /></Field>
                ))}
              </div>
              <div className="mt-3"><Notice>Retention runs nightly. Data-subject export and erasure requests are under “Data export & deletion”.</Notice></div>
            </Card>
          </div>
        </>
      )}
    </QueryView>
  );
}
