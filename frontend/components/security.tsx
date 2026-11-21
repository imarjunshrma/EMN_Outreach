'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, describeError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, Field, Input, Notice } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useTheme, type Theme } from '@/lib/theme';

/** Two-factor (TOTP) setup, recovery codes and disable — on the My account page. */
export function MfaCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['mfa'], queryFn: () => api<{ enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number }>('/auth/mfa') });
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disable, setDisable] = useState({ password: '', code: '' });
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { toast.error(describeError(e)); } finally { setBusy(false); } };
  const s = status.data;
  return (
    <Card title={<>Two-factor authentication {s && (s.enabled ? <Badge color="green">on</Badge> : <Badge color="yellow">off</Badge>)}</>}>
      {codes && (
        <div className="mb-3" data-testid="recovery-codes">
          <Notice kind="warning"><b>Save these recovery codes now.</b> Each works once if you lose your phone. They will not be shown again.
            <pre className="mt-2 grid grid-cols-2 gap-1 rounded bg-white p-2 font-mono text-xs">{codes.join('\n')}</pre>
            <Button variant="secondary" className="mt-2" onClick={() => void navigator.clipboard.writeText(codes.join('\n'))}>Copy</Button> <Button variant="ghost" onClick={() => setCodes(null)}>I saved them</Button>
          </Notice>
        </div>
      )}
      {!s ? null : s.enabled ? (
        <>
          <p className="text-sm text-slate-600">Enabled {fmtDate(s.enabledAt)} · {s.recoveryCodesLeft} recovery codes left.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Field label="Password"><Input type="password" value={disable.password} onChange={(e) => setDisable({ ...disable, password: e.target.value })} /></Field>
            <Field label="Code or recovery code"><Input value={disable.code} onChange={(e) => setDisable({ ...disable, code: e.target.value })} /></Field>
          </div>
          <Button variant="danger" className="mt-2" loading={busy} disabled={!disable.password || !disable.code} onClick={() => run(async () => { await api('/auth/mfa/disable', { body: { password: disable.password, code: disable.code.trim() } }); setDisable({ password: '', code: '' }); toast.success('Two-factor disabled'); void qc.invalidateQueries({ queryKey: ['mfa'] }); })}>Turn off two-factor</Button>
        </>
      ) : setup ? (
        <>
          <p className="text-sm">Scan this QR code with Google Authenticator, Microsoft Authenticator, 1Password or any TOTP app, then enter the 6-digit code.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qrDataUrl} alt="Authenticator QR code" className="my-3 h-44 w-44 rounded bg-white p-1" />
          <p className="text-xs text-slate-500">Can’t scan? Enter this key manually: <code className="break-all">{setup.secret}</code></p>
          <div className="mt-3 flex gap-2"><Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" /><Button loading={busy} disabled={code.length !== 6} onClick={() => run(async () => { const r = await api<{ recoveryCodes: string[] }>('/auth/mfa/enable', { body: { code } }); setCodes(r.recoveryCodes); setSetup(null); setCode(''); toast.success('Two-factor enabled'); void qc.invalidateQueries({ queryKey: ['mfa'] }); })}>Confirm</Button></div>
        </>
      ) : (
        <>
          <p className="text-sm text-slate-600">Protect your account with a code from an authenticator app at every sign-in.</p>
          <Button className="mt-3" loading={busy} onClick={() => run(async () => setSetup(await api('/auth/mfa/setup', { method: 'POST' })))}>Set up two-factor</Button>
        </>
      )}
    </Card>
  );
}

export function AppearanceCard() {
  const [theme, set] = useTheme();
  return (
    <Card title="Appearance">
      <div className="flex gap-2">{(['light', 'dark', 'system'] as Theme[]).map((t) => <Button key={t} variant={theme === t ? 'primary' : 'secondary'} onClick={() => set(t)}>{t === 'system' ? 'Follow system' : t[0].toUpperCase() + t.slice(1)}</Button>)}</div>
      <p className="mt-2 text-xs text-slate-500">Saved in this browser.</p>
    </Card>
  );
}
