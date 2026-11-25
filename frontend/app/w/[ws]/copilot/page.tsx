'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { CopilotVoice } from './voice';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, ConfirmButton, Empty, Notice, PageHeader, QueryView, Textarea } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const EXAMPLES = ['Which campaigns are underperforming this month and why?', 'Which positive replies still have no response?', 'Draft a campaign for US dentists who post on Instagram', 'Where is AI spend going this month?'];

function ResearchProgress({ id, workspace }: { id: string; workspace: string }) {
  const jobs = useWsQuery<Array<{ id: string; state: string; reportId: string | null; reportStatus: string | null }>>(
    `/copilot/actions/${id}/research`, { refetchInterval: 8000 },
  );
  return <ul className="w-full text-xs text-slate-600">{jobs.data?.map(job => <li key={job.id}>
    {job.reportId
      ? <Link className="text-brand-700 underline" href={`/w/${workspace}/research/${job.reportId}`}>Open research report · {job.reportStatus?.toLowerCase()}</Link>
      : <span>Research job · {job.state}</span>}
  </li>)}</ul>;
}

export default function Copilot() {
  const workspace = useWs();
  const queryClient = useQueryClient();
  const [voiceKey, resetVoice] = useState(0);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [selection, setSelection] = useState<{ leadId?: string; campaignId?: string }>({});
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const leadId = params.get('leadId');
    if (leadId) {
      setSelection({ leadId, campaignId: params.get('campaignId') ?? undefined });
      setQuestion('Research the selected prospect');
    }
  }, []);
  const threads = useWsQuery<any[]>('/copilot/threads');
  const thread = useWsQuery<any>(threadId ? `/copilot/threads/${threadId}` : null);
  const memory = useWsQuery<any[]>('/copilot/memory');
  const repetition = useWsQuery<any>('/copilot/repetition');
  const [mem, setMem] = useState('');
  const ask = useWsMutation(() => ({ path: '/copilot/ask', body: { threadId, question, ...selection } }), { onSuccess: (r: any) => { setThreadId(r.threadId); setQuestion(''); } });
  const exec = useWsMutation<string>((id) => ({ path: `/copilot/actions/${id}/execute`, body: {} }), { success: 'Action done' });
  const reject = useWsMutation<string>((id) => ({ path: `/copilot/actions/${id}/reject`, body: {} }), { success: 'Dismissed' });
  const addMem = useWsMutation(() => ({ path: '/copilot/memory', body: { content: mem } }), { success: 'Saved to business memory', onSuccess: () => setMem('') });
  const delMem = useWsMutation<string>((id) => ({ path: `/copilot/memory/${id}`, method: 'DELETE' }), { success: 'Removed' });
  return (
    <>
      <PageHeader title="AI Copilot" subtitle="Ask about your campaigns, replies, pipeline and costs. Answers use your workspace data. Copilot can queue prospect research and request confirmation for other actions." actions={<Button variant="secondary" onClick={() => { resetVoice(key => key + 1); setThreadId(null); }}>New conversation</Button>} />
      <div className="grid gap-4 lg:grid-cols-4">
        <Card title="Conversations">
          <QueryView q={threads} isEmpty={(d) => d.length === 0} empty={<p className="text-xs text-slate-500">None yet.</p>}>
            {(ts) => <ul className="space-y-1">{ts.map((t) => <li key={t.id}><button className={`w-full truncate rounded px-2 py-1 text-left text-sm ${threadId === t.id ? 'bg-brand-50 text-brand-700' : 'hover:bg-slate-50'}`} onClick={() => { resetVoice(key => key + 1); setThreadId(t.id); }}>{t.title}</button></li>)}</ul>}
          </QueryView>
        </Card>
        <div className="space-y-3 lg:col-span-2">
          {!threadId && <Card title="Try asking"><div className="flex flex-wrap gap-2">{EXAMPLES.map((e) => <Button key={e} variant="secondary" icon={null} onClick={() => setQuestion(e)}>{e}</Button>)}</div></Card>}
          {threadId && <QueryView q={thread}>{(t) => (
            <div className="space-y-3">
              {t.messages.map((m: any) => (
                <div key={m.id} className={`card p-3 ${m.role === 'USER' ? 'ml-10 bg-brand-50/30' : 'mr-10'}`}>
                  <p className="mb-1 text-xs text-slate-500">{m.role === 'USER' ? 'You' : 'Copilot'} · {fmtDate(m.createdAt)}</p>
                  <div className="prose-email">{m.content}</div>
                  {m.data?.recommendations?.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{m.data.recommendations.map((r: any, i: number) => <li key={i}><b>{r.title}</b> — {r.detail}</li>)}</ul>}
                </div>
              ))}
              {t.actions.length > 0 && <Card title="Proposed actions (need your confirmation)">
                <ul className="space-y-2">{t.actions.map((a: any) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2 text-sm" data-testid="copilot-action">
                    <span><Badge>{a.type}</Badge> {a.summary} <span className="text-xs text-slate-500">(needs {a.requiredRole.toLowerCase()})</span></span>
                    {a.status === 'PROPOSED' && !a.executedAt ? <span className="flex gap-2"><ConfirmButton confirm={a.type === 'pause_campaign' ? `Pause campaign ${a.params.campaignId} and stop its scheduled sending? A manager can resume it later.` : `Run ${a.type.replaceAll('_', ' ')} with the displayed details?`} loading={exec.isPending} onConfirm={() => exec.mutate(a.id)}>Confirm</ConfirmButton><Button variant="ghost" onClick={() => reject.mutate(a.id)}>Dismiss</Button></span> : <Badge>{a.status === 'PROPOSED' ? 'RUNNING' : a.status}</Badge>}
                    {a.status === 'PROPOSED' && <details className="w-full text-xs text-slate-600">
                      <summary className="cursor-pointer">Action details</summary>
                      <dl className="mt-1 space-y-1">{Object.entries(a.params ?? {}).map(([key, value]) => <div key={key} className="break-words">
                        <dt className="inline font-medium">{key}</dt> <dd className="inline">{String(value)}</dd>
                      </div>)}</dl>
                    </details>}
                    {a.type === 'queue_research' && a.status === 'EXECUTED' && <ResearchProgress id={a.id} workspace={workspace} />}
                  </li>
                ))}</ul>
              </Card>}
            </div>
          )}</QueryView>}
          <Card>
            <Textarea rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask the Copilot…" />
            <div className="mt-2 flex items-center justify-between"><p className="text-xs text-slate-500">The Copilot never invents prices or commitments. Check numbers before acting on them.</p><Button disabled={!question.trim()} loading={ask.isPending} onClick={() => ask.mutate()}>Ask</Button></div>
            <CopilotVoice key={workspace + voiceKey} workspace={workspace} threadId={threadId} selection={selection} disabled={ask.isPending} onReply={(result) => {
              setThreadId(result.threadId);
              void queryClient.invalidateQueries({ queryKey: ['ws', workspace] });
            }} />
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Business memory">
            <p className="mb-2 text-xs text-slate-500">Facts the Copilot always keeps in mind (admins only).</p>
            <QueryView q={memory} isEmpty={(d) => d.length === 0} empty={<p className="text-xs text-slate-500">Nothing saved.</p>}>
              {(ms) => <ul className="space-y-1">{ms.map((m) => <li key={m.id} className="flex items-start justify-between gap-2 text-sm"><span>{m.content}</span><button className="text-xs text-slate-400" onClick={() => delMem.mutate(m.id)}>✕</button></li>)}</ul>}
            </QueryView>
            <Textarea rows={2} className="mt-2" value={mem} onChange={(e) => setMem(e.target.value)} placeholder="e.g. We only work with clinics in the US and UK" />
            <Button className="mt-2" variant="secondary" disabled={!mem.trim()} onClick={() => addMem.mutate()}>Save</Button>
          </Card>
          <Card title="Repetitive wording check">
            <QueryView q={repetition}>{(r) => (r.repeatedPhrases?.length ? <><p className="mb-1 text-xs text-slate-500">{r.emailsAnalyzed} personalised emails · {r.nearDuplicateOpeningPairs} near-duplicate openings</p><ul className="space-y-1 text-sm">{r.repeatedPhrases.slice(0, 8).map((p: any) => <li key={p.phrase}>“{p.phrase}” <span className="text-xs text-slate-500">×{p.count}</span></li>)}</ul></> : <Empty title="No repeated phrases found">{r.emailsAnalyzed} personalised emails checked.</Empty>)}</QueryView>
          </Card>
        </div>
      </div>
      <div className="mt-4"><Notice>Copilot answers come from a snapshot of your workspace data (campaigns, replies, pipeline, costs) at the time you ask.</Notice></div>
    </>
  );
}
