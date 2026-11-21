'use client';
import Link from 'next/link';
import { Suspense, useMemo, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Building2, Lock, Mail, User } from 'lucide-react';
import { api, describeError } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { Button, Field, Input, Loading, Notice } from '@/components/ui';

type Plans = { billingEnabled: boolean; registrationOpen: boolean; plans: Array<{ code: string; name: string; trialDays: number }> };

function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const meta = useQuery({ queryKey: ['public-plans'], queryFn: () => api<Plans>('/public/plans') });
  // One key per form: a double click or network retry returns the same organization instead of creating two.
  const idempotencyKey = useMemo(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`), []);
  const [f, setF] = useState({ name: '', email: '', organizationName: '', password: '', acceptTerms: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const plan = params.get('plan') ?? undefined;
  const set = (k: keyof typeof f) => (e: { target: { value: string; checked?: boolean } }) => setF({ ...f, [k]: k === 'acceptTerms' ? !!e.target.checked : e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.acceptTerms) { setError('Please accept the Terms of Service and Privacy Policy to continue.'); return; }
    setBusy(true); setError('');
    try {
      const r = await api<{ organization: { id: string } }>('/auth/signup', { body: { ...f, acceptTerms: true, planCode: plan, idempotencyKey, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      router.replace(`/onboarding/${r.organization.id}`);
    } catch (err) { setError(describeError(err)); setBusy(false); }
  }

  if (meta.isLoading) return <Loading />;
  if (meta.data && !meta.data.registrationOpen) return (
    <div className="space-y-4">
      <Notice>New sign-ups are closed on this installation. Ask your administrator for an invitation link.</Notice>
      <Link href="/login" className="text-sm font-semibold text-brand-700 underline">Go to sign in</Link>
    </div>
  );
  const chosen = meta.data?.plans.find((p) => p.code === plan);
  return (
    <form onSubmit={submit} className="space-y-4">
      {chosen && meta.data?.billingEnabled && <Notice kind="success">You are starting a {chosen.trialDays}-day trial of {chosen.name}. No card needed.</Notice>}
      {error && <Notice kind="danger">{error}</Notice>}
      <Field label="Your name"><Input icon={User} autoComplete="name" required value={f.name} onChange={set('name')} /></Field>
      <Field label="Work email"><Input icon={Mail} type="email" autoComplete="email" required value={f.email} onChange={set('email')} /></Field>
      <Field label="Company or agency name" hint="This becomes your organization. You can add client workspaces later."><Input icon={Building2} autoComplete="organization" required minLength={2} value={f.organizationName} onChange={set('organizationName')} /></Field>
      <Field label="Password" hint="At least 12 characters. A short sentence works well."><Input icon={Lock} type="password" autoComplete="new-password" required minLength={12} value={f.password} onChange={set('password')} /></Field>
      <label className="flex items-start gap-2.5 text-sm text-slate-600">
        <input type="checkbox" className="mt-0.5 h-4 w-4" checked={f.acceptTerms} onChange={set('acceptTerms')} aria-describedby="terms-note" />
        <span id="terms-note">I agree to the <Link className="font-semibold text-ink underline" href="/legal/terms" target="_blank">Terms of Service</Link>, <Link className="font-semibold text-ink underline" href="/legal/acceptable-use" target="_blank">Acceptable Use Policy</Link> and <Link className="font-semibold text-ink underline" href="/legal/privacy" target="_blank">Privacy Policy</Link>.</span>
      </label>
      <Button type="submit" loading={busy} className="w-full">Create my account</Button>
      <p className="text-center text-xs text-slate-500">Already have an account? <Link className="font-semibold text-brand-700 underline" href="/login">Sign in</Link></p>
    </form>
  );
}

export default function SignupPage() {
  return <AuthShell title="Create your account" subtitle="Your organization, a first workspace and a trial are set up in one step."><Suspense><SignupForm /></Suspense></AuthShell>;
}
