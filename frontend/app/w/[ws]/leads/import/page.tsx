'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api, describeError } from '@/lib/api';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { LAWFUL_BASES } from '@/lib/constants';
import { Badge, Button, Card, Field, Input, Notice, PageHeader, QueryView, Select, Table } from '@/components/ui';
import { useToast } from '@/components/toast';

const FIELDS = ['ignore', 'email', 'firstName', 'lastName', 'fullName', 'title', 'companyName', 'companyDomain', 'website', 'linkedinUrl', 'custom.youtubeUrl', 'custom.instagramUrl', 'custom.facebookUrl', 'custom.socialUrl', 'custom.transcriptUrl', 'custom.publicProfileUrl', 'custom.notes', 'phone', 'country', 'city', 'timezone', 'tags'];
interface Upload { importId: string; headers: string[]; sampleRows: string[][]; suggestedMapping: Record<string, string> }
interface ImportJob { id: string; targetListId: string | null; fileName: string; status: string; totalRows: number; importedRows: number; updatedRows: number; skippedRows: number; errorRows: number; errors: Array<{ row: number; error: string; retryable?: boolean }>; createdAt: string }

export default function ImportPage() {
  return <Suspense fallback={<p role="status">Loading importer…</p>}><ImportRoute /></Suspense>;
}

function ImportRoute() {
  const params = useSearchParams();
  const listId = params.get('listId') ?? '';
  const destination = listId || (params.get('destination') === 'new' ? 'new' : '');
  return <ImportForm key={destination} initialDestination={destination} />;
}

function ImportForm({ initialDestination }: { initialDestination: string }) {
  const ws = useWs();
  const toast = useToast();
  const [upload, setUpload] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [opts, setOpts] = useState({ dedupeMode: 'skip', newListName: '', sourceName: 'CSV import', lawfulBasis: 'LEGITIMATE_INTEREST', lawfulBasisNote: '', defaultCountry: '' });
  const [busy, setBusy] = useState(false);
  const [destination, setDestination] = useState(initialDestination);
  const fields = new Set(Object.values(mapping));
  const canImport = fields.has('email') || ((fields.has('fullName') || (fields.has('firstName') && fields.has('lastName')))
    && ['companyDomain', 'website', 'custom.publicProfileUrl'].some((field) => fields.has(field)));
  const lists = useWsQuery<Array<{ id: string; name: string }>>('/lists');
  const selectedList = lists.data?.find(list => list.id === destination);
  const validDestination = !destination || (destination === 'new' ? !!opts.newListName.trim() : !!selectedList);
  const listHref = (id: string) => `/w/${ws}/leads?listId=${encodeURIComponent(id)}`;
  const imports = useWsQuery<ImportJob[]>('/imports', { refetchInterval: 5000 });
  const start = useWsMutation(() => ({ path: `/imports/${upload!.importId}/start`, body: { mapping, dedupeMode: opts.dedupeMode, targetListId: selectedList?.id ?? null, newListName: destination === 'new' ? opts.newListName.trim() : undefined, sourceName: opts.sourceName, lawfulBasis: opts.lawfulBasis, lawfulBasisNote: opts.lawfulBasisNote || undefined, defaultCountry: opts.defaultCountry || undefined } }), { success: 'Import started', onSuccess: () => setUpload(null) });

  const retry = useWsMutation<string>((id) => ({ path: `/imports/${id}/retry`, body: {} }), { success: 'Import retry queued' });

  async function onFile(file: File) {
    setBusy(true);
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Choose a CSV or Excel workbook of 20 MB or smaller.');
      const uploadFile = /\.xlsx$/i.test(file.name) ? await (await import('@/lib/prospect-workbook')).workbookToCsv(file) : file;
      const form = new FormData();
      form.append('file', uploadFile);
      const r = await api<Upload>(`/w/${ws}/imports`, { method: 'POST', form });
      setUpload(r);
      setMapping(r.suggestedMapping);
    } catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Import & export" subtitle="Upload a CSV or Excel workbook of prospects. Duplicates (by email) and suppressed addresses are skipped automatically. Record the lawful basis for contacting these people." actions={<a className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" href={`/api/v1/w/${ws}/leads/export`}>Export all leads (CSV)</a>} />
      <Card title="Upload destination" className="mb-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Destination list">
            <Select value={destination} disabled={lists.isLoading || busy || start.isPending} onChange={e => setDestination(e.target.value)} options={[
              { value: '', label: 'All leads only' },
              ...(destination && destination !== 'new' && !selectedList ? [{ value: destination, label: lists.isLoading ? 'Loading list…' : 'List unavailable' }] : []),
              ...(lists.data ?? []).map(list => ({ value: list.id, label: list.name })),
              { value: 'new', label: 'Create a new list' },
            ]} />
          </Field>
          {destination === 'new' && <Field label="New list name"><Input value={opts.newListName} maxLength={100} onChange={e => setOpts({ ...opts, newListName: e.target.value })} /></Field>}
        </div>
        {selectedList && <Link className="text-sm text-brand-700 underline" href={listHref(selectedList.id)}>Open {selectedList.name}</Link>}
        {destination && destination !== 'new' && !selectedList && !lists.isLoading && <Notice kind="warning">This list is unavailable. Choose another destination before starting the import.</Notice>}
      </Card>
      {!upload ? (
        <Card title="Upload prospects">
          <input aria-label="Choose CSV or Excel file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          <p className="mt-2 text-xs text-slate-500">Max 20 MB. Excel imports the first worksheet. Start with a header row. A full name and public source are enough for research when email is missing.</p>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card title="2. Map columns">
            <Table head={['File column', 'Sample', 'Maps to']}>
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
              <Field label="Duplicates" hint={destination ? 'Existing leads still join the destination list.' : undefined}><Select value={opts.dedupeMode} onChange={(e) => setOpts({ ...opts, dedupeMode: e.target.value })} options={[{ value: 'skip', label: 'Keep existing lead details' }, { value: 'update', label: 'Update existing leads' }]} /></Field>
              <Field label="Source name"><Input value={opts.sourceName} onChange={(e) => setOpts({ ...opts, sourceName: e.target.value })} /></Field>
              <Field label="Lawful basis for these contacts"><Select value={opts.lawfulBasis} onChange={(e) => setOpts({ ...opts, lawfulBasis: e.target.value })} options={LAWFUL_BASES} /></Field>
              <Field label="Default country (ISO-2)" hint="Used when the row has no country"><Input value={opts.defaultCountry} maxLength={2} onChange={(e) => setOpts({ ...opts, defaultCountry: e.target.value.toUpperCase() })} /></Field>
              <Field label="Basis note"><Input value={opts.lawfulBasisNote} onChange={(e) => setOpts({ ...opts, lawfulBasisNote: e.target.value })} placeholder="e.g. Public business contact, relevant B2B offer" /></Field>
            </div>
            <div className="mt-3"><Notice kind="warning">A publicly visible email address does not by itself authorise marketing. Choose the basis that genuinely applies; country rules decide whether these contacts can be emailed.</Notice></div>
            <div className="mt-4 flex gap-2"><Button loading={start.isPending} disabled={!canImport || !validDestination || lists.isLoading} onClick={() => start.mutate()}>Start import</Button><Button variant="secondary" onClick={() => setUpload(null)}>Cancel</Button></div>
          </Card>
        </div>
      )}
      <div className="mt-6">
        <Card title="Recent imports">
          <QueryView q={imports} isEmpty={(d) => d.length === 0} empty={<p className="text-sm text-slate-500">No imports yet.</p>}>
            {(rows) => (
              <Table head={['File', 'Destination', 'Status', 'Rows', 'Imported', 'Updated', 'Skipped', 'Errors', 'When']}>
                {rows.map((j) => (
                  <tr key={j.id}>
                    <td className="td">{j.fileName}{(j.status === 'FAILED' || (j.status === 'COMPLETED' && j.errors.some(error => error.retryable))) && <Button variant="ghost" loading={retry.isPending} onClick={() => retry.mutate(j.id)}>Retry import</Button>}{j.errors.length > 0 && <details className="text-xs text-red-700"><summary>row errors</summary>{j.errors.slice(0, 30).map((e) => <div key={e.row}>row {e.row}: {e.error}</div>)}</details>}</td>
                    <td className="td">{j.targetListId ? <Link className="text-brand-700 underline" href={listHref(j.targetListId)}>{lists.data?.find(list => list.id === j.targetListId)?.name ?? 'Open list'}</Link> : 'All leads'}</td>
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
