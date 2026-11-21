'use client';
import Link from 'next/link';
import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, describeError } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { Button, Field, Input, Notice } from '@/components/ui';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function finish() {
    const next = params.get('next');
    router.replace(next && /^\/(w|org|platform|onboarding)\//.test(next) ? next : '/app');
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (challenge) { await api('/auth/mfa/verify', { body: { challenge, code: code.trim() } }); await finish(); return; }
      const r = await api<{ mfaRequired?: boolean; challenge?: string }>('/auth/login', { body: { email, password } });
      if (r.mfaRequired && r.challenge) { setChallenge(r.challenge); setPassword(''); return; }
      await finish();
    } catch (err) { setError(describeError(err)); } finally { setBusy(false); }
  }
  if (challenge) return (
    <form onSubmit={submit} className="space-y-4" data-testid="mfa-step">
      {error && <Notice kind="danger">{error}</Notice>}
      <Notice>Enter the 6-digit code from your authenticator app, or one of your recovery codes.</Notice>
      <Field label="Authentication code"><Input autoFocus inputMode="text" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456 or XXXX-XXXX-XX" /></Field>
      <Button type="submit" loading={busy} className="w-full">Verify</Button>
      <button type="button" className="w-full text-center text-xs text-slate-500 underline" onClick={() => { setChallenge(null); setCode(''); }}>Start over</button>
    </form>
  );
  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Notice kind="danger">{error}</Notice>}
      <Field label="Email"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <Button type="submit" loading={busy} className="w-full">Sign in</Button>
      <p className="flex justify-between text-xs"><Link className="text-slate-500 underline" href="/forgot-password">Forgot your password?</Link><Link className="font-semibold text-brand-700 underline" href="/signup">Create an account</Link></p>
    </form>
  );
}

export default function LoginPage() {
  return <AuthShell title="Sign in" subtitle="Welcome back. Sign in to your organization."><Suspense><LoginForm /></Suspense></AuthShell>;
}
