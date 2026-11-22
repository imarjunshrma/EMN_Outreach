'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowLeft, BarChart3, Building, Database, FileClock, KeyRound, Layers, LifeBuoy, Settings, ShieldAlert, ShieldCheck, UserCog } from 'lucide-react';
import { api } from '@/lib/api';
import { Loading } from '@/components/ui';

type PlatformMe = { role: string; permissions: string[]; mfaEnabled: boolean; mfaRequired?: boolean };
const Ctx = createContext<PlatformMe>({ role: '', permissions: [], mfaEnabled: false });
export const usePlatform = () => useContext(Ctx);

const NAV = [
  { href: '/platform', label: 'Overview', icon: BarChart3, perm: 'metrics:read' },
  { href: '/platform/tenants', label: 'Tenants', icon: Building, perm: 'tenants:read' },
  { href: '/platform/plans', label: 'Plans', icon: Layers, perm: 'tenants:read' },
  { href: '/platform/support', label: 'Support access', icon: LifeBuoy, perm: 'support:access' },
  { href: '/platform/users', label: 'User accounts', icon: UserCog, perm: 'tenants:read' },
  { href: '/platform/data', label: 'Data explorer', icon: Database, perm: 'data:read' },
  { href: '/platform/operations', label: 'Operations', icon: Activity, perm: 'metrics:read' },
  { href: '/platform/audit', label: 'Audit trail', icon: FileClock, perm: 'audit:read' },
  { href: '/platform/staff', label: 'Staff & roles', icon: ShieldCheck, perm: 'staff:manage' },
  { href: '/platform/permissions', label: 'Permission matrix', icon: KeyRound, perm: 'tenants:read' },
  { href: '/platform/settings', label: 'Global settings', icon: Settings, perm: 'tenants:read' },
];

export function PlatformShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const me = useQuery({ queryKey: ['platform-me'], queryFn: () => api<PlatformMe>('/platform/me'), retry: false });
  if (me.isLoading) return <Loading />;
  if (me.error || !me.data) return <div className="grid min-h-screen place-items-center p-8 text-center"><div><p className="font-display text-2xl font-bold">Page not found</p><Link className="mt-3 inline-block text-sm font-semibold text-brand-700 underline" href="/app">Back to the app</Link></div></div>;
  if (!me.data.mfaEnabled && me.data.mfaRequired !== false) return <MfaRequired />;
  const nav = NAV.filter((n) => me.data!.permissions.includes(n.perm));
  return (
    <Ctx.Provider value={me.data}>
      <div className="min-h-screen lg:flex">
        {/* Same surface as the workspace sidebar, so the console follows light and dark mode the same way. */}
        <aside className="flex flex-col border-b border-slate-200 bg-white text-slate-600 dark:border-white/5 dark:text-slate-300 lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r" data-testid="platform-sidebar">
          <div className="px-5 py-5">
            <p className="font-display text-[17px] font-bold text-ink">EMN Platform</p>
            <p className="text-[12px] text-slate-500">Staff console · {me.data.role.replace('_', ' ').toLowerCase()}</p>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:block lg:flex-1 lg:space-y-0.5 lg:overflow-y-auto" aria-label="Platform">
            {nav.map((n) => {
              const active = n.href === '/platform' ? path === n.href : path.startsWith(n.href);
              return <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined} className={`flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] font-semibold transition-colors ${active ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-white' : 'hover:bg-slate-100 hover:text-ink dark:hover:bg-white/5 dark:hover:text-white'}`}><n.icon className={`h-4 w-4 ${active ? 'text-brand-600 dark:text-brand-400' : 'opacity-60'}`} aria-hidden />{n.label}</Link>;
            })}
          </nav>
          <Link href="/app?to=workspace" className="mx-3 mb-4 hidden items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-slate-500 hover:bg-slate-100 hover:text-ink dark:hover:bg-white/5 dark:hover:text-white lg:flex"><ArrowLeft className="h-4 w-4" aria-hidden />Back to my workspace</Link>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </Ctx.Provider>
  );
}

/** Staff must turn on 2FA before any console screen loads, unless this install turned the rule off (the API enforces the same rule). */
function MfaRequired() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ workspaces: Array<{ id: string }> }>('/auth/me') });
  const ws = me.data?.workspaces[0]?.id;
  return (
    <div className="grid min-h-screen place-items-center bg-paper p-6">
      <div className="card max-w-md p-8 text-center" data-testid="platform-mfa-required">
        <ShieldAlert className="mx-auto h-10 w-10 text-brand-600" aria-hidden />
        <h1 className="font-display mt-3 text-2xl font-bold">Turn on two-factor sign-in</h1>
        <p className="mt-2 text-sm text-slate-600">The platform console gives access to every customer, so staff accounts must use two-factor authentication. Set it up once with an authenticator app; it takes about a minute.</p>
        {ws ? <Link href={`/w/${ws}/settings/account`} className="btn-site-primary mt-5">Set up two-factor</Link> : <Link href="/app" className="btn-site-primary mt-5">Open my account</Link>}
      </div>
    </div>
  );
}
