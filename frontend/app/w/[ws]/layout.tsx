'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bell, Building2, ChevronDown, ChevronsUpDown, LogOut, Menu, Moon, Monitor, Search, ShieldCheck, Sun, UserCircle, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useRealtime, useWs, useWsQuery } from '@/lib/hooks';
import { useTheme, type Theme } from '@/lib/theme';
import { Loading } from '@/components/ui';
import { visibleNav } from '@/components/shell/nav';
import { CommandPalette } from '@/components/shell/command-palette';
import { PageMeta } from '@/components/shell/page-context';

type Me = { user: { name: string; email: string; isPlatformAdmin?: boolean; platformRole?: string | null; emailVerified?: boolean }; organizations: Array<{ id: string; name: string; role: string; status: string }>; workspaces: Array<{ id: string; name: string; role: string; organizationId: string; organizationName: string; organizationStatus: string }> };

function ResendVerification() {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  if (state === 'sent') return <span className="font-semibold">Link sent — check your inbox.</span>;
  return <button className="font-semibold underline" disabled={state === 'sending'} onClick={async () => { setState('sending'); try { await api('/auth/verify-email/resend', { method: 'POST' }); setState('sent'); } catch { setState('error'); } }}>{state === 'error' ? 'Could not send. Try again' : 'Resend the link'}</button>;
}

/** Owners and admins see a slim reminder until the required setup steps are done (dismissible per organization). */
function SetupReminder({ orgId }: { orgId: string }) {
  const [hidden, setHidden] = useState(true);
  useEffect(() => { try { setHidden(localStorage.getItem(`emn-onboarding-${orgId}`) === 'later'); } catch { setHidden(false); } }, [orgId]);
  const q = useQuery({ queryKey: ['onboarding', orgId], queryFn: () => api<{ complete: boolean; steps: Array<{ done: boolean; optional: boolean }> }>(`/orgs/${orgId}/onboarding`), enabled: !hidden, staleTime: 300_000 });
  if (hidden || !q.data || q.data.complete) return null;
  const left = q.data.steps.filter((s) => !s.done && !s.optional).length;
  if (!left) return null;
  return <div className="flex items-center gap-3 bg-brand-50 px-4 py-2 text-sm text-brand-900 lg:px-8" data-testid="setup-reminder"><span className="flex-1">{left} required setup step{left === 1 ? '' : 's'} left before your first campaign.</span><Link className="font-semibold underline" href={`/onboarding/${orgId}`}>Open the checklist</Link><button className="text-brand-700 hover:text-ink" onClick={() => { try { localStorage.setItem(`emn-onboarding-${orgId}`, 'later'); } catch { /* ignore */ } setHidden(true); }} aria-label="Hide setup reminder"><X className="h-4 w-4" /></button></div>;
}

function useCollapsed() {
  const [c, setC] = useState<Record<string, boolean>>({});
  useEffect(() => { try { setC(JSON.parse(localStorage.getItem('emn-nav') ?? '{}')); } catch { /* ignore */ } }, []);
  return [c, (g: string) => setC((p) => { const n = { ...p, [g]: !p[g] }; try { localStorage.setItem('emn-nav', JSON.stringify(n)); } catch { /* ignore */ } return n; })] as const;
}

function UserMenu({ me, base, current }: { me: Me; base: string; current?: Me['workspaces'][number] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  const initials = me.user.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const themes: Array<[Theme, typeof Sun, string]> = [['light', Sun, 'Light'], ['dark', Moon, 'Dark'], ['system', Monitor, 'Auto']];
  return (
    <div className="relative" ref={ref}>
      <button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-slate-100 dark:hover:bg-slate-800">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-600 text-[12px] font-bold text-white">{initials}</span>
        <span className="hidden text-sm font-semibold sm:block">{me.user.name}</span>
        <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="card absolute right-0 top-11 z-40 w-64 p-1.5 shadow-pop">
          <div className="px-2.5 py-2"><p className="text-sm font-bold">{me.user.name}</p><p className="truncate text-xs text-slate-500">{me.user.email}</p></div>
          <div className="my-1 flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800" data-testid="theme-toggle">
            {themes.map(([t, Icon, label]) => <button key={t} onClick={() => setTheme(t)} aria-pressed={theme === t} className={`flex flex-1 items-center justify-center gap-1 rounded-md py-1 text-xs font-semibold ${theme === t ? 'bg-white text-ink shadow-sm dark:bg-slate-950 dark:text-white' : 'text-slate-500'}`}><Icon className="h-3.5 w-3.5" aria-hidden />{label}</button>)}
          </div>
          <Link role="menuitem" href={`${base}/settings/account`} onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"><UserCircle className="h-4 w-4" aria-hidden />My account & 2FA</Link>
          {current && <Link role="menuitem" href={`/org/${current.organizationId}`} onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"><Building2 className="h-4 w-4" aria-hidden />Organization settings</Link>}
          {me.user.platformRole && <Link role="menuitem" href="/platform" className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"><ShieldCheck className="h-4 w-4" aria-hidden />Platform admin</Link>}
          <button role="menuitem" onClick={async () => { await api('/auth/logout', { method: 'POST' }); router.replace('/login'); }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-red-700 hover:bg-red-50"><LogOut className="h-4 w-4" aria-hidden />Sign out</button>
        </div>
      )}
    </div>
  );
}

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const ws = useWs();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [collapsed, toggle] = useCollapsed();
  useRealtime(ws);
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me') });
  const notes = useWsQuery<{ unread: number }>('/notifications', { refetchInterval: 60_000 });
  const bill = useWsQuery<{ mode: string; active: boolean; reason: string | null }>('/billing', { refetchInterval: 300_000 });
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => { try { localStorage.setItem('emn-last-ws', ws); } catch { /* ignore */ } }, [ws]);
  if (me.isLoading) return <Loading />;
  if (me.error || !me.data) return <Loading label="Redirecting to sign in…" />;
  const current = me.data.workspaces.find((w) => w.id === ws);
  if (!current) return <div className="p-8 text-sm">Workspace not found or you are not a member. <Link className="underline" href="/select-workspace">Choose a workspace</Link></div>;
  const base = `/w/${ws}`;
  const groups = visibleNav(current.role);
  // The longest matching nav entry wins, so /leads/import highlights "Import & export", not "Leads".
  const all = groups.flatMap((g) => g.items.map((i) => i.href));
  const match = all.filter((h) => (h === '' ? path === base : path === base + h || path.startsWith(`${base}${h}/`))).sort((a, b) => b.length - a.length)[0];
  const currentItem = groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group }))).find((i) => i.href === match);
  const unread = notes.data?.unread ?? 0;

  return (
    <div className="min-h-screen lg:flex">
      {open && <div className="fixed inset-0 z-30 bg-ink/40 lg:hidden" onClick={() => setOpen(false)} aria-hidden />}
      <aside className={`${open ? 'translate-x-0' : '-translate-x-full'} fixed inset-y-0 left-0 z-40 flex w-[264px] flex-col border-r border-slate-200 bg-white text-slate-600 transition-transform dark:border-white/5 dark:text-slate-300 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0`}>
        <div className="px-4 pb-3 pt-4">
          <Link href={base} className="flex items-center gap-2.5">
            <span className="font-display grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 text-[14px] font-bold text-white shadow-brand">em</span>
            <span className="leading-tight"><span className="font-display block text-[17px] font-bold tracking-[-0.02em] text-ink">Outreach OS</span><span className="block text-[11px] text-slate-500">Elite Media Networks</span></span>
          </Link>
          <label className="relative mt-4 block">
            <span className="sr-only">Workspace</span>
            <select className="w-full appearance-none rounded-lg border border-slate-200 bg-slate-50 py-2 pl-3 pr-8 text-sm font-semibold text-ink outline-none hover:border-slate-300 focus:border-brand-500 focus:ring-4 focus:ring-brand-100 dark:focus:ring-brand-900/60" value={ws} onChange={(e) => (e.target.value === '__new' ? router.push('/select-workspace') : router.push(`/w/${e.target.value}`))}>
              {me.data.organizations.length > 1
                ? me.data.organizations.map((o) => <optgroup key={o.id} label={o.name}>{me.data!.workspaces.filter((w) => w.organizationId === o.id).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</optgroup>)
                : me.data.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              <option value="__new">+ New workspace…</option>
            </select>
            <ChevronsUpDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-slate-400" aria-hidden />
          </label>
          <button onClick={() => setPalette(true)} className="mt-2 flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm text-slate-500 hover:border-slate-300 hover:text-ink">
            <Search className="h-4 w-4" aria-hidden /><span className="flex-1">Go to…</span><kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 text-[11px] text-slate-500">⌘K</kbd>
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2.5 pb-6" aria-label="Main">
          {groups.map((g) => {
            const isCollapsed = collapsed[g.group] && !g.items.some((i) => i.href === match);
            return (
              <div key={g.group} className="mt-3">
                <button onClick={() => toggle(g.group)} aria-expanded={!isCollapsed} className="flex w-full items-center justify-between rounded px-2 py-1 text-[12px] font-bold text-slate-400 hover:text-slate-600">
                  {g.group}<ChevronDown className={`h-3.5 w-3.5 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} aria-hidden />
                </button>
                {!isCollapsed && g.items.map((i) => {
                  const active = i.href === match;
                  return (
                    <Link key={i.href} href={base + i.href} aria-current={active ? 'page' : undefined}
                      className={`relative mt-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] font-semibold transition-colors ${active ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-white' : 'hover:bg-slate-100 hover:text-ink dark:hover:bg-white/5 dark:hover:text-white'}`}>
                      {active && <span className="absolute -left-2.5 top-1.5 h-[calc(100%-12px)] w-[3px] rounded-r bg-brand-500" aria-hidden />}
                      <i.icon className={`h-[17px] w-[17px] shrink-0 ${active ? 'text-brand-600 dark:text-brand-400' : 'opacity-60'}`} aria-hidden strokeWidth={active ? 2.25 : 2} />
                      <span className="flex-1 truncate">{i.label}</span>
                      {i.href === '/notifications' && unread > 0 && <span className="rounded-full bg-brand-500 px-1.5 text-[11px] font-bold text-white tnum">{unread}</span>}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <Link href={`/org/${current.organizationId}`} className="flex items-center gap-2 border-t border-slate-200 px-4 py-3 text-[12px] text-slate-500 hover:text-ink">
          <Building2 className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
          <span className="min-w-0 flex-1 truncate"><span className="font-semibold text-slate-700">{current.organizationName}</span> · {current.role.toLowerCase()}</span>
        </Link>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur lg:px-8">
          <button className="rounded-lg p-1.5 text-ink-600 hover:bg-slate-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
          <nav aria-label="Breadcrumb" className="min-w-0 flex-1 truncate text-sm">
            <span className="text-slate-500">{currentItem?.group ?? current.name}</span>
            {currentItem && <><span className="mx-2 text-slate-300">/</span><span className="font-semibold text-ink">{currentItem.label}</span></>}
          </nav>
          <Link href={`${base}/notifications`} className="relative rounded-lg p-2 text-ink-600 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
            <Bell className="h-[18px] w-[18px]" />
            {unread > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-brand-500 ring-2 ring-white" />}
          </Link>
          <UserMenu me={me.data} base={base} current={current} />
        </header>
        {(me.data.organizations.find((o) => o.id === current.organizationId)?.role === 'OWNER' || me.data.organizations.find((o) => o.id === current.organizationId)?.role === 'ADMIN') && <SetupReminder orgId={current.organizationId} />}
        {me.data.user.emailVerified === false && bill.data?.mode === 'saas' && <div className="bg-brand-50 px-4 py-2 text-sm text-brand-900 lg:px-8">Confirm your email address to invite teammates and start campaigns. <ResendVerification /></div>}
        {bill.data?.mode === 'saas' && (!bill.data.active || bill.data.reason) && <div data-testid="billing-banner" className={`px-4 py-2 text-sm lg:px-8 ${bill.data.active ? 'bg-amber-50 text-amber-900' : 'bg-red-50 text-red-800'}`}>{bill.data.reason}. <Link className="font-semibold underline" href={`${base}/billing`}>Open plan & billing</Link></div>}
        <main className="mx-auto max-w-[1360px] px-4 py-6 lg:px-8 lg:py-8"><PageMeta.Provider value={{ icon: currentItem?.icon, group: currentItem?.group }}>{children}</PageMeta.Provider></main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} groups={groups} base={base} />
      {open && <button className="fixed right-4 top-4 z-50 rounded-lg bg-white p-1.5 lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu"><X className="h-5 w-5" /></button>}
    </div>
  );
}
