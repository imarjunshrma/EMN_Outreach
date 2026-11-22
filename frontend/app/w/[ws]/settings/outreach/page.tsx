'use client';

import { useEffect, useState } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { Button, Card, Field, Input, Notice, PageHeader, QueryView } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const SWITCHES: Array<[string, string, string]> = [
  ['automaticCampaignSending', 'Automatic campaign sending', 'Creates and sends approved campaign messages through the existing scheduler. Turning this off pauses new scheduling and defers queued sends.'],
  ['automaticFollowups', 'Automatic follow-ups', 'Pauses later sequence steps without deleting their enrollment or campaign data. Replies, unsubscribes and suppression always stop sequences.'],
  ['aiReplyClassification', 'AI reply classification', 'Uses configured AI to classify inbound replies; deterministic opt-out handling remains active for compliance.'],
  ['aiFollowupGeneration', 'AI follow-up generation', 'Allows the existing campaign writing pipeline to generate AI-personalized sequence steps.'],
  ['mailboxReadinessManagement', 'Mailbox readiness management', 'Applies a conservative daily volume cap to mailboxes explicitly enrolled under Mailbox Health. Progression is based on real sending history and measured health; it never generates warm-up messages or engagement.'],
];

export default function OutreachAutomationSettings() {
  const q = useWsQuery<any>('');
  const [s, setS] = useState<any>(null);
  useEffect(() => { if (q.data?.settings) setS(q.data.settings); }, [q.data]);
  const save = useWsMutation(() => ({ path: '', method: 'PATCH', body: { settings: s } }), { success: 'Outreach automation settings saved' });
  const set = (key: string, value: unknown) => setS({ ...s, [key]: value });
  return <QueryView q={q}>{() => !s ? null : <>
    <PageHeader title="Outreach automation" subtitle="Workspace controls for campaign scheduling, replies and safety gates." actions={<Button loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button>} />
    <div className="mb-4"><Card title="Emergency pause">
      <p className="mb-3 text-sm text-slate-600">Stops new campaign scheduling and defers queued outbound messages. Existing campaigns, enrollments and job history remain available.</p>
      <label className="flex items-center gap-3 text-sm font-medium"><input type="checkbox" checked={s.emergencyPause} onChange={(e) => set('emergencyPause', e.target.checked)} />Pause all outbound campaign email immediately</label>
      {s.emergencyPause && <div className="mt-3"><Notice kind="warning">Outbound sending is paused across this workspace. Save to apply or clear the pause.</Notice></div>}
    </Card></div>
    <div className="grid gap-4 lg:grid-cols-2">{SWITCHES.map(([key, title, hint]) => <Card key={key} title={title}>
      <p className="mb-3 text-sm text-slate-600">{hint}</p>
      <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={!!s[key]} onChange={(e) => set(key, e.target.checked)} />{s[key] ? 'Enabled' : 'Disabled'}</label>
    </Card>)}</div>
    <div className="mt-4"><Card title="Always-on safety controls">
      <p className="text-sm text-slate-600">Inbound mailbox synchronization, reply sequence stopping, unsubscribe handling, hard-bounce suppression, sending windows, idempotency and send-time compliance checks remain active to prevent unsafe outreach.</p>
    </Card></div>
    <div className="mt-4"><Card title="Sending capacity">
      <p className="mb-3 text-sm text-slate-600">The effective limit is the lowest configured mailbox, campaign, workspace or domain cap.</p>
      <Field label="Workspace sends per day"><Input type="number" min={1} max={100000} value={s.dailyEmailSendLimit ?? ''} onChange={(e) => set('dailyEmailSendLimit', e.target.value ? Number(e.target.value) : null)} /></Field>
      <Field label="Per-domain sends per day" hint="Applies across all connected mailboxes using the same sender domain. Blank disables the additional domain cap."><Input type="number" min={1} max={100000} value={s.dailyDomainSendLimit ?? ''} onChange={(e) => set('dailyDomainSendLimit', e.target.value ? Number(e.target.value) : null)} /></Field>
    </Card></div>
  </>}</QueryView>;
}
