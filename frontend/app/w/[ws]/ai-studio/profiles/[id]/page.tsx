'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { qs, type Paged } from '@/lib/api';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate, fullName } from '@/lib/format';
import { Badge, Button, Card, Checkbox, Field, Input, Notice, PageHeader, QueryView, Select, Table, Textarea } from '@/components/ui';
import { CheckList, ScoreBox } from '@/components/personalization';

const opt = (xs: string[]) => [{ value: '', label: '— inherit —' }, ...xs.map((x) => ({ value: x, label: x.replace(/_/g, ' ') }))];

export default function ProfileEditor() {
  const ws = useWs();
  const { id } = useParams<{ id: string }>();
  const q = useWsQuery<any>(`/ai-studio/profiles/${id}`);
  const meta = useWsQuery<any>('/ai-studio/schemas');
  const [text, setText] = useState('');
  const [settings, setSettings] = useState<any>({});
  const [note, setNote] = useState('');
  const [lint, setLint] = useState<any>(null);
  const [m, setM] = useState<any>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!q.data) return;
    const active = q.data.versions.find((v: any) => v.id === q.data.activeVersionId) ?? q.data.versions[0];
    setText(active?.instructions ?? ''); setSettings(active?.settings ?? {});
    setM({ name: q.data.name, description: q.data.description ?? '', folder: q.data.folder ?? '', tags: q.data.tags.join(', ') });
  }, [q.data]);
  const lintM = useWsMutation(() => ({ path: '/ai-studio/profiles/lint', body: { instructions: text } }), { invalidate: false, onSuccess: (r: any) => setLint(r) });
  useEffect(() => { const t = setTimeout(() => { if (text) lintM.mutate(); }, 600); return () => clearTimeout(t); }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveV = useWsMutation(() => {
    const clean: any = {}; for (const [k, v] of Object.entries(settings)) if (v !== '' && v !== null && v !== undefined) clean[k] = v;
    return { path: `/ai-studio/profiles/${id}/versions`, body: { instructions: text, settings: clean, changeNote: note || undefined, activate: true } };
  }, { success: (r: any) => `Saved version ${r.version}`, onSuccess: () => setNote('') });
  const saveMeta = useWsMutation<any>((b) => ({ path: `/ai-studio/profiles/${id}`, method: 'PATCH', body: b }), { success: 'Saved' });
  const activate = useWsMutation<string>((vid) => ({ path: `/ai-studio/profiles/${id}/versions/${vid}/activate`, body: {} }), { success: 'Version activated' });
  const dup = useWsMutation(() => ({ path: `/ai-studio/profiles/${id}/duplicate`, body: { name: `${q.data?.name} (copy)` } }), { success: 'Duplicated', onSuccess: (r: any) => { window.location.href = `/w/${ws}/ai-studio/profiles/${r.id}`; } });
  const insert = (v: string) => { const el = ref.current; const tok = `{{${v}}}`; if (!el) return setText(text + tok); const p = el.selectionStart; setText(text.slice(0, p) + tok + text.slice(el.selectionEnd)); };
  return (
    <QueryView q={q}>
      {(p) => m && (
        <>
          <PageHeader title={p.name} subtitle={<>{p.isApproved ? <Badge color="green">approved for the team</Badge> : <Badge>not approved</Badge>} · used by {p.campaigns.length} campaign(s)</>} actions={<>
            <Button variant="secondary" onClick={() => saveMeta.mutate({ isApproved: !p.isApproved })}>{p.isApproved ? 'Withdraw approval' : 'Approve for team use'}</Button>
            <Button variant="secondary" loading={dup.isPending} onClick={() => dup.mutate()}>Duplicate</Button>
            <Button variant="ghost" onClick={() => saveMeta.mutate({ isArchived: !p.isArchived })}>{p.isArchived ? 'Unarchive' : 'Archive'}</Button>
          </>} />
          <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
            <div className="space-y-4">
              <Card title="Details" actions={<Button variant="secondary" onClick={() => saveMeta.mutate({ name: m.name, description: m.description || null, folder: m.folder || null, tags: m.tags.split(',').map((t: string) => t.trim()).filter(Boolean) })}>Save details</Button>}>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Name"><Input value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} /></Field>
                  <Field label="Folder"><Input value={m.folder} onChange={(e) => setM({ ...m, folder: e.target.value })} /></Field>
                  <Field label="Tags (comma separated)"><Input value={m.tags} onChange={(e) => setM({ ...m, tags: e.target.value })} /></Field>
                  <Field label="Description"><Input value={m.description} onChange={(e) => setM({ ...m, description: e.target.value })} /></Field>
                </div>
              </Card>
              <Card title="Prompt" actions={<div className="flex items-center gap-2"><Input className="w-56" placeholder="Change note" value={note} onChange={(e) => setNote(e.target.value)} /><Button disabled={!!lint?.errors?.length || !!lint?.unknownVariables?.length} loading={saveV.isPending} onClick={() => saveV.mutate()}>Save as new version</Button></div>}>
                <textarea ref={ref} rows={14} className="input font-mono" value={text} onChange={(e) => setText(e.target.value)} />
                {lint?.errors?.length > 0 && <Notice kind="danger">{lint.errors.join('; ')}</Notice>}
                {lint?.unknownVariables?.length > 0 && <Notice kind="danger">Unknown variables: {lint.unknownVariables.join(', ')}</Notice>}
                {lint && !lint.errors.length && !lint.unknownVariables.length && <p className="text-xs text-green-700">Syntax OK</p>}
                <p className="mt-2 text-xs text-slate-500">Conditions: <code>{'{{#if research.hasClaims}}…{{else}}…{{/if}}'}</code> · <code>{'{{#unless lead.title}}…{{/unless}}'}</code> · <code>{'{{#if lead.country == "US"}}…{{/if}}'}</code> · fallback <code>{'{{company.name|their company}}'}</code>. This prompt sits inside the platform's safety rules and your AI Studio instructions; it cannot switch them off.</p>
                <div className="mt-3 grid gap-3 md:grid-cols-4">
                  <Field label="Tone"><Select value={settings.tone ?? ''} onChange={(e) => setSettings({ ...settings, tone: e.target.value })} options={opt(['friendly', 'professional', 'direct', 'consultative', 'casual'])} /></Field>
                  <Field label="CTA"><Select value={settings.ctaStyle ?? ''} onChange={(e) => setSettings({ ...settings, ctaStyle: e.target.value })} options={opt(['soft_question', 'interest_check', 'meeting_request', 'resource_offer', 'booking_link'])} /></Field>
                  <Field label="Intensity"><Select value={settings.personalizationIntensity ?? ''} onChange={(e) => setSettings({ ...settings, personalizationIntensity: e.target.value })} options={opt(['light', 'medium', 'deep'])} /></Field>
                  <Field label="Max words"><Input type="number" value={settings.maxWords ?? ''} onChange={(e) => setSettings({ ...settings, maxWords: e.target.value === '' ? '' : Number(e.target.value) })} /></Field>
                </div>
              </Card>
              <TestOnLead profile={p} />
            </div>
            <div className="space-y-4">
              <Card title="Variables (click to insert)">
                <ul className="space-y-1 text-xs">{(meta.data?.promptVariables ?? []).map((v: any) => <li key={v.name}><button className="font-mono text-brand-700 underline" onClick={() => insert(v.name)}>{v.name}</button> — {v.description}</li>)}<li><span className="font-mono">lead.custom.&lt;field&gt;</span> — any custom field</li></ul>
              </Card>
              <Versions profile={p} onActivate={(vid) => activate.mutate(vid)} />
            </div>
          </div>
        </>
      )}
    </QueryView>
  );
}

function Versions({ profile, onActivate }: { profile: any; onActivate: (id: string) => void }) {
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);
  const cmp = useWsQuery<any>(a && b ? `/ai-studio/profiles/${profile.id}/compare${qs({ a, b })}` : null);
  return (
    <Card title="Versions">
      <Table head={['', 'Version', 'Saved', '']}>{profile.versions.map((v: any) => (
        <tr key={v.id}><td><input type="checkbox" checked={a === v.version || b === v.version} onChange={() => (a === null ? setA(v.version) : b === null && v.version !== a ? setB(v.version) : (setA(v.version), setB(null)))} /></td><td>v{v.version} {v.id === profile.activeVersionId && <Badge color="green">active</Badge>}<div className="text-xs text-slate-500">{v.changeNote}</div></td><td className="text-xs">{fmtDate(v.createdAt)}</td><td>{v.id !== profile.activeVersionId && <Button variant="ghost" onClick={() => onActivate(v.id)}>Activate</Button>}</td></tr>
      ))}</Table>
      <p className="mt-1 text-xs text-slate-500">Tick two versions to compare. Approved campaigns keep the version frozen at approval.</p>
      {cmp.data && (
        <div className="mt-2 text-xs">
          {cmp.data.removedLines.map((l: string, i: number) => <div key={`r${i}`} className="bg-red-50 text-red-800">− {l}</div>)}
          {cmp.data.addedLines.map((l: string, i: number) => <div key={`a${i}`} className="bg-green-50 text-green-800">+ {l}</div>)}
          {cmp.data.settingsChanged && <div className="mt-1">Settings changed: {JSON.stringify(cmp.data.settingsA)} → {JSON.stringify(cmp.data.settingsB)}</div>}
          {!cmp.data.addedLines.length && !cmp.data.removedLines.length && !cmp.data.settingsChanged && <div>No differences.</div>}
        </div>
      )}
    </Card>
  );
}

function TestOnLead({ profile }: { profile: any }) {
  const [campaignId, setCampaignId] = useState(profile.campaigns[0]?.id ?? '');
  const camp = useWsQuery<any>(campaignId ? `/campaigns/${campaignId}` : null);
  const listId = camp.data?.lists?.[0]?.listId;
  const leads = useWsQuery<Paged<any>>(listId ? `/leads${qs({ listId, pageSize: 100 })}` : null);
  const [leadId, setLeadId] = useState('');
  const [stepOrder, setStepOrder] = useState(1);
  const [res, setRes] = useState<any>(null);
  const [confirm, setConfirm] = useState(false);
  const run = useWsMutation(() => ({ path: `/ai-studio/profiles/${profile.id}/test`, body: { campaignId, leadId, stepOrder } }), { invalidate: false, onSuccess: (r: any) => setRes(r) });
  if (!profile.campaigns.length) return <Card title="Test on a sample lead"><Notice>Select this profile on a campaign (campaign → AI personalization) to test it against that campaign's leads and settings.</Notice></Card>;
  return (
    <Card title="Test on a sample lead (real AI call — cost is recorded, nothing is saved)">
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Campaign"><Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} options={profile.campaigns.map((c: any) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Lead"><Select value={leadId} onChange={(e) => setLeadId(e.target.value)} options={[{ value: '', label: 'Choose…' }, ...(leads.data?.data ?? []).map((l: any) => ({ value: l.id, label: fullName(l) || l.email }))]} /></Field>
        <Field label="Step"><Select value={String(stepOrder)} onChange={(e) => setStepOrder(Number(e.target.value))} options={(camp.data?.sequence?.steps ?? []).map((s: any) => ({ value: String(s.order), label: `Step ${s.order}` }))} /></Field>
        <div className="space-y-1 pt-5"><Checkbox label="I understand this uses AI credits" checked={confirm} onChange={setConfirm} /><Button disabled={!leadId || !confirm} loading={run.isPending} onClick={() => run.mutate()}>Run test</Button></div>
      </div>
      {res && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="text-sm">
            {res.status === 'SKIPPED' || res.status === 'NEEDS_RESEARCH' ? <Notice kind="warning">{res.reason}</Notice> : <>
              <Badge color={res.status === 'GENERATED' ? 'blue' : 'red'}>{res.status}</Badge>
              {res.subject && <div className="mt-2 font-medium">{res.subject}</div>}
              <pre className="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2 font-sans">{res.body}</pre>
              <div className="mt-1 text-xs text-slate-500">Cost ${Number(res.costUsd ?? 0).toFixed(4)}{res.costIsEstimate ? ' (estimate)' : ''}</div>
              {res.usedClaims?.length > 0 && <ul className="mt-2 text-xs">{res.usedClaims.map((c: any) => <li key={c.id}>Evidence: {c.text} — <a className="underline" href={c.url} target="_blank" rel="noreferrer noopener">{c.url}</a></li>)}</ul>}
            </>}
          </div>
          {res.quality && <div className="space-y-2"><CheckList quality={res.quality} /><ScoreBox score={res.quality.score} explanation={res.explanation} /></div>}
        </div>
      )}
    </Card>
  );
}
