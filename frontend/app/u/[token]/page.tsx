'use client';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { api, describeError } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { Button, Notice } from '@/components/ui';

// Public unsubscribe confirmation page (linked in every email footer).
export default function Unsubscribe() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  async function go() {
    setState('busy');
    try { const r = await api<{ sender: string }>(`/public/unsubscribe/${token}`, { method: 'POST' }); setMsg(r.sender); setState('done'); }
    catch (e) { setMsg(describeError(e)); setState('error'); }
  }
  return (
    <AuthShell title="Unsubscribe">
      {state === 'done' ? <Notice>You have been unsubscribed{msg ? ` from emails sent by ${msg}` : ''}. You will not receive further outreach emails.</Notice>
        : state === 'error' ? <Notice kind="danger">{msg}</Notice>
        : <div className="space-y-4"><p className="text-sm text-slate-600">Click below to stop receiving emails from this sender.</p><Button onClick={go} loading={state === 'busy'} className="w-full">Unsubscribe me</Button></div>}
    </AuthShell>
  );
}
