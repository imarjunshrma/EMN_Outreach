'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftCircle, UserCheck, Wrench } from 'lucide-react';
import { api } from '@/lib/api';

type Me = { user: { name: string; email: string }; impersonation: null | { by: { name: string; email: string } | null; reason: string | null; expiresAt: string } };
type PublicConfig = { appName: string; supportEmail: string | null; passwordMinLength: number; maintenance: null | { message: string } };

/** Leaves a "log in as" session and goes back to the super admin's own account (works even after it expired). */
export async function returnToConsole() {
  const r = await api<{ restored: boolean; redirectTo: string }>('/auth/impersonation/stop', { method: 'POST' });
  window.location.href = r.redirectTo;
}

const APP_AREAS = ['/w/', '/app', '/org', '/onboarding', '/select-workspace'];

/** Product name, password rule and maintenance notice, from Platform → Global settings. */
export function usePublicConfig() {
  return useQuery({ queryKey: ['public-config'], queryFn: () => api<PublicConfig>('/public/config'), staleTime: 60_000 });
}

/** Banners for the signed-in app: "you are signed in as …" for super admins, and maintenance mode for everyone. */
export function AppBanners() {
  const path = usePathname() ?? '';
  const inApp = APP_AREAS.some((p) => path.startsWith(p));
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), enabled: inApp, staleTime: 60_000, retry: false });
  const config = usePublicConfig();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const [busy, setBusy] = useState(false);
  const imp = inApp ? me.data?.impersonation : null;
  const maintenance = inApp ? config.data?.maintenance : null;
  if (!imp && !maintenance) return null;
  const left = imp ? Math.max(0, Math.round((new Date(imp.expiresAt).getTime() - now) / 60_000)) : 0;
  return (
    <>
      {imp && (
        <div className="sticky top-0 z-50 flex flex-wrap items-center gap-x-3 gap-y-1 bg-red-700 px-4 py-2 text-sm text-white lg:px-8" role="status" data-testid="impersonation-banner">
          <UserCheck className="h-4 w-4 shrink-0" aria-hidden />
          <span className="flex-1">
            You are signed in as <b>{me.data?.user.name}</b> ({me.data?.user.email}). Everything you change is recorded as done by {imp.by?.email ?? 'you'}.
            <span className="opacity-80"> {left > 0 ? `Ends in ${left} min.` : 'This session has ended.'}{imp.reason ? ` Reason: ${imp.reason}` : ''}</span>
          </span>
          <button disabled={busy} onClick={async () => { setBusy(true); try { await returnToConsole(); } finally { setBusy(false); } }} className="inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1 text-[13px] font-bold text-red-800 hover:bg-red-50" data-testid="return-to-console">
            <ArrowLeftCircle className="h-4 w-4" aria-hidden />Return to console
          </button>
        </div>
      )}
      {maintenance && (
        <div className="flex items-center gap-2 bg-amber-100 px-4 py-2 text-sm text-amber-950 lg:px-8" role="status" data-testid="maintenance-banner">
          <Wrench className="h-4 w-4 shrink-0" aria-hidden /><span>{maintenance.message}</span>
        </div>
      )}
    </>
  );
}
