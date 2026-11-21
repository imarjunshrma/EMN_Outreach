'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { api, describeError } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { Button, Field, Input, Notice } from '@/components/ui';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await api('/auth/password/forgot', { body: { email } }); setDone(true); } catch (err) { setError(describeError(err)); } finally { setBusy(false); }
  }
  return (
    <AuthShell title="Reset your password" subtitle="We will email a single-use link that is valid for one hour.">
      {done ? <Notice>If an account exists for that address, a reset link is on its way. Check your inbox (and spam folder).</Notice> : (
        <form onSubmit={submit} className="space-y-4">
          {error && <Notice kind="danger">{error}</Notice>}
          <Field label="Email"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" loading={busy} className="w-full">Send reset link</Button>
        </form>
      )}
      <p className="mt-4 text-center text-xs"><Link className="text-slate-500 underline" href="/login">Back to sign in</Link></p>
    </AuthShell>
  );
}
