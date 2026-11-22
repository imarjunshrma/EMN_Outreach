'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Building, Pencil, Trash2, UserRound } from 'lucide-react';
import { api, describeError, qs } from '@/lib/api';
import { Button, Card, ErrorState, Field, Input, Loading, Modal, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { usePlatform } from '@/components/platform/shell';
import { DataValue, type DataField } from '@/components/platform/data-value';
import { LINK_BTN } from '@/components/platform/login-as';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Detail = {
  model: { name: string; idField: string | null; fields: DataField[] }; record: Record<string, any>; organizationId: string | null;
  parents: Array<{ field: string; model: string; id: string }>; children: Array<{ field: string; model: string; count: number; filterField: string | null }>;
};

/** Text shown in an edit box for a value, and turned back into a value on save. */
function toText(f: DataField, v: any): string {
  if (v === null || v === undefined) return '';
  if (f.type === 'Json' || f.isList) return JSON.stringify(v, null, 2);
  if (f.type === 'DateTime') { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
  return String(v);
}
function fromText(f: DataField, t: string): unknown {
  if (t === '' && (f.isOptional || f.isList)) return f.isList ? [] : null;
  if (f.type === 'Json' || f.isList) return JSON.parse(t);
  if (f.type === 'Boolean') return t === 'true';
  if (f.type === 'Int' || f.type === 'Float') return Number(t);
  if (f.type === 'DateTime') return new Date(t).toISOString();
  return t;
}

export default function DataRecord() {
  const { model, recordId } = useParams<{ model: string; recordId: string }>();
  const me = usePlatform(); const toast = useToast(); const qc = useQueryClient(); const router = useRouter();
  const q = useQuery({ queryKey: ['platform-data-record', model, recordId], queryFn: () => api<Detail>(`/platform/data/${model}/${encodeURIComponent(recordId)}`) });
  const [edit, setEdit] = useState<Record<string, string> | null>(null);
  const [confirm, setConfirm] = useState<'save' | 'delete' | null>(null);
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  const canWrite = me.permissions.includes('data:write');

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const d = q.data;
  const changed = edit ? d.model.fields.filter((f) => f.editable && edit[f.name] !== toText(f, d.record[f.name])) : [];

  async function save() {
    setBusy(true);
    try {
      const changes: Record<string, unknown> = {};
      for (const f of changed) {
        try { changes[f.name] = fromText(f, edit![f.name]); } catch { throw new Error(`${f.name}: not valid JSON`); }
      }
      const r = await api<Detail>(`/platform/data/${model}/${encodeURIComponent(recordId)}`, { method: 'PATCH', body: { changes, reason } });
      qc.setQueryData(['platform-data-record', model, recordId], r);
      void qc.invalidateQueries({ queryKey: ['platform-data-rows', model] });
      toast.success(`Saved ${changed.length} change${changed.length === 1 ? '' : 's'}`); setEdit(null); setConfirm(null); setReason('');
    } catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try { await api(`/platform/data/${model}/${encodeURIComponent(recordId)}`, { method: 'DELETE', body: { reason } }); toast.success('Record deleted'); void qc.invalidateQueries({ queryKey: ['platform-data-rows', model] }); router.push(`/platform/data/${model}`); }
    catch (e) { toast.error(describeError(e)); setBusy(false); }
  }

  const title = d.record.name ?? d.record.email ?? d.record.emailAddress ?? d.record.title ?? d.record.subject ?? recordId;
  return (
    <>
      <Link href={`/platform/data/${model}${qs({ organizationId: d.organizationId ?? undefined })}`} className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-600 hover:text-ink"><ArrowLeft className="h-4 w-4" aria-hidden />{model}</Link>
      <PageHeader title={String(title)} subtitle={<span>{model} · <code className="text-xs">{recordId}</code></span>} actions={<>
        {model === 'User' && <Link href={`/platform/users/${recordId}`} className={LINK_BTN}><UserRound className="h-4 w-4" aria-hidden />Account page</Link>}
        {d.organizationId && <Link href={`/platform/tenants/${d.organizationId}`} className={LINK_BTN}><Building className="h-4 w-4" aria-hidden />Tenant</Link>}
        {canWrite && d.model.idField && !edit && <Button variant="secondary" icon={Pencil} onClick={() => setEdit(Object.fromEntries(d.model.fields.map((f) => [f.name, toText(f, d.record[f.name])])))}>Edit</Button>}
        {canWrite && !edit && <Button variant="danger" icon={Trash2} onClick={() => { setReason(''); setConfirm('delete'); }}>Delete</Button>}
      </>} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Fields" className="lg:col-span-2" actions={edit ? <div className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button size="sm" disabled={!changed.length} onClick={() => { setReason(''); setConfirm('save'); }}>Save {changed.length || ''} change{changed.length === 1 ? '' : 's'}</Button></div> : undefined}>
          <dl className="divide-y divide-slate-100 dark:divide-slate-800">
            {d.model.fields.map((f) => (
              <div key={f.name} className="grid gap-1 py-2 sm:grid-cols-[200px_1fr]" data-testid={`field-${f.name}`}>
                <dt className="text-sm"><span className="font-semibold">{f.name}</span><span className="block text-xs text-slate-500">{f.type}{f.isList ? '[]' : ''}{f.isOptional ? ' · optional' : ''}{!f.editable && edit ? ' · locked' : ''}</span></dt>
                <dd className="min-w-0 break-words text-sm">{edit && f.editable ? <EditBox f={f} value={edit[f.name]} onChange={(v) => setEdit({ ...edit, [f.name]: v })} changed={changed.includes(f)} /> : <DataValue field={f} value={d.record[f.name]} />}</dd>
              </div>
            ))}
          </dl>
          {edit && <p className="mt-3 text-xs text-slate-500">Locked fields (ids, tenant, secrets, staff roles, two-factor, account status) are changed on their own screens or not at all.</p>}
        </Card>
        <div className="space-y-4">
          <Card title="Belongs to">
            {d.parents.length === 0 ? <p className="text-sm text-slate-500">Nothing.</p> : <ul className="space-y-1.5 text-sm">{d.parents.map((p) => <li key={p.field}><Link className="font-semibold text-brand-700 hover:underline" href={`/platform/data/${p.model}/${encodeURIComponent(p.id)}`}>{p.field}</Link> <span className="text-xs text-slate-500">{p.model} {p.id.slice(0, 8)}</span></li>)}</ul>}
          </Card>
          <Card title="Related records">
            {d.children.length === 0 ? <p className="text-sm text-slate-500">None.</p> : <><ul className="space-y-1.5 text-sm">{d.children.filter((c) => c.count > 0 || showEmpty).sort((a, b) => b.count - a.count).map((c) => <li key={c.field} className="flex justify-between gap-2">
              {c.filterField && c.count > 0 ? <Link className="font-semibold text-brand-700 hover:underline" href={`/platform/data/${c.model}${qs({ field: c.filterField, value: recordId })}`}>{c.field}</Link> : <span className={c.count ? 'font-semibold' : 'text-slate-400'}>{c.field}</span>}
              <span className="tnum text-slate-500">{c.count.toLocaleString()}</span></li>)}</ul>
              {d.children.some((c) => c.count === 0) && <button className="mt-2 text-xs font-semibold text-brand-700 hover:underline" onClick={() => setShowEmpty(!showEmpty)}>{showEmpty ? 'Hide empty' : `Show ${d.children.filter((c) => c.count === 0).length} empty`}</button>}</>}
          </Card>
        </div>
      </div>

      <Modal open={!!confirm} title={confirm === 'delete' ? `Delete this ${model} record` : `Save ${changed.length} change${changed.length === 1 ? '' : 's'}`} onClose={() => setConfirm(null)}
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Back</Button><Button variant={confirm === 'delete' ? 'danger' : 'primary'} loading={busy} disabled={reason.trim().length < 5} onClick={confirm === 'delete' ? remove : save}>{confirm === 'delete' ? 'Delete record' : 'Save changes'}</Button></>}>
        {confirm === 'delete'
          ? <Notice kind="danger">This removes the record from the customer’s data straight away. A copy of its values is kept in the platform audit trail. If other records still point at it, the delete is refused.</Notice>
          : <ul className="mb-3 space-y-1 text-sm">{changed.map((f) => <li key={f.name}><b>{f.name}</b>: <span className="text-slate-500 line-through">{toText(f, d.record[f.name]).slice(0, 60) || 'empty'}</span> → {edit![f.name].slice(0, 60) || 'empty'}</li>)}</ul>}
        <div className="mt-3"><Field label="Reason" hint="Required; recorded with the old and new values in the platform audit trail."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
      </Modal>
    </>
  );
}

function EditBox({ f, value, onChange, changed }: { f: DataField; value: string; onChange: (v: string) => void; changed: boolean }) {
  const ring = changed ? 'ring-2 ring-amber-300 rounded-lg' : '';
  if (f.enumValues && !f.isList) return <div className={ring}><Select aria-label={f.name} value={value} onChange={(e) => onChange(e.target.value)} options={[...(f.isOptional ? [{ value: '', label: '— empty —' }] : []), ...f.enumValues.map((v) => ({ value: v, label: v }))]} /></div>;
  if (f.type === 'Boolean' && !f.isList) return <div className={ring}><Select aria-label={f.name} value={value} onChange={(e) => onChange(e.target.value)} options={[{ value: 'true', label: 'yes' }, { value: 'false', label: 'no' }, ...(f.isOptional ? [{ value: '', label: '— empty —' }] : [])]} /></div>;
  if (f.type === 'Json' || f.isList) return <div className={ring}><Textarea aria-label={f.name} rows={Math.min(14, Math.max(3, value.split('\n').length))} className="font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value)} /></div>;
  if (f.type === 'DateTime') return <div className={ring}><Input aria-label={f.name} type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} /></div>;
  if (f.type === 'Int' || f.type === 'Float' || f.type === 'Decimal' || f.type === 'BigInt') return <div className={ring}><Input aria-label={f.name} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} /></div>;
  return <div className={ring}>{value.length > 80 || value.includes('\n') ? <Textarea aria-label={f.name} rows={4} value={value} onChange={(e) => onChange(e.target.value)} /> : <Input aria-label={f.name} value={value} onChange={(e) => onChange(e.target.value)} />}</div>;
}
