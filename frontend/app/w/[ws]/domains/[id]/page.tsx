'use client';

import { useParams } from 'next/navigation';
import { DomainManager } from '@/components/domain-manager';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, Notice, PageHeader, QueryView, Table } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function DomainDetail() {
  const { id } = useParams<{ id: string }>();
  const q = useWsQuery<any>(`/domains/${id}`);
  const check = useWsMutation(() => ({ path: `/domains/${id}/check`, body: {} }), { success: 'Check complete' });
  return (
    <QueryView q={q}>
      {(d) => {
        const last = d.checks[0];
        return (
          <>
            <PageHeader title={d.name} subtitle={<>Health <Badge>{d.healthStatus}</Badge> · last checked {fmtDate(d.lastCheckedAt)}</>} actions={<Button loading={check.isPending} onClick={() => check.mutate()}>Check now</Button>} />
            <DomainManager domain={d} />
            {last ? (
              <div className="grid gap-4 lg:grid-cols-2">
                <Card title="Issues & guidance">{(last.issues as any[]).length === 0 ? <Notice>No issues found.</Notice> : <ul className="space-y-2">{(last.issues as any[]).map((i) => <li key={i.code}><Notice kind={i.severity === 'critical' ? 'danger' : 'warning'}><b>{i.code}</b>: {i.message}</Notice></li>)}</ul>}</Card>
                <Card title="Records found">
                  <dl className="space-y-2 text-sm">
                    <div><dt className="label">SPF <Badge>{last.spfStatus}</Badge></dt><dd className="break-all font-mono text-xs">{last.spfRecord ?? 'none'}</dd></div>
                    <div><dt className="label">DMARC <Badge>{last.dmarcStatus}</Badge></dt><dd className="break-all font-mono text-xs">{last.dmarcRecord ?? 'none'}</dd></div>
                    <div><dt className="label">DKIM <Badge>{last.dkimStatus}</Badge></dt><dd className="text-xs">{(last.dkimResults as any[]).map((r) => `${r.selector}: ${r.found ? 'found' : 'not found'}`).join(' · ')}</dd></div>
                    <div><dt className="label">MX <Badge>{last.mxStatus}</Badge></dt><dd className="text-xs">{(last.mxRecords as any[]).map((r) => `${r.priority} ${r.exchange}`).join(' · ') || 'none'}</dd></div>
                  </dl>
                </Card>
                <Card title="Setup reference" className="lg:col-span-2">
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    <li><b>SPF</b> (TXT on {d.name}): Google — <code>v=spf1 include:_spf.google.com ~all</code>; Microsoft — <code>v=spf1 include:spf.protection.outlook.com ~all</code>. Only one SPF record per domain.</li>
                    <li><b>DKIM</b>: enable signing in Google Admin (Apps → Gmail → Authenticate email) or Microsoft Defender (Email authentication → DKIM), publish the record they give you, then add the selector above.</li>
                    <li><b>DMARC</b> (TXT on _dmarc.{d.name}): start with <code>v=DMARC1; p=none; rua=mailto:dmarc@{d.name}</code>, then move to quarantine/reject when aligned.</li>
                    <li>Consider sending cold outreach from a separate domain so your primary domain’s reputation is protected.</li>
                  </ul>
                </Card>
                <Card title="Check history" className="lg:col-span-2"><Table head={['When', 'SPF', 'DKIM', 'DMARC', 'MX', 'Issues']}>{d.checks.map((c: any) => <tr key={c.id}><td className="td text-xs">{fmtDate(c.checkedAt)}</td><td className="td"><Badge>{c.spfStatus}</Badge></td><td className="td"><Badge>{c.dkimStatus}</Badge></td><td className="td"><Badge>{c.dmarcStatus}</Badge></td><td className="td"><Badge>{c.mxStatus}</Badge></td><td className="td">{(c.issues as any[]).length}</td></tr>)}</Table></Card>
              </div>
            ) : <Notice>No check has run yet. Click “Check now”.</Notice>}
          </>
        );
      }}
    </QueryView>
  );
}
