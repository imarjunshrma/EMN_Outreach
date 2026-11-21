'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useWsQuery } from '@/lib/hooks';
import { Badge, Card, Empty, PageHeader, QueryView, Table } from '@/components/ui';

export default function VerificationBatchPage() {
  const params = useParams<{ ws: string; id: string }>();
  const batch = useWsQuery<any>(`/email-verification/batches/${params.id}`, { refetchInterval: 2500 });
  return <>
    <PageHeader title="Email verification batch" subtitle="DNS and address attributes only; mailbox existence is not confirmed." actions={<Link className="underline" href={`/w/${params.ws}/enrichment`}>Back to verification</Link>} />
    <QueryView q={batch} empty={<Empty title="Verification batch not found" />}>
      {(b) => <>
        <div className="mb-4 grid gap-3 md:grid-cols-3">
          <Card title="Status"><Badge>{b.status}</Badge></Card>
          <Card title="Progress">{b.processed}/{b.total}</Card>
          <Card title="Created">{new Date(b.createdAt).toLocaleString()}</Card>
        </div>
        <Table head={['Email', 'Primary status', 'DNS / SMTP', 'Attributes', 'Risk', 'Reason']}>
          {(b.verifications ?? []).map((v: any) => <tr key={v.id}>
            <td className="td">{v.email}</td><td className="td"><Badge>{v.result}</Badge></td>
            <td className="td">{v.details?.dns?.status ?? v.details?.state ?? 'Queued'}{v.details?.smtp?.classification ? ` / ${v.details.smtp.classification}` : ''}{v.details?.catchAll?.status ? ` / catch-all ${v.details.catchAll.status}` : ''}</td>
            <td className="td text-xs">{[['Disposable', v.details?.attributes?.disposable], ['Free', v.details?.attributes?.freeProvider], ['Role', v.details?.attributes?.roleBased]].filter(([, yes]) => yes).map(([name]) => name).join(', ') || '—'}</td>
            <td className="td">{v.details?.risk ? `${v.details.risk.score} (${v.details.risk.level})` : '—'}</td>
            <td className="td text-xs">{v.details?.syntax?.reason ?? v.details?.dns?.error ?? 'Mailbox existence not checked'}</td>
          </tr>)}
        </Table>
      </>}
    </QueryView>
  </>;
}
