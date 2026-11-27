'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader, QueryView, Table } from '@/components/ui';
import { describeError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { isProcessing, type ImportSummary, useCanReviewImports } from './import-types';

export default function KnowledgeImports() {
  const ws = useWs();
  const router = useRouter();
  const canReview = useCanReviewImports();
  const imports = useWsQuery<ImportSummary[]>('/ai-studio/imports', { refetchInterval: 5000 });
  const [files, setFiles] = useState<File[]>([]);
  const tooLarge = files.some((file) => file.size > 20 * 1024 * 1024)
    || files.reduce((total, file) => total + file.size, 0) > 40 * 1024 * 1024;
  const upload = useWsMutation<File[], { id: string }>((selection) => {
    const form = new FormData();
    selection.forEach((file) => form.append('files', file));
    return { path: '/ai-studio/imports', form };
  }, { onSuccess: ({ id }) => router.push(`/w/${ws}/ai-studio/imports/${id}`) });

  return (
    <>
      <PageHeader title="Knowledge importer" subtitle="Import company knowledge, Outreach Brain settings, and ICPs. Review the proposed changes before applying them."
        actions={<a className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700" href={`/api/v1/w/${ws}/ai-studio/imports/template.xlsx`}>Download XLSX template</a>} />
      {canReview && <Card title="New import" className="mb-5">
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); upload.mutate(files); }}>
          <Field label="Choose files" hint="Upload up to 20 XLSX, CSV, PDF, DOCX, TXT, MD, JSON, or HTML files. The limit is 20 MB per file and 40 MB total.">
            <Input type="file" multiple accept=".xlsx,.csv,.pdf,.docx,.txt,.md,.json,.html" disabled={upload.isPending} onChange={(event) => { setFiles(Array.from(event.target.files ?? [])); upload.reset(); }} />
          </Field>
          {upload.error && <Notice kind="danger">{describeError(upload.error)}</Notice>}
          {files.length > 20 && <Notice kind="warning">Choose 20 files or fewer for each import.</Notice>}
          {tooLarge && <Notice kind="warning">Choose files within the 20 MB per-file and 40 MB total limits.</Notice>}
          <Button type="submit" loading={upload.isPending} disabled={!files.length || files.length > 20 || tooLarge}>Upload files</Button>
        </form>
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
