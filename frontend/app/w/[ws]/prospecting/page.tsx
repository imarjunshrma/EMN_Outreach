'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { LAWFUL_BASES } from '@/lib/constants';
import { EMPTY, IcpEditor, type Criteria, type Icp } from '@/components/icp-editor';
import { Badge, Button, Card, Checkbox, Empty, Field, Notice, PageHeader, QueryView, Select, Table, Textarea } from '@/components/ui';

interface Person { externalId: string; firstName: string | null; lastName: string | null; title: string | null; email: string | null; linkedinUrl: string | null; country: string | null; city: string | null; alreadyInWorkspace: boolean; company: { name: string | null; domain: string | null; industry: string | null; employeeCount: number | null } }
interface SearchResult { searchId: string; total: number | null; results: Person[] }

export default function Prospecting() {
  const ws = useWs();
  const settings = useWsQuery<{ settings: { leadProvider: string } }>('');
  const icps = useWsQuery<Icp[]>('/icps');
  const lists = useWsQuery<Array<{ id: string; name: string }>>('/lists');
  const history = useWsQuery<Array<{ id: string; provider: string; query: string; status: string; resultCount: number; error: string | null; createdAt: string }>>('/prospecting/searches');
  const [text, setText] = useState('');
  const [draft, setDraft] = useState({ name: 'Search', description: '', criteria: EMPTY as Criteria, minScore: 60, isActive: true });
  const [icpId, setIcpId] = useState('');
  const [page, setPage] = useState(1);
  const [res, setRes] = useState<SearchResult | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [imp, setImp] = useState({ listId: '', lawfulBasis: 'LEGITIMATE_INTEREST', lawfulBasisNote: '', enrich: true, autoVerify: true, autoResearch: true, autoScore: true });
  const toFilters = useWsMutation(() => ({ path: '/icps/from-text', body: { description: text } }), { invalidate: false, success: 'Filters generated — review them below', onSuccess: (r: unknown) => setDraft({ ...draft, ...(r as { criteria: Criteria }), name: (r as { name: string }).name }) });
  const search = useWsMutation<number, SearchResult>((p) => ({ path: '/prospecting/search', body: { icpId: icpId || null, query: text, criteria: draft.criteria, page: p, perPage: 25 } }), { onSuccess: (r) => { setRes(r); setSel([]); } });
  const doImport = useWsMutation(() => ({ path: '/prospecting/import', body: { searchId: res!.searchId, externalIds: sel, listId: imp.listId || null, lawfulBasis: imp.lawfulBasis, lawfulBasisNote: imp.lawfulBasisNote || undefined, enrich: imp.enrich, autoVerify: imp.autoVerify, autoResearch: imp.autoResearch, autoScore: imp.autoScore } }), {
    success: (r: unknown) => { const x = r as { created: number; duplicates: number; noEmail: number; suppressed: number }; return `Imported ${x.created} · ${x.duplicates} duplicates · ${x.noEmail} without email · ${x.suppressed} suppressed`; }, onSuccess: () => setSel([]),
  });
  const provider = settings.data?.settings.leadProvider ?? 'none';

  return (
    <>
      <PageHeader title="Prospect discovery" subtitle="Describe your ideal customer, review the generated filters, then search your licensed data provider. Imported prospects are deduplicated, verified, researched and scored automatically." />
      {provider === 'none' && <div className="mb-4"><Notice kind="warning">No lead-data provider is selected. Choose Apollo in <Link className="underline" href={`/w/${ws}/settings/general`}>System settings</Link> and add its API key in <Link className="underline" href={`/w/${ws}/settings/integrations`}>Integrations</Link>, or use <Link className="underline" href={`/w/${ws}/leads/import`}>CSV import</Link>. LinkedIn and other sites whose terms forbid scraping are never scraped.</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="1. Describe who you want">
          <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Established business consultants, fractional executives and podcast hosts in the UK and USA who publish content and sell advisory services…" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button disabled={text.trim().length < 10} loading={toFilters.isPending} onClick={() => toFilters.mutate()}>Generate filters with AI</Button>
            <span className="text-xs text-slate-500">or start from a saved ICP:</span>
            <Select className="w-48" value={icpId} onChange={(e) => { setIcpId(e.target.value); const i = icps.data?.find((x) => x.id === e.target.value); if (i) setDraft({ ...draft, name: i.name, criteria: { ...EMPTY, ...i.criteria } }); }} options={[{ value: '', label: '—' }, ...(icps.data ?? []).map((i) => ({ value: i.id, label: i.name }))]} />
          </div>
        </Card>
        <Card title="2. Review filters" actions={<Button loading={search.isPending} disabled={provider === 'none'} onClick={() => { setPage(1); search.mutate(1); }}>Search {provider !== 'none' ? provider : ''}</Button>}>
          <IcpEditor value={draft} onChange={setDraft} />
        </Card>
      </div>
      {res && (
        <div className="mt-4 space-y-4">
          <Card title={`3. Results (${res.total ?? res.results.length} total, page ${page})`} actions={<><Button variant="secondary" disabled={page <= 1} onClick={() => { setPage(page - 1); search.mutate(page - 1); }}>Prev</Button><Button variant="secondary" onClick={() => { setPage(page + 1); search.mutate(page + 1); }}>Next</Button></>}>
            {res.results.length === 0 ? <Empty title="No matches">Broaden the filters.</Empty> : (
              <Table head={[<input key="a" type="checkbox" aria-label="Select all" onChange={(e) => setSel(e.target.checked ? res.results.filter((p) => !p.alreadyInWorkspace).map((p) => p.externalId) : [])} />, 'Person', 'Company', 'Location', 'Email', '']}>
                {res.results.map((p) => (
                  <tr key={p.externalId}>
                    <td className="td"><input type="checkbox" disabled={p.alreadyInWorkspace} checked={sel.includes(p.externalId)} onChange={(e) => setSel(e.target.checked ? [...sel, p.externalId] : sel.filter((x) => x !== p.externalId))} aria-label="select" /></td>
                    <td className="td"><b>{[p.firstName, p.lastName].filter(Boolean).join(' ')}</b><div className="text-xs text-slate-500">{p.title}</div></td>
                    <td className="td">{p.company.name}<div className="text-xs text-slate-500">{p.company.domain} · {p.company.industry} · {p.company.employeeCount ?? '?'} emp.</div></td>
                    <td className="td text-sm">{[p.city, p.country].filter(Boolean).join(', ')}</td>
                    <td className="td text-sm">{p.email ?? <span className="text-xs text-slate-400">revealed on import</span>}</td>
                    <td className="td">{p.alreadyInWorkspace && <Badge>already in workspace</Badge>}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <Card title={`4. Import ${sel.length} selected`}>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Add to list"><Select value={imp.listId} onChange={(e) => setImp({ ...imp, listId: e.target.value })} options={[{ value: '', label: '— none —' }, ...(lists.data ?? []).map((l) => ({ value: l.id, label: l.name }))]} /></Field>
              <Field label="Lawful basis"><Select value={imp.lawfulBasis} onChange={(e) => setImp({ ...imp, lawfulBasis: e.target.value })} options={LAWFUL_BASES} /></Field>
              <Field label="Basis note"><input className="input" value={imp.lawfulBasisNote} onChange={(e) => setImp({ ...imp, lawfulBasisNote: e.target.value })} /></Field>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-4">
              <Checkbox label="Find emails (uses provider credits)" checked={imp.enrich} onChange={(v) => setImp({ ...imp, enrich: v })} />
              <Checkbox label="Verify emails" checked={imp.autoVerify} onChange={(v) => setImp({ ...imp, autoVerify: v })} />
              <Checkbox label="Research websites" checked={imp.autoResearch} onChange={(v) => setImp({ ...imp, autoResearch: v })} />
              <Checkbox label="Score vs ICP" checked={imp.autoScore} onChange={(v) => setImp({ ...imp, autoScore: v })} />
            </div>
            <Button className="mt-3" disabled={sel.length === 0} loading={doImport.isPending} onClick={() => doImport.mutate()}>Import selected</Button>
          </Card>
        </div>
      )}
      <div className="mt-6">
        <Card title="Recent searches">
          <QueryView q={history} isEmpty={(d) => d.length === 0} empty={<p className="text-sm text-slate-500">No searches yet.</p>}>
            {(rows) => <Table head={['When', 'Provider', 'Query', 'Status', 'Results']}>{rows.map((h) => <tr key={h.id}><td className="td text-xs">{fmtDate(h.createdAt)}</td><td className="td">{h.provider}</td><td className="td text-sm">{h.query.slice(0, 100) || '—'}</td><td className="td"><Badge>{h.status}</Badge>{h.error && <div className="text-xs text-red-600">{h.error}</div>}</td><td className="td">{h.resultCount}</td></tr>)}</Table>}
          </QueryView>
        </Card>
      </div>
    </>
  );
}
