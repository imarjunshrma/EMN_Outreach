'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Circle, RotateCcw } from 'lucide-react';
import { api, describeError } from '@/lib/api';
import { Logo } from '@/components/site/site-shell';
import { Button, ErrorState, Loading } from '@/components/ui';
import { useToast } from '@/components/toast';

type Step = { id: string; label: string; optional: boolean; done: boolean; skipped: boolean };
type Status = { steps: Step[]; complete: boolean; firstWorkspaceId: string | null; details: Record<string, number> };

const HELP: Record<string, { what: string; path: string; cta: string }> = {
  organization: { what: 'Your sender name and postal address. Most anti-spam laws require the address in every email.', path: '/settings/general', cta: 'Add workspace details' },
  business: { what: 'What you sell, who it is for and the proof points the AI may use. Without it, drafts stay generic.', path: '/ai-studio/knowledge', cta: 'Write business knowledge' },
  team: { what: 'Invite the people who will review drafts and handle replies.', path: '/settings/team', cta: 'Invite teammates' },
  ai: { what: 'Connect your OpenAI or Anthropic key for research and writing. You pay the provider directly.', path: '/settings/ai', cta: 'Add an AI provider' },
  mailbox: { what: 'Connect the Gmail, Microsoft 365 or SMTP mailbox you will send from.', path: '/email-accounts', cta: 'Connect a mailbox' },
  domain: { what: 'Check SPF, DKIM and DMARC for your sending domain and prove you own it.', path: '/domains', cta: 'Check a domain' },
  leads: { what: 'Upload a CSV or find prospects that match your ideal customer.', path: '/leads/import', cta: 'Import leads' },
  campaign: { what: 'Create a sequence, generate drafts and approve your first emails.', path: '/campaigns', cta: 'Create a campaign' },
};

export default function Onboarding() {
  const { orgId } = useParams<{ orgId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['onboarding', orgId], queryFn: () => api<Status>(`/orgs/${orgId}/onboarding`), refetchOnWindowFocus: true });
  const org = useQuery({ queryKey: ['org', orgId], queryFn: () => api<{ name: string }>(`/orgs/${orgId}`) });
  async function skip(step: string, s: boolean) {
    try { const r = await api<Status>(`/orgs/${orgId}/onboarding/${step}/skip`, { body: { skip: s } }); qc.setQueryData(['onboarding', orgId], r); } catch (e) { toast.error(describeError(e)); }
  }
  const later = () => { try { localStorage.setItem(`emn-onboarding-${orgId}`, 'later'); } catch { /* ignore */ } router.push(q.data?.firstWorkspaceId ? `/w/${q.data.firstWorkspaceId}` : '/app'); };
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <div className="p-8"><ErrorState error={q.error} retry={() => q.refetch()} /></div>;
  const { steps, firstWorkspaceId } = q.data;
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done && !s.skipped);
  const base = firstWorkspaceId ? `/w/${firstWorkspaceId}` : '';
  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-slate-200 bg-white"><div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-5"><Logo /><button onClick={later} className="text-sm font-semibold text-slate-600 hover:text-ink">Do this later</button></div></header>
      <main className="mx-auto max-w-4xl px-5 py-12">
        <p className="text-sm font-bold text-brand-700">{org.data?.name ?? 'Your organization'}</p>
        <h1 className="font-display mt-1 text-[36px] font-bold tracking-[-0.03em]">Set up your organization</h1>
        <p className="mt-2 max-w-xl text-slate-600">Each item is checked against your real configuration, so it turns green as soon as the setting exists. Two items are required; the rest can wait.</p>
        <div className="mt-6 flex items-center gap-3" aria-label={`${done} of ${steps.length} done`}>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${(done / steps.length) * 100}%` }} /></div>
          <span className="text-sm font-bold tnum">{done} / {steps.length}</span>
        </div>
        {q.data.complete && <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-5"><p className="font-bold text-emerald-900">You are set up.</p><p className="mt-1 text-sm text-emerald-800">Everything required is in place. Open your workspace to review drafts and start sending.</p><Link href={base || '/app'} className="btn-site-primary mt-3">Open the workspace</Link></div>}
        <ol className="mt-8 space-y-3" data-testid="onboarding-steps">
          {steps.map((s) => {
            const h = HELP[s.id];
            const isNext = next?.id === s.id;
            return (
              <li key={s.id} className={`rounded-2xl border bg-white p-5 ${isNext ? 'border-brand-300 shadow-card' : 'border-slate-200'}`} data-step={s.id} data-done={s.done}>
                <div className="flex items-start gap-4">
                  <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full ${s.done ? 'bg-emerald-600 text-white' : s.skipped ? 'bg-slate-200 text-slate-500' : 'border-2 border-slate-300 text-slate-300'}`} aria-hidden>{s.done ? <Check className="h-4 w-4" /> : <Circle className="h-2.5 w-2.5 fill-current" />}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold">{s.label} {!s.optional && <span className="ml-1 text-xs font-bold text-brand-700">Required</span>}{s.done && <span className="ml-1 text-xs font-semibold text-emerald-700">Done</span>}{s.skipped && <span className="ml-1 text-xs font-semibold text-slate-500">Skipped</span>}</p>
                    <p className="mt-1 text-sm text-slate-600">{h?.what}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {s.skipped && <Button variant="ghost" size="sm" onClick={() => skip(s.id, false)}><RotateCcw className="h-3.5 w-3.5" aria-hidden />Undo skip</Button>}
                    {!s.done && !s.skipped && s.optional && <Button variant="ghost" size="sm" onClick={() => skip(s.id, true)}>Skip for now</Button>}
                    {!s.done && base && h && <Link href={`${base}${h.path}`} className={isNext ? 'btn-site-primary h-9' : 'btn-site-ghost h-9'}>{h.cta}<ArrowRight className="ml-1.5 h-4 w-4" aria-hidden /></Link>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="mt-8 text-sm text-slate-500">Come back any time from <span className="font-semibold">Organization settings → Setup checklist</span>. Need help? Read the <Link className="font-semibold text-brand-700 underline" href="/docs/quickstart">quickstart</Link>.</p>
      </main>
    </div>
  );
}
