'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api, describeError } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { Button, Field, Input, Notice } from '@/components/ui';

export default function SetupPage() {
  const router = useRouter();
  const [f, setF] = useState({ name: '', email: '', password: '', workspaceName: 'Elite Media Networks' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => { api<{ needsSetup: boolean; publicRegistration: boolean }>('/auth/bootstrap').then((b) => setAllowed(b.needsSetup || b.publicRegistration)).catch(() => setAllowed(false)); }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api<{ workspace: { id: string } }>('/auth/register', { body: f });
      router.replace(`/w/${r.workspace.id}?welcome=1`);
    } catch (err) { setError(describeError(err)); } finally { setBusy(false); }
  }
  if (allowed === false) return <AuthShell title="Setup complete"><Notice>An owner account already exists. <a className="underline" href="/login">Sign in</a> or ask an admin for an invitation.</Notice></AuthShell>;
  return (
    <AuthShell title="Create the owner account" subtitle="First-run setup. This account becomes the workspace owner.">
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice kind="danger">{error}</Notice>}
        <Field label="Your name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email"><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Password" hint="At least 12 characters with letters and numbers."><Input type="password" minLength={12} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="Workspace name"><Input required value={f.workspaceName} onChange={(e) => setF({ ...f, workspaceName: e.target.value })} /></Field>
        <Button type="submit" loading={busy} className="w-full">Create account</Button>
      </form>
    </AuthShell>
  );
}
