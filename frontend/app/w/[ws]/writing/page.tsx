'use client';

import { useState } from 'react';
import { qs, type Paged } from '@/lib/api';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
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
  const gen = useWsMutation(() => ({ path: '/writing/generate', body: { leadId, ...f } }), { invalidate: false, onSuccess: (r: unknown) => { const d = r as Draft; setDraft(d); setText([d.subject ? `Subject: ${d.subject}` : '', d.firstLine ?? '', d.body ?? ''].filter(Boolean).join('\n\n')); } });
  const check = useWsMutation(() => ({ path: '/writing/fact-check', body: { leadId, text } }), { invalidate: false, success: (r: unknown) => ((r as { passed: boolean }).passed ? 'Fact-check passed' : 'Fact-check found unsupported statements'), onSuccess: (r: unknown) => draft && setDraft({ ...draft, factCheck: r as Draft['factCheck'] }) });
  const subj = useWsMutation(() => ({ path: '/writing/subjects', body: { leadId, body: text, count: 5 } }), { invalidate: false, onSuccess: (r: unknown) => setSubjects((r as { subjects: string[] }).subjects) });

  return (
    <>
      <PageHeader title="AI writing studio" subtitle="Generate evidence-backed drafts for one prospect, check them, and copy the wording into your campaign templates. The AI may only state facts from the lead’s verified research." />
      <div className="grid gap-4 lg:grid-cols-2">
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
      </div>
    </>
  );
}
