'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Building2, ChevronRight } from 'lucide-react';
import { api, describeError } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { Button, Field, Input, Loading, Notice, Select } from '@/components/ui';

type Me = { organizations: Array<{ id: string; name: string; role: string; status: string }>; workspaces: Array<{ id: string; name: string; role: string; organizationId: string }> };

export default function SelectWorkspace() {
  const router = useRouter();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me') });
  const [name, setName] = useState('');
  const [org, setOrg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (me.isLoading || !me.data) return <Loading />;
  const manageable = me.data.organizations.filter((o) => o.role === 'OWNER' || o.role === 'ADMIN');
  const target = org || manageable[0]?.id || '';
  async function create(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      // Inside an organization you manage; with none (e.g. invited member), this creates a new organization of your own.
      const ws = target ? await api<{ id: string }>(`/orgs/${target}/workspaces`, { body: { name } }) : await api<{ id: string }>('/workspaces', { body: { name } });
      router.push(`/w/${ws.id}`);
    } catch (x) { setErr(describeError(x)); setBusy(false); }
  }
  return (
    <AuthShell title="Choose a workspace">
      <div className="space-y-5">
        {me.data.organizations.map((o) => {
          const ws = me.data!.workspaces.filter((w) => w.organizationId === o.id);
          return (
            <div key={o.id}>
              <div className="mb-2 flex items-center justify-between"><p className="flex items-center gap-1.5 text-sm font-bold"><Building2 className="h-4 w-4 text-slate-400" aria-hidden />{o.name}</p><Link href={`/org/${o.id}`} className="text-xs font-semibold text-brand-700 underline">Settings</Link></div>
              {ws.length === 0 ? <p className="text-sm text-slate-500">No workspaces you can open.</p> : <div className="space-y-2">{ws.map((w) => <button key={w.id} onClick={() => router.push(`/w/${w.id}`)} className="card flex w-full items-center justify-between p-3 text-left hover:border-brand-300"><span className="font-semibold">{w.name} <span className="text-xs font-normal text-slate-500">· {w.role.toLowerCase()}</span></span><ChevronRight className="h-4 w-4 text-slate-400" aria-hidden /></button>)}</div>}
            </div>
          );
        })}
      </div>
      <form className="mt-8 space-y-3 border-t border-slate-200 pt-6" onSubmit={create}>
        {err && <Notice kind="danger">{err}</Notice>}
        {manageable.length > 1 && <Field label="Organization"><Select value={target} onChange={(e) => setOrg(e.target.value)} options={manageable.map((o) => ({ value: o.id, label: o.name }))} /></Field>}
        <Field label={manageable.length ? 'New workspace' : 'Start your own organization'} hint={manageable.length ? 'Counts toward your plan’s workspace limit.' : 'Creates a separate organization that you own.'}><Input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Button type="submit" loading={busy}>Create workspace</Button>
      </form>
    </AuthShell>
  );
}
