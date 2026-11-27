'use client';

import Link from 'next/link';
import { Badge, Card, Empty, PageHeader, QueryView, Table } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { useWs, useWsQuery } from '@/lib/hooks';
import { ImportUploader } from './import-uploader';
import { isProcessing, type ImportSummary, useCanReviewImports } from './import-types';

export default function KnowledgeImports() {
  const ws = useWs();
  const canReview = useCanReviewImports();
  const imports = useWsQuery<ImportSummary[]>('/ai-studio/imports', { refetchInterval: 5000 });
  return (
    <>
      <PageHeader title="Knowledge importer" subtitle="Import company knowledge, Outreach Brain settings, and ICPs. Review the proposed changes before applying them."
        actions={<a className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700" href={`/api/v1/w/${ws}/ai-studio/imports/template.xlsx`}>Download XLSX template</a>} />
      {canReview && <Card title="New import" className="mb-5">
        <ImportUploader />
      </Card>}
      <Card title="Import history">
        <QueryView q={imports} isEmpty={(rows) => !rows.length} empty={<Empty title="No imports yet">Upload a workbook or supporting documents to begin.</Empty>}>
          {(rows) => <Table head={['Import', 'Status', 'Files', 'Extracted', 'Approved', 'Rejected', 'Conflicts', 'Failed', 'Applied']}>
            {rows.map((session) => <tr key={session.id}>
              <td className="td">
                <Link className="font-semibold text-brand-600 hover:underline" href={`/w/${ws}/ai-studio/imports/${session.id}`}>{fmtDate(session.createdAt)}</Link>
                {session.errorSummary && <p className="mt-1 max-w-xs text-xs text-red-600">{session.errorSummary}</p>}
              </td>
              <td className="td">
                <Badge color={isProcessing(session.status) ? 'blue' : undefined}>{session.status}</Badge>
                {typeof session.progress === 'number' && isProcessing(session.status) && <progress aria-label="Processing progress" className="mt-2 block w-20" value={session.progress} max={100} />}
              </td>
              <td className="td">{session._count?.files ?? '—'}</td>
              <td className="td">{session._count?.items ?? '—'}</td>
              {['APPROVED', 'REJECTED', 'CONFLICT', 'FAILED', 'APPLIED'].map((status) => <td key={status} className="td">{session.counts ? session.counts[status] ?? 0 : '—'}</td>)}
            </tr>)}
          </Table>}
        </QueryView>
      </Card>
    </>
  );
}
