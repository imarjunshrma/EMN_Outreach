'use client';

import { TrackingTotals, type TrackingCounts } from '@/components/tracking-totals';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { qs, type Paged } from '@/lib/api';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate, fullName } from '@/lib/format';
import { Badge, Button, Card, Checkbox, ConfirmButton, Empty, Field, Input, Notice, PageHeader, Pagination, QueryView, Select, Table, Tabs, Textarea, TimezoneSelect } from '@/components/ui';
import { ReviewPanel } from '@/components/review-panel';
import { CampaignAiPanel, VersionsPanel, PreviewPanel } from '@/components/personalization';
import { GeneratePanel } from '@/components/ai/generate-panel';
import { useAiOwner } from '@/components/ai/hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Variant { label: string; subject: string; body: string; weight: number; aiInstructions?: string | null }
interface Step { delayDays: number; threadMode: string; personalizationMode: string; condition: string; aiInstructions?: string | null; variants: Variant[] }
const DAYS = [{ v: 1, l: 'Mon' }, { v: 2, l: 'Tue' }, { v: 3, l: 'Wed' }, { v: 4, l: 'Thu' }, { v: 5, l: 'Fri' }, { v: 6, l: 'Sat' }, { v: 7, l: 'Sun' }];
const VARS = ['firstName', 'lastName', 'company.name', 'title', 'city', 'sender.name', 'aiFirstLine', 'bookingLink'];

export default function CampaignDetail() {
  const ws = useWs();
  const { id } = useParams<{ id: string }>();
  const q = useWsQuery<any>(`/campaigns/${id}`);
  const [tab, setTab] = useState('sequence');
  const owner = useAiOwner();
  const [validation, setValidation] = useState<{ blocking: string[]; warnings: string[]; recipients: { total: number; eligible: number; excluded: Record<string, number> } } | null>(null);
  const validate = useWsMutation(() => ({ path: `/campaigns/${id}/validate`, body: {} }), { invalidate: false, onSuccess: (r: any) => setValidation(r) });
  const action = useWsMutation<{ a: string; body?: unknown }>((x) => ({ path: `/campaigns/${id}/${x.a}`, body: x.body ?? {} }), { success: (r: any) => (r?.status ? `Campaign ${String(r.status).toLowerCase()}` : 'Done'), onSuccess: (r: any) => r?.blocking && setValidation(r) });
  const del = useWsMutation(() => ({ path: `/campaigns/${id}`, method: 'DELETE' }), { success: 'Deleted', onSuccess: () => { window.location.href = `/w/${ws}/campaigns`; } });
  const dup = useWsMutation(() => ({ path: `/campaigns/${id}/duplicate`, body: {} }), { success: 'Campaign duplicated', onSuccess: (r: any) => { window.location.href = `/w/${ws}/campaigns/${r.id}`; } });
  useEffect(() => { if (q.data && !validation) validate.mutate(); }, [q.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <QueryView q={q}>
      {(c) => (
        <>
          <PageHeader title={c.name} subtitle={<><Badge>{c.status === 'PREPARING' ? 'Active · AI preparation' : c.status}</Badge><span className="ml-2 text-xs">Campaign email sending {c.status === 'RUNNING' ? 'enabled' : 'off'}</span>{c.approvedAt && <span className="ml-2 text-xs">approved {fmtDate(c.approvedAt)}</span>}{c.pauseReason && <span className="ml-2 text-xs text-amber-700">{c.pauseReason}</span>}</>}
            actions={<>
              <Button variant="secondary" loading={validate.isPending} onClick={() => validate.mutate()}>Validate</Button>
              {['DRAFT', 'PREPARING'].includes(c.status) && <Button loading={action.isPending} onClick={() => { setTab('ai'); action.mutate({ a: 'prepare' }); }}>{c.status === 'PREPARING' ? 'Run preparation again' : 'Activate AI preparation'}</Button>}
              {c.status === 'PREPARING' && <Button variant="secondary" onClick={() => action.mutate({ a: 'pause' })}>Stop preparation</Button>}
              {['DRAFT', 'PENDING_APPROVAL'].includes(c.status) && c.status === 'DRAFT' && <Button onClick={() => action.mutate({ a: 'submit' })} loading={action.isPending}>Submit for approval</Button>}
              {c.status === 'PENDING_APPROVAL' && <Button onClick={() => action.mutate({ a: 'approve' })} loading={action.isPending}>Approve</Button>}
              {['APPROVED', 'PAUSED'].includes(c.status) && <Button onClick={() => action.mutate({ a: 'start' })} loading={action.isPending}>{c.status === 'PAUSED' ? 'Resume' : 'Start sending'}</Button>}
              {c.status === 'RUNNING' && <Button variant="secondary" onClick={() => action.mutate({ a: 'pause', body: { reason: 'Paused by user' } })}>Pause</Button>}
              {!['RUNNING', 'ARCHIVED'].includes(c.status) && <ConfirmButton variant="ghost" confirm="Archive this campaign? All sequences stop." onConfirm={() => action.mutate({ a: 'archive' })}>Archive</ConfirmButton>}
              <Button variant="ghost" loading={dup.isPending} onClick={() => dup.mutate()}>Duplicate</Button>
              {c.status === 'DRAFT' && <ConfirmButton variant="ghost" confirm="Delete this draft?" onConfirm={() => del.mutate()}>Delete</ConfirmButton>}
            </>} />
          {c.status === 'PREPARING' && <div className="mb-4"><Notice>Review draft status and content in AI personalization. For new research, mark supported claims, then run preparation again. To enable campaign sending later, stop preparation and follow the campaign approval and start steps.</Notice></div>}
          {validation && (
            <div className="mb-4 space-y-2">
              {validation.blocking.length > 0 && <Notice kind="danger"><b>Must fix before approval:</b><ul className="list-disc pl-5">{validation.blocking.map((b) => <li key={b}>{b}</li>)}</ul></Notice>}
              {validation.warnings.length > 0 && <Notice kind="warning"><ul className="list-disc pl-5">{validation.warnings.map((b) => <li key={b}>{b}</li>)}</ul></Notice>}
              <Notice>Recipients in selected lists: <b>{validation.recipients.total}</b> · currently eligible: <b>{validation.recipients.eligible}</b>{Object.keys(validation.recipients.excluded).length > 0 && <> · excluded: {Object.entries(validation.recipients.excluded).map(([k, v]) => `${k} (${v})`).join('; ')}</>}</Notice>
            </div>
          )}
          {['APPROVED', 'RUNNING', 'PAUSED'].includes(c.status) && <div className="mb-4"><Notice kind="warning">Editing the sequence or settings sends this campaign back for approval and stops sending until it is re-approved.</Notice></div>}
          <Tabs active={tab} onChange={setTab} tabs={[{ id: 'sequence', label: 'Sequence builder' }, { id: 'ai', label: 'AI personalization' }, ...(owner.allowed ? [{ id: 'mygen', label: 'Generate with my AI' }] : []), { id: 'preview', label: 'Preview & test' }, { id: 'settings', label: 'Settings & schedule' }, { id: 'audience', label: 'Lists & mailboxes' }, { id: 'recipients', label: 'Recipients' }, { id: 'review', label: 'Review queue' }, { id: 'log', label: 'Send log' }, { id: 'activity', label: 'Activity' }, { id: 'results', label: 'A/B & step results' }, { id: 'versions', label: 'Versions' }]} />
          {tab === 'sequence' && <SequenceBuilder campaign={c} />}
          {tab === 'ai' && <CampaignAiPanel campaign={c} />}
          {tab === 'mygen' && owner.allowed && <MyAiGenerate campaignId={c.id} />}
          {tab === 'preview' && <PreviewPanel campaign={c} />}
          {tab === 'versions' && <VersionsPanel campaign={c} />}
          {tab === 'settings' && <SettingsForm campaign={c} />}
          {tab === 'audience' && <Audience campaign={c} />}
          {tab === 'recipients' && <Recipients id={id} canGenerate={owner.allowed} />}
          {tab === 'review' && <ReviewPanel campaignId={id} />}
          {tab === 'log' && <SendLog id={id} />}
          {tab === 'activity' && <CampaignActivity id={id} />}
          {tab === 'results' && <StepResults id={id} />}
        </>
      )}
    </QueryView>
  );
}

function SequenceBuilder({ campaign }: { campaign: any }) {
  const [steps, setSteps] = useState<Step[]>([]);
  useEffect(() => {
    setSteps((campaign.sequence?.steps ?? []).map((s: any) => ({ delayDays: s.delayDays, threadMode: s.threadMode, personalizationMode: s.personalizationMode, condition: s.condition, aiInstructions: s.aiInstructions ?? '', variants: s.variants.map((v: any) => ({ label: v.label, subject: v.subject, body: v.body, weight: v.weight, aiInstructions: v.aiInstructions ?? '' })) })));
  }, [campaign]);
  const save = useWsMutation(() => ({ path: `/campaigns/${campaign.id}/sequence`, method: 'PUT', body: { steps } }), { success: 'Sequence saved' });
  const upd = (i: number, patch: Partial<Step>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const updV = (i: number, k: number, patch: Partial<Variant>) => upd(i, { variants: steps[i].variants.map((v, j) => (j === k ? { ...v, ...patch } : v)) });
  let day = 1;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">Variables: {VARS.map((v) => <code key={v} className="mr-1 rounded bg-slate-100 px-1 text-xs">{`{{${v}}}`}</code>)} · fallback syntax <code className="rounded bg-slate-100 px-1 text-xs">{'{{firstName|there}}'}</code>. An unsubscribe link and your postal address are added to every email automatically.</p>
      {steps.map((s, i) => {
        day += i === 0 ? 0 : s.delayDays;
        return (
          <div key={i} className="relative">
            {i > 0 && <div className="mb-2 ml-6 border-l-2 border-dashed border-slate-300 py-1 pl-4 text-xs text-slate-500">wait {s.delayDays} day(s){s.condition !== 'ALWAYS' ? ` · only ${s.condition.replace(/_/g, ' ').toLowerCase()}` : ''} · stops automatically on reply, unsubscribe, bounce, complaint or suppression</div>}
            <Card title={<>Step {i + 1} <span className="text-xs font-normal text-slate-500">· around day {day}</span></>} actions={steps.length > 1 && <Button variant="ghost" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>Remove step</Button>}>
              <div className="grid gap-3 md:grid-cols-4">
                {i > 0 && <Field label="Delay (days after previous)"><Input type="number" min={0} max={90} value={s.delayDays} onChange={(e) => upd(i, { delayDays: Number(e.target.value) })} /></Field>}
                {i > 0 && <Field label="Thread"><Select value={s.threadMode} onChange={(e) => upd(i, { threadMode: e.target.value })} options={[{ value: 'REPLY_IN_THREAD', label: 'Reply in same thread' }, { value: 'NEW_THREAD', label: 'New email thread' }]} /></Field>}
                <Field label="Personalisation"><Select value={s.personalizationMode} onChange={(e) => upd(i, { personalizationMode: e.target.value })} options={[{ value: 'TEMPLATE_ONLY', label: 'Template only' }, { value: 'AI_FIRST_LINE', label: 'AI first line ({{aiFirstLine}})' }, { value: 'AI_FULL', label: 'AI writes full email' }]} /></Field>
                {i > 0 && s.condition !== 'ALWAYS' && <Field label="Legacy open condition" hint="Switch to a scheduled follow-up before requesting approval.">
                  <Button variant="secondary" onClick={() => upd(i, { condition: 'ALWAYS' })}>Use scheduled follow-up</Button>
                </Field>}
              </div>
              {s.personalizationMode !== 'TEMPLATE_ONLY' && <div className="mt-3"><Field label="AI instructions for this step" hint="Applied after workspace and campaign instructions; wins on conflict (except hard safety rules). E.g. “Step 2: relevant follow-up with a different business angle.”"><Textarea rows={2} value={s.aiInstructions ?? ''} onChange={(e) => upd(i, { aiInstructions: e.target.value })} /></Field></div>}
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                {s.variants.map((v, k) => (
                  <div key={k} className="rounded-md border border-slate-200 p-3">
                    <div className="mb-2 flex items-center justify-between"><span className="text-sm font-semibold">Variant {v.label}</span><div className="flex items-center gap-2"><span className="text-xs text-slate-500">weight</span><Input className="w-16" type="number" min={1} max={100} value={v.weight} onChange={(e) => updV(i, k, { weight: Number(e.target.value) })} />{s.variants.length > 1 && <Button variant="ghost" onClick={() => upd(i, { variants: s.variants.filter((_, j) => j !== k) })}>✕</Button>}</div></div>
                    <Field label={i === 0 || s.threadMode === 'NEW_THREAD' ? 'Subject' : 'Subject (empty = “Re: ” + first subject)'}><Input value={v.subject} onChange={(e) => updV(i, k, { subject: e.target.value })} /></Field>
                    <Field label={s.personalizationMode === 'TEMPLATE_ONLY' ? 'Body' : 'Body / structure template for the AI'}><Textarea rows={8} value={v.body} onChange={(e) => updV(i, k, { body: e.target.value })} /></Field>
                    {s.personalizationMode !== 'TEMPLATE_ONLY' && <Field label="AI angle for this variant (A/B)" hint="e.g. “lead with a question about their content”"><Input value={v.aiInstructions ?? ''} onChange={(e) => updV(i, k, { aiInstructions: e.target.value })} /></Field>}
                  </div>
                ))}
              </div>
              {s.variants.length < 5 && <Button variant="secondary" className="mt-2" onClick={() => upd(i, { variants: [...s.variants, { label: String.fromCharCode(65 + s.variants.length), subject: s.variants[0]?.subject ?? '', body: s.variants[0]?.body ?? '', weight: 1 }] })}>Add A/B variant</Button>}
            </Card>
          </div>
        );
      })}
      <div className="flex gap-2">
        {steps.length < 10 && <Button variant="secondary" onClick={() => setSteps([...steps, { delayDays: steps.length === 1 ? 3 : 4, threadMode: 'REPLY_IN_THREAD', personalizationMode: 'TEMPLATE_ONLY', condition: 'ALWAYS', variants: [{ label: 'A', subject: '', body: 'Hi {{firstName|there}},\n\nJust following up on my note above.\n\n{{sender.name}}', weight: 1 }] }])}>Add follow-up step</Button>}
        <Button loading={save.isPending} onClick={() => save.mutate()}>Save sequence</Button>
      </div>
    </div>
  );
}

function SettingsForm({ campaign }: { campaign: any }) {
  const [f, setF] = useState<any>(null);
  useEffect(() => setF({ name: campaign.name, timezone: campaign.timezone, useLeadTimezone: campaign.useLeadTimezone, sendingWindow: campaign.sendingWindow, dailyNewLeadLimit: campaign.dailyNewLeadLimit, dailySendLimit: campaign.dailySendLimit, sendingPolicy: campaign.sendingPolicy ?? null, stopOnReply: campaign.stopOnReply, stopOnAutoReply: campaign.stopOnAutoReply, reviewMode: campaign.reviewMode, requireFactCheck: true, trackOpens: campaign.trackOpens, trackClicks: campaign.trackClicks, requireVerifiedEmail: campaign.requireVerifiedEmail, minLeadScore: campaign.minLeadScore, maxBounceRatePct: campaign.maxBounceRatePct, maxComplaints: campaign.maxComplaints, usePregeneratedAi: true, scheduledStartAt: campaign.scheduledStartAt }), [campaign]);
  const save = useWsMutation(() => ({ path: `/campaigns/${campaign.id}`, method: 'PATCH', body: f }), { success: 'Settings saved' });
  if (!f) return null;
  const w = f.sendingWindow;
  return (
    <Card title="Settings & schedule">
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Fallback time zone (IANA)" hint="Used when a lead has no time zone"><TimezoneSelect value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field>
        <div className="pt-6"><Checkbox label="Send in each recipient’s local time" checked={f.useLeadTimezone} onChange={(v) => setF({ ...f, useLeadTimezone: v })} /></div>
        <Field label="Sending days"><div className="flex flex-wrap gap-2">{DAYS.map((d) => <label key={d.v} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={w.days.includes(d.v)} onChange={(e) => setF({ ...f, sendingWindow: { ...w, days: e.target.checked ? [...w.days, d.v].sort() : w.days.filter((x: number) => x !== d.v) } })} />{d.l}</label>)}</div></Field>
        <Field label="Window start"><Input type="time" value={w.start} onChange={(e) => setF({ ...f, sendingWindow: { ...w, start: e.target.value } })} /></Field>
        <Field label="Window end"><Input type="time" value={w.end} onChange={(e) => setF({ ...f, sendingWindow: { ...w, end: e.target.value } })} /></Field>
        <Field label="New prospects per day"><Input type="number" min={1} value={f.dailyNewLeadLimit} onChange={(e) => setF({ ...f, dailyNewLeadLimit: Number(e.target.value) })} /></Field>
        <Field label="Max emails per day (campaign)" hint="Each mailbox also has its own daily limit"><Input type="number" min={1} value={f.dailySendLimit} onChange={(e) => setF({ ...f, dailySendLimit: Number(e.target.value) })} /></Field>
        <Field label="Mailbox sending strategy" hint="The strictest running campaign policy applies to every campaign sharing a mailbox. Existing mailbox and workspace limits still apply.">
          <Select value={f.sendingPolicy?.mode ?? 'STANDARD'} options={[
            { value: 'STANDARD', label: 'Standard' }, { value: 'GRADUAL', label: 'Gradual ramp-up' }, { value: 'MANUAL', label: 'Manual cap' },
          ]} onChange={event => {
            const mode = event.target.value;
            setF({ ...f, sendingPolicy: mode === 'STANDARD' ? null : mode === 'MANUAL' ? { mode, maximum: f.dailySendLimit } : {
              mode, starting: 1, maximum: Math.min(f.dailySendLimit, 2000), increase: 1, qualifyingDays: 3, minimumDailySample: 1,
            } });
          }} />
        </Field>
        {f.sendingPolicy && <Field label="Maximum daily sends per mailbox"><Input type="number" min={1} max={2000} value={f.sendingPolicy.maximum}
          onChange={event => setF({ ...f, sendingPolicy: { ...f.sendingPolicy, maximum: Number(event.target.value) } })} /></Field>}
        {f.sendingPolicy?.mode === 'GRADUAL' && ([
          ['starting', 'Starting daily target'], ['increase', 'Increase per qualifying period'],
          ['qualifyingDays', 'Healthy sending days per increase'], ['minimumDailySample', 'Minimum accepted submissions per qualifying day'],
        ] as const).map(([key, label]) => <Field key={key} label={label}><Input type="number" min={1} value={f.sendingPolicy[key]}
          onChange={event => setF({ ...f, sendingPolicy: { ...f.sendingPolicy, [key]: Number(event.target.value) } })} /></Field>)}
        <Field label="Minimum lead score (optional)"><Input type="number" min={0} max={100} value={f.minLeadScore ?? ''} onChange={(e) => setF({ ...f, minLeadScore: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
        <Field label="Human review"><Select value={f.reviewMode} onChange={(e) => setF({ ...f, reviewMode: e.target.value })} options={[{ value: 'AI_CONTENT_ONLY', label: 'Review AI-written emails' }, { value: 'ALL', label: 'Review every email' }, { value: 'NONE', label: 'No review (fact-check still applies)' }]} /></Field>
        <Field label="Auto-pause if bounce rate above (%)"><Input type="number" step="0.5" value={f.maxBounceRatePct} onChange={(e) => setF({ ...f, maxBounceRatePct: Number(e.target.value) })} /></Field>
        <Field label="Scheduled start (optional)" hint="No new prospects are enrolled before this time"><Input type="datetime-local" value={f.scheduledStartAt ? String(f.scheduledStartAt).slice(0, 16) : ''} onChange={(e) => setF({ ...f, scheduledStartAt: e.target.value ? new Date(e.target.value).toISOString() : null })} /></Field>
        <Field label="Auto-pause after complaints"><Input type="number" min={1} value={f.maxComplaints} onChange={(e) => setF({ ...f, maxComplaints: Number(e.target.value) })} /></Field>
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-2">
        <Checkbox label="Stop sequence when the prospect replies" checked={f.stopOnReply} onChange={(v) => setF({ ...f, stopOnReply: v })} />
        <Checkbox label="Also stop on auto-replies (out of office)" checked={f.stopOnAutoReply} onChange={(v) => setF({ ...f, stopOnAutoReply: v })} />
        <Checkbox label="Mandatory fact-check for AI-generated emails" hint="Required evidence and quality protection; cannot be disabled for campaign AI content" checked disabled onChange={() => undefined} />
        <Checkbox label="Pre-generate AI personalization before sending" hint="Required so research, service-fit, quality and approval gates run before a message is queued" checked disabled onChange={() => undefined} />
        <Checkbox label="Only email verified addresses (VALID / catch-all)" checked={f.requireVerifiedEmail} onChange={(v) => setF({ ...f, requireVerifiedEmail: v })} />
        <Checkbox label="Open tracking (optional)" hint="Adds a pixel; reduces deliverability; opens are estimates" checked={f.trackOpens} onChange={(v) => setF({ ...f, trackOpens: v })} />
        <Checkbox label="Click tracking (optional)" hint="Rewrites links through your server" checked={f.trackClicks} onChange={(v) => setF({ ...f, trackClicks: v })} />
      </div>
      <Button className="mt-4" loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button>
    </Card>
  );
}

function Audience({ campaign }: { campaign: any }) {
  const ws = useWs();
  const lists = useWsQuery<Array<{ id: string; name: string; memberCount: number }>>('/lists');
  const accounts = useWsQuery<Array<{ id: string; emailAddress: string; status: string; dailySendLimit: number; sentToday: number }>>('/email-accounts');
  const [listIds, setListIds] = useState<string[]>([]);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  useEffect(() => { setListIds(campaign.lists.map((l: any) => l.listId)); setAccountIds(campaign.accounts.map((a: any) => a.emailAccountId)); }, [campaign]);
  const saveLists = useWsMutation(() => ({ path: `/campaigns/${campaign.id}/lists`, method: 'PUT', body: { listIds } }), { success: 'Lists saved' });
  const saveAccounts = useWsMutation(() => ({ path: `/campaigns/${campaign.id}/accounts`, method: 'PUT', body: { accountIds } }), { success: 'Mailboxes saved' });
  const toggle = (arr: string[], set: (v: string[]) => void, v: string) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Lead lists" actions={<Link className="text-sm text-brand-700" href={`/w/${ws}/leads/lists`}>Manage lists</Link>}>
        {(lists.data ?? []).length === 0 ? <Empty title="No lists">Create a list and add leads to it first.</Empty> : (lists.data ?? []).map((l) => <Checkbox key={l.id} label={`${l.name} (${l.memberCount})`} checked={listIds.includes(l.id)} onChange={() => toggle(listIds, setListIds, l.id)} />)}
        <Button className="mt-3" loading={saveLists.isPending} onClick={() => saveLists.mutate()}>Save lists</Button>
      </Card>
      <Card title="Sending mailboxes" actions={<Link className="text-sm text-brand-700" href={`/w/${ws}/email-accounts`}>Manage mailboxes</Link>}>
        <p className="mb-2 text-xs text-slate-500">Each prospect is assigned one mailbox when enrolled and keeps it for every follow-up and reply. There is no rotation between mailboxes.</p>
        {(accounts.data ?? []).length === 0 ? <Empty title="No mailboxes connected" /> : (accounts.data ?? []).map((a) => <Checkbox key={a.id} label={`${a.emailAddress} — ${a.status.toLowerCase()} · ${a.sentToday}/${a.dailySendLimit} today`} checked={accountIds.includes(a.id)} onChange={() => toggle(accountIds, setAccountIds, a.id)} />)}
        <Button className="mt-3" loading={saveAccounts.isPending} onClick={() => saveAccounts.mutate()}>Save mailboxes</Button>
      </Card>
    </div>
  );
}

function Recipients({ id, canGenerate }: { id: string; canGenerate?: boolean }) {
  const ws = useWs();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useWsQuery<Paged<any>>(`/campaigns/${id}/recipients${qs({ status, page, pageSize: 50 })}`);
  const stop = useWsMutation<string>((eid) => ({ path: `/enrollments/${eid}/stop`, body: {} }), { success: 'Stopped' });
  return (
    <>
      <Select className="mb-3 w-56" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} options={[{ value: '', label: 'Any status' }, ...['ACTIVE', 'PAUSED', 'COMPLETED', 'STOPPED_REPLIED', 'STOPPED_BOUNCED', 'STOPPED_UNSUBSCRIBED', 'STOPPED_SUPPRESSED', 'STOPPED_COMPLAINT', 'STOPPED_INELIGIBLE', 'STOPPED_MANUAL', 'FAILED'].map((s) => ({ value: s, label: s.toLowerCase().replace(/_/g, ' ') }))]} />
      <QueryView q={q} isEmpty={(d) => d.total === 0} empty={<Empty title="No recipients enrolled yet">Prospects are enrolled gradually (per your daily limit) once the campaign is running.</Empty>}>
        {(d) => (
          <div className="card p-2">
            <Table head={['Prospect', 'Status', 'Step', 'Next send', 'Mailbox', 'Reason', '']}>
              {d.data.map((e: any) => <tr key={e.id}><td className="td"><Link className="text-brand-700 hover:underline" href={`/w/${ws}/leads/${e.lead.id}`}>{fullName(e.lead)}</Link><div className="text-xs text-slate-500">{e.lead.email}</div>{canGenerate && <Link className="text-xs text-brand-700 underline" href={`/w/${ws}/leads/${e.lead.id}?tab=ai&campaign=${id}`}>Generate emails</Link>}</td><td className="td"><Badge>{e.status}</Badge></td><td className="td">{e.currentStepOrder}</td><td className="td text-xs">{fmtDate(e.nextActionAt)}</td><td className="td text-xs">{e.emailAccount.emailAddress}</td><td className="td text-xs">{e.stopReason}</td><td className="td">{['ACTIVE', 'PAUSED'].includes(e.status) && <Button variant="ghost" onClick={() => stop.mutate(e.id)}>Stop</Button>}</td></tr>)}
            </Table>
            <Pagination page={d.page} totalPages={d.totalPages} total={d.total} onPage={setPage} />
          </div>
        )}
      </QueryView>
    </>
  );
}

/** Owner-only: pick a prospect and generate with a personal-subscription workflow, attributed to this campaign. */
function MyAiGenerate({ campaignId }: { campaignId: string }) {
  const [search, setSearch] = useState('');
  const [leadId, setLeadId] = useState<string | null>(null);
  const leads = useWsQuery<Paged<any>>(`/leads${qs({ q: search || undefined, pageSize: 10 })}`);
  return (
    <div className="space-y-4">
      <Card title="Prospect">
        <Field label="Find a prospect"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, email or company" /></Field>
        <div className="flex flex-wrap gap-2">
          {(leads.data?.data ?? []).map((l: any) => (
            <button key={l.id} type="button" aria-pressed={leadId === l.id} onClick={() => setLeadId(l.id)} className={`rounded-md border px-2 py-1 text-xs ${leadId === l.id ? 'border-brand-400 bg-brand-50 dark:border-brand-600 dark:bg-brand-950/40' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'}`}>{fullName(l)} · {l.email}</button>
          ))}
        </div>
      </Card>
      {leadId ? <GeneratePanel key={leadId} leadId={leadId} defaultCampaignId={campaignId} /> : <Empty title="Choose a prospect to generate emails" />}
    </div>
  );
}

function SendLog({ id }: { id: string }) {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useWsQuery<Paged<any>>(`/outbound${qs({ campaignId: id, status, page, pageSize: 50 })}`, { refetchInterval: 20_000 });
  return (
    <>
      <Select className="mb-3 w-56" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} options={[{ value: '', label: 'Any status' }, ...['PENDING', 'AWAITING_APPROVAL', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'SKIPPED'].map((s) => ({ value: s, label: s.toLowerCase().replace(/_/g, ' ') }))]} />
      <QueryView q={q} isEmpty={(d) => d.total === 0} empty={<Empty title="Nothing sent yet" />}>
        {(d) => (
          <div className="card p-2">
            <Table head={['To', 'Step / variant', 'Status', 'Subject', 'Scheduled', 'Sent', 'Attempts', 'Last error']}>
              {d.data.map((o: any) => <tr key={o.id}><td className="td text-sm">{o.toAddress}</td><td className="td">{o.step.order} / {o.variant.label}</td><td className="td"><Badge>{o.status}</Badge>{o.factCheckStatus !== 'NOT_REQUIRED' && <div><Badge>{o.factCheckStatus}</Badge></div>}</td><td className="td max-w-xs truncate text-sm">{o.subject}</td><td className="td text-xs">{fmtDate(o.scheduledFor)}</td><td className="td text-xs">{fmtDate(o.sentAt)}</td><td className="td">{o.attempts}</td><td className="td max-w-xs text-xs text-red-700">{o.lastError}</td></tr>)}
            </Table>
            <Pagination page={d.page} totalPages={d.totalPages} total={d.total} onPage={setPage} />
          </div>
        )}
      </QueryView>
    </>
  );
}

function CampaignActivity({ id }: { id: string }) {
  const ws = useWs();
  const [page, setPage] = useState(1);
  const activity = useWsQuery<Paged<{
    id: string; type: string; occurredAt: string;
    lead: { id: string; email: string; firstName: string | null; lastName: string | null } | null;
    emailAccount: { emailAddress: string } | null;
  }> & { lifetimeTracking: TrackingCounts }>(`/campaigns/${id}/activity${qs({ page, pageSize: 30 })}`);
  return <Card title="Campaign activity">
    <QueryView q={activity} isEmpty={data => !data.total} empty={<Empty title="No campaign events yet" />}>
      {data => <>
        <p className="mb-2 text-xs font-medium">Tracking across all dates</p>
        <TrackingTotals totals={data.lifetimeTracking} />
        <Table head={['When', 'Event', 'Prospect', 'Mailbox']}>{data.data.map(event => <tr key={event.id}>
          <td className="td">{fmtDate(event.occurredAt)}</td>
          <td className="td"><Badge>{event.type === 'SENT' ? 'Provider accepted' : event.type === 'OPENED' ? 'Estimated open' : event.type === 'CLICKED' ? 'Estimated click' : event.type === 'COMPLAINED' ? 'Reply complaint signal' : event.type}</Badge></td>
          <td className="td">{event.lead ? <Link className="underline" href={`/w/${ws}/leads/${event.lead.id}`}>{fullName(event.lead)}</Link> : '—'}</td>
          <td className="td">{event.emailAccount?.emailAddress ?? '—'}</td>
        </tr>)}</Table>
        <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={setPage} />
      </>}
    </QueryView>
  </Card>;
}

function StepResults({ id }: { id: string }) {
  const q = useWsQuery<Array<{ step: number; variant: string; sent: number; replied: number }>>(`/campaigns/${id}/steps`);
  return (
    <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No results yet" />}>
      {(rows) => (
        <Card title="Per step and A/B variant (measured)">
          <Table head={['Step', 'Variant', 'Sent', 'Replies after this step', 'Reply rate']}>
            {rows.map((r) => <tr key={`${r.step}${r.variant}`}><td className="td">{r.step}</td><td className="td">{r.variant}</td><td className="td">{r.sent}</td><td className="td">{r.replied}</td><td className="td">{r.sent ? `${Math.round((r.replied / r.sent) * 1000) / 10}%` : '—'}</td></tr>)}
          </Table>
          <p className="mt-2 text-xs text-slate-500">Each reply is attributed to the latest preceding send in its enrollment.</p>
        </Card>
      )}
    </QueryView>
  );
}
