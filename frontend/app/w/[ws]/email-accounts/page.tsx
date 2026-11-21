'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Card, Checkbox, ConfirmButton, Empty, Field, Input, Modal, Notice, PageHeader, QueryView, Table, TimezoneSelect } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const DAYS = [1, 2, 3, 4, 5, 6, 7];

function Mailboxes() {
  const params = useSearchParams();
  const q = useWsQuery<any[]>('/email-accounts', { refetchInterval: 30_000 });
  const [smtp, setSmtp] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const oauth = useWsMutation<'google' | 'microsoft', { url: string }>((p) => ({ path: `/email-accounts/oauth/${p}`, body: {} }), { invalidate: false, onSuccess: (r) => { window.location.href = r.url; } });
  const act = useWsMutation<{ id: string; a: string }>((b) => ({ path: `/email-accounts/${b.id}/${b.a}`, body: {} }), { success: (r: any) => (r?.ok === false ? `Test failed: ${r.error}` : r?.ok ? 'Connection OK' : 'Done') });
  const diagnostic = useWsMutation<string, { acceptedByProvider: boolean; note: string }>((id) => ({ path: `/email-accounts/${id}/delivery-diagnostic`, body: {} }), { success: (r) => r.note });
  const disconnect = useWsMutation<string>((id) => ({ path: `/email-accounts/${id}`, method: 'DELETE' }), { success: 'Disconnected' });
  return (
    <>
      <PageHeader title="Mailboxes" subtitle="Connect the authorised mailboxes you send from. Each prospect is assigned one mailbox and keeps it; there is no rotation or warm-up network."
        actions={<><Button loading={oauth.isPending} onClick={() => oauth.mutate('google')}>Connect Google Workspace</Button><Button loading={oauth.isPending} onClick={() => oauth.mutate('microsoft')}>Connect Microsoft 365</Button><Button variant="secondary" onClick={() => setSmtp(true)}>SMTP / IMAP</Button></>} />
      {params.get('connected') && <div className="mb-4"><Notice>Connected {params.get('connected')}. The first sync runs in the background.</Notice></div>}
      <div className="mb-4"><Notice kind="warning">Daily limits are your own policy within each provider’s published maximum. No fixed number is “safe”: start low, keep bounce rates under ~2%, and increase only if replies and bounces stay healthy. Warm-up does not guarantee inbox placement.</Notice></div>
      <QueryView q={q} isEmpty={(d) => d.length === 0} empty={<Empty title="No mailboxes connected">Connect Google Workspace or Microsoft 365 with OAuth. Reseller-provisioned mailboxes work only if their tenant admin allows third-party OAuth apps (see INSTALLATION.md).</Empty>}>
        {(rows) => (
          <div className="card p-2">
            <Table head={['Mailbox', 'Provider / connection', 'Status', 'Today', 'Last 30 days', 'Domain', 'Last sync', '']}>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="td"><b>{a.emailAddress}</b><div className="text-xs text-slate-500">{a.displayName}</div>{a.lastError && <div className="max-w-xs text-xs text-red-600">{a.lastError}</div>}</td>
                  <td className="td text-sm">{a.provider}{a.provider === 'SMTP_IMAP' && <div className="mt-1 flex gap-1 text-xs"><Badge color={a.connectionHealth?.smtp?.ok ? 'green' : a.connectionHealth?.smtp ? 'red' : 'gray'}>SMTP {a.connectionHealth?.smtp?.ok ? 'OK' : a.connectionHealth?.smtp ? 'Error' : '—'}</Badge><Badge color={a.connectionHealth?.imap?.ok ? 'green' : a.connectionHealth?.imap ? 'red' : 'gray'}>IMAP {a.connectionHealth?.imap?.ok ? 'OK' : a.connectionHealth?.imap ? 'Error' : '—'}</Badge></div>}</td>
                  <td className="td"><Badge>{a.status}</Badge>{a.statusReason && <div className="max-w-xs text-xs text-slate-500">{a.statusReason}</div>}</td>
                  <td className="td text-sm">{a.sentToday} / {a.dailySendLimit}</td>
                  <td className="td text-xs">{a.sent30d} sent · {a.bounces30d} bounces{a.bounceRate30d !== null && ` (${(a.bounceRate30d * 100).toFixed(1)}%)`}</td>
                  <td className="td">{a.domain ? <Badge>{a.domain.healthStatus}</Badge> : '—'}</td>
                  <td className="td text-xs">{fmtDate(a.lastSyncedAt)}</td>
                  <td className="td space-x-1 whitespace-nowrap text-right">
                    <Button variant="ghost" onClick={() => setEdit(a)}>Settings</Button>
                    <Button variant="ghost" onClick={() => act.mutate({ id: a.id, a: 'test' })}>Test connection</Button>
                    {a.status === 'CONNECTED' && <ConfirmButton variant="ghost" confirm={`Send one clearly labeled diagnostic email from ${a.emailAddress} back to the same mailbox? It will not contact a prospect or generate a reply.`} onConfirm={() => diagnostic.mutate(a.id)}>Send self-test</ConfirmButton>}
                    <Button variant="ghost" onClick={() => act.mutate({ id: a.id, a: 'resync' })}>Resync</Button>
                    {a.status === 'PAUSED' ? <Button variant="ghost" onClick={() => act.mutate({ id: a.id, a: 'resume' })}>Resume</Button> : a.status === 'CONNECTED' && <Button variant="ghost" onClick={() => act.mutate({ id: a.id, a: 'pause' })}>Pause</Button>}
                    {['NEEDS_REAUTH', 'DISCONNECTED'].includes(a.status) && a.provider !== 'SMTP_IMAP' && <Button variant="secondary" onClick={() => oauth.mutate(a.provider === 'GMAIL' ? 'google' : 'microsoft')}>Reconnect</Button>}
                    {a.status !== 'DISCONNECTED' && <ConfirmButton variant="ghost" confirm="Disconnect this mailbox? Its active sequences will pause." onConfirm={() => disconnect.mutate(a.id)}>Disconnect</ConfirmButton>}
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </QueryView>
      {smtp && <SmtpModal onClose={() => setSmtp(false)} />}
      {edit && <EditModal account={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function EditModal({ account, onClose }: { account: any; onClose: () => void }) {
  const [f, setF] = useState({ displayName: account.displayName ?? '', replyTo: account.replyTo ?? '', signatureText: account.signatureText ?? '', dailySendLimit: account.dailySendLimit, minSecondsBetweenSends: account.minSecondsBetweenSends, sendingWindow: { enabled: false, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', timezone: 'UTC', ...(account.sendingWindow ?? {}) } });
  const save = useWsMutation(() => ({ path: `/email-accounts/${account.id}`, method: 'PATCH', body: { ...f, displayName: f.displayName || null, replyTo: f.replyTo || null, signatureText: f.signatureText || null } }), { success: 'Saved', onSuccess: onClose });
  const w = f.sendingWindow;
  return (
    <Modal open wide title={`Sender settings — ${account.emailAddress}`} onClose={onClose} footer={<Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Sender name"><Input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field>
        <Field label="Reply-to (optional)"><Input value={f.replyTo} onChange={(e) => setF({ ...f, replyTo: e.target.value })} /></Field>
        <Field label="Daily send limit (this mailbox)"><Input type="number" min={1} value={f.dailySendLimit} onChange={(e) => setF({ ...f, dailySendLimit: Number(e.target.value) })} /></Field>
        <Field label="Minimum seconds between sends"><Input type="number" min={30} value={f.minSecondsBetweenSends} onChange={(e) => setF({ ...f, minSecondsBetweenSends: Number(e.target.value) })} /></Field>
        <div className="md:col-span-2"><Field label="Signature (plain text)"><textarea className="input" rows={3} value={f.signatureText} onChange={(e) => setF({ ...f, signatureText: e.target.value })} /></Field></div>
      </div>
      <div className="mt-3 rounded border border-slate-200 p-3">
        <Checkbox label="Restrict this mailbox to its own sending hours (in addition to each campaign’s recipient-time window)" checked={w.enabled} onChange={(v) => setF({ ...f, sendingWindow: { ...w, enabled: v } })} />
        {w.enabled && <div className="mt-2 grid gap-2 md:grid-cols-4">
          <Field label="Days">{DAYS.map((d) => <label key={d} className="mr-2 text-xs"><input type="checkbox" checked={w.days.includes(d)} onChange={(e) => setF({ ...f, sendingWindow: { ...w, days: e.target.checked ? [...w.days, d].sort() : w.days.filter((x: number) => x !== d) } })} /> {['', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'][d]}</label>)}</Field>
          <Field label="From"><Input type="time" value={w.start} onChange={(e) => setF({ ...f, sendingWindow: { ...w, start: e.target.value } })} /></Field>
          <Field label="To"><Input type="time" value={w.end} onChange={(e) => setF({ ...f, sendingWindow: { ...w, end: e.target.value } })} /></Field>
          <Field label="Time zone"><TimezoneSelect value={w.timezone} onChange={(e) => setF({ ...f, sendingWindow: { ...w, timezone: e.target.value } })} /></Field>
        </div>}
      </div>
    </Modal>
  );
}

function SmtpModal({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ emailAddress: '', displayName: '', smtpUsername: '', smtpPassword: '', smtpHost: '', smtpPort: 465, smtpSecure: true, imapUsername: '', imapPassword: '', imapHost: '', imapPort: 993, imapSecure: true, sentFolder: 'Sent', appendToSent: false });
  const m = useWsMutation(() => ({ path: '/email-accounts/smtp', body: f }), { success: 'Mailbox connected', onSuccess: onClose });
  const t = (k: keyof typeof f, label: string, type = 'text') => <Field label={label}><Input type={type} value={String(f[k])} onChange={(e) => setF({ ...f, [k]: type === 'number' ? Number(e.target.value) : e.target.value })} /></Field>;
  return (
    <Modal open wide title="Connect via SMTP / IMAP" onClose={onClose} footer={<Button loading={m.isPending} onClick={() => m.mutate()}>Test & connect</Button>}>
      <Notice kind="warning">Use only where your mailbox provider permits SMTP/IMAP with an app password (for example Zoho, Fastmail or a self-hosted server). Google and Microsoft accounts should use OAuth.</Notice>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {t('emailAddress', 'Email address')}{t('displayName', 'Sender name')}{t('smtpHost', 'SMTP host')}{t('smtpPort', 'SMTP port', 'number')}
        {t('smtpUsername', 'SMTP username')}{t('smtpPassword', 'SMTP password / app password', 'password')}
        {t('imapHost', 'IMAP host')}{t('imapPort', 'IMAP port', 'number')}{t('imapUsername', 'IMAP username')}{t('imapPassword', 'IMAP password / app password', 'password')}{t('sentFolder', 'Sent folder name')}
        <div className="space-y-2 pt-5"><Checkbox label="SMTP uses TLS (port 465)" checked={f.smtpSecure} onChange={(v) => setF({ ...f, smtpSecure: v })} /><Checkbox label="IMAP uses TLS" checked={f.imapSecure} onChange={(v) => setF({ ...f, imapSecure: v })} /><Checkbox label="Save a copy to the Sent folder (if the server does not)" checked={f.appendToSent} onChange={(v) => setF({ ...f, appendToSent: v })} /></div>
      </div>
    </Modal>
  );
}

export default function Page() { return <Suspense><Mailboxes /></Suspense>; }
