'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAiOwner } from '@/components/ai/hooks';
import { GeneratePanel } from '@/components/ai/generate-panel';
import { ApiError, qs, type Paged } from '@/lib/api';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fullName } from '@/lib/format';
import { Badge, Button, Card, Field, Input, Notice, PageHeader, Select, Textarea } from '@/components/ui';

interface Draft { subject: string | null; firstLine: string | null; body: string | null; usedClaimIds: string[]; claims: Array<{ id: string; text: string; evidence: { url: string } }>; factCheck: { passed: boolean; sentences: Array<{ text: string; verdict: string; reason: string }> } }

export default function WritingStudio() {
  const [search, setSearch] = useState('');
  const leads = useWsQuery<Paged<{ id: string; email: string; firstName: string | null; lastName: string | null; currentScore: number | null }>>(`/leads${qs({ q: search, pageSize: 20, sort: 'score' })}`);
  const [leadId, setLeadId] = useState('');
  const [f, setF] = useState({ mode: 'full', templateSubject: '', templateBody: 'Hi {{firstName}},\n\n{{aiFirstLine}}\n\nWe help founders turn their expertise into consistent content that brings in qualified calls.\n\nOpen to a quick idea?', previousEmails: '', instructions: 'Short and plain. One specific observation, one soft question.' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState('');
  const [subjects, setSubjects] = useState<string[]>([]);
  const owner = useAiOwner();
  const ws = useWs();
  // Your connected Claude / ChatGPT subscription is the default when you may use it; API-key providers stay available.
  const [source, setSource] = useState<'subscription' | 'api' | null>(null);
  const engine = source ?? (owner.allowed ? 'subscription' : 'api');
  const gen = useWsMutation(() => ({ path: '/writing/generate', body: { leadId, ...f } }), { invalidate: false, onSuccess: (r: unknown) => { const d = r as Draft; setDraft(d); setText([d.subject ? `Subject: ${d.subject}` : '', d.firstLine ?? '', d.body ?? ''].filter(Boolean).join('\n\n')); } });
  const check = useWsMutation(() => ({ path: '/writing/fact-check', body: { leadId, text } }), { invalidate: false, success: (r: unknown) => ((r as { passed: boolean }).passed ? 'Fact-check passed' : 'Fact-check found unsupported statements'), onSuccess: (r: unknown) => draft && setDraft({ ...draft, factCheck: r as Draft['factCheck'] }) });
  const subj = useWsMutation(() => ({ path: '/writing/subjects', body: { leadId, body: text, count: 5 } }), { invalidate: false, onSuccess: (r: unknown) => setSubjects((r as { subjects: string[] }).subjects) });

  const noProvider = gen.error instanceof ApiError && gen.error.code === 'PROVIDER_NOT_CONFIGURED';
  return (
    <>
      <PageHeader title="AI writing studio" subtitle="Generate evidence-backed drafts for one prospect, check them, and copy the wording into your campaign templates. The AI may only state facts from the lead’s verified research." />
      {owner.allowed && (
        <div className="mb-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="Writing engine">
          {([['subscription', 'Claude / Codex subscription'], ['api', 'API provider']] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={engine === id} onClick={() => setSource(id)} className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${engine === id ? 'bg-ink text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200'}`}>{label}</button>
          ))}
        </div>
      )}
      {engine === 'subscription' && (
        <div className="space-y-4">
          <Card title="Prospect">
            <Field label="Find lead"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="name or email" /></Field>
            <Select className="mt-2" value={leadId} onChange={(e) => setLeadId(e.target.value)} options={[{ value: '', label: 'Choose a lead…' }, ...(leads.data?.data ?? []).map((l) => ({ value: l.id, label: `${fullName(l) || l.email} · ${l.email}` }))]} />
            <p className="mt-2 text-xs text-slate-500">Uses your connected subscription and your active workflow and writing playbook. Research, three variants, then edit, pick and save as a draft. Nothing is sent.</p>
          </Card>
          {leadId ? <GeneratePanel key={leadId} leadId={leadId} /> : <p className="text-sm text-slate-500">Choose a lead to generate emails.</p>}
        </div>
      )}
      {engine === 'api' && noProvider && (
        <div className="mb-4"><Notice kind="warning">No API-key AI provider is set up, so this tab can’t write. {owner.allowed ? <>Use the <button className="font-semibold underline" onClick={() => setSource('subscription')}>Claude / Codex subscription</button> tab instead, or </> : 'Either '}add an API key under <Link className="font-semibold underline" href={`/w/${ws}/settings/ai`}>AI settings</Link>.</Notice></div>
      )}
      {engine === 'api' && <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Inputs">
          <Field label="Find lead"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="name or email" /></Field>
          <Select className="mt-2" value={leadId} onChange={(e) => setLeadId(e.target.value)} options={[{ value: '', label: 'Choose a lead…' }, ...(leads.data?.data ?? []).map((l) => ({ value: l.id, label: `${fullName(l)} <${l.email}>${l.currentScore !== null ? ` · ${l.currentScore}` : ''}` }))]} />
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <Field label="Mode"><Select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} options={[{ value: 'full', label: 'Full email' }, { value: 'first_line', label: 'Personalised first line only' }, { value: 'followup', label: 'Follow-up' }]} /></Field>
            <Field label="Template subject"><Input value={f.templateSubject} onChange={(e) => setF({ ...f, templateSubject: e.target.value })} /></Field>
          </div>
          <Field label="Template / guidance"><Textarea rows={7} value={f.templateBody} onChange={(e) => setF({ ...f, templateBody: e.target.value })} /></Field>
          {f.mode === 'followup' && <Field label="Previous emails"><Textarea rows={4} value={f.previousEmails} onChange={(e) => setF({ ...f, previousEmails: e.target.value })} /></Field>}
          <Field label="Extra instructions"><Input value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></Field>
          <Button className="mt-3" disabled={!leadId} loading={gen.isPending} onClick={() => gen.mutate()}>Generate draft</Button>
        </Card>
        <Card title="Draft" actions={draft && <>{draft.factCheck.passed ? <Badge color="green">Fact-check passed</Badge> : <Badge color="red">Unsupported statements</Badge>}</>}>
          {!draft ? <p className="text-sm text-slate-500">Choose a lead and generate a draft. Run research on the lead first for specific personalisation.</p> : (
            <>
              <Textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} />
              <div className="mt-2 flex flex-wrap gap-2"><Button variant="secondary" loading={check.isPending} onClick={() => check.mutate()}>Re-check facts</Button><Button variant="secondary" loading={subj.isPending} onClick={() => subj.mutate()}>Suggest subject lines</Button><Button variant="ghost" onClick={() => navigator.clipboard.writeText(text)}>Copy</Button></div>
              {subjects.length > 0 && <ul className="mt-3 list-disc pl-5 text-sm">{subjects.map((s) => <li key={s}>{s}</li>)}</ul>}
              <div className="mt-4">
                <p className="label">Fact-check by sentence</p>
                <ul className="space-y-1 text-sm">{draft.factCheck.sentences.map((s, i) => <li key={i}><Badge color={s.verdict === 'UNSUPPORTED' ? 'red' : s.verdict === 'SUPPORTED' ? 'green' : 'gray'}>{s.verdict}</Badge> {s.text} {s.verdict === 'UNSUPPORTED' && <span className="text-xs text-red-600">— {s.reason}</span>}</li>)}</ul>
              </div>
              <div className="mt-4">
                <p className="label">Facts used</p>
                {draft.claims.length === 0 ? <p className="text-xs text-slate-500">No research facts used.</p> : <ul className="space-y-1 text-sm">{draft.claims.map((c) => <li key={c.id}>{c.text} <a className="text-xs text-brand-700 underline" href={c.evidence.url} target="_blank" rel="noreferrer">source</a></li>)}</ul>}
              </div>
              {!draft.factCheck.passed && <div className="mt-3"><Notice kind="warning">Remove or rewrite the unsupported sentences before using this text. Campaigns block emails that fail the fact-check.</Notice></div>}
            </>
          )}
        </Card>
      </div>}
    </>
  );
}
