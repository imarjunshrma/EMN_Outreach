'use client';
import Link from 'next/link';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useWsQuery } from '@/lib/hooks';
import { PageHeader, QueryView } from '@/components/ui';
import { BillingPanel } from '@/components/org/billing-panel';

function Inner() {
  const params = useSearchParams();
  const q = useWsQuery<{ organizationId: string; mode: string }>('/billing');
  return (
    <QueryView q={q}>
      {(b) => (
        <>
          <PageHeader title="Plan & billing" subtitle={<>Billing belongs to your organization and covers all of its workspaces. <Link className="font-semibold text-brand-700 underline" href={`/org/${b.organizationId}?tab=billing`}>Open organization billing</Link></>} />
          <BillingPanel orgId={b.organizationId} checkoutReturned={params.get('checkout') === 'success'} />
        </>
      )}
    </QueryView>
  );
}
export default function Billing() { return <Suspense><Inner /></Suspense>; }
