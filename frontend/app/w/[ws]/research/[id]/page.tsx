'use client';

import { RESEARCH_AREAS } from '../../../../../../shared/src/research-coverage';
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
  const retry = useWsMutation<string>((leadId) => ({ path: `/leads/${leadId}/research`, body: { retryMissing: true, retryReportId: id } }), { success: 'Research retry queued.' });
  const setClaim = useWsMutation<{ id: string; status: string }>((b) => ({ path: `/research/claims/${b.id}`, method: 'PATCH', body: { status: b.status } }), { success: 'Updated' });
  return (
    <QueryView q={q}>
      {(r) => (
        <>
          <PageHeader title={`Research: ${r.lead ? fullName(r.lead) : r.company?.name}`} subtitle={<>{fmtDate(r.createdAt)} · <Badge>{r.status}</Badge> {r.lead && <Link className="ml-2 underline" href={`/w/${ws}/leads/${r.lead.id}`}>Open lead</Link>}</>} />
          {r.lead && <div className="mb-4"><Button loading={retry.isPending} onClick={() => retry.mutate(r.lead.id)}>Retry missing sources</Button></div>}
          {r.coverage?.retry && <div className="mb-4"><Notice>
            <p>{r.coverage.retry.message}</p>
            <p>Attempted {r.coverage.retry.attemptedCategories.map((key: keyof typeof RESEARCH_AREAS) => RESEARCH_AREAS[key]).join(', ') || 'none'}</p>
            <p>Completed {r.coverage.retry.completedCategories.map((key: keyof typeof RESEARCH_AREAS) => RESEARCH_AREAS[key]).join(', ') || 'none'}</p>
            {r.coverage.retry.unavailableCategories.length > 0 && <p>Inaccessible {r.coverage.retry.unavailableCategories.map((key: keyof typeof RESEARCH_AREAS) => RESEARCH_AREAS[key]).join(', ')}</p>}
            {r.coverage.retry.sourceFailures?.length > 0 && <ul className="mt-2 list-disc pl-5">
              {r.coverage.retry.sourceFailures.map((failure: { url: string; reason: string }, index: number) =>
                <li key={index}>{failure.url} · {failure.reason}</li>)}
            </ul>}
            {r.coverage.retry.searchUnavailable && <p>{r.coverage.retry.searchUnavailable}</p>}
          </Notice></div>}
          {r.error && <div className="mb-4"><Notice kind="warning">{r.error}</Notice></div>}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Research coverage" className="lg:col-span-1">
              {r.coverage && <dl className="mb-3 space-y-1 text-sm">
                <div><dt className="inline text-slate-500">Completeness </dt><dd className="inline">{r.coverage.researchCompleteness.toLowerCase()}</dd></div>
                <div><dt className="inline text-slate-500">Evidence </dt><dd className="inline">{r.coverage.supportedClaims} supported claims · {r.coverage.evidenceQuality.toLowerCase().replaceAll('_', ' ')}</dd></div>
                {r.coverage.missingInformation.length > 0 && <div><dt className="inline text-slate-500">Missing </dt><dd className="inline">{r.coverage.missingInformation.join(', ')}</dd></div>}
              </dl>}
              {r.coverage?.areas && <ul className="mb-3 space-y-2 text-sm">
                {Object.entries(RESEARCH_AREAS).map(([key, title]) => {
                  const area = r.coverage.areas[key];
                  return area && <li key={key}><b>{title}</b> <Badge>{area.status.toLowerCase().replaceAll('_', ' ')}</Badge><div>{area.detail}</div></li>;
                })}
              </ul>}
              {r.summary ? <p className="text-sm">Extracted summary for review. {r.summary}</p> : <p className="text-sm text-slate-500">No summary: no facts could be verified.</p>}
              <dl className="mt-3 space-y-1 text-sm">
                {r.industry && <div><dt className="inline text-slate-500">Industry: </dt><dd className="inline">{r.industry}</dd></div>}
                {r.services?.length > 0 && <div><dt className="inline text-slate-500">Services: </dt><dd className="inline">{r.services.join(', ')}</dd></div>}
                {r.audience && <div><dt className="inline text-slate-500">Audience: </dt><dd className="inline">{r.audience}</dd></div>}
                {r.businessModel && <div><dt className="inline text-slate-500">Business model: </dt><dd className="inline">{r.businessModel}</dd></div>}
              </dl>
            </Card>
            <Card title={`Reported claims (${r.claims.length})`} className="lg:col-span-2">
              <p className="mb-2 text-xs text-slate-500">Only SUPPORTED facts can be used by the AI writer. Reject anything that is outdated or irrelevant.</p>
              <Table head={['Fact', 'Evidence quote', 'Source', '']}>
                {r.claims.map((c: any) => (
                  <tr key={c.id}>
                    <td className="td text-sm"><Badge>{c.status}</Badge> <span className="ml-1">{c.text}</span><div className="text-xs text-slate-400">{c.category} · confidence {Math.round(c.confidence * 100)}%</div></td>
                    <td className="td max-w-xs text-xs italic text-slate-600">“{c.quote}”</td>
                    <td className="td text-xs"><a className="text-brand-700 underline" href={c.evidence.url.startsWith('http') ? c.evidence.url : undefined} target="_blank" rel="noreferrer">{c.evidence.title ?? c.evidence.url}</a>{c.evidence.publishedAt && <div>Published {fmtDate(c.evidence.publishedAt)}</div>}<div>Retrieved {fmtDate(c.evidence.fetchedAt)}</div></td>
                    <td className="td">
                      {c.status !== 'SUPPORTED' && !c.evidence.url.startsWith('search:') && <Button variant="ghost" onClick={() => setClaim.mutate({ id: c.id, status: 'SUPPORTED' })}>Mark supported</Button>}
                      {c.status !== 'REJECTED' && <Button variant="ghost" onClick={() => setClaim.mutate({ id: c.id, status: 'REJECTED' })}>Reject</Button>}
                    </td>
                  </tr>
                ))}
              </Table>
            </Card>
            <Card title="Sources and discovery records" className="lg:col-span-3">
              <Table head={['Type', 'URL', 'HTTP', 'Fetched']}>{r.evidence.map((e: any) => <tr key={e.id}><td className="td"><Badge>{e.sourceType}</Badge></td><td className="td text-sm">{e.url.startsWith('http') ? <a className="underline" href={e.url} target="_blank" rel="noreferrer">{e.url}</a> : e.url}</td><td className="td">{e.httpStatus ?? '—'}</td><td className="td text-xs">{fmtDate(e.fetchedAt)}</td></tr>)}</Table>
            </Card>
          </div>
        </>
      )}
    </QueryView>
  );
}
