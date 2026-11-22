'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader, QueryView, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Enrichment() {
  const ws = useWs();
  const settings = useWsQuery<any>('');
  const stats = useWsQuery<any[]>('/enrichment/stats?days=90');
  const [f, setF] = useState({ firstName: '', lastName: '', domain: '' });
  const [found, setFound] = useState<any>(null);
  const [verifyEmail, setVerifyEmail] = useState('');
  const [bulkEmails, setBulkEmails] = useState('');
  const [verification, setVerification] = useState<any>(null);
  const [batchResult, setBatchResult] = useState<any>(null);
  const [diagnostic, setDiagnostic] = useState<any>(null);
  const [override, setOverride] = useState({ domain: '', disposable: true });
  const [roleLocalPart, setRoleLocalPart] = useState('');
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvColumn, setCsvColumn] = useState('');
  const [csvHasHeader, setCsvHasHeader] = useState(true);
  const batches = useWsQuery<any>('/email-verification/batches?page=1&pageSize=10');
  const datasets = useWsQuery<any>('/email-verification/datasets');
  const verificationResult = useWsQuery<any>(verification?.id ? `/email-verification/${verification.id}` : null, { refetchInterval: 2000 });
  const verify = useWsMutation(() => ({ path: '/email-verification/verify', body: { email: verifyEmail } }), { onSuccess: (r: any) => setVerification(r) });
  const verifyBulk = useWsMutation(() => ({ path: '/email-verification/bulk', body: { emails: bulkEmails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean) } }), { onSuccess: (r: any) => setBatchResult(r) });
  const runDiagnostics = useWsMutation(() => ({ path: '/email-verification/diagnostics', body: {} }), { onSuccess: (r: any) => setDiagnostic(r) });
  const refreshDataset = useWsMutation(() => ({ path: '/email-verification/datasets/refresh', body: {} }));
  const saveOverride = useWsMutation((body: typeof override) => ({ path: '/email-verification/domain-overrides', body }));
  const deleteOverride = useWsMutation((id: string) => ({ path: `/email-verification/domain-overrides/${id}`, method: 'DELETE' }));
  const saveRole = useWsMutation((body: { localPart: string; enabled: boolean }) => ({ path: '/email-verification/role-patterns', body }));
  const uploadCsv = useWsMutation((form: FormData) => ({ path: '/email-verification/bulk.csv', form }), { onSuccess: (r: any) => setBatchResult(r) });
  const find = useWsMutation(() => ({ path: '/enrichment/find-email', body: f }), { invalidate: false, onSuccess: (r: any) => setFound(r) });
  const s = settings.data?.settings;
  return (
    <>
      <PageHeader title="Verification & enrichment" subtitle="Email verification runs through a waterfall of providers until one gives a definitive answer. Recently verified leads are skipped to save credits." actions={<Link href={`/w/${ws}/settings/policies`}><Button variant="secondary">Change provider order</Button></Link>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="First-party email checks" className="lg:col-span-3">
          <p className="mb-3 text-sm text-slate-600">Checks syntax, IDN domain normalization, disposable/free/role attributes and DNS/MX routing. SMTP recipient probing is optional and disabled by default; it never sends a message, and acceptance cannot confirm a mailbox exists.</p>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <Field label="Verify one email"><Input type="email" value={verifyEmail} onChange={(e) => setVerifyEmail(e.target.value)} placeholder="person@example.com" /></Field>
              <Button className="mt-2" disabled={!verifyEmail.trim()} loading={verify.isPending} onClick={() => verify.mutate()}>Verify</Button>
              {verification && <div className="mt-3"><Notice>{verificationResult.data?.details?.state === 'COMPLETE' ? <>{verificationResult.data.result}: DNS {verificationResult.data.details.dns?.status}; SMTP {verificationResult.data.details.smtp?.classification}; risk {verificationResult.data.details.risk?.score}/100. {verificationResult.data.details.attributes?.disposable ? 'Disposable; ' : ''}{verificationResult.data.details.attributes?.freeProvider ? 'Free provider; ' : ''}{verificationResult.data.details.attributes?.roleBased ? 'Role-based; ' : ''}Mailbox existence is not confirmed.</> : `Verification ${verification.id} is queued.`}</Notice></div>}
            </div>
            <div>
              <Field label="Bulk email list (one per line; up to 1,000 unique addresses)"><textarea className="input min-h-28 w-full" value={bulkEmails} onChange={(e) => setBulkEmails(e.target.value)} placeholder={'person1@example.com\nperson2@example.org'} /></Field>
              <Button className="mt-2" disabled={!bulkEmails.trim()} loading={verifyBulk.isPending} onClick={() => verifyBulk.mutate()}>Queue bulk checks</Button>
              {batchResult && <div className="mt-3"><Notice>Batch <Link className="underline" href={`/w/${ws}/enrichment/batches/${batchResult.batchId}`}>{batchResult.batchId}</Link>: {batchResult.total !== undefined ? `${batchResult.total} unique addresses, ${batchResult.queued} queued, ${batchResult.cached} from cache.` : `${batchResult.fileName} uploaded (${batchResult.bytes} bytes); ingestion is queued.`}</Notice></div>}
              <div className="mt-4 border-t pt-3">
                <Field label="CSV file (maximum 10 MB; maximum 500,000 non-empty rows)"><Input type="file" accept=".csv,text/csv" onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)} /></Field>
                <div className="mt-2 flex flex-wrap items-center gap-3"><Field label="Email column name or zero-based index (blank = detect)"><Input value={csvColumn} onChange={(e) => setCsvColumn(e.target.value)} placeholder="Email or 0" /></Field><label className="text-sm"><input type="checkbox" checked={csvHasHeader} onChange={(e) => setCsvHasHeader(e.target.checked)} /> First row contains column names</label><Button variant="secondary" disabled={!csvFile} loading={uploadCsv.isPending} onClick={() => { if (!csvFile) return; const form = new FormData(); form.append('file', csvFile); form.append('hasHeader', String(csvHasHeader)); if (csvColumn.trim()) form.append('emailColumn', csvColumn.trim()); uploadCsv.mutate(form); }}>Upload CSV</Button></div>
                <p className="mt-1 text-xs text-slate-500">CSV parsing is streamed in the worker after authenticated upload. XLSX is not supported. Rows beyond the limit are rejected with an explicit batch error.</p>
              </div>
            </div>
          </div>
          <div className="mt-5 grid gap-3 border-t pt-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold">Disposable domain dataset</h3>
              <p className="mb-2 text-xs text-slate-500">Bundled fallback plus a daily refresh from the public disposable-email-domains list. Overrides apply only to this workspace.</p>
              <QueryView q={datasets} empty={<Empty title="Dataset status unavailable" />}>
                {(d: any) => <p className="text-xs">Source: {d.dataset?.sourceUrl ?? 'not refreshed yet'} · domains: {d.dataset?.domainCount ?? 0} · last update: {d.dataset?.lastUpdated ? new Date(d.dataset.lastUpdated).toLocaleString() : 'never'} · status: {d.dataset?.lastStatus ?? 'never updated'}{d.dataset?.lastError ? ` · ${d.dataset.lastError}` : ''}</p>}
              </QueryView>
              <div className="mt-2 flex flex-wrap gap-2"><Input value={override.domain} onChange={(e) => setOverride({ ...override, domain: e.target.value })} placeholder="domain.example" /><select className="input" value={String(override.disposable)} onChange={(e) => setOverride({ ...override, disposable: e.target.value === 'true' })}><option value="true">Mark disposable</option><option value="false">Exclude as non-disposable</option></select><Button variant="secondary" disabled={!override.domain} loading={saveOverride.isPending} onClick={() => saveOverride.mutate(override)}>Save override</Button><Button variant="secondary" loading={refreshDataset.isPending} onClick={() => refreshDataset.mutate({})}>Refresh list</Button></div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">{(datasets.data?.overrides ?? []).map((x: any) => <span key={x.id} className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1">{x.domain}={x.disposable ? 'disposable' : 'excluded'}<button aria-label={`Remove ${x.domain} override`} className="font-bold" onClick={() => deleteOverride.mutate(x.id)}>×</button></span>)}</div>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Role-based address patterns</h3>
              <p className="mb-2 text-xs text-slate-500">Add a local-part token such as procurement. These patterns are attributes and do not assert mailbox validity.</p>
              <div className="flex gap-2"><Input value={roleLocalPart} onChange={(e) => setRoleLocalPart(e.target.value)} placeholder="procurement" /><Button variant="secondary" disabled={!roleLocalPart} loading={saveRole.isPending} onClick={() => saveRole.mutate({ localPart: roleLocalPart, enabled: true })}>Add pattern</Button></div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">{(datasets.data?.rolePatterns ?? []).map((x: any) => <button key={x.id} className="rounded bg-slate-100 px-2 py-1" onClick={() => saveRole.mutate({ localPart: x.localPart, enabled: !x.enabled })}>{x.localPart} · {x.enabled ? 'enabled (click to disable)' : 'disabled (click to enable)'}</button>)}</div>
            </div>
          </div>
          <div className="mt-4">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <Button variant="secondary" loading={runDiagnostics.isPending} onClick={() => runDiagnostics.mutate()}>Run SMTP and worker diagnostics</Button>
              {diagnostic && <Notice kind={diagnostic.smtp?.status === 'CONNECTED' && diagnostic.redis === 'CONNECTED' ? 'success' : 'warning'}>SMTP: {diagnostic.smtp?.status} · server probe: {diagnostic.smtpEnabled ? 'enabled' : 'disabled'} · sender address: {diagnostic.mailFromConfigured ? 'configured' : 'missing'} · catch-all control: {diagnostic.catchAllProbeEnabled ? 'enabled' : 'disabled'} · Redis: {diagnostic.redis} · queue waiting/active/delayed/failed: {diagnostic.verificationQueue ? `${diagnostic.verificationQueue.waiting}/${diagnostic.verificationQueue.active}/${diagnostic.verificationQueue.delayed}/${diagnostic.verificationQueue.failed}` : 'unavailable'} · {diagnostic.smtp?.message ?? 'SMTP disabled'}</Notice>}
            </div>
            <h3 className="mb-2 text-sm font-semibold">Recent verification batches</h3>
            <QueryView q={batches} isEmpty={(d) => (d.data ?? []).length === 0} empty={<Empty title="No verification batches yet" />}>
              {(result: any) => <Table head={['Created', 'Status', 'Progress', 'Batch']}>
                {(result.data ?? []).map((b: any) => <tr key={b.id}><td className="td">{new Date(b.createdAt).toLocaleString()}</td><td className="td"><Badge>{b.status}</Badge></td><td className="td">{b.processed}/{b.total}</td><td className="td"><Link className="underline" href={`/w/${ws}/enrichment/batches/${b.id}`}>View</Link></td></tr>)}
              </Table>}
            </QueryView>
          </div>
        </Card>
        <Card title="Current waterfall">
          {s ? <ol className="list-decimal space-y-1 pl-5 text-sm">{s.verifierOrder.map((v: string) => <li key={v}>{v}</li>)}</ol> : null}
          <p className="mt-2 text-xs text-slate-500">Disposable-domain addresses are rejected before any paid check. Bulk: select leads on the Leads page and choose “Verify”. Single lead: “Verify email” on the lead profile.</p>
          <p className="mt-1 text-xs text-slate-500">Keys are added under <Link className="underline" href={`/w/${ws}/settings/integrations`}>Integrations</Link>.</p>
        </Card>
        <Card title="Find an email address" className="lg:col-span-2">
          <div className="grid gap-2 md:grid-cols-3">
            <Field label="First name"><Input value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></Field>
            <Field label="Last name"><Input value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Field>
            <Field label="Company domain"><Input value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} placeholder="clinic.com" /></Field>
          </div>
          <Button className="mt-2" disabled={!f.firstName || !f.lastName || !f.domain} loading={find.isPending} onClick={() => find.mutate()}>Find</Button>
          {found && <div className="mt-3">{found.email ? <Notice><b>{found.email}</b> — {found.confidence}% confidence via {found.source}. {found.note}</Notice> : <Notice kind="warning">No address found ({found.attempts?.map((a: any) => `${a.provider}: ${a.outcome ?? a.error ?? 'none'}`).join(', ') || 'no finder configured'}).</Notice>}</div>}
        </Card>
        <Card title="Provider comparison (last 90 days)" className="lg:col-span-3">
          <QueryView q={stats} isEmpty={(d) => d.length === 0} empty={<Empty title="No verifications yet" />}>
            {(rows) => <Table head={['Provider', 'Checks', 'Definitive', 'Credits', 'Results']}>{rows.map((p) => <tr key={p.provider}><td className="td">{p.provider}</td><td className="td">{p.checks}</td><td className="td">{p.definitiveRatePct}%</td><td className="td">{p.credits}</td><td className="td text-xs">{Object.entries(p.results).map(([k, v]) => <span key={k} className="mr-2"><Badge>{k}</Badge> {String(v)}</span>)}</td></tr>)}</Table>}
          </QueryView>
        </Card>
      </div>
    </>
  );
}
