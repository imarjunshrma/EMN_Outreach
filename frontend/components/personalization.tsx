'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs, type Paged } from '@/lib/api';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate, fullName } from '@/lib/format';
import { Badge, Button, Card, Checkbox, ConfirmButton, Empty, Field, Input, Modal, Notice, Pagination, QueryView, Select, Table, Textarea } from '@/components/ui';

const STATUS_COLOR: Record<string, any> = { APPROVED: 'green', GENERATED: 'blue', BLOCKED: 'red', FAILED: 'red', NEEDS_RESEARCH: 'yellow', SKIPPED: 'gray', QUEUED: 'gray', GENERATING: 'blue', REJECTED: 'gray' };
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const usd = (n: number | string | null | undefined) => `$${Number(n ?? 0).toFixed(4)}`;
const INHERIT = { value: '', label: '— inherit —' };
const o = (xs: string[]) => xs.map((x) => ({ value: x, label: x.replace(/_/g, ' ') }));
const REJECTION_REASONS = ['WRONG_PROSPECT', 'WRONG_IDENTITY', 'INCORRECT_RESEARCH', 'UNSUPPORTED_CLAIM', 'WRONG_SERVICE', 'GENERIC_OPENING', 'IRRELEVANT_OPPORTUNITY', 'POOR_WRITING', 'WRONG_TONE', 'WEAK_CTA', 'OTHER'];

export function CheckList({ quality }: { quality: any }) {
  if (!quality?.checks) return null;
  const icon: Record<string, string> = { pass: '✓', warn: '!', fail: '✕', info: 'i' };
  const color: Record<string, string> = { pass: 'text-green-700', warn: 'text-amber-700', fail: 'text-red-700', info: 'text-slate-500' };
  return (
    <ul className="space-y-1 text-xs">
      {quality.checks.map((c: any) => <li key={c.id} className={color[c.status]}><b className="inline-block w-4">{icon[c.status]}</b><b>{c.label}:</b> {c.detail}</li>)}
    </ul>
  );
}

export function ScoreBox({ score, explanation }: { score: number | null; explanation: any }) {
  if (score === null || score === undefined) return null;
  return (
    <div className="rounded border border-slate-200 bg-slate-50 p-2 text-xs">
      <div className="mb-1 font-semibold">Personalization score {score}/100</div>
      <ul>{(explanation?.factors ?? []).map((f: any) => <li key={f.factor}>{f.points}/{f.max} · {f.factor} — {f.note}</li>)}</ul>
      {explanation?.basis && <p className="mt-1">Observation used: <i>{explanation.basis}</i></p>}
      {explanation?.opportunityAnalysis && <div className="mt-2 border-t border-slate-200 pt-2">
        <p><b>Opportunity analysis (heuristic)</b> · {explanation.opportunityAnalysis.qualification?.replaceAll('_', ' ').toLowerCase()} · {Math.round((explanation.opportunityAnalysis.confidence ?? 0) * 100)}% confidence</p>
        {explanation.opportunityAnalysis.businessModel?.statement && <p>Business model ({explanation.opportunityAnalysis.businessModel.basis.toLowerCase()}): {explanation.opportunityAnalysis.businessModel.statement}</p>}
        {explanation.opportunityAnalysis.opportunity && <p>Potential opportunity: {explanation.opportunityAnalysis.opportunity}</p>}
        {explanation.opportunityAnalysis.serviceFit && <p>Service fit: {explanation.opportunityAnalysis.serviceFit}</p>}
        {explanation.opportunityAnalysis.recommendedApproach && <p>Suggested approach: {explanation.opportunityAnalysis.recommendedApproach}</p>}
        {!!explanation.opportunityAnalysis.unknowns?.length && <p>Unknown: {explanation.opportunityAnalysis.unknowns.join('; ')}</p>}
        {!!explanation.opportunityAnalysis.missingInformation?.length && <p>Missing information: {explanation.opportunityAnalysis.missingInformation.join('; ')}</p>}
      </div>}
      <p className="mt-1 text-slate-500">{explanation?.disclaimer}</p>
    </div>
  );
}

// ------------------------------------------------------------------ campaign AI tab

export function CampaignAiPanel({ campaign }: { campaign: any }) {
  return (
    <div className="space-y-4">
      <CampaignAiSettings campaign={campaign} />
      <Generation campaign={campaign} />
      <PersonalizationTable campaign={campaign} />
    </div>
  );
}

const SOURCE_HINT = {
  workspace: 'Uses the AI source chosen in Settings → AI providers.',
  api: 'Uses the workspace API keys; billed per use.',
  claude_subscription: 'Writes with your Claude subscription; no API bill. Generate drafts before starting the campaign.',
  codex_subscription: 'Writes with your Codex subscription; no API bill. Generate drafts before starting the campaign.',
};

function CampaignAiSettings({ campaign }: { campaign: any }) {
  const ws = useWsQuery<{ mode: string; options: Array<{ mode: string; label: string; available: boolean }> }>('/ai/source');
  const profiles = useWsQuery<any[]>('/ai-studio/profiles');
  const icps = useWsQuery<any>('/icps');
  const serviceCatalog = useWsQuery<any[]>('/ai-studio/services');
  const [f, setF] = useState<any>(null);
  const [services, setServices] = useState<Array<{ serviceVersionId: string; isPreferred: boolean }>>([]);
  useEffect(() => {
    const o = campaign.aiOverrides ?? {};
    setF({
      aiProfileId: campaign.aiProfileId ?? '', icpId: campaign.icpId ?? '', maxAiCostPerLeadUsd: campaign.maxAiCostPerLeadUsd ?? '',
      writing: { tone: '', ctaStyle: '', formality: '', personalizationIntensity: '', minWords: '', maxWords: '', ...(o.writing ?? {}) },
      avoid: (o.writing?.avoidPhrases ?? []).join('\n'), forbidden: (o.writing?.forbiddenClaims ?? []).join('\n'),
      audienceContext: o.audienceContext ?? '', offerContext: o.offerContext ?? '', customInstructions: o.customInstructions ?? '',
      objective: o.objective ?? '', targetGeography: (o.targetGeography ?? []).join('\n'), targetIndustries: (o.targetIndustries ?? []).join('\n'), targetDecisionMaker: o.targetDecisionMaker ?? '', desiredProspectOutcome: o.desiredProspectOutcome ?? '', outreachAngle: o.outreachAngle ?? '', buyingSignals: (o.buyingSignals ?? []).join('\n'), exclusions: (o.exclusions ?? []).join('\n'), maxEvidenceAgeDays: o.research?.maxEvidenceAgeDays ?? '',
      aiSource: o.aiSource ?? 'workspace',
      serviceSelections: campaign.serviceSelections ?? [],
      personTopics: (o.research?.personTopics ?? []).join('\n'), companyTopics: (o.research?.companyTopics ?? []).join('\n'), onMissing: o.research?.onMissing ?? '', researchNotes: o.research?.customInstructions ?? '',
    });
    setServices((campaign.serviceSelections ?? []).map((s: any) => ({ serviceVersionId: s.serviceVersionId, isPreferred: !!s.isPreferred })));
  }, [campaign]);
  const save = useWsMutation(() => {
    const w: any = {};
    for (const k of ['tone', 'ctaStyle', 'formality', 'personalizationIntensity']) if (f.writing[k]) w[k] = f.writing[k];
    for (const k of ['minWords', 'maxWords']) if (f.writing[k] !== '' && f.writing[k] !== undefined) w[k] = Number(f.writing[k]);
    if (lines(f.avoid).length) w.avoidPhrases = lines(f.avoid);
    if (lines(f.forbidden).length) w.forbiddenClaims = lines(f.forbidden);
    const r: any = {};
    if (lines(f.personTopics).length) r.personTopics = lines(f.personTopics);
    if (lines(f.companyTopics).length) r.companyTopics = lines(f.companyTopics);
    if (f.onMissing) r.onMissing = f.onMissing;
    if (f.maxEvidenceAgeDays !== '' && f.maxEvidenceAgeDays !== undefined) r.maxEvidenceAgeDays = Number(f.maxEvidenceAgeDays);
    if (f.researchNotes.trim()) r.customInstructions = f.researchNotes;
    return { path: `/campaigns/${campaign.id}/ai`, method: 'PUT', body: { aiProfileId: f.aiProfileId || null, icpId: f.icpId || null, maxAiCostPerLeadUsd: f.maxAiCostPerLeadUsd === '' ? null : Number(f.maxAiCostPerLeadUsd), aiOverrides: { writing: w, research: r, audienceContext: f.audienceContext, offerContext: f.offerContext, objective: f.objective, targetGeography: lines(f.targetGeography), targetIndustries: lines(f.targetIndustries), targetDecisionMaker: f.targetDecisionMaker, desiredProspectOutcome: f.desiredProspectOutcome, outreachAngle: f.outreachAngle, buyingSignals: lines(f.buyingSignals), exclusions: lines(f.exclusions), customInstructions: f.customInstructions, aiSource: f.aiSource } } };
  }, { success: 'AI settings saved (campaign needs re-approval)' });
  const saveServices = useWsMutation(() => ({ path: `/campaigns/${campaign.id}/services`, method: 'PUT', body: { selections: services } }), { success: 'Approved service selection saved (campaign needs re-approval)' });
  if (!f) return null;
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const setW = (k: string, v: any) => setF({ ...f, writing: { ...f.writing, [k]: v } });
  return (
    <div className="space-y-4">
    <Card title="Approved EMN services" actions={<Button loading={saveServices.isPending} onClick={() => saveServices.mutate()}>Save services</Button>}>
      <Notice>Select the approved services this campaign is allowed to offer. The AI is held if it cannot support an exact selected service with prospect evidence. A preferred service is used as the primary match.</Notice>
      <div className="mt-3 space-y-2">{(serviceCatalog.data ?? []).flatMap((svc: any) => (svc.versions ?? []).filter((v: any) => v.status === 'APPROVED').map((v: any) => {
        const selected = services.some((x) => x.serviceVersionId === v.id);
        return <div key={v.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-slate-200 p-2"><Checkbox label={`${svc.name} · v${v.version}`} checked={selected} onChange={(checked) => setServices((cur) => checked ? [...cur, { serviceVersionId: v.id, isPreferred: cur.length === 0 }] : cur.filter((x) => x.serviceVersionId !== v.id))} /><span className="text-xs text-slate-500">{v.description}</span>{selected && <Select aria-label={`Preferred service ${svc.name}`} value={services.find((x) => x.serviceVersionId === v.id)?.isPreferred ? v.id : ''} onChange={(e) => setServices((cur) => cur.map((x) => ({ ...x, isPreferred: x.serviceVersionId === e.target.value })))} options={[{ value: '', label: 'Alternative' }, { value: v.id, label: 'Preferred' }]} />}</div>;
      }))}{!(serviceCatalog.data ?? []).some((svc: any) => (svc.versions ?? []).some((v: any) => v.status === 'APPROVED')) && <p className="text-sm text-amber-700">No approved service versions yet. Add and approve them in AI Studio → Business knowledge.</p>}</div>
    </Card>
    <Card title="Campaign AI profile & overrides" actions={<Button loading={save.isPending} onClick={() => save.mutate()}>Save AI settings</Button>}>
      <Notice>Order of precedence: <b>platform safety rules</b> (cannot be overridden) → AI Studio workspace defaults → prompt profile → <b>these campaign settings</b> → ICP instructions → step instructions → variant angle → per-prospect instructions. Blank fields inherit. Words to avoid and forbidden claims add to the workspace lists; they never remove from them.</Notice>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <Field label="AI source for this campaign" hint={SOURCE_HINT[f.aiSource as keyof typeof SOURCE_HINT]}><Select aria-label="AI source for this campaign" value={f.aiSource} onChange={(e) => set('aiSource', e.target.value)} options={[{ value: 'workspace', label: `Workspace setting${ws.data ? ` (${ws.data.options.find((x) => x.mode === ws.data!.mode)?.label ?? ''})` : ''}` }, ...(ws.data?.options ?? []).map((x) => ({ value: x.mode, label: x.available || x.mode === 'api' ? x.label : `${x.label} (not connected)` }))]} /></Field>
        <Field label="Prompt profile"><Select value={f.aiProfileId} onChange={(e) => set('aiProfileId', e.target.value)} options={[{ value: '', label: '— none —' }, ...(profiles.data ?? []).map((p: any) => ({ value: p.id, label: `${p.name}${p.activeVersion ? ` (v${p.activeVersion})` : ''}${p.isApproved ? ' ✓' : ''}` }))]} /></Field>
        <Field label="ICP (adds its AI instructions)"><Select value={f.icpId} onChange={(e) => set('icpId', e.target.value)} options={[{ value: '', label: '— none —' }, ...((icps.data?.data ?? icps.data ?? []) as any[]).map((i: any) => ({ value: i.id, label: i.name }))]} /></Field>
        <Field label="Max AI cost per lead (USD)" hint="Blank = workspace default"><Input type="number" step="0.01" min={0} value={f.maxAiCostPerLeadUsd} onChange={(e) => set('maxAiCostPerLeadUsd', e.target.value)} /></Field>
        <Field label="Tone"><Select value={f.writing.tone} onChange={(e) => setW('tone', e.target.value)} options={[INHERIT, ...o(['friendly', 'professional', 'direct', 'consultative', 'casual'])]} /></Field>
        <Field label="CTA style"><Select value={f.writing.ctaStyle} onChange={(e) => setW('ctaStyle', e.target.value)} options={[INHERIT, ...o(['soft_question', 'interest_check', 'meeting_request', 'resource_offer', 'booking_link'])]} /></Field>
        <Field label="Formality"><Select value={f.writing.formality} onChange={(e) => setW('formality', e.target.value)} options={[INHERIT, ...o(['informal', 'neutral', 'formal'])]} /></Field>
        <Field label="Personalization intensity"><Select value={f.writing.personalizationIntensity} onChange={(e) => setW('personalizationIntensity', e.target.value)} options={[INHERIT, ...o(['light', 'medium', 'deep'])]} /></Field>
        <Field label="Min words"><Input type="number" value={f.writing.minWords} onChange={(e) => setW('minWords', e.target.value)} /></Field>
        <Field label="Max words"><Input type="number" value={f.writing.maxWords} onChange={(e) => setW('maxWords', e.target.value)} /></Field>
        <Field label="Maximum evidence age (days)" hint="Evidence older than this is excluded"><Input type="number" min={1} max={3650} value={f.maxEvidenceAgeDays} onChange={(e) => set('maxEvidenceAgeDays', e.target.value)} /></Field>
        <Field label="Extra words to avoid (one per line)"><Textarea rows={3} value={f.avoid} onChange={(e) => set('avoid', e.target.value)} /></Field>
        <Field label="Extra claims AI must never make (one per line)"><Textarea rows={3} value={f.forbidden} onChange={(e) => set('forbidden', e.target.value)} /></Field>
        <Field label="If research is missing"><Select value={f.onMissing} onChange={(e) => set('onMissing', e.target.value)} options={[INHERIT, { value: 'hold_for_research', label: 'Hold until researched' }, { value: 'use_role_and_company_only', label: 'Simple honest email (role + company only)' }, { value: 'skip_lead', label: 'Skip the lead' }]} /></Field>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Field label="Campaign objective"><Input value={f.objective} onChange={(e) => set('objective', e.target.value)} placeholder="Start conversations about an approved service" /></Field>
        <Field label="Target decision-maker"><Input value={f.targetDecisionMaker} onChange={(e) => set('targetDecisionMaker', e.target.value)} placeholder="e.g. Founder or VP of Marketing" /></Field>
        <Field label="Target geography" hint="One per line"><Textarea rows={2} value={f.targetGeography} onChange={(e) => set('targetGeography', e.target.value)} /></Field>
        <Field label="Target industries" hint="One per line"><Textarea rows={2} value={f.targetIndustries} onChange={(e) => set('targetIndustries', e.target.value)} /></Field>
        <Field label="Desired prospect outcome"><Textarea rows={2} value={f.desiredProspectOutcome} onChange={(e) => set('desiredProspectOutcome', e.target.value)} /></Field>
        <Field label="Outreach angle"><Textarea rows={2} value={f.outreachAngle} onChange={(e) => set('outreachAngle', e.target.value)} /></Field>
        <Field label="Buying signals" hint="One per line"><Textarea rows={2} value={f.buyingSignals} onChange={(e) => set('buyingSignals', e.target.value)} /></Field>
        <Field label="Exclusions" hint="One per line"><Textarea rows={2} value={f.exclusions} onChange={(e) => set('exclusions', e.target.value)} /></Field>
        <Field label="Target audience context"><Textarea rows={3} value={f.audienceContext} onChange={(e) => set('audienceContext', e.target.value)} placeholder="e.g. Consulting founders with 2–20 staff selling B2B advisory services" /></Field>
        <Field label="Offer context"><Textarea rows={3} value={f.offerContext} onChange={(e) => set('offerContext', e.target.value)} placeholder="What this campaign offers" /></Field>
        <Field label="Extra person research topics (one per line)"><Textarea rows={2} value={f.personTopics} onChange={(e) => set('personTopics', e.target.value)} /></Field>
        <Field label="Extra company research topics (one per line)"><Textarea rows={2} value={f.companyTopics} onChange={(e) => set('companyTopics', e.target.value)} /></Field>
      </div>
      <Field label="Campaign instructions for the AI" hint="Overrides workspace instructions where they conflict"><Textarea rows={6} value={f.customInstructions} onChange={(e) => set('customInstructions', e.target.value)} placeholder="This campaign targets consulting founders. Understand their services, audience, public content and business model. Identify opportunities to generate qualified consulting enquiries." /></Field>
      <Field label="Campaign research notes"><Textarea rows={2} value={f.researchNotes} onChange={(e) => set('researchNotes', e.target.value)} /></Field>
    </Card>
    </div>
  );
}

function Generation({ campaign }: { campaign: any }) {
  const aiSteps = (campaign.sequence?.steps ?? []).filter((s: any) => s.personalizationMode !== 'TEMPLATE_ONLY');
  const [opts, setOpts] = useState<{ stepIds: string[]; force: boolean; onlyMissing: boolean; maxCostUsd: string }>({ stepIds: [], force: false, onlyMissing: true, maxCostUsd: '' });
  const [est, setEst] = useState<any>(null);
  const body = () => ({ stepIds: opts.stepIds.length ? opts.stepIds : undefined, force: opts.force, onlyMissing: opts.onlyMissing, maxCostUsd: opts.maxCostUsd === '' ? null : Number(opts.maxCostUsd) });
  const estimate = useWsMutation(() => ({ path: `/campaigns/${campaign.id}/personalizations/estimate`, body: body() }), { invalidate: false, onSuccess: (r: any) => setEst(r) });
  const start = useWsMutation(() => ({ path: `/campaigns/${campaign.id}/personalizations/batches`, body: body() }), { success: (r: any) => `Queued ${r.generations} generation(s)`, onSuccess: () => setEst(null) });
  const research = useWsMutation(() => ({ path: `/campaigns/${campaign.id}/personalizations/research-missing`, body: { maxAgeDays: 90 } }), { success: (r: any) => `Research queued for ${r.queued} lead(s)` });
  const retry = useWsMutation(() => ({ path: `/campaigns/${campaign.id}/personalizations/retry-failed`, body: {} }), { success: 'Failed generations re-queued' });
  const batches = useWsQuery<any[]>(`/campaigns/${campaign.id}/personalizations/batches`, { refetchInterval: 5000 });
  const cancel = useWsMutation<string>((id) => ({ path: `/personalization-batches/${id}/cancel`, body: {} }), { success: 'Batch cancelled' });
  if (!aiSteps.length) return <Notice>No step uses AI personalization. Set a step to “AI writes full email” or “AI first line” in the sequence builder.</Notice>;
  return (
    <Card title="Bulk generation" actions={<><Button variant="secondary" loading={research.isPending} onClick={() => research.mutate()}>Research leads without evidence</Button><Button variant="secondary" loading={retry.isPending} onClick={() => retry.mutate()}>Retry failed</Button></>}>
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Steps"><div className="space-y-1">{aiSteps.map((s: any) => <Checkbox key={s.id} label={`Step ${s.order}`} checked={opts.stepIds.includes(s.id)} onChange={(v) => setOpts({ ...opts, stepIds: v ? [...opts.stepIds, s.id] : opts.stepIds.filter((x) => x !== s.id) })} />)}<span className="text-xs text-slate-500">none selected = all AI steps</span></div></Field>
        <div className="space-y-2 pt-6"><Checkbox label="Only leads without a draft" checked={opts.onlyMissing} onChange={(v) => setOpts({ ...opts, onlyMissing: v })} /><Checkbox label="Force (also regenerate approved / manually edited)" checked={opts.force} onChange={(v) => setOpts({ ...opts, force: v })} /></div>
        <Field label="Stop batch at cost (USD, optional)"><Input type="number" step="0.5" min={0} value={opts.maxCostUsd} onChange={(e) => setOpts({ ...opts, maxCostUsd: e.target.value })} /></Field>
        <div className="flex items-end gap-2"><Button variant="secondary" loading={estimate.isPending} onClick={() => estimate.mutate()}>Estimate cost</Button><Button disabled={!est || !est.generations} loading={start.isPending} onClick={() => start.mutate()}>Generate</Button></div>
      </div>
      {est && <div className="mt-3"><Notice kind={est.priced ? 'info' : 'warning'}>{est.generations} generation(s) for {est.leads} lead(s) × {est.steps} step(s){est.preserved ? ` · ${est.preserved} preserved (approved/edited/already drafted)` : ''} · estimated <b>{usd(est.estimatedUsd)}</b> ({usd(est.perGenerationUsd)} each, upper bound). {est.note}</Notice></div>}
      {opts.force && <div className="mt-2"><Notice kind="warning">Force regenerates approved and manually edited emails. Their approval is reset and the previous text stays in the revision history.</Notice></div>}
      <div className="mt-4">
        <QueryView q={batches} isEmpty={(d) => !d.length} empty={<p className="text-sm text-slate-500">No bulk runs yet.</p>}>
          {(d) => <Table head={['Started', 'Status', 'Progress', 'Cost (est → actual)', '']}>{d.map((b: any) => <tr key={b.id}><td>{fmtDate(b.createdAt)}</td><td><Badge>{b.status}</Badge>{b.error && <div className="text-xs text-slate-500">{b.error}</div>}</td><td>{b.done} done · {b.failed} failed · {b.skipped} skipped / {b.total}</td><td>{usd(b.estimatedCostUsd)} → {usd(b.spentUsd)}</td><td>{b.status === 'RUNNING' && <Button variant="ghost" onClick={() => cancel.mutate(b.id)}>Cancel</Button>}</td></tr>)}</Table>}
        </QueryView>
      </div>
    </Card>
  );
}

function PersonalizationTable({ campaign }: { campaign: any }) {
  const [filter, setFilter] = useState({ status: '', stepId: '', q: '', page: 1 });
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const q = useWsQuery<Paged<any> & { summary: any }>(`/campaigns/${campaign.id}/personalizations${qs({ ...filter, pageSize: 50 })}`, { refetchInterval: 8000 });
  const approve = useWsMutation(() => ({ path: '/personalizations/approve', body: { ids: selected } }), { success: (r: any) => `Approved ${r.approved}${r.refused?.length ? `, ${r.refused.length} refused (failing checks)` : ''}`, onSuccess: () => setSelected([]) });
  return (
    <Card title="Every recipient's generated sequence" actions={<Button disabled={!selected.length} loading={approve.isPending} onClick={() => approve.mutate()}>Approve selected ({selected.length})</Button>}>
      <div className="mb-3 flex flex-wrap gap-2">
        <Input placeholder="Search lead" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value, page: 1 })} className="w-56" />
        <Select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value, page: 1 })} options={[{ value: '', label: 'All statuses' }, ...o(['GENERATED', 'BLOCKED', 'APPROVED', 'NEEDS_RESEARCH', 'FAILED', 'SKIPPED', 'QUEUED', 'REJECTED'])]} className="w-48" />
        <Select value={filter.stepId} onChange={(e) => setFilter({ ...filter, stepId: e.target.value, page: 1 })} options={[{ value: '', label: 'All steps' }, ...(campaign.sequence?.steps ?? []).map((s: any) => ({ value: s.id, label: `Step ${s.order}` }))]} className="w-36" />
      </div>
      <QueryView q={q} isEmpty={(d) => !d.data.length} empty={<Empty title="Nothing generated yet">Use bulk generation above, or open a lead from the Preview tab.</Empty>}>
        {(d) => (
          <>
            <p className="mb-2 text-xs text-slate-500">{Object.entries(d.summary.byStatus).map(([k, v]) => `${k}: ${v}`).join(' · ')} · AI cost so far {usd(d.summary.aiCostUsd)}</p>
            <Table head={['', 'Lead', 'Step', 'Status', 'Score', 'Opening', 'Warnings', 'Cost', '']}>
              {d.data.map((r: any) => (
                <tr key={r.id}>
                  <td><input type="checkbox" disabled={!r.qualityPassed || r.status === 'APPROVED'} checked={selected.includes(r.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, r.id] : selected.filter((x) => x !== r.id))} /></td>
                  <td>{fullName(r.lead) || r.lead.email}<div className="text-xs text-slate-500">{r.lead.title}{r.lead.company?.name ? ` · ${r.lead.company.name}` : ''}</div></td>
                  <td>{r.step.order}{r.variant ? r.variant.label : ''}</td>
                  <td><Badge color={STATUS_COLOR[r.status]}>{r.status}</Badge>{r.manuallyEdited && <div className="text-xs">edited</div>}</td>
                  <td>{r.score ?? '—'}</td>
                  <td className="max-w-xs truncate text-xs">{r.openingLine ?? r.error ?? ''}</td>
                  <td className="text-xs">{r.warnings.length ? <span title={r.warnings.join('\n')}>{r.warnings.length}</span> : '—'}</td>
                  <td className="text-xs">{usd(r.costUsd)}{r.costIsEstimate ? '*' : ''}</td>
                  <td><Button variant="ghost" onClick={() => setOpen(r.leadId)}>Review</Button></td>
                </tr>
              ))}
            </Table>
            <Pagination page={d.page} totalPages={d.totalPages} total={d.total} onPage={(p) => setFilter({ ...filter, page: p })} />
            <p className="mt-1 text-xs text-slate-500">* cost marked with an asterisk used a model without a configured price (shown as an estimate).</p>
          </>
        )}
      </QueryView>
      {open && <LeadReviewModal campaignId={campaign.id} leadId={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

export function LeadReviewModal({ campaignId, leadId, onClose }: { campaignId: string; leadId: string; onClose: () => void }) {
  const ws = useWs();
  const research = useWsMutation(() => ({ path: `/leads/${leadId}/research`, body: { campaignId } }), { success: 'Research queued' });
  const q = useWsQuery<any>(`/campaigns/${campaignId}/personalizations/lead/${leadId}`);
  const exclude = useWsMutation<string>((reason) => ({
    path: '/leads/bulk', body: { ids: [leadId], action: 'review_qualification', review: 'DISQUALIFIED', reviewReason: reason },
  }), { success: 'Prospect excluded from outreach' });
  const [instr, setInstr] = useState<string | null>(null);
  const saveInstr = useWsMutation(() => ({ path: `/leads/${leadId}/ai-instructions`, method: 'PUT', body: { aiInstructions: instr } }), { success: 'Prospect instructions saved' });
  return (
    <Modal open wide title="Recipient review" onClose={onClose}>
      <QueryView q={q}>
        {(d) => (
          <div className="space-y-4">
            <div className="text-sm"><b>{fullName(d.lead) || d.lead.email}</b> · {d.lead.title ?? 'no title'} · {d.lead.company?.name ?? 'no company'} · {d.lead.email} · AI cost for this lead {usd(d.aiCostUsd)}</div>
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge>{d.lead.emailVerificationStatus}</Badge>
              <Badge>{d.lead.qualificationReview?.replaceAll('_', ' ') ?? 'Qualification not reviewed'}</Badge>
              <span>ICP score {d.lead.currentScore ?? 'unavailable'}</span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" loading={research.isPending} onClick={() => research.mutate()}>Research this prospect</Button>
              {d.lead.qualificationReview !== 'DISQUALIFIED' && <Button variant="secondary" loading={exclude.isPending} onClick={() => {
                const reason = window.prompt('Exclude this prospect from outreach across the workspace. Enter a reason.');
                if (reason && reason.trim().length >= 3) exclude.mutate(reason);
              }}>Exclude from outreach</Button>}
              <Link className="text-sm underline" href={`/w/${ws}/copilot?leadId=${leadId}&campaignId=${campaignId}`}>Research with Copilot</Link>
            </div>
            <Card title={`Research used (${d.research.claims.length} evidence-backed claims${d.research.excludedByRules ? `, ${d.research.excludedByRules} excluded by research rules` : ''})`}>
              {d.research.claims.length === 0 ? <Notice kind="warning">No usable evidence. The AI is told not to state any prospect-specific fact. {d.research.reports[0]?.error ?? ''}</Notice> : (
                <ul className="space-y-2 text-sm">{d.research.claims.map((c: any) => <li key={c.id}><b>{c.text}</b><div className="text-xs text-slate-500">“{c.quote}” — <a className="underline" href={c.url} target="_blank" rel="noreferrer noopener">{c.title ?? c.url}</a> · {c.sourceType} · retrieved {fmtDate(c.fetchedAt)} · confidence {Math.round(c.confidence * 100)}%</div></li>)}</ul>
              )}
            </Card>
            <Field label="Instructions for this prospect only (applied last)"><Textarea rows={2} value={instr ?? d.lead.aiInstructions ?? ''} onChange={(e) => setInstr(e.target.value)} placeholder="e.g. We met at the Jaipur founders meetup — mention it." /></Field>
            {instr !== null && <Button variant="secondary" loading={saveInstr.isPending} onClick={() => saveInstr.mutate()}>Save prospect instructions</Button>}
            {d.steps.filter((s: any) => s.personalizationMode !== 'TEMPLATE_ONLY').map((s: any) => <StepReview key={s.id} campaignId={campaignId} leadId={leadId} step={s} row={d.personalizations.find((p: any) => p.stepId === s.id)} />)}
          </div>
        )}
      </QueryView>
    </Modal>
  );
}

function StepReview({ campaignId, leadId, step, row }: { campaignId: string; leadId: string; step: any; row: any }) {
  const [edit, setEdit] = useState<any>(null);
  const [note, setNote] = useState('');
  const [compare, setCompare] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [rejectReasonCode, setRejectReasonCode] = useState('OTHER');
  const [rejectReason, setRejectReason] = useState('');
  const gen = useWsMutation<{ force: boolean }>((b) => ({ path: `/campaigns/${campaignId}/personalizations/generate`, body: { leadId, stepId: step.id, force: b.force, note: note || undefined } }), { success: (r: any) => (r.preserved ? `Preserved: ${r.preserved}` : `Result: ${r.status}`) });
  const variants = useWsMutation(() => ({ path: `/personalizations/${row.id}/variants`, body: {} }), { success: 'Alternatives generated for review' });
  const selectVariant = useWsMutation<string>((selectionId) => ({
    path: `/personalizations/${row.id}/variants/select`, body: { selectionId, revision: row.revision },
  }), { success: 'Alternative selected. Approval is still required.' });
  const save = useWsMutation(() => ({ path: `/personalizations/${row.id}`, method: 'PATCH', body: { ...edit, rerunFactCheck: true } }), { success: (r: any) => `Saved (revision ${r.revision}, ${r.status})`, onSuccess: () => setEdit(null) });
  const approve = useWsMutation(() => ({ path: '/personalizations/approve', body: { ids: [row.id] } }), { success: 'Approved' });
  const reject = useWsMutation(() => ({ path: `/personalizations/${row.id}/reject`, body: { reason: rejectReason || rejectReasonCode.replaceAll('_', ' ').toLowerCase(), reasonCode: rejectReasonCode } }), { success: 'Rejected' });
  const promote = useWsMutation(() => ({ path: `/personalizations/${row.id}/promote-example`, method: 'POST', body: {} }), { success: 'Redacted approved example added to workspace retrieval' });
  const detail = useWsQuery<any>(compare && row ? `/personalizations/${row.id}` : null);
  const prompt = useWsQuery<any>(showPrompt ? `/campaigns/${campaignId}/personalizations/prompt-preview${qs({ leadId, stepId: step.id })}` : null);
  return (
    <Card title={<>Step {step.order} {row && <Badge color={STATUS_COLOR[row.status]}>{row.status}</Badge>} {row?.manuallyEdited && <Badge>manually edited</Badge>} {row?.contentHashMatches === false && <Badge color="red">changed after approval</Badge>}</>}
      actions={<>
        <Button variant="ghost" onClick={() => setShowPrompt(!showPrompt)}>{showPrompt ? 'Hide' : 'Show'} instructions used</Button>
        {row?.revision > 1 && <Button variant="ghost" onClick={() => setCompare(!compare)}>Compare revisions</Button>}
      </>}>
      {!row && <p className="text-sm text-slate-500">Not generated yet.</p>}
      {row?.error && <Notice kind={row.status === 'FAILED' ? 'danger' : 'warning'}>{row.error}</Notice>}
      {row?.body && !edit && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2 text-sm">
            {row.subject !== null && <div><span className="label">Subject</span>{row.subject}{row.subjectAlternatives?.length > 0 && <div className="text-xs text-slate-500">alternatives: {row.subjectAlternatives.join(' · ')}</div>}</div>}
            <div><span className="label">Body</span><pre className="whitespace-pre-wrap rounded bg-slate-50 p-2 font-sans">{row.body}</pre></div>
            {row.cta && <div className="text-xs">CTA: {row.cta}</div>}
            <div className="text-xs text-slate-500">Revision {row.revision} · generated {fmtDate(row.generatedAt)} · cost {usd(row.costUsd)}{row.costIsEstimate ? ' (estimate)' : ''}{row.profileVersionId ? ' · prompt profile version pinned' : ''}</div>
          </div>
          <div className="space-y-2">
            {row.scoreExplanation?.rewriteAttempted && <p className="text-xs text-slate-600">One rewrite attempted · {row.scoreExplanation.decision === 'PASS' ? 'passed evaluation' : 'held for review'}</p>}
            <CheckList quality={row.quality} /><ScoreBox score={row.score} explanation={row.scoreExplanation} />
          </div>
        </div>
      )}
      {edit && (
        <div className="space-y-2">
          {row.subject !== null && <Field label="Subject"><Input value={edit.subject ?? ''} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} /></Field>}
          <Field label="Opening line"><Input value={edit.openingLine ?? ''} onChange={(e) => setEdit({ ...edit, openingLine: e.target.value })} /></Field>
          <Field label="Body"><Textarea rows={10} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
          <Field label="Feedback scope" hint="Only global feedback can create a reviewable learning suggestion."><Select value={edit.feedbackScope ?? 'CAMPAIGN'} onChange={(e) => setEdit({ ...edit, feedbackScope: e.target.value })} options={o(['CAMPAIGN', 'PROSPECT', 'FACTUAL', 'GLOBAL'])} /></Field>
          <Field label="Why did you change it? (optional)"><Input value={edit.feedbackNote ?? ''} onChange={(e) => setEdit({ ...edit, feedbackNote: e.target.value })} maxLength={1000} /></Field>
          <div className="flex gap-2"><Button loading={save.isPending} onClick={() => save.mutate()}>Save edit (re-checks; preserved from regeneration)</Button><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button></div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        {row?.body && !edit && <Button variant="secondary" onClick={() => setEdit({ subject: row.subject, openingLine: row.openingLine, body: row.body, feedbackScope: 'CAMPAIGN', feedbackNote: '' })}>Edit</Button>}
        {row && ['GENERATED', 'BLOCKED'].includes(row.status) && <Button disabled={!row.qualityPassed} loading={approve.isPending} onClick={() => approve.mutate()} title={row.qualityPassed ? '' : 'Fix failing checks first'}>Approve</Button>}
        {row?.status === 'APPROVED' && <Button variant="secondary" loading={promote.isPending} onClick={() => promote.mutate()}>Add as approved example</Button>}
        {row && ['GENERATED', 'BLOCKED', 'APPROVED'].includes(row.status) && <><Select aria-label="Rejection reason" value={rejectReasonCode} onChange={(e) => setRejectReasonCode(e.target.value)} options={REJECTION_REASONS.map((x) => ({ value: x, label: x.replaceAll('_', ' ').toLowerCase() }))} /><Input className="w-56" placeholder="Optional rejection details" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} maxLength={500} /></>}
        {row && ['GENERATED', 'BLOCKED', 'APPROVED'].includes(row.status) && <Button variant="ghost" onClick={() => reject.mutate()}>Reject</Button>}
        <Input className="w-72" placeholder="Optional note for regeneration" value={note} onChange={(e) => setNote(e.target.value)} />
        {(!row || !['APPROVED'].includes(row.status) && !row.manuallyEdited)
          ? <Button variant="secondary" loading={gen.isPending} onClick={() => gen.mutate({ force: false })}>{row ? 'Regenerate' : 'Generate'}</Button>
          : <ConfirmButton variant="secondary" confirm="Regenerate and replace approved / manually edited content? The current text stays in the revision history and approval is reset." onConfirm={() => gen.mutate({ force: true })}>Force regenerate</ConfirmButton>}
      </div>
      {row?.body && row.status !== 'APPROVED' && !edit && <div className="mt-3">
        <Button variant="secondary" loading={variants.isPending} onClick={() => variants.mutate()}>Generate three alternatives</Button>
      </div>}
      {Array.isArray(row?.draftVariants) && row.draftVariants.length > 0 && <div className="mt-3 grid gap-3 lg:grid-cols-3">
        {row.draftVariants.map((draft: any) => <Card key={draft.label} title={draft.label}>
          <p className="text-sm font-medium">{draft.subject}</p>
          <p className="my-2 whitespace-pre-wrap text-sm">{draft.body}</p>
          <CheckList quality={draft.quality} />
          {row.status !== 'APPROVED' && draft.selectable && <Button variant="secondary" loading={selectVariant.isPending} onClick={() => selectVariant.mutate(draft.selectionId)}>Select for review</Button>}
          {!draft.selectable && <p className="text-xs text-slate-500">This draft did not pass the quality or distinctness checks.</p>}
        </Card>)}
      </div>}
      {compare && detail.data && <RevisionCompare revisions={detail.data.revisions} />}
      {showPrompt && prompt.data && (
        <div className="mt-3 rounded border border-slate-200 p-2 text-xs">
          <p className="mb-1">{prompt.data.frozenConfig ? 'Using the configuration frozen at campaign approval.' : 'Using the live AI Studio configuration.'} Variant {prompt.data.variant} · {prompt.data.claims} claim(s) · earlier steps used as context: {prompt.data.previousSteps.join(', ') || 'none'}</p>
          <p className="mb-1">Settings source: {Object.entries(prompt.data.resolved.writingSources).map(([k, v]) => `${k}=${v}`).join(', ')}</p>
          {prompt.data.profilePrompt.missing.length > 0 && <Notice kind="warning">Prompt variables empty for this lead: {prompt.data.profilePrompt.missing.join(', ')}</Notice>}
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap">{prompt.data.prompt.instructions}{'\n\n'}PROFILE PROMPT:{'\n'}{prompt.data.profilePrompt.text}{'\n\n'}{prompt.data.prompt.stepContext}</pre>
        </div>
      )}
    </Card>
  );
}

function RevisionCompare({ revisions }: { revisions: any[] }) {
  const [a, setA] = useState(revisions[1]?.revision ?? revisions[0]?.revision);
  const [b, setB] = useState(revisions[0]?.revision);
  const ra = revisions.find((r) => r.revision === a); const rb = revisions.find((r) => r.revision === b);
  const opts = revisions.map((r) => ({ value: String(r.revision), label: `rev ${r.revision} · ${r.source} · ${fmtDate(r.createdAt)}` }));
  return (
    <div className="mt-3 grid gap-3 lg:grid-cols-2">
      {[[ra, setA, a], [rb, setB, b]].map(([r, set, v]: any, i) => (
        <div key={i} className="rounded border border-slate-200 p-2 text-sm">
          <Select value={String(v)} onChange={(e) => set(Number(e.target.value))} options={opts} />
          {r && <><div className="mt-2 text-xs">score {r.score ?? '—'} · {usd(r.costUsd)}</div>{r.subject && <div className="font-medium">{r.subject}</div>}<pre className="whitespace-pre-wrap font-sans">{r.body}</pre></>}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ preview & test

export function PreviewPanel({ campaign }: { campaign: any }) {
  const listId = campaign.lists?.[0]?.listId;
  const leads = useWsQuery<Paged<any>>(listId ? `/leads${qs({ listId, pageSize: 100 })}` : null);
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<any>('/auth/me') });
  const [leadId, setLeadId] = useState('');
  const [stepOrder, setStepOrder] = useState(1);
  const [to, setTo] = useState('');
  const [review, setReview] = useState(false);
  useEffect(() => { if (me.data?.user?.email && !to) setTo(me.data.user.email); }, [me.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const pv = useWsQuery<any>(leadId ? `/campaigns/${campaign.id}/preview${qs({ leadId, stepOrder })}` : null);
  const accounts = campaign.accounts?.filter((a: any) => a.emailAccount.status === 'CONNECTED') ?? [];
  const send = useWsMutation(() => ({ path: `/campaigns/${campaign.id}/test-email`, body: { leadId, stepOrder, to } }), { invalidate: false, success: (r: any) => `Test sent to ${r.to}` });
  if (!listId) return <Notice>Select a lead list in “Lists & mailboxes” first.</Notice>;
  return (
    <Card title="Preview any recipient & send a test">
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Lead"><Select value={leadId} onChange={(e) => setLeadId(e.target.value)} options={[{ value: '', label: 'Choose a lead…' }, ...(leads.data?.data ?? []).map((l: any) => ({ value: l.id, label: `${fullName(l) || l.email} (${l.email})` }))]} /></Field>
        <Field label="Step"><Select value={String(stepOrder)} onChange={(e) => setStepOrder(Number(e.target.value))} options={(campaign.sequence?.steps ?? []).map((s: any) => ({ value: String(s.order), label: `Step ${s.order}` }))} /></Field>
        <div className="flex items-end"><Button variant="secondary" disabled={!leadId} onClick={() => setReview(true)}>Open full recipient review</Button></div>
      </div>
      {pv.data && (
        <div className="mt-4 space-y-2 text-sm">
          {pv.data.notes.map((n: string) => <Notice key={n}>{n}</Notice>)}
          {pv.data.missingVariables.length > 0 && <Notice kind="danger">Missing variables for this lead: {pv.data.missingVariables.join(', ')}</Notice>}
          <div><span className="label">Subject (variant {pv.data.variant})</span>{pv.data.subject || <i>reply in thread</i>}</div>
          <pre className="whitespace-pre-wrap rounded border border-slate-200 bg-white p-3 font-sans">{pv.data.body}</pre>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Send test to (must be a workspace member's address)"><Input value={to} onChange={(e) => setTo(e.target.value)} className="w-72" /></Field>
            <Button disabled={!accounts.length || !to} loading={send.isPending} onClick={() => send.mutate()}>Send test email</Button>
            {!accounts.length && <span className="text-xs text-slate-500">Connect a mailbox to this campaign first.</span>}
          </div>
        </div>
      )}
      {review && leadId && <LeadReviewModal campaignId={campaign.id} leadId={leadId} onClose={() => setReview(false)} />}
    </Card>
  );
}

export function VersionsPanel({ campaign }: { campaign: any }) {
  const q = useWsQuery<any[]>(`/campaigns/${campaign.id}/versions`);
  const restore = useWsMutation<number>((v) => ({ path: `/campaigns/${campaign.id}/versions/${v}/restore`, body: {} }), { success: 'Version restored into the editor — review and re-approve' });
  const [open, setOpen] = useState<any>(null);
  return (
    <Card title="Sequence versions (one per approval)">
      <QueryView q={q} isEmpty={(d) => !d.length} empty={<Empty title="No approved versions yet">A version is recorded every time the campaign is approved.</Empty>}>
        {(d) => <Table head={['Version', 'Approved', 'Steps', 'AI config', '']}>{d.map((v: any) => (
          <tr key={v.id}>
            <td>v{v.version}</td><td>{fmtDate(v.createdAt)}</td><td>{v.snapshot.steps?.length ?? 0}</td>
            <td className="text-xs">writing v{v.snapshot.ai?.writingVersion ?? 0} · research v{v.snapshot.ai?.researchVersion ?? 0} · knowledge v{v.snapshot.ai?.knowledgeVersion ?? 0}{v.snapshot.ai?.profileVersion ? ` · profile v${v.snapshot.ai.profileVersion}` : ''}{v.snapshot.aiConfigSnapshot?.executionSnapshotId ? <div className="mt-1">Snapshot {String(v.snapshot.aiConfigSnapshot.executionSnapshotId).slice(0, 8)} · quality v{v.snapshot.aiConfigSnapshot.qualityPolicyVersion ?? '—'} · prompts {Object.entries(v.snapshot.aiConfigSnapshot.taskExecution ?? {}).map(([task, cfg]: [string, any]) => `${task} v${cfg.promptVersion ?? '—'} (${cfg.candidates?.map((c: any) => `${c.provider}/${c.model}`).join('→') ?? 'no route'})`).join(', ')}</div> : null}</td>
            <td className="space-x-2"><Button variant="ghost" onClick={() => setOpen(v)}>View</Button>{campaign.status !== 'RUNNING' && <ConfirmButton variant="ghost" confirm={`Load v${v.version} into the editor? The campaign must be approved again.`} onConfirm={() => restore.mutate(v.version)}>Restore</ConfirmButton>}</td>
          </tr>
        ))}</Table>}
      </QueryView>
      {open && <Modal open wide title={`Version ${open.version}`} onClose={() => setOpen(null)}><pre className="max-h-[70vh] overflow-auto text-xs">{JSON.stringify(open.snapshot, null, 2)}</pre></Modal>}
    </Card>
  );
}
