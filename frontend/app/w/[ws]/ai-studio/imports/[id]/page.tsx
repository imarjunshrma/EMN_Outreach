'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Notice, PageHeader, QueryView, Select, Textarea } from '@/components/ui';
import { describeError } from '@/lib/api';
import { fmtDate, titleCase } from '@/lib/format';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { importItemName, isProcessing, type ImportFields, type ImportItem, type ImportSession, type ReviewStatus, useCanReviewImports } from '../import-types';
import { importFieldKind, importFieldNames } from '../../../../../../../shared/src/knowledge-import';

const linkClass = 'text-sm font-semibold text-brand-600 hover:underline';

function formatLabel(key: string) {
  return titleCase(key.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
}

function destinationPath(destination: string, entityId?: string | null) {
  if (['AI_CONFIG_KNOWLEDGE', 'BUSINESS_SERVICE', 'COMMERCIAL_OFFER'].includes(destination)) return '/ai-studio/knowledge';
  if (destination === 'RESEARCH_CONFIGURATION') return '/ai-studio/research';
  if (destination === 'OUTREACH_CONFIGURATION') return '/ai-studio/writing';
  if (destination === 'ICP') return '/icps';
  if (destination === 'APPROVED_EVIDENCE') return '/ai-studio/knowledge-records';
  return entityId ? `/ai-studio/knowledge-records/${entityId}` : null;
}

function displayValue(value: unknown) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '—';
  return JSON.stringify(value, null, 2);
}

function FieldComparison({ existing, proposed }: { existing?: ImportFields | null; proposed: ImportFields }) {
  const data = typeof existing?.data === 'object' && existing.data !== null && !Array.isArray(existing.data)
    ? existing.data as ImportFields : existing;
  const keys = [...new Set([...Object.keys(proposed), ...Object.keys(data ?? {})])];
  if (!keys.length) return <p className="text-sm text-slate-500">No extracted fields.</p>;
  return <div className="overflow-x-auto">
    {typeof existing?.version === 'number' && <p className="mb-2 text-xs text-slate-500">Existing version {existing.version}</p>}
    <table className="w-full table-fixed divide-y divide-slate-200 text-left text-sm">
      <thead><tr>{['Field', 'Existing', 'Proposed'].map((label) => <th key={label} scope="col" className="px-2 py-2 text-xs font-semibold text-slate-500">{label}</th>)}</tr></thead>
      <tbody className="divide-y divide-slate-100">
        {keys.map((key) => <tr key={key}>
          <th scope="row" className="break-words px-2 py-2 align-top font-medium">{formatLabel(key)}</th>
          <td className="whitespace-pre-wrap break-words px-2 py-2 align-top">{displayValue(data?.[key])}</td>
          <td className="whitespace-pre-wrap break-words px-2 py-2 align-top">{displayValue(proposed[key])}</td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}

function ReviewItem({ item, fileName, editable, selected, setSelected, ws }: {
  item: ImportItem;
  fileName?: string;
  editable: boolean;
  selected: boolean;
  setSelected: (selected: boolean) => void;
  ws: string;
}) {
  const current = item.proposedValue ?? item.payload;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reviewNote, setReviewNote] = useState(item.reviewNote ?? '');
  const [editing, setEditing] = useState(false);
  const [references, setReferences] = useState<string>();
  const [resolveConflict, setResolveConflict] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [reviewVersion, setReviewVersion] = useState<string | null>();
  const fields = [...new Set([...Object.keys(current), ...Object.keys(draft)])];
  const allowedFields = importFieldNames(item.entityType);
  const availableFields = allowedFields.filter((key) => !fields.includes(key));
  const staleReview = reviewVersion !== undefined && reviewVersion !== (item.updatedAt ?? null);
  const conflict = item.status === 'CONFLICT' || !!(item.existingValue && item.conflictReason);
  const decision = useWsMutation((body: {
    status: ReviewStatus;
    expectedUpdatedAt?: string;
    reviewNote?: string;
    resolveConflict?: boolean;
    proposedValue?: ImportFields;
    relationships?: NonNullable<ImportItem['relationships']>;
  }) => ({ path: `/ai-studio/import-items/${item.id}/decision`, body }), {
    onSuccess: () => { setDraft({}); setReferences(undefined); setEditing(false); setResolveConflict(false); setSelected(false); setReviewVersion(undefined); },
    success: 'Review saved',
  });

  function submit(status: ReviewStatus) {
    setFormError(undefined);
    const changes: ImportFields = { ...current };
    if (status === 'APPROVED' || status === 'NEEDS_REVIEW') {
      for (const [key, input] of Object.entries(draft)) {
        if (!input.trim()) {
          delete changes[key];
          continue;
        }
        try {
          if (allowedFields.includes(key)) {
            const kind = importFieldKind(key);
            changes[key] = kind === 'list' ? input.split('\n').map((line) => line.trim()).filter(Boolean)
              : kind === 'numeric' && /^\d+(\.\d+)?$/.test(input.trim()) ? Number(input) : input.trim();
          } else {
            changes[key] = typeof current[key] === 'string' ? input : JSON.parse(input);
          }
        } catch {
          setFormError(`Enter a valid value for ${formatLabel(key)}.`);
          return;
        }
      }
    }
    let relationships: NonNullable<ImportItem['relationships']> | undefined;
    if (references !== undefined && (status === 'APPROVED' || status === 'NEEDS_REVIEW')) {
      relationships = [];
      for (const line of references.split('\n').filter(value => value.trim())) {
        const [entity, ...identifier] = line.split(':');
        const entityType = entity.trim().toUpperCase();
        const externalId = identifier.join(':').trim();
        if (!importFieldNames(entityType).length || !externalId) {
          setFormError('Enter one reference per line as ENTITY_TYPE: external identifier.');
          return;
        }
        relationships.push({ entityType, externalId });
      }
    }
    decision.mutate({
      status,
      relationships,
      proposedValue: Object.keys(draft).length && (status === 'APPROVED' || status === 'NEEDS_REVIEW') ? changes : undefined,
      reviewNote: (reviewVersion === undefined ? item.reviewNote ?? '' : reviewNote).trim(),
      resolveConflict: resolveConflict || undefined,
      expectedUpdatedAt: reviewVersion ?? item.updatedAt ?? undefined,
    });
  }

  function startReview() {
    if (reviewVersion === undefined) {
      setReviewVersion(item.updatedAt ?? null);
      setReviewNote(item.reviewNote ?? '');
    }
  }

  const itemName = importItemName(item) || formatLabel(item.entityType);
  const path = destinationPath(item.destination, item.destinationEntityId);
  const canChoose = editable && item.status !== 'APPLIED';
  return <article className="rounded-xl border border-slate-200 dark:border-slate-700">
    <div className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
      <div className="min-w-0">
        <h3 className="break-words font-semibold">{itemName}</h3>
        <p className="mt-1 text-xs text-slate-500">{[fileName, item.sourceLocator].filter(Boolean).join(' · ')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge color={item.status === 'CONFLICT' || item.status === 'NEEDS_REVIEW' ? 'yellow' : undefined}>{item.status}</Badge>
        {canChoose && <Checkbox label={`Select ${itemName}`} checked={selected} onChange={setSelected} />}
      </div>
    </div>
    <details className="border-t border-slate-200 dark:border-slate-700">
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">Review details</summary>
      <div className="space-y-4 px-4 pb-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs font-medium text-slate-500">Destination</dt><dd>{formatLabel(item.destination)}</dd></div>
          <div><dt className="text-xs font-medium text-slate-500">Confidence</dt><dd>{item.confidence == null ? '—' : `${Math.round(item.confidence * 100)}%`}</dd></div>
          <div><dt className="text-xs font-medium text-slate-500">Classification</dt><dd>{item.classification ? formatLabel(item.classification) : '—'}</dd></div>
          <div><dt className="text-xs font-medium text-slate-500">Verification</dt><dd>{item.verificationStatus ? formatLabel(item.verificationStatus) : '—'}</dd></div>
        </dl>
        {item.mappingExplanation && <p className="text-sm">{item.mappingExplanation}</p>}
        {item.conflictReason && <Notice kind="warning">{item.conflictReason}</Notice>}
        {item.error && <Notice kind="danger">{item.error}</Notice>}
        {!!item.duplicateCandidates?.length && <div>
          <h4 className="mb-2 text-sm font-semibold">Duplicate candidates</h4>
          <ul className="space-y-1 text-sm">
            {item.duplicateCandidates.map((candidate, i) => <li key={i} className="whitespace-pre-wrap break-words rounded bg-slate-50 p-2 dark:bg-slate-800">{displayValue(candidate)}</li>)}
          </ul>
        </div>}
        {!!item.relationships?.length && <div>
          <h4 className="mb-2 text-sm font-semibold">Related records</h4>
          <ul className="space-y-1 text-sm">
            {item.relationships.map(({ entityType, externalId }) => <li key={`${entityType}:${externalId}`}>{formatLabel(entityType)} · {externalId}</li>)}
          </ul>
        </div>}
        {item.sourceExcerpt && <div>
          <h4 className="mb-2 text-sm font-semibold">Source excerpt</h4>
          <blockquote className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3 text-sm dark:bg-slate-800">{item.sourceExcerpt}</blockquote>
        </div>}
        <FieldComparison existing={item.existingValue} proposed={current} />
        {(item.applicationResult || item.destinationEntityId || item.appliedAt) && <div className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
          <div className="flex flex-wrap items-center gap-2">
            {item.applicationResult && <Badge>{item.applicationResult}</Badge>}
            {item.appliedAt && <span>Applied {fmtDate(item.appliedAt)}</span>}
            {path && <Link className={linkClass} href={`/w/${ws}${path}`}>Open destination</Link>}
          </div>
          {item.destinationEntityId && <p className="mt-1 break-all text-xs text-slate-500">Record {item.destinationEntityId}</p>}
        </div>}
        {!canChoose && item.reviewNote && <p className="whitespace-pre-wrap text-sm">{item.reviewNote}</p>}
        {canChoose && <div className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <Button size="sm" variant="secondary" aria-expanded={editing} onClick={() => { startReview(); setEditing(!editing); }}>{editing ? 'Hide editor' : 'Edit proposed fields'}</Button>
          {editing && <>
            <Field label="Relationship references" hint="Enter one reference per line as ENTITY_TYPE: external identifier.">
              <Textarea aria-label="Relationship references" rows={3}
                value={references ?? (item.relationships ?? []).map(ref => `${ref.entityType}: ${ref.externalId}`).join('\n')}
                onChange={event => setReferences(event.target.value)} />
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              {fields.map((key) => {
                const value = current[key];
                const kind = allowedFields.includes(key) ? importFieldKind(key) : typeof value === 'string' ? 'text' : 'json';
                const fieldValue = kind === 'list' && Array.isArray(value) ? value.join('\n') : kind === 'json' ? JSON.stringify(value, null, 2) : String(value ?? '');
                return <Field key={key} label={formatLabel(key)} hint={kind === 'list' ? 'Enter one value per line.' : kind === 'json' ? 'Enter a JSON value.' : undefined}>
                  <Textarea aria-label={formatLabel(key)} rows={kind === 'text' ? 2 : 3} value={draft[key] ?? fieldValue ?? ''} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
                </Field>;
              })}
            </div>
            {!!availableFields.length && <Field label="Add a field">
              <Select value="" options={[{ value: '', label: 'Choose a field' }, ...availableFields.map((key) => ({ value: key, label: formatLabel(key) }))]} onChange={(event) => setDraft({ ...draft, [event.target.value]: '' })} />
            </Field>}
          </>}
          <Field label="Review notes"><Textarea aria-label="Review notes" maxLength={1000} rows={2} value={reviewVersion === undefined ? item.reviewNote ?? '' : reviewNote} onChange={(event) => { startReview(); setReviewNote(event.target.value); }} /></Field>
          {conflict && <Checkbox label="Approve the proposed values after reviewing the conflict" checked={resolveConflict} onChange={(checked) => { startReview(); setResolveConflict(checked); }} />}
          {staleReview && <div className="space-y-2">
            <Notice kind="warning">This record changed while you were reviewing it. Reload the review before submitting a decision.</Notice>
            <Button size="sm" variant="secondary" onClick={() => { setDraft({}); setReferences(undefined); setReviewNote(item.reviewNote ?? ''); setResolveConflict(false); setReviewVersion(undefined); decision.reset(); }}>Reload review</Button>
          </div>}
          {formError && <Notice kind="danger">{formError}</Notice>}
          {decision.error && <Notice kind="danger">{describeError(decision.error)}</Notice>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" loading={decision.isPending} disabled={staleReview || (conflict && !resolveConflict)} onClick={() => submit('APPROVED')}>{item.status === 'FAILED' ? 'Approve for retry' : 'Approve'}</Button>
            <Button size="sm" variant="secondary" disabled={staleReview || decision.isPending} onClick={() => submit('REJECTED')}>Reject</Button>
            <Button size="sm" variant="secondary" disabled={staleReview || decision.isPending} onClick={() => submit('SKIP')}>Skip</Button>
            <Button size="sm" variant="ghost" disabled={staleReview || decision.isPending} onClick={() => submit('NEEDS_REVIEW')}>Save for review</Button>
          </div>
        </div>}
      </div>
    </details>
  </article>;
}

function ImportDetail({ session, ws, canReview }: { session: ImportSession; ws: string; canReview: boolean }) {
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [destination, setDestination] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const base = `/ai-studio/imports/${session.id}`;
  const apply = useWsMutation(() => ({ path: `${base}/apply` }), { success: 'Approved items submitted for application' });
  const cancel = useWsMutation(() => ({ path: `${base}/cancel` }), { success: 'Import cancelled' });
  const retry = useWsMutation(() => ({ path: `${base}/retry` }), { success: 'Import processing queued again' });
  const bulk = useWsMutation((body: { ids: string[]; status: 'REJECTED' | 'SKIP' }) => ({ path: `${base}/decisions`, body }), {
    success: 'Review decisions saved',
    onSuccess: () => setSelected([]),
  });
  const fileNames = new Map(session.files.map((file) => [file.id, file.fileName]));
  const busy = isProcessing(session.status) || apply.isPending || retry.isPending;
  const counts = new Map<string, number>();
  const results = new Map<string, number>();
  for (const item of session.items) {
    counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    if (item.applicationResult) results.set(item.applicationResult, (results.get(item.applicationResult) ?? 0) + 1);
  }
  const groups = new Map<string, ImportItem[]>();
  const query = search.trim().toLowerCase();
  for (const item of session.items) {
    if ((type && item.entityType !== type) || (destination && item.destination !== destination) || (status && item.status !== status)) continue;
    const searchable = [importItemName(item), fileNames.get(item.fileId ?? ''), item.sourceExcerpt, JSON.stringify(item.proposedValue ?? item.payload)].join(' ');
    if (query && !searchable.toLowerCase().includes(query)) continue;
    const group = groups.get(item.entityType) ?? [];
    group.push(item);
    groups.set(item.entityType, group);
  }
  const visibleSelection = [...groups.values()].flat().filter((item) => item.status !== 'APPLIED' && selected.includes(item.id)).map((item) => item.id);
  const options = (values: string[], all: string) => [{ value: '', label: all }, ...[...new Set(values)].sort().map((value) => ({ value, label: formatLabel(value) }))];

  return <div className="space-y-5">
    <Card title="Import session" actions={<Badge color={busy ? 'blue' : undefined}>{session.status}</Badge>}>
      <p className="text-sm text-slate-500">{fmtDate(session.createdAt)}{session.templateVersion && ` · Template ${session.templateVersion}`}</p>
      {session.processingStep && <p className="mt-2 text-sm font-medium" role="status">{formatLabel(session.processingStep)}</p>}
      {busy && typeof session.progress === 'number' && <progress aria-label="Import progress" className="mt-2 w-full max-w-sm" value={session.progress} max={100} />}
      {session.errorSummary && <div className="mt-3"><Notice kind="danger">{session.errorSummary}</Notice></div>}
      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {[['Files', session.files.length], ['Extracted', session.items.length], ...['APPROVED', 'REJECTED', 'CONFLICT', 'FAILED', 'APPLIED'].map((key) => [formatLabel(key), counts.get(key) ?? 0])].map(([label, value]) => <div key={label} className="rounded-md bg-slate-50 p-2 dark:bg-slate-800"><dt className="text-xs text-slate-500">{label}</dt><dd className="font-semibold">{value}</dd></div>)}
      </dl>
    </Card>
    <Card title="Uploaded files">
      {session.files.length ? <ul className="divide-y divide-slate-100">
        {session.files.map((file) => <li key={file.id} className="py-2 text-sm">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="break-all font-medium">{file.fileName}</span><span className="text-xs text-slate-500">{Math.ceil(file.byteCount / 1024).toLocaleString()} KB</span>{file.status && <Badge>{file.status}</Badge>}</div>
          {file.error && <p className="mt-1 text-xs text-red-600">{file.error}</p>}
        </li>)}
      </ul> : <p className="text-sm text-slate-500">No new files were attached to this session.</p>}
    </Card>
    <Card title="Review extracted records">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Search"><Input type="search" placeholder="Search records and sources" value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
        <Field label="Entity type"><Select options={options(session.items.map((item) => item.entityType), 'All entity types')} value={type} onChange={(event) => setType(event.target.value)} /></Field>
        <Field label="Destination"><Select options={options(session.items.map((item) => item.destination), 'All destinations')} value={destination} onChange={(event) => setDestination(event.target.value)} /></Field>
        <Field label="Status"><Select options={options([...counts.keys()], 'All statuses')} value={status} onChange={(event) => setStatus(event.target.value)} /></Field>
      </div>
      {canReview && !!visibleSelection.length && <div className="my-3 flex flex-wrap items-center gap-2">
        <span className="text-sm">{visibleSelection.length} selected</span>
        <Button size="sm" variant="secondary" disabled={busy || bulk.isPending} onClick={() => bulk.mutate({ ids: visibleSelection, status: 'REJECTED' })}>Reject selected</Button>
        <Button size="sm" variant="secondary" disabled={busy || bulk.isPending} onClick={() => bulk.mutate({ ids: visibleSelection, status: 'SKIP' })}>Skip selected</Button>
        <Button size="sm" variant="ghost" onClick={() => setSelected([])}>Clear selection</Button>
      </div>}
      {bulk.error && <Notice kind="danger">{describeError(bulk.error)}</Notice>}
      <div className="mt-4 space-y-5">
        {groups.size ? [...groups].map(([entityType, items]) => <section key={entityType}>
          <h3 className="mb-2 text-sm font-semibold">{formatLabel(entityType)} <span className="text-slate-500">({items.length})</span></h3>
          <div className="space-y-2">
            {items.map((item) => <ReviewItem key={item.id} item={item} editable={canReview && ['REVIEW', 'APPLIED'].includes(session.status) && !busy && !bulk.isPending} ws={ws}
              fileName={fileNames.get(item.fileId ?? '')} selected={selected.includes(item.id)}
              setSelected={(checked) => setSelected((current) => checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />)}
          </div>
        </section>) : <Empty title={session.items.length ? 'No matching records' : 'No extracted records'}>{busy ? 'Records appear here as files are processed.' : undefined}</Empty>}
      </div>
    </Card>
    <Card title="Application results" actions={canReview && <>
      {['UPLOADED', 'PROCESSING'].includes(session.status) && ['IMPORT_FILE_PARSE', 'IMPORT_EXTRACTION', 'IMPORT_SCHEMA_VALIDATION'].includes(session.processingStep ?? '') && <Button size="sm" variant="secondary" loading={cancel.isPending} onClick={() => cancel.mutate(undefined)}>Cancel import</Button>}
      {session.status === 'FAILED' && session.processingStep && <Button size="sm" variant="secondary" loading={retry.isPending} disabled={busy} onClick={() => retry.mutate(undefined)}>Retry processing</Button>}
      <Button size="sm" loading={apply.isPending} disabled={busy || !counts.get('APPROVED')} onClick={() => apply.mutate(undefined)}>Apply approved items</Button>
    </>}>
      {(apply.error || retry.error || cancel.error) && <Notice kind="danger">{describeError(apply.error ?? retry.error ?? cancel.error)}</Notice>}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {['CREATED', 'UPDATED', 'UNCHANGED', 'SKIPPED', 'REJECTED', 'FAILED'].map((key) => <div key={key} className="rounded-md bg-slate-50 p-2 dark:bg-slate-800">
          <dt className="text-xs text-slate-500">{formatLabel(key)}</dt><dd className="font-semibold">{results.get(key) ?? counts.get(key === 'SKIPPED' ? 'SKIP' : key) ?? 0}</dd>
        </div>)}
      </dl>
      {!!counts.get('FAILED') && <p className="mt-3 text-sm text-slate-500">Review failed records above and approve them again before retrying application.</p>}
    </Card>
    <Card title="Audit history">
      {session.auditEvents?.length ? <ul className="divide-y divide-slate-100">
        {session.auditEvents.map((event) => <li className="py-2 text-sm" key={event.id}>
          <span className="font-medium">{formatLabel(event.action.split('.').at(-1) ?? event.action)}</span>
          <span className="ml-3 text-slate-500">{fmtDate(event.createdAt)}</span>
        </li>)}
      </ul> : <p className="text-sm text-slate-500">No audit events available.</p>}
    </Card>
  </div>;
}

export default function KnowledgeImportPage() {
  const ws = useWs();
  const { id } = useParams<{ id: string }>();
  const canReview = useCanReviewImports();
  const session = useWsQuery<ImportSession>(`/ai-studio/imports/${id}`, { refetchInterval: 3000 });
  return <>
    <PageHeader title="Knowledge import" actions={<Link className={linkClass} href={`/w/${ws}/ai-studio/imports`}>Back to import history</Link>} />
    <QueryView q={session}>{(data) => <ImportDetail key={data.id} session={data} ws={ws} canReview={canReview} />}</QueryView>
  </>;
}
