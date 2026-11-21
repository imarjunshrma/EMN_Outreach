'use client';

import Link from 'next/link';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Button, Empty, PageHeader, QueryView } from '@/components/ui';

export default function Notifications() {
  const ws = useWs();
  const q = useWsQuery<{ items: Array<{ id: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }>; unread: number }>('/notifications');
  const read = useWsMutation(() => ({ path: '/notifications/read', body: {} }), { success: 'All marked read' });
  return (
    <>
      <PageHeader title="Notifications" actions={<Button variant="secondary" onClick={() => read.mutate()}>Mark all read</Button>} />
      <QueryView q={q} isEmpty={(d) => d.items.length === 0} empty={<Empty title="No notifications" />}>
        {(d) => <div className="card divide-y divide-slate-100">{d.items.map((n) => (
          <div key={n.id} className={`px-4 py-3 ${n.readAt ? '' : 'bg-brand-50/40'}`}>
            <div className="flex justify-between text-sm"><span className={n.readAt ? '' : 'font-semibold'}>{n.link ? <Link className="hover:underline" href={`/w/${ws}${n.link}`}>{n.title}</Link> : n.title}</span><span className="text-xs text-slate-500">{fmtDate(n.createdAt)}</span></div>
            {n.body && <p className="text-xs text-slate-500">{n.body}</p>}
          </div>
        ))}</div>}
      </QueryView>
    </>
  );
}
