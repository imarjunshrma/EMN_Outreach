'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, describeError } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { Button, Field, Input, Notice } from '@/components/ui';

export default function ResetPassword() {
  const { token } = useParams<{ token: string }>();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw !== confirm) { setError('Passwords do not match'); return; }
    setBusy(true); setError('');
    try { await api('/auth/password/reset', { body: { token, password: pw } }); setDone(true); } catch (err) { setError(describeError(err)); } finally { setBusy(false); }
  }
  return (
    <AuthShell title="Choose a new password" subtitle="All existing sessions will be signed out.">
      {done ? <Notice>Password updated. <Link className="underline" href="/login">Sign in</Link> with your new password.</Notice> : (
        <form onSubmit={submit} className="space-y-4">
          {error && <Notice kind="danger">{error}</Notice>}
          <Field label="New password" hint="At least 12 characters with letters and numbers"><Input type="password" autoComplete="new-password" required minLength={12} value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <Field label="Confirm new password"><Input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
          <Button type="submit" loading={busy} className="w-full">Set password</Button>
        </form>
      )}
    </AuthShell>
  );
}
