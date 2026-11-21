'use client';

import { useState } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, Checkbox, Field, Input, Notice, PageHeader, QueryView, Select, Table, Tabs, Textarea } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const CATEGORIES = ['PROSPECT_RESEARCH', 'PROSPECT_QUALIFICATION', 'OPPORTUNITY_IDENTIFICATION', 'PERSONALIZATION', 'EMAIL_OPENING', 'VALUE_PROPOSITION', 'PITCHING', 'CLOSING', 'FOLLOW_UPS', 'DELIVERABILITY_COMPLIANCE'];
const RULE_DEFAULT = { title: '', description: '', category: 'PERSONALIZATION', priority: 'PREFERRED', condition: '', status: 'ACTIVE', triggerTerms: '' };
const EXAMPLE_DEFAULT = { name: '', content: '', correctedContent: '', category: 'EMAIL', polarity: 'POSITIVE', explanation: '', tags: '', isActive: true };
const options = (xs: string[]) => xs.map((x) => ({ value: x, label: x.toLowerCase().replaceAll('_', ' ') }));

export default function Training() {
  const [tab, setTab] = useState('rules');
  const overview = useWsQuery<any>('/ai-outreach-brain/overview');
  const rules = useWsQuery<any>('/ai-outreach-brain/rules');
  const examples = useWsQuery<any[]>('/ai-outreach-brain/examples');
  const suggestions = useWsQuery<any>('/ai-outreach-brain/suggestions');
  const [rule, setRule] = useState<any>(RULE_DEFAULT);
  const [editingRule, setEditingRule] = useState<string | null>(null);
  const [example, setExample] = useState<any>(EXAMPLE_DEFAULT);
  const [editingExample, setEditingExample] = useState<string | null>(null);
  const saveRule = useWsMutation<any>((body) => ({ path: editingRule ? `/ai-outreach-brain/rules/${editingRule}` : '/ai-outreach-brain/rules', method: editingRule ? 'PATCH' : 'POST', body: { ...body, triggerTerms: body.triggerTerms.split(',').map((x: string) => x.trim()).filter(Boolean), condition: body.condition || null } }), { success: (r: any) => r.conflicts?.length ? `Saved with ${r.conflicts.length} conflict warning(s)` : 'Rule saved', onSuccess: () => { setRule(RULE_DEFAULT); setEditingRule(null); } });
  const removeRule = useWsMutation<string>((id) => ({ path: `/ai-outreach-brain/rules/${id}`, method: 'DELETE' }), { success: 'Rule deleted' });
  const saveExample = useWsMutation<any>((body) => ({ path: editingExample ? `/ai-outreach-brain/examples/${editingExample}` : '/ai-outreach-brain/examples', method: editingExample ? 'PATCH' : 'POST', body: { ...body, tags: body.tags.split(',').map((x: string) => x.trim()).filter(Boolean), correctedContent: body.correctedContent || null, explanation: body.explanation || null } }), { success: 'Example saved', onSuccess: () => { setExample(EXAMPLE_DEFAULT); setEditingExample(null); } });
  const removeExample = useWsMutation<string>((id) => ({ path: `/ai-outreach-brain/examples/${id}`, method: 'DELETE' }), { success: 'Example deleted' });
  const decide = useWsMutation<{ id: string; decision: string }>((x) => ({ path: `/ai-outreach-brain/suggestions/${x.id}/decision`, body: { decision: x.decision } }), { success: 'Learning suggestion updated' });
  return <>
    <PageHeader title="AI Outreach Training" subtitle="Teach your workspace how to research, qualify and write. Rules and examples are captured in campaign approval snapshots." />
    <div className="mb-4 grid gap-3 md:grid-cols-4">{overview.data && <>
      <Card><b>{overview.data.activeRules}</b><div className="text-xs text-slate-500">active rules</div></Card>
      <Card><b>{overview.data.activeExamples}</b><div className="text-xs text-slate-500">active examples</div></Card>
      <Card><b>{overview.data.approvedDrafts}</b><div className="text-xs text-slate-500">approved drafts</div></Card>
      <Card><b>{overview.data.pendingSuggestions}</b><div className="text-xs text-slate-500">learning suggestions</div></Card>
    </>}</div>
    <div className="mb-4 grid gap-3 md:grid-cols-3">
      <Card title="Outreach strategy"><p className="text-sm text-slate-600">Describe target prospects, business opportunities, qualification, services to pitch and whom to avoid in the Research instructions page.</p><a className="mt-2 inline-block text-sm font-semibold text-brand-700 underline" href="../research">Edit research strategy</a></Card>
      <Card title="Writing style"><p className="text-sm text-slate-600">Set tone, sentence length, language, CTA, preferred vocabulary and global writing instructions.</p><a className="mt-2 inline-block text-sm font-semibold text-brand-700 underline" href="../writing">Edit writing style</a></Card>
      <Card title="Business knowledge"><p className="text-sm text-slate-600">Add services and proof points so outreach pitches use your actual offering.</p><a className="mt-2 inline-block text-sm font-semibold text-brand-700 underline" href="../knowledge">Edit business knowledge</a></Card>
    </div>
    <Tabs active={tab} onChange={setTab} tabs={[{ id: 'rules', label: 'Rules & instructions' }, { id: 'examples', label: 'Good & bad examples' }, { id: 'suggestions', label: 'Learning suggestions' }]} />
    {tab === 'rules' && <div className="space-y-4">
      <Card title={editingRule ? 'Edit rule' : 'Add a rule'}>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Title"><Input value={rule.title} onChange={(e) => setRule({ ...rule, title: e.target.value })} placeholder="Never use generic compliments" /></Field>
          <Field label="Category"><Select value={rule.category} onChange={(e) => setRule({ ...rule, category: e.target.value })} options={options(CATEGORIES)} /></Field>
          <Field label="Priority"><Select value={rule.priority} onChange={(e) => setRule({ ...rule, priority: e.target.value })} options={options(['MANDATORY', 'PREFERRED', 'AVOID', 'CONDITIONAL'])} /></Field>
          <Field label="Status"><Select value={rule.status} onChange={(e) => setRule({ ...rule, status: e.target.value })} options={options(['ACTIVE', 'INACTIVE'])} /></Field>
          <Field label="Rule"><Textarea rows={3} value={rule.description} onChange={(e) => setRule({ ...rule, description: e.target.value })} placeholder="Do not open with a generic compliment. Start with a relevant, evidence-backed observation." /></Field>
          <Field label="Condition" hint="Required for Conditional priority"><Textarea rows={3} value={rule.condition} onChange={(e) => setRule({ ...rule, condition: e.target.value })} placeholder="Apply only to first-touch emails" /></Field>
          <Field label="Terms to block" hint="Optional deterministic check for Avoid/Mandatory rules; comma separated"><Input value={rule.triggerTerms} onChange={(e) => setRule({ ...rule, triggerTerms: e.target.value })} placeholder="I hope this finds you well, amazing work" /></Field>
        </div>
        <div className="flex gap-2"><Button disabled={!rule.title.trim() || !rule.description.trim() || (rule.priority === 'CONDITIONAL' && !rule.condition.trim())} loading={saveRule.isPending} onClick={() => saveRule.mutate(rule)}>{editingRule ? 'Save rule' : 'Add rule'}</Button>{editingRule && <Button variant="ghost" onClick={() => { setRule(RULE_DEFAULT); setEditingRule(null); }}>Cancel</Button>}</div>
      </Card>
      <QueryView q={rules}>
        {(d) => <>
          {d.conflicts?.map((c: any, i: number) => <Notice key={i} kind="warning">Rule conflict warning: {c.message}</Notice>)}
          <div className="card p-2"><Table head={['Rule', 'Category', 'Priority', 'Condition', 'Status', 'Updated', '']}>
            {d.rules.map((r: any) => <tr key={r.id}><td className="td"><b>{r.title}</b><div className="text-xs text-slate-500">{r.description}</div>{r.triggerTerms?.length > 0 && <div className="text-xs text-amber-700">Block terms: {r.triggerTerms.join(', ')}</div>}</td><td className="td text-xs">{r.category.replaceAll('_', ' ').toLowerCase()}</td><td className="td"><Badge>{r.priority.toLowerCase()}</Badge></td><td className="td text-xs">{r.condition || '—'}</td><td className="td">{r.status}</td><td className="td text-xs">{fmtDate(r.updatedAt)}</td><td className="td whitespace-nowrap"><Button variant="ghost" onClick={() => { setEditingRule(r.id); setRule({ ...r, triggerTerms: r.triggerTerms.join(', '), condition: r.condition ?? '' }); }}>Edit</Button><Button variant="ghost" onClick={() => removeRule.mutate(r.id)}>Delete</Button></td></tr>)}
          </Table></div>
        </>}
      </QueryView>
    </div>}
    {tab === 'examples' && <div className="space-y-4">
      <Card title={editingExample ? 'Edit example' : 'Add a writing, research or conversation example'}>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name"><Input value={example.name} onChange={(e) => setExample({ ...example, name: e.target.value })} /></Field>
          <Field label="Category"><Select value={example.category} onChange={(e) => setExample({ ...example, category: e.target.value })} options={options(['EMAIL', 'RESEARCH', 'CONVERSATION'])} /></Field>
          <Field label="Example type"><Select value={example.polarity} onChange={(e) => setExample({ ...example, polarity: e.target.value })} options={options(['POSITIVE', 'NEGATIVE'])} /></Field>
          <Field label="Tags" hint="Comma separated"><Input value={example.tags} onChange={(e) => setExample({ ...example, tags: e.target.value })} /></Field>
          <Field label="Original content"><Textarea rows={6} value={example.content} onChange={(e) => setExample({ ...example, content: e.target.value })} /></Field>
          <Field label="Corrected content (optional)"><Textarea rows={6} value={example.correctedContent} onChange={(e) => setExample({ ...example, correctedContent: e.target.value })} /></Field>
          <Field label="Why is this a good or bad example?"><Textarea rows={2} value={example.explanation} onChange={(e) => setExample({ ...example, explanation: e.target.value })} /></Field>
          <Checkbox label="Use this example in future training" checked={example.isActive} onChange={(v) => setExample({ ...example, isActive: v })} />
        </div>
        <div className="flex gap-2"><Button disabled={!example.name.trim() || example.content.trim().length < 10} loading={saveExample.isPending} onClick={() => saveExample.mutate(example)}>{editingExample ? 'Save example' : 'Add example'}</Button>{editingExample && <Button variant="ghost" onClick={() => { setExample(EXAMPLE_DEFAULT); setEditingExample(null); }}>Cancel</Button>}</div>
        <p className="mt-2 text-xs text-slate-500">Examples are text-only and retrieved selectively by prospect/campaign relevance. Uploaded text is treated as untrusted data, never as system instructions.</p>
      </Card>
      <QueryView q={examples}>
        {(d) => <div className="grid gap-3 md:grid-cols-2">{d.map((x: any) => <Card key={x.id} title={<>{x.name} <Badge color={x.polarity === 'POSITIVE' ? 'green' : 'red'}>{x.polarity.toLowerCase()}</Badge></>} actions={<><Button variant="ghost" onClick={() => { setEditingExample(x.id); setExample({ ...x, correctedContent: x.correctedContent ?? '', explanation: x.explanation ?? '', tags: x.tags.join(', ') }); }}>Edit</Button><Button variant="ghost" onClick={() => removeExample.mutate(x.id)}>Delete</Button></>}>
          <p className="line-clamp-4 whitespace-pre-wrap text-sm">{x.content}</p>{x.correctedContent && <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-green-800">Corrected: {x.correctedContent}</p>}<p className="mt-2 text-xs text-slate-500">{x.category.toLowerCase()} · {x.tags.join(', ') || 'no tags'} · {x.isActive ? 'active' : 'inactive'}</p>
        </Card>)}</div>}
      </QueryView>
    </div>}
    {tab === 'suggestions' && <QueryView q={suggestions} isEmpty={(d) => !d.totalPending} empty={<Notice>Learning suggestions appear after at least three similar editing patterns. They never change rules without your approval.</Notice>}>
      {(d) => <div className="space-y-3">{d.pending.map((s: any) => <Card key={s.id} title={<>{s.title} <Badge>{Math.round(s.confidence * 100)}% heuristic confidence</Badge></>}>
        <p className="text-sm">{s.description}</p><p className="mt-1 text-xs text-slate-500">Seen in {s.sampleCount} edits. This is a heuristic pattern, not proof of a general preference.</p>
        <div className="mt-3 flex gap-2"><Button onClick={() => decide.mutate({ id: s.id, decision: 'ACCEPT' })}>Accept as rule</Button><Button variant="secondary" onClick={() => decide.mutate({ id: s.id, decision: 'REJECT' })}>Reject</Button></div>
      </Card>)}</div>}
    </QueryView>}
  </>;
}
