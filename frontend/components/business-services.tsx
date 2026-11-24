'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { Badge, Button, Card, Field, Input, Notice, QueryView, Textarea } from '@/components/ui';

const arrayFields = [
  ['targetIndustries', 'Target industries'], ['excludedIndustries', 'Excluded industries'], ['targetGeographies', 'Target geographies'], ['excludedGeographies', 'Excluded geographies'], ['targetCustomerProfiles', 'Target customer profiles'],
  ['customerProblems', 'Problems solved'], ['desiredOutcomes', 'Desired outcomes'], ['deliverables', 'Deliverables'],
  ['eligibilityCriteria', 'Eligibility criteria'], ['exclusions', 'Exclusions'], ['commercialBoundaries', 'Commercial boundaries'],
] as const;
const empty = { name: '', description: '', minEmployeeCount: '', maxEmployeeCount: '', exclusionRules: '[]', ...Object.fromEntries(arrayFields.map(([k]) => [k, ''])) } as Record<string, string>;
const asLines = (v: string) => v.split('\n').map((x) => x.trim()).filter(Boolean);

export function BusinessServices() {
  const q = useWsQuery<any[]>('/ai-studio/services');
  const [form, setForm] = useState<Record<string, string>>(empty);
  const [editingService, setEditingService] = useState<string | null>(null);
  const [proofVersionId, setProofVersionId] = useState<string | null>(null);
  const [proofClaim, setProofClaim] = useState('');
  const [proofUrl, setProofUrl] = useState('');
  const add = useWsMutation(() => ({ path: editingService ? `/ai-studio/services/${editingService}/versions` : '/ai-studio/services', method: 'POST', body: { ...Object.fromEntries(arrayFields.map(([k]) => [k, asLines(form[k] ?? '')])), exclusionRules: JSON.parse(form.exclusionRules || '[]'), minEmployeeCount: form.minEmployeeCount === '' ? null : Number(form.minEmployeeCount), maxEmployeeCount: form.maxEmployeeCount === '' ? null : Number(form.maxEmployeeCount), ...(editingService ? {} : { name: form.name }), description: form.description } }), { success: editingService ? 'Draft service version created' : 'Draft service created', onSuccess: () => { setForm(empty); setEditingService(null); } });
  const approve = useWsMutation<string>((id) => ({ path: `/ai-studio/service-versions/${id}/approve`, method: 'POST', body: {} }), { success: 'Service version approved' });
  const proof = useWsMutation(() => ({ path: '/ai-studio/proof', method: 'POST', body: { serviceVersionId: proofVersionId, claim: proofClaim, sourceUrl: proofUrl || null } }), { success: 'Proof added as unverified', onSuccess: () => { setProofVersionId(null); setProofClaim(''); setProofUrl(''); } });
  const review = useWsMutation<{ id: string; decision: 'REVIEWED' | 'APPROVED_FOR_USE' | 'REJECTED' | 'REVOKED'; note: string }>((x) => ({ path: `/ai-studio/proof/${x.id}/review`, method: 'POST', body: { decision: x.decision, note: x.note } }), { success: 'Manager review recorded' });
  const revoke = useWsMutation<{ id: string; reason: string }>((x) => ({ path: `/ai-studio/service-versions/${x.id}/revoke`, method: 'POST', body: { reason: x.reason } }), { success: 'Service version revoked' });
  const expire = useWsMutation<{ id: string; expiresAt: string; reason: string }>((x) => ({ path: `/ai-studio/service-versions/${x.id}/expiry`, method: 'POST', body: { expiresAt: x.expiresAt, reason: x.reason } }), { success: 'Service version expiry recorded' });
  return <div className="space-y-4">
    <Card title="Approved service catalog" actions={<Button loading={add.isPending} disabled={!form.name?.trim() && !editingService || !form.description?.trim()} onClick={() => add.mutate()}>{editingService ? 'Create version' : 'Add service draft'}</Button>}>
      <Notice>Only manager-approved versions can be selected on campaigns. Each saved version is immutable after approval. Proof approval records a manager review; it does not claim independent verification. Add source-backed proof and document what was reviewed.</Notice>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {!editingService && <Field label="Service name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Content production" /></Field>}
        {editingService && <div className="text-sm text-slate-600 md:col-span-2">Creating a new draft version for the selected service.</div>}
        <Field label="Service description"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <Field label="Minimum company employees (optional)"><Input type="number" min={0} value={form.minEmployeeCount} onChange={(e) => setForm({ ...form, minEmployeeCount: e.target.value })} /></Field>
        <Field label="Maximum company employees (optional)"><Input type="number" min={0} value={form.maxEmployeeCount} onChange={(e) => setForm({ ...form, maxEmployeeCount: e.target.value })} /></Field>
        {arrayFields.map(([key, label]) => <Field key={key} label={label} hint="One item per line"><Textarea rows={2} value={form[key] ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></Field>)}
        <Field label="Structured exclusion rules (JSON)" hint='Use dimensions INDUSTRY, GEOGRAPHY, EMPLOYEE_COUNT, COMPANY_TYPE, PROSPECT_ROLE, SENIORITY, BUSINESS_CATEGORY; missingBehavior HOLD or ALLOW.'><Textarea rows={5} value={form.exclusionRules} onChange={(e) => setForm({ ...form, exclusionRules: e.target.value })} /></Field>
      </div>
      {editingService && <Button variant="ghost" onClick={() => { setEditingService(null); setForm(empty); }}>Cancel new version</Button>}
    </Card>
    <QueryView q={q} isEmpty={(items) => !items.length} empty={<Card title="Service catalog"><p className="text-sm text-slate-500">No services yet. Add a draft above, review its details, then approve it.</p></Card>}>
      {(items) => <div className="space-y-3">{items.map((service: any) => <Card key={service.id} title={<>{service.name} {service.isArchived && <Badge>archived</Badge>}</>} actions={<Button variant="secondary" onClick={() => { const v = service.versions?.[0]; setEditingService(service.id); setForm({ ...empty, description: v?.description ?? '', minEmployeeCount: v?.minEmployeeCount == null ? '' : String(v.minEmployeeCount), maxEmployeeCount: v?.maxEmployeeCount == null ? '' : String(v.maxEmployeeCount), ...Object.fromEntries(arrayFields.map(([k]) => [k, (v?.[k] ?? []).join('\n')])) }); }}>New version</Button>}>
        <div className="space-y-3">{service.versions.map((v: any) => <div key={v.id} className="rounded border border-slate-200 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><div className="font-medium">Version {v.version} <Badge color={v.status === 'APPROVED' ? 'green' : 'purple'}>{v.status}</Badge>{v.expiresAt && <span className="ml-2 text-xs text-slate-500">expires {new Date(v.expiresAt).toLocaleDateString()}</span>}</div><div className="flex gap-2">{v.status === 'DRAFT' && <Button loading={approve.isPending} onClick={() => approve.mutate(v.id)}>Approve version</Button>}{['APPROVED', 'SUPERSEDED'].includes(v.status) && <><Button variant="secondary" loading={expire.isPending} onClick={() => { const date = window.prompt('Expiry date and time in ISO format (for example 2027-01-31T23:59:00Z):'); if (!date) return; const reason = window.prompt('Reason for expiry (8–500 characters):'); if (reason) expire.mutate({ id: v.id, expiresAt: date, reason }); }}>Set expiry</Button><Button variant="secondary" loading={revoke.isPending} onClick={() => { const reason = window.prompt('Reason for revoking this service version (8–500 characters):'); if (reason) revoke.mutate({ id: v.id, reason }); }}>Revoke</Button></>}</div></div>
          <p className="mt-1 text-sm text-slate-700">{v.description}</p>
          <div className="mt-2 grid gap-2 text-xs text-slate-600 md:grid-cols-2">{arrayFields.map(([key, label]) => (v[key]?.length ? <div key={key}><b>{label}:</b> {v[key].join(' · ')}</div> : null))}{(v.minEmployeeCount != null || v.maxEmployeeCount != null) && <div><b>Employee count:</b> {v.minEmployeeCount ?? 0}–{v.maxEmployeeCount ?? 'no maximum'}</div>}</div>
          <div className="mt-3 space-y-2">{v.proof.map((p: any) => <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-sm"><span>{p.claim}{p.sourceUrl && <> · <a className="underline" href={p.sourceUrl} target="_blank" rel="noreferrer">source</a></>} <Badge color={p.status === 'APPROVED_FOR_USE' ? 'green' : 'amber'}>{p.status}{p.permittedUse ? ' · usable' : ''}</Badge>{p.verificationMethod && <span className="ml-2 text-xs text-slate-500">{p.verificationMethod}</span>}</span>{v.status === 'DRAFT' && <div className="flex gap-2">{p.status === 'SUBMITTED' && <Button variant="secondary" onClick={() => { const note = window.prompt('Describe what you inspected (8+ characters):'); if (note) review.mutate({ id: p.id, decision: 'REVIEWED', note }); }}>Record review</Button>}{p.status === 'REVIEWED' && <Button variant="secondary" onClick={() => { const note = window.prompt('Describe the source and basis for campaign use (8+ characters):'); if (note) review.mutate({ id: p.id, decision: 'APPROVED_FOR_USE', note }); }}>Approve for use</Button>}{['SUBMITTED', 'REVIEWED'].includes(p.status) && <Button variant="ghost" onClick={() => { const note = window.prompt('Reason for rejecting proof (8+ characters):'); if (note) review.mutate({ id: p.id, decision: 'REJECTED', note }); }}>Reject</Button>}{p.status === 'APPROVED_FOR_USE' && <Button variant="ghost" onClick={() => { const note = window.prompt('Reason for revoking proof (8+ characters):'); if (note) review.mutate({ id: p.id, decision: 'REVOKED', note }); }}>Revoke proof</Button>}</div>}</div>)}
            {v.status === 'DRAFT' && <div className="flex flex-wrap items-end gap-2 border-t pt-2"><Field label="Proof claim"><Input value={proofVersionId === v.id ? proofClaim : ''} onChange={(e) => { setProofVersionId(v.id); setProofClaim(e.target.value); }} /></Field><Field label="Public source URL"><Input value={proofVersionId === v.id ? proofUrl : ''} onChange={(e) => { setProofVersionId(v.id); setProofUrl(e.target.value); }} /></Field><Button variant="secondary" disabled={proofVersionId !== v.id || proofClaim.trim().length < 5} loading={proof.isPending} onClick={() => proof.mutate()}>Add proof</Button></div>}
          </div>
        </div>)}</div>
      </Card>)}</div>}
    </QueryView>
  </div>;
}
