'use client';
import { useState } from 'react';
import { api, describeError } from '@/lib/api';
import { useWs, useWsQuery } from '@/lib/hooks';
import { Badge, Button, Card, Field, Input, Modal, Notice, Table } from '@/components/ui';
import { useToast } from '@/components/toast';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Live records of the domain's zone at the connected DNS provider. Edits and deletions apply to one
 * record at a time, are refused if the record changed since it was loaded, and are written to the
 * audit log. NS and SOA records are read-only.
 */
export function ZoneRecords({ domainId, domainName }: { domainId: string; domainName: string }) {
  const ws = useWs(); const toast = useToast();
  const q = useWsQuery<any>(`/domains/${domainId}/zone-records`);
  const [edit, setEdit] = useState<any | null>(null); const [value, setValue] = useState('');
  const [del, setDel] = useState<any | null>(null); const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api(`/w/${ws}/domains/${domainId}/zone-records/${edit.id}`, { method: 'PUT', body: { content: value, expectedContent: edit.content } }); toast.success('Record updated — allow time for DNS to propagate'); setEdit(null); void q.refetch(); }
    catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try { await api(`/w/${ws}/domains/${domainId}/zone-records/${del.id}`, { method: 'DELETE', body: { confirmName: confirm, expectedContent: del.content } }); toast.success('Record deleted'); setDel(null); setConfirm(''); void q.refetch(); }
    catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }
  return (
    <Card title="DNS records at your provider" className="lg:col-span-3" actions={<Button variant="secondary" onClick={() => q.refetch()} loading={q.isFetching}>Reload</Button>}>
      {q.error ? <Notice kind="warning">{describeError(q.error)} — connect Cloudflare under Settings → Integrations to manage records here.</Notice> : q.isLoading ? <p className="text-sm text-slate-500">Loading records…</p> : (
        <>
          <p className="mb-3 text-sm text-slate-600">Zone <b>{q.data.zone.name}</b> at {q.data.zone.provider}. Changes apply to one record at a time and are recorded in the audit log. A change being accepted does not mean it has propagated — use “Check propagation” afterwards.</p>
          <Table head={['Type', 'Name', 'Value', 'TTL', '']}>
            {q.data.records.map((r: any) => (
              <tr key={r.id}>
                <td className="td"><Badge>{r.type}</Badge></td>
                <td className="td text-xs">{r.name === domainName ? '@' : r.name.replace(`.${domainName}`, '')}</td>
                <td className="td max-w-[420px] break-all font-mono text-xs">{r.content}</td>
                <td className="td text-xs">{r.ttl === 1 ? 'auto' : r.ttl}</td>
                <td className="td whitespace-nowrap text-right">{r.editable ? <><Button size="sm" variant="ghost" onClick={() => { setEdit(r); setValue(r.content); }}>Edit</Button><Button size="sm" variant="ghost" onClick={() => { setDel(r); setConfirm(''); }}>Delete</Button></> : <span className="text-xs text-slate-400">managed by provider</span>}</td>
              </tr>
            ))}
          </Table>
        </>
      )}
      <Modal open={!!edit} title={`Edit ${edit?.type} ${edit?.name}`} onClose={() => setEdit(null)} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy} disabled={!value.trim() || value === edit?.content} onClick={save}>Save to DNS</Button></>}>
        <Field label="Current value"><Input readOnly value={edit?.content ?? ''} /></Field>
        <Field label="New value" hint="Only this record changes. If someone edited it since you opened this page, the change is refused."><Input value={value} onChange={(e) => setValue(e.target.value)} /></Field>
      </Modal>
      <Modal open={!!del} title={`Delete ${del?.type} record`} onClose={() => setDel(null)} footer={<><Button variant="ghost" onClick={() => setDel(null)}>Cancel</Button><Button variant="danger" loading={busy} disabled={confirm !== del?.name} onClick={remove}>Delete record</Button></>}>
        <Notice kind="danger">Deleting DNS records can stop email or your website from working. Value: <code className="break-all">{del?.content}</code></Notice>
        <Field label={`Type “${del?.name}” to confirm`}><Input value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
      </Modal>
    </Card>
  );
}
