'use client';
import { useState } from 'react';
import { Copy } from 'lucide-react';
import { Button, Notice } from '@/components/ui';

export type SetupResult = { mailed: boolean; link: string | null } | null;

/**
 * After an admin creates an account or starts a reset: either "we emailed it" or, when system mail is not set up,
 * the single-use link shown once so the admin can pass it on.
 */
export function SetupLinkNotice({ setup, email }: { setup: SetupResult; email: string }) {
  const [copied, setCopied] = useState(false);
  if (!setup) return null;
  if (setup.mailed) return <Notice kind="success">We emailed {email} a link to choose a password. It works once and expires in 7 days.</Notice>;
  if (!setup.link) return null;
  return (
    <Notice kind="warning">
      <p>System email isn’t set up, so send this link to {email} yourself. It works once, expires in 7 days and won’t be shown again.</p>
      <div className="mt-2 flex gap-2">
        <input readOnly value={setup.link} className="input !py-1.5 font-mono text-xs" aria-label="Set-password link" onFocus={(e) => e.currentTarget.select()} data-testid="setup-link" />
        <Button size="sm" variant="secondary" icon={Copy} onClick={async () => { try { await navigator.clipboard.writeText(setup.link!); setCopied(true); } catch { /* the field is selectable */ } }}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
    </Notice>
  );
}
