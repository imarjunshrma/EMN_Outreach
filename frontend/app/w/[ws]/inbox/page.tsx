'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { qs, type Paged } from '@/lib/api';
import { useWs, useWsQuery } from '@/lib/hooks';
import { fmtDate, fullName } from '@/lib/format';
import { REPLY_CATEGORIES } from '@/lib/constants';
import { Badge, Empty, Input, PageHeader, Pagination, QueryView, Select } from '@/components/ui';
import { SavedFilters } from '@/components/saved-filters';

/* eslint-disable @typescript-eslint/no-explicit-any */
function InboxList() {
  const ws = useWs();
  const params = useSearchParams();
  const [f, setF] = useState({ q: '', accountId: '', category: '', status: '', unread: params.get('unread') ?? '', hasReply: params.get('hasReply') ?? 'true', label: '', starred: '', archived: '', page: 1 });
  const accounts = useWsQuery<Array<{ id: string; emailAddress: string }>>('/email-accounts');
  const q = useWsQuery<Paged<any>>(`/conversations${qs({ ...f, pageSize: 30 })}`, { refetchInterval: 30_000 });
  const set = (k: keyof typeof f, v: string | number) => setF({ ...f, [k]: v, page: k === 'page' ? Number(v) : 1 });
  return (
    <>
      <PageHeader title="Unified inbox" subtitle="Replies from every connected mailbox. Replies always go out from the mailbox that started the conversation." />
      <div className="card mb-4 grid gap-2 p-3 md:grid-cols-9">
        <Input className="md:col-span-2" placeholder="Search subject, sender, text" value={f.q} onChange={(e) => set('q', e.target.value)} />
        <Select value={f.accountId} onChange={(e) => set('accountId', e.target.value)} options={[{ value: '', label: 'All mailboxes' }, ...(accounts.data ?? []).map((a) => ({ value: a.id, label: a.emailAddress }))]} />
        <Select value={f.category} onChange={(e) => set('category', e.target.value)} options={[{ value: '', label: 'Any category' }, ...REPLY_CATEGORIES.map((c) => ({ value: c, label: c.toLowerCase().replace(/_/g, ' ') }))]} />
        <Select value={f.status} onChange={(e) => set('status', e.target.value)} options={[{ value: '', label: 'Any status' }, { value: 'OPEN', label: 'Open' }, { value: 'WAITING', label: 'Waiting on them' }, { value: 'CLOSED', label: 'Closed' }]} />
        <Select value={f.unread} onChange={(e) => set('unread', e.target.value)} options={[{ value: '', label: 'Read & unread' }, { value: 'true', label: 'Unread only' }, { value: 'false', label: 'Read only' }]} />
        <Select value={f.hasReply} onChange={(e) => set('hasReply', e.target.value)} options={[{ value: 'true', label: 'With replies' }, { value: '', label: 'All threads (incl. sent)' }]} />
        <Select value={f.starred} onChange={(e) => set('starred', e.target.value)} options={[{ value: '', label: 'Starred & not' }, { value: 'true', label: '★ Starred only' }]} />
        <Select value={f.archived} onChange={(e) => set('archived', e.target.value)} options={[{ value: '', label: 'Inbox (not archived)' }, { value: 'true', label: 'Archived' }, { value: 'all', label: 'Everything' }]} />
        <div className="md:col-span-9"><SavedFilters entity="conversations" current={f} onApply={(q) => setF({ q: '', accountId: '', category: '', status: '', unread: '', hasReply: '', label: '', starred: '', archived: '', ...q, page: 1 })} /></div>
      </div>
      <QueryView q={q} isEmpty={(d) => d.total === 0} empty={<Empty title="No conversations">Replies appear here after the next mailbox sync (every ~2 minutes).</Empty>}>
        {(d) => (
          <div className="card divide-y divide-slate-100">
            {d.data.map((c: any) => (
              <Link key={c.id} href={`/w/${ws}/inbox/${c.id}`} className={`block px-4 py-3 hover:bg-slate-50 ${c.isUnread ? 'bg-brand-50/40' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-sm ${c.isUnread ? 'font-semibold' : ''}`}>{c.isStarred && <span className="text-amber-500">★ </span>}{c.lead ? fullName(c.lead) : c.messages[0]?.fromAddress} <span className="text-xs font-normal text-slate-500">via {c.emailAccount.emailAddress}</span></span>
                  <span className="text-xs text-slate-500">{fmtDate(c.lastMessageAt)}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">{c.subject ?? '(no subject)'}</span>{c.category && <Badge>{c.category}</Badge>}<Badge>{c.status}</Badge>{c.labels.map((l: string) => <Badge key={l} color="purple">{l}</Badge>)}</div>
                <p className="mt-0.5 truncate text-xs text-slate-500">{c.messages[0]?.direction === 'OUTBOUND' ? 'You: ' : ''}{c.messages[0]?.snippet}</p>
              </Link>
            ))}
            <div className="p-2"><Pagination page={d.page} totalPages={d.totalPages} total={d.total} onPage={(p) => set('page', p)} /></div>
          </div>
        )}
      </QueryView>
    </>
  );
}

export default function Inbox() { return <Suspense><InboxList /></Suspense>; }
