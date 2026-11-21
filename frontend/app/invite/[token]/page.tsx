'use client';
import { useState, type FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, describeError } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { Button, Field, Input, Notice } from '@/components/ui';

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api<{ workspaceId: string }>(`/invitations/${token}/accept`, { body: { name: name || undefined, password: password || undefined } });
      router.replace(`/w/${r.workspaceId}`);
    } catch (err) { setError(describeError(err)); } finally { setBusy(false); }
  }
  return (
    <AuthShell title="Join workspace" subtitle="If you already have an account, sign in first and open this link again. Otherwise create your account below.">
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice kind="danger">{error}</Notice>}
        <Field label="Your name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Choose a password" hint="At least 12 characters with letters and numbers."><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Button type="submit" loading={busy} className="w-full">Accept invitation</Button>
      </form>
    </AuthShell>
  );
}
