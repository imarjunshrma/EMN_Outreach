'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AuthShell } from '@/components/auth-shell';
import { Notice } from '@/components/ui';

function Msg() {
  const p = useSearchParams();
  return <Notice kind="danger">{p.get('message') ?? 'The mailbox connection did not complete.'}</Notice>;
}
export default function OAuthError() {
  return (
    <AuthShell title="Mailbox connection failed">
      <Suspense><Msg /></Suspense>
      <p className="mt-4 text-sm text-slate-600">Common causes: the OAuth app is not configured on the server, your Google Workspace / Microsoft 365 admin has not approved the app, or the mailbox belongs to a tenant that does not allow third-party apps. See INSTALLATION.md → Mailbox providers.</p>
      <a href="/" className="mt-4 inline-block text-sm text-brand-600 underline">Back to the app</a>
    </AuthShell>
  );
}
