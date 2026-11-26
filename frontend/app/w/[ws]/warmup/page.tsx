'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useWs, useWsQuery } from '@/lib/hooks';
import { Card, PageHeader, QueryView, Select } from '@/components/ui';

import { WarmupConfiguration } from '@/components/warmup-configuration';

interface Mailbox { id: string; emailAddress: string; provider: string; status: string; dailySendLimit: number }
interface Overview {
  mailboxes: Mailbox[];
  programs: { id: string; status: string; dailyTarget: number; nextAt: string | null; emailAccount: Mailbox; reason: string | null }[];
  metrics: { programId: string; status: string; hardBounce: boolean; _count: { _all: number } }[];
}

export default function WarmupPage() {
  const ws = useWs();
  const [filter, setFilter] = useState('ALL');
  const q = useWsQuery<Overview>('/warmup', { refetchInterval: 30_000 });
  return <>
    <PageHeader title="Email warm-up" subtitle="Controlled mailbox programs for explicitly authorized recipients." />
    <QueryView q={q}>{data => <>
      <Card title="Programs">
        <p className="mb-3 text-sm">{data.mailboxes.filter(m => m.status === 'CONNECTED').length} connected · {data.programs.length} enrolled · {data.programs.filter(p => p.status === 'ACTIVE').length} active · {data.programs.filter(p => p.status === 'PAUSED').length} paused · {data.programs.filter(p => p.status === 'COMPLETED').length} completed</p>
        <Select aria-label="Filter programs" value={filter} onChange={e => setFilter(e.target.value)} options={['ALL', 'ACTIVE', 'PAUSED', 'COMPLETED', 'NEEDS_ATTENTION'].map(value => ({ value, label: value.replaceAll('_', ' ') }))} />
        <ul className="mt-3 space-y-3">{data.programs.filter(p => filter === 'ALL' || filter === p.status || (filter === 'NEEDS_ATTENTION' && ['HEALTH_HOLD', 'AUTH_REQUIRED'].includes(p.status))).map(p => {
          const metrics = data.metrics.filter(m => m.programId === p.id);
          const count = (state: string) => metrics.filter(m => m.status === state).reduce((sum, m) => sum + m._count._all, 0);
          return <li key={p.id}><Link className="underline" href={`/w/${ws}/warmup/${p.id}`}>{p.emailAccount.emailAddress}</Link><p className="text-sm">{p.emailAccount.provider} · {p.status.replaceAll('_', ' ')} · {p.dailyTarget}/day target · {count('ACCEPTED')} provider accepted · {metrics.filter(m => m.hardBounce).reduce((sum, m) => sum + m._count._all, 0)} hard bounces · {count('UNCERTAIN')} ambiguous</p>{p.reason && <p className="text-sm">{p.reason}</p>}</li>;
        })}</ul>
        {!data.programs.length && <p className="mt-3 text-sm">No mailboxes enrolled.</p>}
      </Card>
      <WarmupConfiguration mailboxes={data.mailboxes} />
    </>}</QueryView>
  </>;
}
