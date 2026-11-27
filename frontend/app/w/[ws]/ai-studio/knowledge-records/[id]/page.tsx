'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Badge, Card, PageHeader, QueryView } from '@/components/ui';
import { fmtDate, titleCase } from '@/lib/format';
import { useWs, useWsQuery } from '@/lib/hooks';
import type { KnowledgeRecord } from '../page';

function label(key: string) {
  return titleCase(key.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
}

export default function KnowledgeRecordDetail() {
  const ws = useWs();
  const { id } = useParams<{ id: string }>();
  const record = useWsQuery<KnowledgeRecord>(`/ai-studio/knowledge-records/${id}`);
  return <QueryView q={record}>{(item) => <>
    <PageHeader title={item.name} subtitle={<Badge>{item.kind}</Badge>}
      actions={<Link className="text-sm font-semibold text-brand-600 hover:underline" href={`/w/${ws}/ai-studio/knowledge-records`}>Back to business records</Link>} />
    <Card title="Version history">
      <div className="space-y-3">
        {item.revisions.map((revision, index) => <details key={revision.id} open={index === 0} className="rounded-lg border border-slate-200 dark:border-slate-700">
          <summary className="cursor-pointer p-3 text-sm font-semibold">Version {revision.version} · {fmtDate(revision.createdAt)}</summary>
          <div className="space-y-3 px-3 pb-3">
            <dl className="grid gap-3 text-sm md:grid-cols-2">
              {Object.entries(revision.data).map(([key, value]) => <div key={key}>
                <dt className="mb-1 text-xs font-medium text-slate-500">{label(key)}</dt>
                <dd className="whitespace-pre-wrap break-words">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</dd>
              </div>)}
            </dl>
            <div className="flex flex-wrap gap-3 text-sm">
              {typeof revision.provenance.classification === 'string' && <Badge>{revision.provenance.classification}</Badge>}
              {typeof revision.provenance.verificationStatus === 'string' && <Badge>{revision.provenance.verificationStatus}</Badge>}
              {typeof revision.provenance.locator === 'string' && <span>{revision.provenance.locator}</span>}
              {typeof revision.provenance.importSessionId === 'string' && <Link href={`/w/${ws}/ai-studio/imports/${revision.provenance.importSessionId}`} className="font-semibold text-brand-600 hover:underline">Open source import</Link>}
            </div>
          </div>
        </details>)}
      </div>
    </Card>
  </>}</QueryView>;
}
