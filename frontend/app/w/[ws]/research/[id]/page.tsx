'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate, fullName } from '@/lib/format';
import { Badge, Button, Card, Notice, PageHeader, QueryView, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function ReportDetail() {
  const ws = useWs();
  const { id } = useParams<{ id: string }>();
  const q = useWsQuery<any>(`/research/${id}`);
  const setClaim = useWsMutation<{ id: string; status: string }>((b) => ({ path: `/research/claims/${b.id}`, method: 'PATCH', body: { status: b.status } }), { success: 'Updated' });
  return (
    <QueryView q={q}>
      {(r) => (
        <>
          <PageHeader title={`Research: ${r.lead ? fullName(r.lead) : r.company?.name}`} subtitle={<>{fmtDate(r.createdAt)} · <Badge>{r.status}</Badge> {r.lead && <Link className="ml-2 underline" href={`/w/${ws}/leads/${r.lead.id}`}>Open lead</Link>}</>} />
          {r.error && <div className="mb-4"><Notice kind="warning">{r.error}</Notice></div>}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Summary" className="lg:col-span-1">
              {r.summary ? <p className="text-sm">{r.summary}</p> : <p className="text-sm text-slate-500">No summary: no facts could be verified.</p>}
              <dl className="mt-3 space-y-1 text-sm">
                {r.industry && <div><dt className="inline text-slate-500">Industry: </dt><dd className="inline">{r.industry}</dd></div>}
                {r.services?.length > 0 && <div><dt className="inline text-slate-500">Services: </dt><dd className="inline">{r.services.join(', ')}</dd></div>}
                {r.audience && <div><dt className="inline text-slate-500">Audience: </dt><dd className="inline">{r.audience}</dd></div>}
                {r.businessModel && <div><dt className="inline text-slate-500">Business model: </dt><dd className="inline">{r.businessModel}</dd></div>}
              </dl>
            </Card>
            <Card title={`Verified facts (${r.claims.length})`} className="lg:col-span-2">
              <p className="mb-2 text-xs text-slate-500">Only SUPPORTED facts can be used by the AI writer. Reject anything that is outdated or irrelevant.</p>
              <Table head={['Fact', 'Evidence quote', 'Source', '']}>
                {r.claims.map((c: any) => (
                  <tr key={c.id}>
                    <td className="td text-sm"><Badge>{c.status}</Badge> <span className="ml-1">{c.text}</span><div className="text-xs text-slate-400">{c.category} · confidence {Math.round(c.confidence * 100)}%</div></td>
                    <td className="td max-w-xs text-xs italic text-slate-600">“{c.quote}”</td>
                    <td className="td text-xs"><a className="text-brand-700 underline" href={c.evidence.url.startsWith('http') ? c.evidence.url : undefined} target="_blank" rel="noreferrer">{c.evidence.title ?? c.evidence.url}</a></td>
                    <td className="td">{c.status === 'SUPPORTED' ? <Button variant="ghost" onClick={() => setClaim.mutate({ id: c.id, status: 'REJECTED' })}>Reject</Button> : <Button variant="ghost" onClick={() => setClaim.mutate({ id: c.id, status: 'SUPPORTED' })}>Restore</Button>}</td>
                  </tr>
                ))}
              </Table>
            </Card>
            <Card title="Sources read" className="lg:col-span-3">
              <Table head={['Type', 'URL', 'HTTP', 'Fetched']}>{r.evidence.map((e: any) => <tr key={e.id}><td className="td"><Badge>{e.sourceType}</Badge></td><td className="td text-sm">{e.url.startsWith('http') ? <a className="underline" href={e.url} target="_blank" rel="noreferrer">{e.url}</a> : e.url}</td><td className="td">{e.httpStatus ?? '—'}</td><td className="td text-xs">{fmtDate(e.fetchedAt)}</td></tr>)}</Table>
            </Card>
          </div>
        </>
      )}
    </QueryView>
  );
}
