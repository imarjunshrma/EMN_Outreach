'use client';

import { useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, ConfirmButton, Empty, Field, Input, Notice, PageHeader, QueryView, Select, Table, Tabs } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const EVENT_PRESETS = ['*', 'reply.*', 'campaign.*', 'billing.*', 'workflow.failed', 'domain.*', 'mailbox.*', 'export.ready'];

export default function Reports() {
  const ws = useWs();
  const [tab, setTab] = useState('reports');
  const reports = useWsQuery<any[]>('/reports');
  const channels = useWsQuery<any[]>('/notification-channels');
  const members = useWsQuery<{ members: Array<{ user: { email: string; name: string } }> }>('/members');
  const [r, setR] = useState({ name: '', kind: 'campaign_summary', frequency: 'WEEKLY', recipients: [] as string[] });
  const [preview, setPreview] = useState<string | null>(null);
  const saveR = useWsMutation(() => ({ path: '/reports', body: { ...r, isActive: true } }), { success: 'Report scheduled', onSuccess: () => setR({ ...r, name: '', recipients: [] }) });
  const toggleR = useWsMutation<any>((x) => ({ path: `/reports/${x.id}`, method: 'PUT', body: { name: x.name, kind: x.kind, frequency: x.frequency, recipients: x.recipients, isActive: !x.isActive } }), { success: 'Updated' });
  const delR = useWsMutation<string>((id) => ({ path: `/reports/${id}`, method: 'DELETE' }), { success: 'Deleted' });
  const prev = useWsMutation<string>((kind) => ({ path: `/reports/preview/${kind}`, method: 'GET' }), { invalidate: false, onSuccess: (x: any) => setPreview(x.text) });
  const [c, setC] = useState({ type: 'SLACK', name: '', webhookUrl: '', to: '', events: ['reply.*'] as string[] });
  const saveC = useWsMutation(() => ({ path: '/notification-channels', body: c.type === 'SLACK' ? { type: 'SLACK', name: c.name, webhookUrl: c.webhookUrl, events: c.events } : { type: 'EMAIL', name: c.name, to: c.to, events: c.events } }), { success: 'Channel added', onSuccess: () => setC({ ...c, name: '', webhookUrl: '', to: '' }) });
  const delC = useWsMutation<string>((id) => ({ path: `/notification-channels/${id}`, method: 'DELETE' }), { success: 'Removed' });
  const testC = useWsMutation(() => ({ path: '/notification-channels/test', body: {} }), { success: (x: any) => `Delivered to ${x.delivered} channel(s)` });
  return (
    <>
      <PageHeader title="Reports & alerts" subtitle="Scheduled email reports for your team, and Slack / email alerts for important events. Exports are on the Analytics and Pipeline pages." actions={<><a href={`/api/v1/w/${ws}/analytics/campaigns/export`}><Button variant="secondary">Campaign CSV</Button></a><a href={`/api/v1/w/${ws}/crm/opportunities/export`}><Button variant="secondary">Opportunities CSV</Button></a></>} />
      <Notice>Reports and email alerts are sent through the system mailer (<code>SYSTEM_SMTP_URL</code>), never through your prospecting mailboxes.</Notice>
      <div className="mt-4"><Tabs active={tab} onChange={setTab} tabs={[{ id: 'reports', label: 'Scheduled reports', count: reports.data?.length }, { id: 'channels', label: 'Alert channels', count: channels.data?.length }]} /></div>
      {tab === 'reports' && <div className="grid gap-4 lg:grid-cols-3">
        <Card title="New report">
          <Field label="Name"><Input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="Weekly pipeline" /></Field>
          <Field label="Contents"><Select value={r.kind} onChange={(e) => setR({ ...r, kind: e.target.value })} options={[{ value: 'campaign_summary', label: 'Campaign summary (last 7 days)' }, { value: 'pipeline', label: 'Pipeline & forecast' }, { value: 'ai_cost', label: 'AI spend this month' }]} /></Field>
          <Field label="Frequency"><Select value={r.frequency} onChange={(e) => setR({ ...r, frequency: e.target.value })} options={[{ value: 'DAILY', label: 'Daily' }, { value: 'WEEKLY', label: 'Weekly (Mondays)' }]} /></Field>
          <p className="label mt-2">Recipients (members)</p>
          {(members.data?.members ?? []).map((m) => <label key={m.user.email} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={r.recipients.includes(m.user.email)} onChange={(e) => setR({ ...r, recipients: e.target.checked ? [...r.recipients, m.user.email] : r.recipients.filter((x) => x !== m.user.email) })} />{m.user.name} <span className="text-xs text-slate-500">{m.user.email}</span></label>)}
          <div className="mt-3 flex gap-2"><Button disabled={!r.name || r.recipients.length === 0} loading={saveR.isPending} onClick={() => saveR.mutate()}>Schedule</Button><Button variant="secondary" onClick={() => prev.mutate(r.kind)}>Preview</Button></div>
          {preview && <pre className="mt-3 whitespace-pre-wrap rounded bg-slate-100 p-2 text-xs">{preview}</pre>}
        </Card>
        <div className="lg:col-span-2"><QueryView q={reports} isEmpty={(d) => d.length === 0} empty={<Empty title="No scheduled reports" />}>
          {(rows) => <div className="card p-2"><Table head={['Name', 'Contents', 'Frequency', 'Recipients', 'Last sent', 'Status', '']}>{rows.map((x) => <tr key={x.id}><td className="td">{x.name}</td><td className="td text-xs">{x.kind}</td><td className="td text-xs">{x.frequency}</td><td className="td text-xs">{x.recipients.join(', ')}</td><td className="td text-xs">{fmtDate(x.lastSentAt)}{x.lastError && <div className="text-red-700">{x.lastError}</div>}</td><td className="td">{x.isActive ? <Badge color="green">on</Badge> : <Badge color="gray">off</Badge>}</td><td className="td"><Button variant="ghost" onClick={() => toggleR.mutate(x)}>{x.isActive ? 'Pause' : 'Resume'}</Button><ConfirmButton variant="ghost" confirm="Delete report?" onConfirm={() => delR.mutate(x.id)}>Delete</ConfirmButton></td></tr>)}</Table></div>}
        </QueryView></div>
      </div>}
      {tab === 'channels' && <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Add channel">
          <Field label="Type"><Select value={c.type} onChange={(e) => setC({ ...c, type: e.target.value })} options={[{ value: 'SLACK', label: 'Slack (incoming webhook)' }, { value: 'EMAIL', label: 'Email' }]} /></Field>
          <Field label="Name"><Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} placeholder="#sales-alerts" /></Field>
          {c.type === 'SLACK' ? <Field label="Webhook URL" hint="Slack → Apps → Incoming Webhooks. Stored encrypted; never shown again."><Input type="password" value={c.webhookUrl} onChange={(e) => setC({ ...c, webhookUrl: e.target.value })} placeholder="https://hooks.slack.com/services/…" /></Field> : <Field label="Send to"><Input type="email" value={c.to} onChange={(e) => setC({ ...c, to: e.target.value })} /></Field>}
          <p className="label mt-2">Events</p>
          <div className="flex flex-wrap gap-2">{EVENT_PRESETS.map((e) => <label key={e} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={c.events.includes(e)} onChange={(x) => setC({ ...c, events: x.target.checked ? [...c.events, e] : c.events.filter((y) => y !== e) })} />{e === '*' ? 'everything' : e}</label>)}</div>
          <Button className="mt-3" disabled={!c.name || c.events.length === 0 || (c.type === 'SLACK' ? !c.webhookUrl : !c.to)} loading={saveC.isPending} onClick={() => saveC.mutate()}>Add channel</Button>
        </Card>
        <div className="lg:col-span-2"><QueryView q={channels} isEmpty={(d) => d.length === 0} empty={<Empty title="No alert channels" />}>
          {(rows) => <Card title="Channels" actions={<Button variant="secondary" loading={testC.isPending} onClick={() => testC.mutate()}>Send test</Button>}><Table head={['Name', 'Type', 'Events', 'Status', '']}>{rows.map((x) => <tr key={x.id}><td className="td">{x.name}</td><td className="td">{x.type}</td><td className="td text-xs">{x.events.join(', ')}</td><td className="td">{x.lastError ? <Badge color="red">error</Badge> : <Badge color="green">ok</Badge>}{x.lastError && <div className="text-xs text-red-700">{x.lastError}</div>}</td><td className="td"><ConfirmButton variant="ghost" confirm="Remove channel?" onConfirm={() => delC.mutate(x.id)}>Remove</ConfirmButton></td></tr>)}</Table></Card>}
        </QueryView></div>
      </div>}
    </>
  );
}
