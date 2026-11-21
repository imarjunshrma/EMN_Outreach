'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, describeError } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { Loading, Notice } from '@/components/ui';

export default function VerifyEmail() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<{ ok?: boolean; error?: string }>({});
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return; once.current = true;
    api('/auth/verify-email', { body: { token } }).then(() => setState({ ok: true })).catch((e) => setState({ error: describeError(e) }));
  }, [token]);
  return (
    <AuthShell title="Confirm your email">
      {!state.ok && !state.error && <Loading label="Checking your link…" />}
      {state.ok && <div className="space-y-4"><Notice kind="success">Your email address is confirmed. You can now invite teammates and start campaigns.</Notice><Link href="/app" className="text-sm font-semibold text-brand-700 underline">Continue to the app</Link></div>}
      {state.error && <div className="space-y-4"><Notice kind="danger">{state.error}</Notice><p className="text-sm text-slate-600">Signed in? Use “Resend the link” at the top of any page in the app to get a fresh one.</p><Link href="/app" className="text-sm font-semibold text-brand-700 underline">Open the app</Link></div>}
    </AuthShell>
  );
}
