'use client';
import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useWs, useWsMutation, useWsQuery } from '@/lib/hooks';
import { Badge, Button, Card, Checkbox, Notice } from '@/components/ui';

type Mode = 'api' | 'claude_subscription' | 'codex_subscription';
type Source = {
  mode: Mode; fallbackToApi: boolean; owner: { name: string; email: string } | null; ready: boolean; problem: string | null; apiProviders: number;
  options: Array<{ mode: Mode; label: string; available: boolean; reason: string | null }>;
};

const WHAT: Record<Mode, string> = {
  api: 'Uses the API keys below (Anthropic, OpenAI and others). Billed per use by that provider.',
  claude_subscription: 'Uses your connected Claude subscription. No API bill; slower, and limited by your plan’s usage limits.',
  codex_subscription: 'Uses your connected ChatGPT / Codex subscription. No API bill; slower, and limited by your plan’s usage limits.',
};

/**
 * One switch for where AI runs in this workspace. Every AI feature follows it: Copilot, research, campaign
 * personalization, reply suggestions, fact-checks and AI Studio. Campaigns can override it on their AI tab.
 */
export function AiSourceCard() {
  const ws = useWs();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ workspaces: Array<{ id: string; role: string }> }>('/auth/me') });
  const canEdit = ['OWNER', 'ADMIN'].includes(me.data?.workspaces.find((w) => w.id === ws)?.role ?? '');
  const q = useWsQuery<Source>('/ai/source');
  const [mode, setMode] = useState<Mode>('api');
  const [fallback, setFallback] = useState(false);
  useEffect(() => { if (q.data) { setMode(q.data.mode); setFallback(q.data.fallbackToApi); } }, [q.data]);
  const save = useWsMutation(() => ({ path: '/ai/source', method: 'PUT', body: { mode, fallbackToApi: fallback } }), { success: 'AI source saved. Every AI feature now uses it.', invalidate: true });
  if (!q.data) return null;
  const d = q.data;
  const changed = mode !== d.mode || fallback !== d.fallbackToApi;
  return (
    <Card title="AI source: where AI runs" className="mb-5">
      <p className="mb-4 text-sm text-slate-600">Choose once; Copilot, research, campaign personalization, reply suggestions, fact-checks and AI Studio all use it. A campaign can pick a different source on its AI tab.</p>
      <div className="grid gap-3 md:grid-cols-3" role="radiogroup" aria-label="AI source">
        {d.options.map((o) => {
          const selected = mode === o.mode;
          const disabled = !canEdit || (!o.available && o.mode !== 'api');
          return (
            <button key={o.mode} type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={() => setMode(o.mode)} data-testid={`ai-source-${o.mode}`}
              className={`rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${selected ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/15' : 'border-slate-200 hover:border-slate-300 dark:border-white/10'}`}>
              <span className="flex items-center justify-between gap-2"><span className="font-semibold text-ink">{o.label}</span>{d.mode === o.mode && <Badge color={d.ready ? 'green' : 'yellow'}>in use</Badge>}</span>
              <span className="mt-1 block text-xs text-slate-500">{WHAT[o.mode]}</span>
              {!o.available && o.reason && <span className="mt-2 block text-xs text-amber-700 dark:text-amber-300">{o.reason}</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex items-start gap-2 text-sm">
        {d.ready ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />}
        <span data-testid="ai-source-status">{d.ready
          ? <>AI runs on <b>{d.options.find((o) => o.mode === d.mode)?.label}</b>{d.owner ? <> using {d.owner.name}’s login ({d.owner.email})</> : null}.</>
          : <>AI can’t run yet: {d.problem}</>}</span>
      </div>
      {mode !== 'api' && <div className="mt-3"><Checkbox label="If the subscription is unavailable, use the API keys instead" hint="Off by default, so nothing is ever billed to an API key without your say-so." checked={fallback} onChange={setFallback} /></div>}
      {mode !== 'api' && <div className="mt-3"><Notice>Subscriptions are personal logins: choosing one uses <b>your</b> Claude or Codex account for this workspace’s AI work. Keep it for your own private install.</Notice></div>}
      {canEdit ? <div className="mt-4"><Button disabled={!changed} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save AI source</Button></div> : <p className="mt-4 text-xs text-slate-500">Only workspace admins can change the AI source.</p>}
    </Card>
  );
}
