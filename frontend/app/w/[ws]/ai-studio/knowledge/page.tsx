'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, ConfirmButton, Field, Input, Modal, Notice, PageHeader, QueryView, Table, Textarea } from '@/components/ui';
import { ConfigEditor, LinesField, ObjList } from '@/components/ai-studio';
import { BusinessServices } from '@/components/business-services';

export default function Knowledge() {
  return (
    <>
      <PageHeader title="Business knowledge" subtitle="Trusted facts about YOUR company. The AI may only state facts about you that appear here." />
      <div className="space-y-4">
        <BusinessServices />
        <ConfigEditor kind="knowledge" title="Company knowledge">
          {(d, set) => {
            const s = (k: string, v: any) => set({ ...d, [k]: v });
            return (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Company name"><Input value={d.companyName} onChange={(e) => s('companyName', e.target.value)} /></Field>
                  <Field label="Website"><Input value={d.website} onChange={(e) => s('website', e.target.value)} /></Field>
                </div>
                <Field label="Company description & positioning"><Textarea rows={4} value={d.description} onChange={(e) => s('description', e.target.value)} /></Field>
                <ObjList title="Services" fields={[{ key: 'name', label: 'Service' }, { key: 'description', label: 'Description', type: 'textarea' }]} value={d.services} onChange={(v) => s('services', v)} blank={{ name: '', description: '' }} />
                <ObjList title="Products" fields={[{ key: 'name', label: 'Product' }, { key: 'description', label: 'Description', type: 'textarea' }]} value={d.products} onChange={(v) => s('products', v)} blank={{ name: '', description: '' }} />
                <LinesField label="Unique selling points / differentiators" value={d.usps} onChange={(v) => s('usps', v)} />
                <Notice>Only items marked <b>verified</b> are given to the AI. Unverified case studies and achievements are never mentioned.</Notice>
                <ObjList title="Case studies" fields={[{ key: 'title', label: 'Title' }, { key: 'summary', label: 'Summary + result (what actually happened)', type: 'textarea' }, { key: 'verified', label: 'Verified', type: 'bool' }]} value={d.caseStudies} onChange={(v) => s('caseStudies', v)} blank={{ title: '', summary: '', result: '', url: '', verified: false }} />
                <ObjList title="Achievements" fields={[{ key: 'text', label: 'Achievement' }, { key: 'source', label: 'Source / proof' }, { key: 'verified', label: 'Verified', type: 'bool' }]} value={d.achievements} onChange={(v) => s('achievements', v)} blank={{ text: '', source: '', verified: false }} />
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Target audience"><Textarea rows={3} value={d.targetAudience} onChange={(e) => s('targetAudience', e.target.value)} /></Field>
                  <Field label="Customer profiles (who buys, why)" hint="Structured ICPs live under Prospects → ICP; their AI instructions apply when a campaign selects them"><Textarea rows={3} value={d.customerProfiles} onChange={(e) => s('customerProfiles', e.target.value)} /></Field>
                </div>
                <ObjList title="Offers" fields={[{ key: 'name', label: 'Offer' }, { key: 'description', label: 'Description', type: 'textarea' }, { key: 'price', label: 'Price (optional)' }]} value={d.offers} onChange={(v) => s('offers', v)} blank={{ name: '', description: '', price: '' }} />
                <Field label="Pricing notes" hint="Leave empty if the AI must never discuss pricing"><Textarea rows={2} value={d.pricingNotes} onChange={(e) => s('pricingNotes', e.target.value)} /></Field>
                <ObjList title="Competitors (never disparaged)" fields={[{ key: 'name', label: 'Competitor' }, { key: 'notes', label: 'How we differ', type: 'textarea' }]} value={d.competitors} onChange={(v) => s('competitors', v)} blank={{ name: '', notes: '' }} />
              </div>
            );
          }}
        </ConfigEditor>
        <WebsiteIntake />
        <Documents />
      </div>
    </>
  );
}

function WebsiteIntake() {
  const [website, setWebsite] = useState('');
  const [urls, setUrls] = useState('');
  const [result, setResult] = useState<any>(null);
  const intake = useWsMutation<{ website: string; urls: string[] }, any>(
    (body) => ({ path: '/ai-studio/onboarding/website', body }),
    { success: (r) => r.unchanged ? r.notice : `Collected ${r.sourceDocuments.length} source page(s); created ${r.draftServices.length} service draft(s). Review required.`, onSuccess: setResult },
  );
  return (
    <Card title="Build draft knowledge from your website">
      <p className="mb-3 text-sm text-slate-600">Outvexa reads a small number of public pages on the same site and extracts candidate company facts and services. Source pages stay inactive, services and proof stay unapproved, and a knowledge configuration draft is created for review. It does not activate extracted content.</p>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Company website"><Input type="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://example.com" /></Field>
        <Field label="Optional service or case-study page URLs" hint="One URL per line. Each URL must use the same host as the company website."><Textarea rows={3} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="https://example.com/services\nhttps://example.com/case-studies" /></Field>
      </div>
      <Button disabled={!website.trim()} loading={intake.isPending} onClick={() => { setResult(null); intake.mutate({ website: website.trim(), urls: urls.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) }); }}>Extract review drafts</Button>
      {result?.unchanged && <Notice>{result.notice}</Notice>}
      {result && !result.unchanged && <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
        <b>Human review required.</b> Knowledge version {result.draftKnowledge.version} is inactive; {result.sourceDocuments.length} source document(s) are inactive; {result.draftServices.length} service draft(s) were created and none are approved.
        {result.draftServices.length > 0 && <ul className="mt-2 list-disc pl-5">{result.draftServices.map((s: any) => <li key={s.versionId}>{s.name} — draft version</li>)}</ul>}
        {result.draftKnowledge.data.description && <p className="mt-3"><b>Draft company description:</b> {result.draftKnowledge.data.description}</p>}
        {result.supportedClaims.length > 0 && <div className="mt-3"><b>Extracted claims to review:</b><ul className="mt-1 list-disc space-y-1 pl-5">{result.supportedClaims.map((claim: any, i: number) => {
          const source = result.sourceDocuments.find((d: any) => d.id === claim.evidenceId);
          return <li key={`${claim.evidenceId}-${i}`}><span className="font-medium">{claim.category}:</span> {claim.text} <span className="text-slate-600">Source quote: “{claim.quote}”</span>{source && <> · <button className="underline" onClick={() => document.getElementById(`website-source-${source.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>source</button></>}</li>;
        })}</ul></div>}
        <DraftRevision draftId={result.draftKnowledge.id} sources={result.sourceDocuments.map((source: { id: string }) => source.id)} />
        <p className="mt-2">Review extracted facts and sources below, then review each service and its submitted proof in the service catalog. Do not approve claims unless their wording and commercial status are correct.</p>
      </div>}
    </Card>
  );
}

function DraftRevision({ draftId, sources }: { draftId: string; sources: string[] }) {
  const [instruction, setInstruction] = useState('');
  const [field, setField] = useState('description');
  const [proposal, setProposal] = useState<{ version: number; value: string; quote: string; sourceUrl: string | null } | null>(null);
  const revise = useWsMutation(() => ({
    path: '/ai-studio/onboarding/revise',
    body: { draftId, sourceIds: sources, field, instruction },
  }), { onSuccess: setProposal, success: 'Revision saved for review in company knowledge version history.' });

  return <div className="mt-4 space-y-2">
    <Field label="Field to revise">
      <select value={field} onChange={(e) => setField(e.target.value)}>
        <option value="description">Description and positioning</option>
        <option value="targetAudience">Target audience</option>
        <option value="customerProfiles">Customer profiles</option>
      </select>
    </Field>
    <Field label="Revision instructions"><Textarea rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} /></Field>
    <Button loading={revise.isPending} disabled={!instruction.trim()} onClick={() => revise.mutate()}>Propose a revision</Button>
    {proposal && <div><b>Inactive version {proposal.version}</b><p>{proposal.value}</p><p>Source quote “{proposal.quote}”</p>{proposal.sourceUrl && <p>{proposal.sourceUrl}</p>}</div>}
  </div>;
}

function Documents() {
  const q = useWsQuery<any[]>('/ai-studio/documents');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [view, setView] = useState<string | null>(null);
  const doc = useWsQuery<any>(view ? `/ai-studio/documents/${view}` : null);
  const add = useWsMutation(() => {
    if (file) { const f = new FormData(); f.append('file', file); f.append('title', title || file.name); return { path: '/ai-studio/documents', form: f }; }
    return { path: '/ai-studio/documents', body: { title, text } };
  }, { success: 'Document added', onSuccess: () => { setTitle(''); setText(''); setFile(null); } });
  const toggle = useWsMutation<{ id: string; isActive: boolean }>((b) => ({ path: `/ai-studio/documents/${b.id}`, method: 'PATCH', body: { isActive: b.isActive } }), { success: 'Updated' });
  const del = useWsMutation<string>((id) => ({ path: `/ai-studio/documents/${id}`, method: 'DELETE' }), { success: 'Deleted' });
  return (
    <Card title="Supporting documents & reference files">
      <p className="mb-3 text-sm text-slate-600">Upload .txt, .md, .csv, .json or .html (max 5 MB), or paste text (for PDF/Word, paste the text). Active documents are given to the AI as trusted knowledge (first ~12,000 characters across documents, newest first).</p>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="File (optional)"><input type="file" accept=".txt,.md,.markdown,.csv,.json,.html,.htm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" /></Field>
        <div className="flex items-end"><Button disabled={!file && (!title || !text)} loading={add.isPending} onClick={() => add.mutate()}>Add document</Button></div>
      </div>
      {!file && <Field label="…or paste text"><Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} /></Field>}
      <div className="mt-4">
        <QueryView q={q} isEmpty={(d) => !d.length} empty={<p className="text-sm text-slate-500">No documents yet.</p>}>
          {(d) => <Table head={['Title', 'Size', 'Added', 'Status', '']}>{d.map((x: any) => <tr key={x.id} id={`website-source-${x.id}`}><td><button className="underline" onClick={() => setView(x.id)}>{x.title}</button><div className="text-xs text-slate-500">{x.fileName ?? 'pasted text'}</div></td><td>{x.charCount.toLocaleString()} chars</td><td>{fmtDate(x.createdAt)}</td><td>{x.isActive ? <Badge color="green">active</Badge> : <Badge>inactive</Badge>}</td><td className="space-x-1"><Button variant="ghost" onClick={() => toggle.mutate({ id: x.id, isActive: !x.isActive })}>{x.isActive ? 'Deactivate' : 'Activate'}</Button><ConfirmButton variant="ghost" confirm="Delete this document?" onConfirm={() => del.mutate(x.id)}>Delete</ConfirmButton></td></tr>)}</Table>}
        </QueryView>
      </div>
      {view && doc.data && <Modal open wide title={doc.data.title} onClose={() => setView(null)}><pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap text-xs">{doc.data.text}</pre></Modal>}
    </Card>
  );
}
