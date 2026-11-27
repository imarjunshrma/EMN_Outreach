'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { Badge, Button, Card, Empty, PageHeader, QueryView, Table } from '@/components/ui';

type Verification = {
  id: string; email: string; result: string;
  details?: {
    state?: string; syntax?: { reason?: string }; dns?: { status?: string; error?: string }; smtp?: { classification?: string };
    catchAll?: { status?: string }; attributes?: { disposable?: boolean; freeProvider?: boolean; roleBased?: boolean };
    risk?: { level?: string; score?: number };
  };
};
type Batch = { status: string; total: number; processed: number; createdAt: string; error?: string | null; page: number; pageSize: number; resultCount: number; verifications?: Verification[] };

export default function VerificationBatchPage() {
  const params = useParams<{ ws: string; id: string }>();
  const [page, setPage] = useState(1);
  const batch = useWsQuery<Batch>(`/email-verification/batches/${params.id}?page=${page}&pageSize=100`, { refetchInterval: 2500 });
  const control = useWsMutation((action: string) => ({ path: `/email-verification/batches/${params.id}/${action}`, body: {} }));
  return <>
    <PageHeader title="Email verification batch" subtitle="DNS and address attributes only; SMTP replies remain unconfirmed." actions={<div className="flex gap-2"><Link href={`/api/v1/w/${params.ws}/email-verification/batches/${params.id}/export.csv`}><Button variant="secondary">Download CSV</Button></Link><Link className="underline" href={`/w/${params.ws}/enrichment`}>Back to verification</Link></div>} />
    <QueryView q={batch} empty={<Empty title="Verification batch not found" />}>
      {(b) => <>
        <div className="mb-4 grid gap-3 md:grid-cols-3">
          <Card title="Status"><Badge>{b.status}</Badge></Card>
          <Card title="Progress">{b.processed}/{b.total}</Card>
          <Card title="Created">{new Date(b.createdAt).toLocaleString()}</Card>
        </div>
        <div className="mb-4 flex flex-wrap gap-2">
          {b.status === 'PROCESSING' && <Button variant="secondary" loading={control.isPending} onClick={() => control.mutate('pause')}>Pause</Button>}
          {b.status === 'PAUSED' && <Button variant="secondary" loading={control.isPending} onClick={() => control.mutate('resume')}>Resume</Button>}
          {b.status === 'COMPLETED_WITH_ERRORS' && <Button variant="secondary" loading={control.isPending} onClick={() => control.mutate('retry')}>Retry failed rows</Button>}
          {!['COMPLETED','COMPLETED_WITH_ERRORS','CANCELLED'].includes(b.status) && <Button variant="danger" loading={control.isPending} onClick={() => control.mutate('cancel')}>Cancel pending work</Button>}
        </div>
        {b.error && <p className="mb-3 text-sm text-red-700">Batch error: {b.error}</p>}
        <Table head={['Email', 'Primary status', 'DNS / SMTP', 'Attributes', 'Risk', 'Reason']}>
          {(b.verifications ?? []).map((v) => <tr key={v.id}>
            <td className="td">{v.email}</td><td className="td"><Badge>{v.result}</Badge></td>
            <td className="td">{v.details?.dns?.status ?? v.details?.state ?? 'Queued'}{v.details?.smtp?.classification ? ` / ${v.details.smtp.classification}` : ''}{v.details?.catchAll?.status ? ` / catch-all ${v.details.catchAll.status}` : ''}</td>
            <td className="td text-xs">{[['Disposable', v.details?.attributes?.disposable], ['Free', v.details?.attributes?.freeProvider], ['Role', v.details?.attributes?.roleBased]].filter(([, yes]) => yes).map(([name]) => name).join(', ') || '—'}</td>
            <td className="td">{v.details?.risk ? `${v.details.risk.score} (${v.details.risk.level})` : '—'}</td>
            <td className="td text-xs">{v.details?.syntax?.reason ?? v.details?.dns?.error ?? 'Mailbox existence not checked'}</td>
          </tr>)}
        </Table>
        <div className="mt-3 flex items-center justify-between text-sm"><span>{b.resultCount} rows · page {b.page} of {Math.max(1, Math.ceil(b.resultCount / b.pageSize))}</span><div className="flex gap-2"><Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button variant="secondary" disabled={page >= Math.ceil(b.resultCount / b.pageSize)} onClick={() => setPage(page + 1)}>Next</Button></div></div>
      </>}
    </QueryView>
  </>;
}
