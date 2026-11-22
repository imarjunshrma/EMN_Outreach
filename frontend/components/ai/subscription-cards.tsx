'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, Card, Checkbox, ConfirmButton, Field, Input, Notice } from '@/components/ui';
import { fmtWhen, useCopy, useOwnerMutation, useOwnerQuery } from './hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Conn = {
  provider: 'CLAUDE_SUBSCRIPTION' | 'CODEX_SUBSCRIPTION'; status: string; configured: boolean; credentialHint?: string | null; accountLabel?: string | null;
  model?: string | null; concurrency?: number; delayMs?: number; paused?: boolean; connectedAt?: string | null; expiresAt?: string | null; expiringSoon?: boolean;
  lastTestedAt?: string | null; lastTestOk?: boolean | null; serverCodexHome?: string; lastError?: string | null; limitResetsAt?: string | null; limitType?: string | null; utilization?: number | null; lastUsedAt?: string | null;
};

const STATUS_TEXT: Record<string, string> = {
  CONNECTED: 'Connected', DISCONNECTED: 'Not connected', CONNECTING: 'Connecting…', EXPIRED: 'Sign-in expired', USAGE_LIMITED: 'Usage limit reached', ERROR: 'Needs attention',
};
const STATUS_COLOR: Record<string, 'green' | 'gray' | 'blue' | 'red' | 'yellow'> = { CONNECTED: 'green', DISCONNECTED: 'gray', CONNECTING: 'blue', EXPIRED: 'red', USAGE_LIMITED: 'yellow', ERROR: 'red' };

export function SubscriptionCards() {
  const q = useOwnerQuery<{ connections: Conn[] }>('/ai-subscriptions/connections', { refetchInterval: 30_000 });
  const claude = q.data?.connections.find((c) => c.provider === 'CLAUDE_SUBSCRIPTION');
  const codex = q.data?.connections.find((c) => c.provider === 'CODEX_SUBSCRIPTION');
  return (
    <section aria-labelledby="my-subs" className="mb-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="my-subs" className="text-base font-semibold text-ink">My subscriptions</h2>
        <p className="text-xs text-ink-500">Only you can see these. They are never used automatically as a fallback for paid API keys.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {claude && <ClaudeCard c={claude} />}
        {codex && <CodexCard c={codex} />}
      </div>
    </section>
  );
}

function StatusLine({ c }: { c: Conn }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {c.accountLabel && <><dt className="text-ink-500">Signed in with</dt><dd>{c.accountLabel}{c.credentialHint ? <span className="ml-1 font-mono text-xs text-ink-500">{c.credentialHint}</span> : null}</dd></>}
      {c.connectedAt && <><dt className="text-ink-500">Connected</dt><dd>{fmtWhen(c.connectedAt)}</dd></>}
      {c.expiresAt && <><dt className="text-ink-500">Token valid until</dt><dd>{fmtWhen(c.expiresAt)} <span className="text-xs text-ink-500">(one-year token; checked on every use)</span></dd></>}
      {c.lastTestedAt && <><dt className="text-ink-500">Last test</dt><dd>{fmtWhen(c.lastTestedAt)} — {c.lastTestOk ? 'passed' : 'failed'}</dd></>}
      {c.lastUsedAt && <><dt className="text-ink-500">Last used</dt><dd>{fmtWhen(c.lastUsedAt)}</dd></>}
      <dt className="text-ink-500">Usage</dt>
      <dd>
        {c.utilization != null ? <UsageBar value={c.utilization} /> : <span className="text-ink-500">Shown when the provider reports it</span>}
        {c.limitType && <span className="ml-2 text-xs text-ink-500">{c.limitType.replace(/_/g, ' ')} window</span>}
        {c.limitResetsAt && <div className="text-xs text-ink-500">Resets {fmtWhen(c.limitResetsAt)}</div>}
      </dd>
    </dl>
  );
}

function UsageBar({ value }: { value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span className="inline-flex items-center gap-2 align-middle">
      <span className="h-1.5 w-28 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Subscription usage in the current window">
        <span className={`block h-full rounded-full ${pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-brand-500'}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-xs tabular-nums">{pct}%</span>
    </span>
  );
}

function Header({ title, c }: { title: string; c: Conn }) {
  return <>{title} <Badge color={STATUS_COLOR[c.status] ?? 'gray'}>{STATUS_TEXT[c.status] ?? c.status}</Badge>{c.paused ? <Badge color="yellow">Paused</Badge> : null}</>;
}

function ConnectionSettings({ c }: { c: Conn }) {
  const [f, setF] = useState({ model: c.model ?? '', concurrency: c.concurrency ?? 1, delaySec: Math.round((c.delayMs ?? 3000) / 1000), paused: !!c.paused });
  useEffect(() => { setF({ model: c.model ?? '', concurrency: c.concurrency ?? 1, delaySec: Math.round((c.delayMs ?? 3000) / 1000), paused: !!c.paused }); }, [c.model, c.concurrency, c.delayMs, c.paused]);
  const save = useOwnerMutation(() => ({ path: `/ai-subscriptions/${c.provider}/settings`, method: 'PUT', body: { model: f.model || null, concurrency: f.concurrency, delayMs: f.delaySec * 1000, paused: f.paused } }), { success: 'Settings saved' });
  return (
    <details className="mt-4 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <summary className="cursor-pointer text-sm font-semibold">Queue and model settings</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Model (optional)" hint="Leave empty for the subscription default."><Input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder="Default" /></Field>
        <Field label="Parallel jobs" hint="1 is safest for subscriptions."><Input type="number" min={1} max={4} value={f.concurrency} onChange={(e) => setF({ ...f, concurrency: Math.max(1, Math.min(4, Number(e.target.value) || 1)) })} /></Field>
        <Field label="Seconds between jobs"><Input type="number" min={0} max={600} value={f.delaySec} onChange={(e) => setF({ ...f, delaySec: Math.max(0, Math.min(600, Number(e.target.value) || 0)) })} /></Field>
      </div>
      <Checkbox label="Pause this provider" hint="Stages that need it wait; nothing is moved to another provider." checked={f.paused} onChange={(v) => setF({ ...f, paused: v })} />
      <Button className="mt-3" size="sm" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save settings</Button>
    </details>
  );
}

function Actions({ c, onReconnect }: { c: Conn; onReconnect: () => void }) {
  const test = useOwnerMutation(() => ({ path: `/ai-subscriptions/${c.provider}/test` }), { success: (r: any) => (r.ok ? 'Connection works' : `Test failed: ${r.error}`) });
  const disconnect = useOwnerMutation(() => ({ path: `/ai-subscriptions/${c.provider}`, method: 'DELETE' }), { success: 'Disconnected' });
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <Button variant="secondary" loading={test.isPending} onClick={() => test.mutate(undefined)}>Test connection</Button>
      <Button variant="secondary" onClick={onReconnect}>Reconnect</Button>
      <ConfirmButton variant="ghost" confirm="Disconnect? Running workflows that need it will pause." onConfirm={() => disconnect.mutate(undefined)}>Disconnect</ConfirmButton>
    </div>
  );
}

function ClaudeCard({ c }: { c: Conn }) {
  const [showForm, setShowForm] = useState(false);
  const [token, setToken] = useState('');
  const copy = useCopy();
  const connect = useOwnerMutation(() => ({ path: '/ai-subscriptions/claude/connect', body: { token } }), {
    success: (r: any) => (r.test?.ok ? 'Claude connected' : `Saved, but the test failed: ${r.test?.error ?? 'unknown error'}`),
    onSuccess: () => { setToken(''); setShowForm(false); },
  });
  const needsForm = showForm || !c.configured || c.status === 'DISCONNECTED' || c.status === 'EXPIRED';
  return (
    <Card title={<Header title="Claude — My Subscription" c={c} />}>
      {c.status === 'EXPIRED' && <Notice kind="danger">Claude rejected the stored token (expired or revoked). Create a new one with <code>claude setup-token</code> and paste it below.</Notice>}
      {c.status === 'USAGE_LIMITED' && <Notice kind="warning">Claude usage limit reached. Workflows that need Claude are paused{c.limitResetsAt ? ` until about ${fmtWhen(c.limitResetsAt)}` : ''}.</Notice>}
      {c.expiringSoon && c.status === 'CONNECTED' && <Notice kind="warning">This token expires soon. Create a new one and reconnect.</Notice>}
      {c.lastError && c.status === 'ERROR' && <Notice kind="danger">{c.lastError}</Notice>}
      {c.configured && c.status !== 'DISCONNECTED' && <StatusLine c={c} />}
      {needsForm && (
        <div className="mt-3">
          <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-ink-600 dark:text-slate-300">
            <li>On a computer with a browser and Claude Code installed, run <button type="button" className="rounded bg-slate-100 px-1.5 font-mono text-xs hover:bg-slate-200 dark:bg-slate-800" onClick={() => copy('claude setup-token', 'Command copied')}>claude setup-token</button>.</li>
            <li>Approve access in the browser with the Claude account that has your subscription.</li>
            <li>Copy the token it prints (it starts with <code>sk-ant-oat</code>) and paste it here. It is encrypted on the server and never shown again.</li>
          </ol>
          <Field label="Subscription token"><Input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="sk-ant-oat01-…" /></Field>
          <div className="flex gap-2">
            <Button disabled={token.trim().length < 20} loading={connect.isPending} onClick={() => connect.mutate(undefined)}>{c.configured && c.status !== 'DISCONNECTED' ? 'Replace token' : 'Connect Claude'}</Button>
            {showForm && <Button variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>}
          </div>
          <p className="mt-2 text-xs text-ink-500">Connecting runs one tiny test request on your subscription. API keys (sk-ant-api…) are not accepted here — add those under API providers.</p>
        </div>
      )}
      {c.configured && c.status !== 'DISCONNECTED' && !needsForm && <Actions c={c} onReconnect={() => setShowForm(true)} />}
      {c.configured && c.status !== 'DISCONNECTED' && <ConnectionSettings c={c} />}
    </Card>
  );
}

type LoginState = { state: 'STARTING' } | { state: 'PENDING'; verificationUrl: string; userCode: string; expiresAt: string } | { state: 'SUCCEEDED' } | { state: 'FAILED'; error: string } | null;

function CodexCard({ c }: { c: Conn }) {
  const [polling, setPolling] = useState(c.status === 'CONNECTING');
  const copy = useCopy();
  const login = useOwnerQuery<{ login: LoginState; connection: Conn }>(polling ? '/ai-subscriptions/codex/login' : null, { refetchInterval: polling ? 3000 : false });
  const start = useOwnerMutation(() => ({ path: '/ai-subscriptions/codex/login' }), { onSuccess: () => setPolling(true) });
  const cancel = useOwnerMutation(() => ({ path: '/ai-subscriptions/codex/login', method: 'DELETE' }), { onSuccess: () => setPolling(false) });
  const st = login.data?.login ?? null;
  useEffect(() => { if (st && (st.state === 'SUCCEEDED' || st.state === 'FAILED')) setPolling(false); }, [st]);
  const connected = c.configured && !['DISCONNECTED', 'CONNECTING'].includes(c.status);
  const [reconnect, setReconnect] = useState(false);
  return (
    <Card title={<Header title="Codex — My ChatGPT Subscription" c={c} />}>
      {c.status === 'EXPIRED' && <Notice kind="danger">Codex is no longer signed in to ChatGPT. Reconnect to continue.</Notice>}
      {c.status === 'USAGE_LIMITED' && <Notice kind="warning">Codex usage limit reached. Workflows that need Codex are paused{c.limitResetsAt ? ` until about ${fmtWhen(c.limitResetsAt)}` : ''}.</Notice>}
      {c.lastError && (c.status === 'ERROR' || c.status === 'DISCONNECTED') && <Notice kind="danger">{c.lastError}</Notice>}
      {connected && <StatusLine c={c} />}
      {(!connected || reconnect) && (
        <div className="mt-3">
          {polling && st?.state === 'PENDING' ? (
            <div className="rounded-lg border border-brand-200 bg-brand-50/60 p-4 dark:border-brand-800 dark:bg-brand-950/30">
              <p className="text-sm font-semibold">Finish signing in with ChatGPT</p>
              <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm">
                <li>Open <a className="font-medium text-brand-700 underline dark:text-brand-300" href={st.verificationUrl} target="_blank" rel="noreferrer noopener">{st.verificationUrl}</a> and sign in to the ChatGPT account that has your subscription.</li>
                <li>Enter this one-time code:
                  <div className="mt-1 flex items-center gap-2"><span className="rounded-md bg-white px-3 py-1.5 font-mono text-lg font-bold tracking-widest text-ink ring-1 ring-brand-200 dark:bg-slate-900 dark:text-slate-100">{st.userCode}</span><Button size="sm" variant="secondary" onClick={() => copy(st.userCode, 'Code copied')}>Copy</Button></div>
                </li>
              </ol>
              <p className="mt-2 text-xs text-ink-500" aria-live="polite">Waiting for you to finish… The code expires {fmtWhen(st.expiresAt)}.</p>
              <Button className="mt-2" size="sm" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(undefined)}>Cancel sign-in</Button>
            </div>
          ) : (
            <>
              <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-ink-600 dark:text-slate-300">
                <li>Turn on device code sign-in in your ChatGPT security settings (needed once).</li>
                <li>Press Connect. The server starts the official <code>codex login --device-auth</code> and shows you a link and a code.</li>
                <li>Codex keeps the sign-in on the server and refreshes it itself.</li>
              </ol>
              {st?.state === 'FAILED' && <Notice kind="danger">{st.error}</Notice>}
              <div className="flex gap-2">
                <Button loading={start.isPending || (polling && (!st || st.state === 'STARTING'))} onClick={() => start.mutate(undefined)}>{connected ? 'Sign in again' : 'Connect Codex'}</Button>
                {reconnect && <Button variant="ghost" onClick={() => setReconnect(false)}>Cancel</Button>}
              </div>
              {c.serverCodexHome && (
                <details className="mt-3 text-xs text-ink-500">
                  <summary className="cursor-pointer">Can&apos;t use device sign-in here? Sign in from the server shell</summary>
                  <p className="mt-1">Run this on the server as the app user, then press Test connection:</p>
                  <pre className="mt-1 overflow-x-auto rounded bg-slate-100 p-2 font-mono text-[11px] text-ink dark:bg-slate-800 dark:text-slate-100">{`sudo -u emn env CODEX_HOME=${c.serverCodexHome} HOME=${c.serverCodexHome.replace(/\/\.codex$/, '')} codex login --device-auth`}</pre>
                  <Button className="mt-1" size="sm" variant="ghost" onClick={() => copy(`sudo -u emn env CODEX_HOME=${c.serverCodexHome} HOME=${(c.serverCodexHome ?? '').replace(/\/\.codex$/, '')} codex login --device-auth`, 'Command copied')}>Copy command</Button>
                </details>
              )}
            </>
          )}
        </div>
      )}
      {connected && !reconnect && <Actions c={c} onReconnect={() => setReconnect(true)} />}
      {connected && <ConnectionSettings c={c} />}
    </Card>
  );
}
