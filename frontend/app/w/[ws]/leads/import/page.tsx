'use client';

import { useState } from 'react';
import { api, describeError } from '@/lib/api';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { LAWFUL_BASES } from '@/lib/constants';
import { Badge, Button, Card, Field, Input, Notice, PageHeader, QueryView, Select, Table } from '@/components/ui';
import { useToast } from '@/components/toast';

const FIELDS = ['ignore', 'email', 'firstName', 'lastName', 'title', 'companyName', 'companyDomain', 'website', 'linkedinUrl', 'phone', 'country', 'city', 'timezone', 'tags'];
interface Upload { importId: string; headers: string[]; sampleRows: string[][]; suggestedMapping: Record<string, string> }
interface ImportJob { id: string; fileName: string; status: string; totalRows: number; importedRows: number; updatedRows: number; skippedRows: number; errorRows: number; errors: Array<{ row: number; error: string }>; createdAt: string }

export default function ImportPage() {
  const ws = useWs();
  const toast = useToast();
  const [upload, setUpload] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [opts, setOpts] = useState({ dedupeMode: 'skip', newListName: '', targetListId: '', sourceName: 'CSV import', lawfulBasis: 'LEGITIMATE_INTEREST', lawfulBasisNote: '', defaultCountry: '' });
  const [busy, setBusy] = useState(false);
  const lists = useWsQuery<Array<{ id: string; name: string }>>('/lists');
  const imports = useWsQuery<ImportJob[]>('/imports', { refetchInterval: 5000 });
  const start = useWsMutation(() => ({ path: `/imports/${upload!.importId}/start`, body: { mapping, dedupeMode: opts.dedupeMode, targetListId: opts.targetListId || null, newListName: opts.newListName || undefined, sourceName: opts.sourceName, lawfulBasis: opts.lawfulBasis, lawfulBasisNote: opts.lawfulBasisNote || undefined, defaultCountry: opts.defaultCountry || undefined } }), { success: 'Import started', onSuccess: () => setUpload(null) });

  async function onFile(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await api<Upload>(`/w/${ws}/imports`, { method: 'POST', form });
      setUpload(r);
      setMapping(r.suggestedMapping);
    } catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Import & export" subtitle="Upload a CSV of prospects. Duplicates (by email) and suppressed addresses are skipped automatically. Record the lawful basis for contacting these people." actions={<a className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" href={`/api/v1/w/${ws}/leads/export`}>Export all leads (CSV)</a>} />
      {!upload ? (
        <Card title="1. Upload CSV">
          <input type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          <p className="mt-2 text-xs text-slate-500">Max 20 MB. First row must be headers. One column must contain email addresses.</p>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card title="2. Map columns">
            <Table head={['CSV column', 'Sample', 'Maps to']}>
              {upload.headers.map((h, i) => (
                <tr key={h}>
                  <td className="td font-medium">{h}</td>
                  <td className="td text-xs text-slate-500">{upload.sampleRows.map((r) => r[i]).filter(Boolean).slice(0, 2).join(', ')}</td>
                  <td className="td w-60">
                    <Select value={mapping[h] ?? 'ignore'} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })} options={[...FIELDS.map((f) => ({ value: f, label: f })), { value: `custom.${h.replace(/[^a-zA-Z0-9_]/g, '_')}`, label: `custom field "${h}"` }]} />
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title="3. Options">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Duplicates"><Select value={opts.dedupeMode} onChange={(e) => setOpts({ ...opts, dedupeMode: e.target.value })} options={[{ value: 'skip', label: 'Skip existing leads' }, { value: 'update', label: 'Update existing leads' }]} /></Field>
              <Field label="Add to existing list"><Select value={opts.targetListId} onChange={(e) => setOpts({ ...opts, targetListId: e.target.value })} options={[{ value: '', label: '— none —' }, ...(lists.data ?? []).map((l) => ({ value: l.id, label: l.name }))]} /></Field>
              <Field label="…or create new list"><Input value={opts.newListName} onChange={(e) => setOpts({ ...opts, newListName: e.target.value })} placeholder="e.g. UK consultants Nov" /></Field>
              <Field label="Source name"><Input value={opts.sourceName} onChange={(e) => setOpts({ ...opts, sourceName: e.target.value })} /></Field>
              <Field label="Lawful basis for these contacts"><Select value={opts.lawfulBasis} onChange={(e) => setOpts({ ...opts, lawfulBasis: e.target.value })} options={LAWFUL_BASES} /></Field>
              <Field label="Default country (ISO-2)" hint="Used when the row has no country"><Input value={opts.defaultCountry} maxLength={2} onChange={(e) => setOpts({ ...opts, defaultCountry: e.target.value.toUpperCase() })} /></Field>
              <Field label="Basis note"><Input value={opts.lawfulBasisNote} onChange={(e) => setOpts({ ...opts, lawfulBasisNote: e.target.value })} placeholder="e.g. Public business contact, relevant B2B offer" /></Field>
            </div>
            <div className="mt-3"><Notice kind="warning">A publicly visible email address does not by itself authorise marketing. Choose the basis that genuinely applies; country rules decide whether these contacts can be emailed.</Notice></div>
            <div className="mt-4 flex gap-2"><Button loading={start.isPending} disabled={!Object.values(mapping).includes('email')} onClick={() => start.mutate()}>Start import</Button><Button variant="secondary" onClick={() => setUpload(null)}>Cancel</Button></div>
          </Card>
        </div>
      )}
      <div className="mt-6">
        <Card title="Recent imports">
          <QueryView q={imports} isEmpty={(d) => d.length === 0} empty={<p className="text-sm text-slate-500">No imports yet.</p>}>
            {(rows) => (
              <Table head={['File', 'Status', 'Rows', 'Imported', 'Updated', 'Skipped', 'Errors', 'When']}>
                {rows.map((j) => (
                  <tr key={j.id}>
                    <td className="td">{j.fileName}{j.errors.length > 0 && <details className="text-xs text-red-700"><summary>row errors</summary>{j.errors.slice(0, 30).map((e) => <div key={e.row}>row {e.row}: {e.error}</div>)}</details>}</td>
                    <td className="td"><Badge>{j.status}</Badge></td><td className="td">{j.totalRows}</td><td className="td">{j.importedRows}</td><td className="td">{j.updatedRows}</td><td className="td">{j.skippedRows}</td><td className="td">{j.errorRows}</td><td className="td text-xs">{fmtDate(j.createdAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </QueryView>
        </Card>
      </div>
    </>
  );
}
