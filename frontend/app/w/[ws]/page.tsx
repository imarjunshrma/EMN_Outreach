'use client';

import Link from 'next/link';
import { AlertTriangle, ArrowRight, Plus, CheckCircle2, Circle, ClipboardCheck, Inbox, ListTodo, MailWarning, MessageSquareReply, Send, Sparkles } from 'lucide-react';
import { Badge, Card, QueryView } from '@/components/ui';
import { useWs, useWsQuery } from '@/lib/hooks';
import { DailyChart } from '@/components/charts';

interface Dash {
  sentToday: number; repliesToday: number; positiveOpen: number; reviewQueue: number; tasksDue: number; failedJobs24h: number; unreadConversations: number;
  accountsAttention: Array<{ id: string; emailAddress: string; status: string; statusReason: string | null }>;
  campaigns: Array<{ id: string; name: string; status: string; pauseReason: string | null }>;
  setup: { postalAddress: boolean; aiProvider: boolean; mailbox: boolean; icp: boolean; leads: boolean };
}

function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }

export default function Dashboard() {
  const ws = useWs();
  const q = useWsQuery<Dash>('/dashboard', { refetchInterval: 60_000 });
  const daily = useWsQuery<Array<{ day: string; sent: number; replied: number; bounced: number; leads: number }>>('/analytics/daily?days=14');
  const b = `/w/${ws}`;
  return (
    <QueryView q={q}>
      {(d) => {
        const steps = [
          { ok: d.setup.postalAddress, label: 'Add your sender name and postal address', href: `${b}/settings/general` },
          { ok: d.setup.mailbox, label: 'Connect a sending mailbox', href: `${b}/email-accounts` },
          { ok: d.setup.aiProvider, label: 'Connect an AI model provider', href: `${b}/settings/ai` },
          { ok: d.setup.icp, label: 'Describe your ideal customer', href: `${b}/icps` },
          { ok: d.setup.leads, label: 'Import or discover prospects', href: `${b}/leads/import` },
        ];
        const done = steps.filter((s) => s.ok).length;
        // The day's work, in the order it happens: approve → send → replies arrive → follow up.
        const flow = [
          { label: 'Waiting for your approval', value: d.reviewQueue, href: `${b}/followups`, icon: ClipboardCheck, hot: d.reviewQueue > 0 },
          { label: 'Sent today', value: d.sentToday, href: `${b}/analytics`, icon: Send },
          { label: 'Replies today', value: d.repliesToday, href: `${b}/inbox`, icon: MessageSquareReply },
          { label: 'Positive, not yet answered', value: d.positiveOpen, href: `${b}/inbox`, icon: Inbox, hot: d.positiveOpen > 0 },
          { label: 'Tasks due', value: d.tasksDue, href: `${b}/tasks`, icon: ListTodo, hot: d.tasksDue > 0 },
        ];
        const attention = [
          ...d.accountsAttention.map((a) => ({ key: a.id, icon: MailWarning, text: <><b>{a.emailAddress}</b> is {a.status.toLowerCase().replace(/_/g, ' ')}{a.statusReason ? `: ${a.statusReason}` : ''}</>, href: `${b}/email-accounts`, cta: 'Reconnect' })),
          ...(d.failedJobs24h > 0 ? [{ key: 'jobs', icon: AlertTriangle, text: <><b>{d.failedJobs24h}</b> background job{d.failedJobs24h === 1 ? '' : 's'} failed in the last 24 hours</>, href: `${b}/settings/jobs`, cta: 'Review' }] : []),
          ...(d.unreadConversations > 0 ? [{ key: 'unread', icon: Inbox, text: <><b>{d.unreadConversations}</b> unread conversation{d.unreadConversations === 1 ? '' : 's'}</>, href: `${b}/inbox?unread=true`, cta: 'Open inbox' }] : []),
          ...d.campaigns.filter((c) => c.status === 'PAUSED' && c.pauseReason).map((c) => ({ key: c.id, icon: AlertTriangle, text: <><b>{c.name}</b> paused: {c.pauseReason}</>, href: `${b}/campaigns/${c.id}`, cta: 'Open' })),
        ];
        return (
          <div className="space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 className="text-[34px] font-bold leading-tight tracking-[-0.035em] text-ink">{greeting()}</h1>
                <p className="mt-1 text-sm text-slate-500">Here is today’s outreach, from approval to reply. Numbers come from recorded events only.</p>
              </div>
              <div className="flex gap-2">
                <Link href={`${b}/copilot`} className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-ink-700 shadow-sm hover:bg-slate-50"><Sparkles className="h-4 w-4 text-brand-600" aria-hidden />Ask Copilot</Link>
                <Link href={`${b}/campaigns`} className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white shadow-brand hover:bg-brand-700"><Plus className="h-4 w-4" aria-hidden />New campaign</Link>
              </div>
            </div>

            <section aria-label="Today" className="relative overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-card dark:border-white/10" data-testid="today-flow">
              <div aria-hidden className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-brand-300/25 blur-3xl dark:bg-brand-600/25" />
              <ol className="relative grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
                {flow.map((f, i) => (
                  <li key={f.label} className={`relative ${i > 0 ? 'lg:border-l lg:border-slate-200' : ''}`}>
                    <Link href={f.href} className="group block h-full px-5 py-5 transition-colors hover:bg-brand-50/40">
                      <span className="flex min-h-[2.5rem] items-start gap-2 text-[13px] font-semibold leading-snug text-slate-500"><f.icon className={`mt-0.5 h-4 w-4 shrink-0 ${f.hot ? 'text-brand-600 dark:text-brand-300' : 'text-slate-400'}`} aria-hidden />{f.label}</span>
                      <span className={`font-display mt-2 block text-[44px] font-bold leading-none tracking-[-0.04em] tnum ${f.hot ? 'text-brand-600 dark:text-brand-300' : 'text-ink'}`}>{f.value}</span>
                      <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-slate-400 group-hover:text-brand-700">Open<ArrowRight className="h-3 w-3" aria-hidden /></span>
                    </Link>
                  </li>
                ))}
              </ol>
            </section>

            <div className="grid gap-6 lg:grid-cols-3">
              <div className="space-y-6 lg:col-span-2">
                <Card title="Needs attention">
                  {attention.length === 0 ? (
                    <p className="flex items-center gap-2 text-sm text-slate-600"><CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />Nothing is blocked. Mailboxes, jobs and campaigns are healthy.</p>
                  ) : (
                    <ul className="-my-2 divide-y divide-slate-100">
                      {attention.map((a) => (
                        <li key={a.key} className="flex items-center gap-3 py-2.5 text-sm">
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-700"><a.icon className="h-4 w-4" aria-hidden /></span>
                          <span className="min-w-0 flex-1">{a.text}</span>
                          <Link href={a.href} className="shrink-0 text-sm font-semibold text-brand-700 hover:underline">{a.cta}</Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card title="Last 14 days" actions={<Link className="text-sm font-semibold text-brand-700 hover:underline" href={`${b}/analytics`}>Analytics</Link>}>
                  <QueryView q={daily}>{(rows) => <DailyChart rows={rows} />}</QueryView>
                </Card>
              </div>
              <div className="space-y-6">
                {done < steps.length && (
                  <Card title="Get set up">
                    <div className="mb-3 flex items-center gap-3">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done}><div className="h-full rounded-full bg-brand-600" style={{ width: `${(done / steps.length) * 100}%` }} /></div>
                      <span className="text-xs font-semibold text-slate-500 tnum">{done} of {steps.length}</span>
                    </div>
                    <ul className="space-y-1">
                      {steps.map((s) => (
                        <li key={s.label}>
                          {s.ok ? <span className="flex items-center gap-2.5 py-1 text-sm text-slate-400 line-through"><CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />{s.label}</span>
                            : <Link href={s.href} className="flex items-center gap-2.5 rounded-md py-1 text-sm font-semibold text-ink hover:text-brand-700"><Circle className="h-4 w-4 text-slate-300" aria-hidden />{s.label}</Link>}
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
                <Card title="Campaigns in motion" actions={<Link className="text-sm font-semibold text-brand-700 hover:underline" href={`${b}/campaigns`}>All campaigns</Link>}>
                  {d.campaigns.length === 0 ? <p className="text-sm text-slate-500">No running, paused or pending campaigns yet. Create one to start sending.</p> : (
                    <ul className="-my-2 divide-y divide-slate-100">{d.campaigns.map((c) => <li key={c.id} className="flex items-center justify-between gap-2 py-2.5 text-sm"><Link className="min-w-0 truncate font-semibold hover:text-brand-700" href={`${b}/campaigns/${c.id}`}>{c.name}</Link><Badge>{c.status}</Badge></li>)}</ul>
                  )}
                </Card>
              </div>
            </div>
          </div>
        );
      }}
    </QueryView>
  );
}
