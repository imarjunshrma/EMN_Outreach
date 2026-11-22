'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Loading } from '@/components/ui';

type Me = { user: { platformRole?: string | null }; workspaces: Array<{ id: string; organizationId: string }> };

/**
 * Entry point after sign-in: setup on a fresh install; platform staff go to the platform console; everyone else to
 * the last workspace used (new sign-ups go to onboarding directly). `/app?to=workspace` skips the console for staff.
 */
export default function AppEntry() {
  const router = useRouter();
  useEffect(() => {
    (async () => {
      const boot = await api<{ needsSetup: boolean }>('/auth/bootstrap').catch(() => ({ needsSetup: false }));
      if (boot.needsSetup) return router.replace('/setup');
      let me: Me;
      try { me = await api<Me>('/auth/me'); } catch { return router.replace('/login?next=/app'); }
      const wantsWorkspace = new URLSearchParams(window.location.search).get('to') === 'workspace';
      if (me.user?.platformRole && !wantsWorkspace) return router.replace('/platform');
      let last: string | null = null;
      try { last = localStorage.getItem('emn-last-ws'); } catch { /* ignore */ }
      const ws = me.workspaces.find((w) => w.id === last) ?? me.workspaces[0];
      if (!ws) return router.replace('/select-workspace');
      router.replace(`/w/${ws.id}`);
    })();
  }, [router]);
  return <Loading label="Opening EMN Outreach OS…" />;
}
