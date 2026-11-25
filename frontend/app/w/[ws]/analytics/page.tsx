'use client';

import { useState } from 'react';
import { useWsQuery } from '@/lib/hooks';
import { fmtMoney, fmtPct, fmtUsd } from '@/lib/format';
import { Badge, Card, Notice, PageHeader, QueryView, Select, Stat, Table } from '@/components/ui';
import { DailyChart, SimpleBars } from '@/components/charts';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Analytics() {
  const [days, setDays] = useState(30);
  const ov = useWsQuery<any>(`/analytics/overview?days=${days}`);
  const daily = useWsQuery<any[]>(`/analytics/daily?days=${days}`);
  const monthly = useWsQuery<any[]>('/analytics/monthly');
  const camps = useWsQuery<any[]>('/analytics/campaigns');
  const boxes = useWsQuery<any[]>(`/analytics/mailboxes?days=${days}`);
  return (
    <>
      <PageHeader title="Performance" subtitle="Measured numbers come directly from recorded events. Estimates are labelled and explained." actions={<Select className="w-40" value={String(days)} onChange={(e) => setDays(Number(e.target.value))} options={[{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: '365', label: 'Last 12 months' }]} />} />
      <QueryView q={ov}>
        {(o) => (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
              <Stat label="Prospects added" value={o.measured.prospectsAdded} /><Stat label="Qualified" value={o.measured.qualified} hint={`${fmtPct(o.rates.qualificationRatePct)} of added`} /><Stat label="Verified emails" value={o.measured.verifiedEmails} />
              <Stat label="Emails sent" value={o.measured.emailsSent} /><Stat label="Replies" value={o.measured.replies} hint={`${fmtPct(o.rates.replyRatePct)} reply rate`} /><Stat label="Positive replies" value={o.measured.positiveReplies} hint={fmtPct(o.rates.positiveReplyRatePct)} />
              <Stat label="Meetings booked" value={o.measured.meetingsBooked} hint={fmtPct(o.rates.meetingRatePct)} /><Stat label="Hard bounces" value={o.measured.bounces} hint={`${fmtPct(o.rates.bounceRatePct)} bounce rate`} /><Stat label="Unsubscribes" value={o.measured.unsubscribes} />
              <Stat label="Complaints detected" value={o.measured.complaintsDetected} /><Stat label="Send failures" value={o.measured.sendFailures} /><Stat label="Deals won" value={o.measured.wonDeals} />
            </div>
            {o.intelligence && <Card title="Prospect research and email evaluation">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Research reports completed" value={o.intelligence.completedResearch} hint={`${fmtPct(o.intelligence.completionRatePct)} completion · ${o.intelligence.failedResearch} failed`} />
                <Stat label="Drafts passing evaluation" value={o.intelligence.passedDrafts} hint={`${fmtPct(o.intelligence.passRatePct)} of ${o.intelligence.evaluatedDrafts} evaluated`} />
                <Stat label="Model tokens" value={o.intelligence.modelTokens} />
                <Stat label="Embedding tokens" value={o.intelligence.embeddingTokens} />
              </div>
            </Card>}
            <Card title="Estimates (not directly measured)">
              <Table head={['Metric', 'Value', 'Why it is an estimate']}>
                <tr><td className="td">Delivered emails</td><td className="td">{o.estimates.deliveredEmails.value}</td><td className="td text-xs text-slate-500">{o.estimates.deliveredEmails.note}</td></tr>
                <tr><td className="td">Opens</td><td className="td">{o.estimates.opens.value}</td><td className="td text-xs text-slate-500">{o.estimates.opens.note}</td></tr>
                <tr><td className="td">Clicks</td><td className="td">{o.estimates.clicks.value}</td><td className="td text-xs text-slate-500">{o.estimates.clicks.note}</td></tr>
                <tr><td className="td">Won deal value</td><td className="td">{fmtMoney(o.estimates.wonValueCents.value)}</td><td className="td text-xs text-slate-500">{o.estimates.wonValueCents.note}</td></tr>
                <tr><td className="td">AI cost</td><td className="td">{fmtUsd(o.estimates.aiCostUsd.value)}</td><td className="td text-xs text-slate-500">{o.estimates.aiCostUsd.note}</td></tr>
                <tr><td className="td">Complaints</td><td className="td">—</td><td className="td text-xs text-slate-500">{o.estimates.complaints.note}</td></tr>
              </Table>
            </Card>
          </div>
        )}
      </QueryView>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="Daily activity"><QueryView q={daily}>{(r) => <DailyChart rows={r} />}</QueryView></Card>
        <Card title="Monthly activity"><QueryView q={monthly}>{(r) => <SimpleBars rows={r.map((m: any) => ({ label: m.month, sent: m.sent, replied: m.replied, bounced: m.bounced }))} keys={[{ key: 'sent', label: 'Sent', color: '#4f26fc' }, { key: 'replied', label: 'Replies', color: '#0f9d6b' }, { key: 'bounced', label: 'Bounces', color: '#dc2626' }]} />}</QueryView></Card>
      </div>
      <div className="mt-5"><Card title="Campaign performance & attribution">
        <QueryView q={camps} isEmpty={(d) => d.length === 0} empty={<p className="text-sm text-slate-500">No campaigns yet.</p>}>
          {(rows) => <Table head={['Campaign', 'Status', 'Sent', 'Replies', 'Reply rate', 'Positive', 'Bounces', 'Unsubs', 'Complaints', 'Opportunities', 'Pipeline']}>{rows.map((c) => <tr key={c.id}><td className="td">{c.name}</td><td className="td"><Badge>{c.status}</Badge></td><td className="td">{c.sent}</td><td className="td">{c.replies}</td><td className="td">{fmtPct(c.replyRatePct)}</td><td className="td">{c.positive}</td><td className="td">{c.bounces}</td><td className="td">{c.unsubscribes}</td><td className="td">{c.complaints}</td><td className="td">{c.opportunities}</td><td className="td">{fmtMoney(c.pipelineValueCents)}</td></tr>)}</Table>}
        </QueryView>
      </Card></div>
      <div className="mt-5"><Card title="Mailbox performance">
        <QueryView q={boxes} isEmpty={(d) => d.length === 0} empty={<p className="text-sm text-slate-500">No mailboxes yet.</p>}>
          {(rows) => <><Table head={['Mailbox', 'Status', 'Daily limit', 'Sent', 'Replies', 'Reply rate', 'Bounces', 'Bounce rate', 'Failures']}>{rows.map((a) => <tr key={a.id}><td className="td">{a.emailAddress}</td><td className="td"><Badge>{a.status}</Badge></td><td className="td">{a.dailySendLimit}</td><td className="td">{a.sent}</td><td className="td">{a.replies}</td><td className="td">{fmtPct(a.replyRatePct)}</td><td className="td">{a.bounces}</td><td className={`td ${(a.bounceRatePct ?? 0) > 3 ? 'font-semibold text-red-600' : ''}`}>{fmtPct(a.bounceRatePct)}</td><td className="td">{a.failures}</td></tr>)}</Table>
          <div className="mt-2"><Notice>A bounce rate above ~2–3% usually means list quality problems. Verify emails before sending.</Notice></div></>}
        </QueryView>
      </Card></div>
    </>
  );
}
