'use client';
import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { api, describeError } from '@/lib/api';
import { Button, Field, Modal, Notice, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { usePlatform } from '@/components/platform/shell';

/** Secondary-button look for links. */
export const LINK_BTN = 'inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-ink-700 shadow-sm hover:border-slate-400 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200';
export const LINK_BTN_SM = LINK_BTN.replace('h-10', 'h-8').replace('px-4 text-sm', 'px-2.5 text-xs');

/**
 * "Log in as": opens a time-limited session as a customer user, with everything they can do.
 * Give `userId` for one person, or `orgId` for a tenant's owner (or `orgId` + `userId` for a member of that tenant).
 */
export function LoginAsButton({ userId, orgId, workspaceId, label, who, size = 'sm', variant = 'secondary' }: { userId?: string; orgId?: string; workspaceId?: string; label?: string; who: string; size?: 'sm' | 'md'; variant?: 'primary' | 'secondary' | 'ghost' }) {
  const me = usePlatform(); const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(''); const [minutes, setMinutes] = useState('30'); const [busy, setBusy] = useState(false);
  if (!me.permissions.includes('impersonate')) return null;
  async function go() {
    setBusy(true);
    try {
      const path = orgId ? `/platform/tenants/${orgId}/impersonate` : `/platform/users/${userId}/impersonate`;
      const r = await api<{ redirectTo: string }>(path, { body: { reason, minutes: Number(minutes), ...(orgId && userId ? { userId } : {}), ...(workspaceId ? { workspaceId } : {}) } });
      window.location.href = r.redirectTo;
    } catch (e) { toast.error(describeError(e)); setBusy(false); }
  }
  return (
    <>
      <Button size={size} variant={variant} icon={LogIn} onClick={() => setOpen(true)} data-testid="login-as">{label ?? 'Log in as'}</Button>
      <Modal open={open} title={`Log in as ${who}`} onClose={() => setOpen(false)}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Back</Button><Button icon={LogIn} loading={busy} disabled={reason.trim().length < 5} onClick={go}>Log in as {who}</Button></>}>
        <Notice kind="warning">You will see and do exactly what they can, including sending, editing and deleting. Every change is recorded under your name, and their organization’s audit log shows that staff signed in. Their password, two-factor and sessions stay locked.</Notice>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_160px]">
          <Field label="Reason" hint="Required; recorded in both audit trails."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Ticket #512, fixing their campaign schedule" /></Field>
          <Field label="Ends after"><Select value={minutes} onChange={(e) => setMinutes(e.target.value)} options={[['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour'], ['120', '2 hours'], ['240', '4 hours'], ['480', '8 hours']].map(([value, label]) => ({ value, label }))} /></Field>
        </div>
        <p className="text-xs text-slate-500">A red bar at the top lets you return to the console at any time. Signing out also brings you back here.</p>
      </Modal>
    </>
  );
}
