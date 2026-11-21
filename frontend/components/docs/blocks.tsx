'use client';
import { useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Copy, Info, Lightbulb, ShieldAlert } from 'lucide-react';

const LANG: Record<string, string> = { bash: 'Shell', sh: 'Shell', shell: 'Shell', json: 'JSON', ts: 'TypeScript', typescript: 'TypeScript', js: 'JavaScript', javascript: 'JavaScript', python: 'Python', py: 'Python', http: 'HTTP', env: '.env', dns: 'DNS', text: 'Text', yaml: 'YAML' };

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ } }}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-semibold text-ink-300 hover:bg-white/10 hover:text-white ${className}`} aria-label={done ? 'Copied' : 'Copy code'}>
      {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}{done ? 'Copied' : 'Copy'}
    </button>
  );
}

export function CodeBlock({ code, lang = 'text', title }: { code: string; lang?: string; title?: string }) {
  return (
    <div className="my-5 overflow-hidden rounded-xl bg-ink text-ink-100 shadow-card">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-1.5">
        <span className="text-[12px] font-semibold text-ink-300">{title ?? LANG[lang] ?? lang}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto px-4 py-3.5 text-[13px] leading-relaxed"><code className="!bg-transparent !p-0 !text-inherit">{code}</code></pre>
    </div>
  );
}

const KINDS = {
  note: { icon: Info, cls: 'border-slate-300 bg-paper', label: 'Note' },
  tip: { icon: Lightbulb, cls: 'border-brand-300 bg-brand-50', label: 'Tip' },
  warning: { icon: AlertTriangle, cls: 'border-amber-300 bg-amber-50', label: 'Warning' },
  security: { icon: ShieldAlert, cls: 'border-red-300 bg-red-50', label: 'Security' },
} as const;

export function Callout({ kind, children }: { kind: string; children: ReactNode }) {
  const k = KINDS[kind as keyof typeof KINDS] ?? KINDS.note;
  return (
    <aside className={`my-6 rounded-xl border-l-4 px-5 py-1 ${k.cls}`} aria-label={k.label}>
      <p className="mt-3 flex items-center gap-1.5 text-[13px] font-bold text-ink"><k.icon className="h-4 w-4" aria-hidden />{k.label}</p>
      <div className="[&>p:first-child]:mt-1 [&>p]:text-[15px]">{children}</div>
    </aside>
  );
}
