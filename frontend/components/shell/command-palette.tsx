'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import type { NavGroup } from './nav';

/** ⌘K / Ctrl+K: jump to any screen by name. */
export function CommandPalette({ open, onClose, groups, base }: { open: boolean; onClose: () => void; groups: NavGroup[]; base: string }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const items = useMemo(() => {
    const all = groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group })));
    const t = q.trim().toLowerCase();
    return t ? all.filter((i) => `${i.label} ${i.group} ${i.keywords ?? ''}`.toLowerCase().includes(t)) : all;
  }, [groups, q]);
  useEffect(() => { if (open) { setQ(''); setIdx(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => { setIdx(0); }, [q]);
  if (!open) return null;
  const go = (href: string) => { onClose(); router.push(base + href); };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/50 p-4 pt-[12vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Go to" className="card w-full max-w-xl overflow-hidden shadow-pop">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4">
          <Search className="h-4 w-4 text-slate-400" aria-hidden />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Go to… (leads, inbox, workflows, billing)" className="w-full bg-transparent py-3.5 text-[15px] outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, items.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
              if (e.key === 'Enter' && items[idx]) go(items[idx].href);
            }} />
          <kbd className="rounded border border-slate-200 px-1.5 text-[11px] text-slate-400">Esc</kbd>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto p-1.5">
          {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-500">No screen matches “{q}”.</li>}
          {items.map((i, n) => (
            <li key={i.href + i.label}>
              <button onMouseEnter={() => setIdx(n)} onClick={() => go(i.href)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${n === idx ? 'bg-brand-50 text-brand-800 dark:text-brand-200' : 'text-ink-700'}`}>
                <i.icon className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
                <span className="flex-1 font-semibold">{i.label}</span>
                <span className="text-xs text-slate-400">{i.group}</span>
                {n === idx && <CornerDownLeft className="h-3.5 w-3.5 text-brand-600" aria-hidden />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
