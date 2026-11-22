'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building, X } from 'lucide-react';
import { api, qs } from '@/lib/api';
import { Input } from '@/components/ui';

/** Picks a tenant (organization) to filter by, or clears the filter. */
export function TenantFilter({ orgId, onChange }: { orgId?: string; onChange: (id: string | undefined) => void }) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const current = useQuery({ queryKey: ['platform-tenant', orgId], queryFn: () => api<{ organization: { name: string } }>(`/platform/tenants/${orgId}`), enabled: !!orgId });
  const list = useQuery({ queryKey: ['platform-tenants-pick', term], queryFn: () => api<{ data: Array<{ id: string; name: string; status: string }> }>(`/platform/tenants${qs({ q: term, pageSize: 8 })}`), enabled: open });
  useEffect(() => { if (!open) setTerm(''); }, [open]);
  if (orgId) return (
    <span className="inline-flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-semibold text-brand-900" data-testid="tenant-filter">
      <Building className="h-4 w-4" aria-hidden />{current.data?.organization.name ?? 'Tenant'}
      <button aria-label="Clear tenant filter" onClick={() => onChange(undefined)} className="text-brand-700 hover:text-ink"><X className="h-4 w-4" /></button>
    </span>
  );
  return (
    <div className="relative w-72">
      <Input icon={Building} placeholder="All tenants — pick one to filter" value={term} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={(e) => setTerm(e.target.value)} aria-label="Filter by tenant" />
      {open && (list.data?.data.length ?? 0) > 0 && (
        <div className="card absolute z-30 mt-1 w-full p-1 shadow-pop">
          {list.data!.data.map((t) => <button key={t.id} className="block w-full rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800" onMouseDown={() => onChange(t.id)}>{t.name} <span className="text-xs text-slate-500">{t.status.toLowerCase()}</span></button>)}
        </div>
      )}
    </div>
  );
}
