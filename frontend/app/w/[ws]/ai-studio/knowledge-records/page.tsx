'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge, Card, Empty, Field, PageHeader, QueryView, Select, Table } from '@/components/ui';
import { qs } from '@/lib/api';
import { fmtDate, titleCase } from '@/lib/format';
import { useWs, useWsQuery } from '@/lib/hooks';

export interface KnowledgeRecord {
  id: string;
  kind: string;
  name: string;
  domain?: string | null;
  version: number;
  updatedAt: string;
  revisions: Array<{
    id: string;
    version: number;
    data: Record<string, unknown>;
    provenance: Record<string, unknown>;
    createdAt: string;
  }>;
}

const recordKinds = [
  'TARGET_AUDIENCE', 'TARGET_PERSONA', 'ICP_CRITERIA', 'BUSINESS_OPPORTUNITY',
  'COMPETITOR', 'RESEARCH_RULE', 'OUTREACH_RULE', 'EXCLUSION', 'CAMPAIGN_PREFERENCE', 'PROOF_CASE_STUDY',
];

export default function KnowledgeRecords() {
  const ws = useWs();
  const [kind, setKind] = useState('');
  const records = useWsQuery<KnowledgeRecord[]>(`/ai-studio/knowledge-records${qs({ kind })}`);
  return <>
    <PageHeader title="Imported business records" subtitle="Browse applied records and their source history." />
    <Card title="Business records">
      <div className="mb-4 max-w-sm">
        <Field label="Record type"><Select value={kind} onChange={(event) => setKind(event.target.value)}
          options={[{ value: '', label: 'All record types' }, ...recordKinds.map((value) => ({ value, label: titleCase(value) }))]} /></Field>
      </div>
      <QueryView q={records} isEmpty={(items) => !items.length} empty={<Empty title="No imported records">Apply reviewed items in the Knowledge importer to add records.</Empty>}>
        {(items) => <Table head={['Record', 'Type', 'Version', 'Updated']}>
          {items.map((record) => <tr key={record.id}>
            <td className="td"><Link className="font-semibold text-brand-600 hover:underline" href={`/w/${ws}/ai-studio/knowledge-records/${record.id}`}>{record.name}</Link></td>
            <td className="td"><Badge>{record.kind}</Badge></td>
            <td className="td">{record.version}</td>
            <td className="td">{fmtDate(record.updatedAt)}</td>
          </tr>)}
        </Table>}
      </QueryView>
    </Card>
  </>;
}
