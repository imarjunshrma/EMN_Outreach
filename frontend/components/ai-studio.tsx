'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState, type ReactNode } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, Checkbox, Field, Input, QueryView, Table, Textarea } from '@/components/ui';

/** Loads the active config version of a kind, renders a form, saves a new version, lists history. */
export function ConfigEditor({ kind, title, children }: { kind: 'knowledge' | 'writing' | 'research'; title: string; children: (data: any, set: (d: any) => void) => ReactNode }) {
  const q = useWsQuery<{ data: any; version: number }>(`/ai-studio/config/${kind}`);
  const versions = useWsQuery<any[]>(`/ai-studio/config/${kind}/versions`);
  const [data, setData] = useState<any>(null);
  const [note, setNote] = useState('');
  useEffect(() => { if (q.data) setData(q.data.data); }, [q.data]);
  const save = useWsMutation(() => ({ path: `/ai-studio/config/${kind}`, method: 'PUT', body: { data, changeNote: note || undefined } }), { success: (r: any) => `Saved as version ${r.version}`, onSuccess: () => setNote('') });
  const activate = useWsMutation<string>((id) => ({ path: `/ai-studio/config-versions/${id}/activate`, body: {} }), { success: 'Version activated' });
  return (
    <div className="space-y-4">
      <QueryView q={q}>
        {(d) => data && (
          <Card title={<>{title} <span className="text-xs font-normal text-slate-500">· active version {d.version || 'defaults'}</span></>} actions={<div className="flex items-center gap-2"><Input className="w-56" placeholder="Change note (optional)" value={note} onChange={(e) => setNote(e.target.value)} /><Button loading={save.isPending} onClick={() => save.mutate()}>Save new version</Button></div>}>
            {children(data, setData)}
            <p className="mt-3 text-xs text-slate-500">Every save creates a new version. Campaigns that are already approved keep the version frozen at approval; draft campaigns pick up the new version on their next generation.</p>
          </Card>
        )}
      </QueryView>
      <Card title="Version history">
        <QueryView q={versions} isEmpty={(v) => !v.length} empty={<p className="text-sm text-slate-500">Nothing saved yet — built-in defaults are in use.</p>}>
          {(v) => <Table head={['Version', 'Saved', 'Note', '']}>{v.map((x: any) => <tr key={x.id}><td>v{x.version} {x.isActive && <Badge color="green">active</Badge>}</td><td>{fmtDate(x.createdAt)}</td><td>{x.changeNote ?? ''}</td><td>{!x.isActive && <Button variant="ghost" onClick={() => activate.mutate(x.id)}>Activate</Button>}</td></tr>)}</Table>}
        </QueryView>
      </Card>
    </div>
  );
}

export function LinesField({ label, hint, value, onChange, rows = 4 }: { label: string; hint?: string; value: string[]; onChange: (v: string[]) => void; rows?: number }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => { if (text.split('\n').map((x) => x.trim()).filter(Boolean).join('\n') !== value.join('\n')) setText(value.join('\n')); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Field label={label} hint={hint ?? 'One per line'}><Textarea rows={rows} value={text} onChange={(e) => { setText(e.target.value); onChange(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)); }} /></Field>;
}

export interface ObjField { key: string; label: string; type?: 'text' | 'textarea' | 'bool' }

export function ObjList({ title, fields, value, onChange, blank }: { title: string; fields: ObjField[]; value: any[]; onChange: (v: any[]) => void; blank: any }) {
  const upd = (i: number, k: string, v: any) => onChange(value.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between"><span className="label">{title}</span><Button variant="ghost" onClick={() => onChange([...value, { ...blank }])}>Add</Button></div>
      {value.length === 0 && <p className="text-xs text-slate-500">None yet.</p>}
      <div className="space-y-2">
        {value.map((item, i) => (
          <div key={i} className="grid gap-2 rounded border border-slate-200 p-2 md:grid-cols-[1fr_2fr_auto]">
            {fields.map((f) => f.type === 'bool'
              ? <div key={f.key} className="pt-1"><Checkbox label={f.label} checked={!!item[f.key]} onChange={(v) => upd(i, f.key, v)} /></div>
              : f.type === 'textarea'
                ? <Textarea key={f.key} rows={2} placeholder={f.label} value={item[f.key] ?? ''} onChange={(e) => upd(i, f.key, e.target.value)} />
                : <Input key={f.key} placeholder={f.label} value={item[f.key] ?? ''} onChange={(e) => upd(i, f.key, e.target.value)} />)}
            <Button variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</Button>
          </div>
        ))}
      </div>
    </div>
  );
}
