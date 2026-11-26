'use client';

import { useState } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { LAWFUL_BASES } from '@/lib/constants';
import { Badge, Button, Checkbox, ConfirmButton, Field, Input, Modal, Notice, PageHeader, QueryView, Table, Textarea } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const BLANK = { countryCode: '', label: '', sendingAllowed: false, allowedLawfulBases: ['CONSENT'], requirePostalAddress: true, requireUnsubscribeLink: true, reviewedByOwner: false, notes: '' };

export default function Compliance() {
  const q = useWsQuery<any[]>('/compliance/rules');
  const [edit, setEdit] = useState<any | null>(null);
  const save = useWsMutation(() => ({ path: '/compliance/rules', method: 'PUT', body: edit }), { success: 'Rule saved', onSuccess: () => setEdit(null) });
  const del = useWsMutation<string>((id) => ({ path: `/compliance/rules/${id}`, method: 'DELETE' }), { success: 'Deleted' });
  return (
    <>
      <PageHeader title="Compliance settings" subtitle="Country rules are evaluated when a prospect is enrolled and again right before every send." actions={<Button onClick={() => setEdit(BLANK)}>Add country rule</Button>} />
      <div className="mb-4 space-y-2">
        <Notice kind="warning"><b>Technical safeguards, not legal advice.</b> These defaults are deliberately conservative. EU/EEA, Canada, Australia and unknown countries are disabled until you review them with a qualified advisor and tick “reviewed”. A publicly visible email address does not by itself authorise cold marketing.</Notice>
        <Notice>Always enforced regardless of country: unsubscribe link + one-click List-Unsubscribe header, suppression list, bounce/complaint suppression, sender identity and postal address in the footer.</Notice>
      </div>
      <QueryView q={q}>
        {(rows) => (
          <div className="card p-2"><Table head={['Country', 'Sending', 'Accepted lawful bases', 'Postal address', 'Reviewed', 'Notes', '']}>
            {rows.map((r) => <tr key={r.id}><td className="td"><b>{r.countryCode}</b><div className="text-xs text-slate-500">{r.label}</div></td><td className="td">{r.sendingAllowed ? <Badge color="green">allowed</Badge> : <Badge color="red">blocked</Badge>}</td><td className="td text-xs">{r.allowedLawfulBases.join(', ')}</td><td className="td">{r.requirePostalAddress ? 'required' : '—'}</td><td className="td">{r.reviewedByOwner ? '✅' : '—'}</td><td className="td max-w-sm text-xs text-slate-600">{r.notes}</td><td className="td whitespace-nowrap"><Button variant="ghost" onClick={() => setEdit({ ...r, notes: r.notes ?? '' })}>Edit</Button>{r.countryCode !== '*' && <ConfirmButton variant="ghost" confirm="Delete rule?" onConfirm={() => del.mutate(r.id)}>✕</ConfirmButton>}</td></tr>)}
          </Table></div>
        )}
      </QueryView>
      {edit && (
        <Modal open title="Country rule" onClose={() => setEdit(null)} footer={<Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Country code" hint="ISO-2, “EU” group or “*” default"><Input value={edit.countryCode} onChange={(e) => setEdit({ ...edit, countryCode: e.target.value.toUpperCase() })} /></Field>
            <Field label="Label"><Input value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} /></Field>
          </div>
          <p className="label mt-3">Accepted lawful bases</p>
          <div className="grid grid-cols-2 gap-1">{LAWFUL_BASES.map((b) => <Checkbox key={b} label={b.toLowerCase().replace(/_/g, ' ')} checked={edit.allowedLawfulBases.includes(b)} onChange={(v) => setEdit({ ...edit, allowedLawfulBases: v ? [...edit.allowedLawfulBases, b] : edit.allowedLawfulBases.filter((x: string) => x !== b) })} />)}</div>
          <div className="mt-3 space-y-2">
            <Checkbox label="Sending allowed" checked={edit.sendingAllowed} onChange={(v) => setEdit({ ...edit, sendingAllowed: v })} />
            <Checkbox label="Require postal address in footer" checked={edit.requirePostalAddress} onChange={(v) => setEdit({ ...edit, requirePostalAddress: v })} />
            <Checkbox label="I have reviewed this rule with a qualified advisor" checked={edit.reviewedByOwner} onChange={(v) => setEdit({ ...edit, reviewedByOwner: v })} />
          </div>
          <Field label="Notes"><Textarea rows={3} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
        </Modal>
      )}
    </>
  );
}
