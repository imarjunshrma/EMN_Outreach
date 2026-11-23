'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ChevronUp, CircleHelp, Sparkles } from 'lucide-react';
import { useWsQuery } from '@/lib/hooks';
import { PAGE_HELP } from './page-help';

/**
 * "How this page works" above every workspace page: what the page is for and what to do, in order. Collapsible per
 * page (remembered in this browser). Pages that use AI also say which AI source is in use and where to change it.
 */
export function PageHelpPanel({ href, base }: { href: string; base: string }) {
  const help = PAGE_HELP[href];
  const key = `emn-help-${href || 'dashboard'}`;
  const [open, setOpen] = useState(true);
  useEffect(() => { try { setOpen(localStorage.getItem(key) !== 'hidden'); } catch { /* storage unavailable */ } }, [key]);
  const source = useWsQuery<{ mode: string; ready: boolean; problem: string | null; options: Array<{ mode: string; label: string }> }>(help?.ai && open ? '/ai/source' : null);
  if (!help) return null;
  const toggle = (v: boolean) => { setOpen(v); try { localStorage.setItem(key, v ? 'shown' : 'hidden'); } catch { /* ignore */ } };
  if (!open) {
    return <div className="mb-3 flex justify-end"><button type="button" onClick={() => toggle(true)} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-100 hover:text-ink dark:hover:bg-white/5 dark:hover:text-white" data-testid="page-help-open"><CircleHelp className="h-3.5 w-3.5" aria-hidden />How this page works</button></div>;
  }
  const label = source.data?.options.find((o) => o.mode === source.data!.mode)?.label;
  return (
    <section className="mb-5 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm dark:border-white/10" aria-label="How this page works" data-testid="page-help">
      <div className="flex items-start gap-3">
        <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-brand-600 dark:text-brand-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">{help.what}</p>
          <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-slate-600">{help.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          {help.ai && (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              <Sparkles className="h-3.5 w-3.5 text-brand-600 dark:text-brand-400" aria-hidden />
              {source.data
                ? source.data.ready ? <>AI on this page runs on <b className="text-ink">{label}</b>.</> : <>AI can’t run yet: {source.data.problem}</>
                : <>AI on this page uses the workspace AI source.</>}
              <Link className="font-semibold text-brand-700 underline dark:text-brand-300" href={`${base}/settings/ai`}>Change AI source</Link>
            </p>
          )}
        </div>
        <button type="button" onClick={() => toggle(false)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-ink dark:hover:bg-white/5 dark:hover:text-white" aria-label="Hide help for this page" title="Hide help for this page"><ChevronUp className="h-4 w-4" /></button>
      </div>
    </section>
  );
}
