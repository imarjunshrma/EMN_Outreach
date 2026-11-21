'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Menu, Search, X } from 'lucide-react';
import { Logo, useSignedIn } from '@/components/site/site-shell';
import type { NavGroup, SearchEntry } from '@/lib/docs';

type ApiGroups = Array<{ group: string; tags: Array<{ tag: string; slug: string; count: number }> }>;

export function DocsShell({ nav, index, apiGroups, children }: { nav: NavGroup[]; index: SearchEntry[]; apiGroups: ApiGroups; children: ReactNode }) {
  const path = usePathname();
  const signedIn = useSignedIn();
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    const el = document.documentElement; const was = el.classList.contains('dark'); el.classList.remove('dark');
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearching(true); } if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); setSearching(true); } };
    window.addEventListener('keydown', h);
    return () => { window.removeEventListener('keydown', h); if (was) el.classList.add('dark'); };
  }, []);
  const inApi = path.startsWith('/docs/api');

  const sidebar = (
    <nav aria-label="Documentation" className="space-y-7 text-[14px]">
      {nav.map((g) => (
        <div key={g.section}>
          <p className="mb-2 px-3 text-[12.5px] font-bold text-slate-400">{g.section}</p>
          <ul className="space-y-0.5">{g.items.map((i) => {
            const active = i.href === '/docs' ? path === '/docs' : i.href === '/docs/api' ? inApi : path === i.href;
            return <li key={i.href}><Link href={i.href} aria-current={active ? 'page' : undefined} className={`block rounded-lg px-3 py-1.5 font-medium ${active ? 'bg-brand-50 font-bold text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-ink'}`}>{i.title}</Link></li>;
          })}</ul>
          {g.section === 'Developers' && inApi && (
            <div className="ml-3 mt-2 space-y-3 border-l border-slate-200 pl-3">
              {apiGroups.map((ag) => (
                <div key={ag.group}>
                  <p className="mb-1 text-[12px] font-semibold text-slate-400">{ag.group}</p>
                  <ul>{ag.tags.map((t) => { const href = `/docs/api/${t.slug}`; const active = path === href; return <li key={t.slug}><Link href={href} aria-current={active ? 'page' : undefined} className={`flex justify-between rounded-md px-2 py-1 text-[13px] ${active ? 'bg-brand-50 font-bold text-brand-700' : 'text-slate-600 hover:text-ink'}`}><span>{t.tag}</span><span className="text-slate-400 tnum">{t.count}</span></Link></li>; })}</ul>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen bg-white text-ink">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-4 px-5">
          <button className="rounded-lg p-2 lg:hidden" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Close navigation' : 'Open navigation'}>{open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}</button>
          <Logo />
          <span className="hidden rounded-md bg-brand-50 px-2 py-0.5 text-[12px] font-bold text-brand-700 sm:inline">Docs</span>
          <button onClick={() => setSearching(true)} className="ml-4 hidden h-10 max-w-sm flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-paper px-3 text-left text-[14px] text-slate-500 hover:border-slate-300 md:flex" data-testid="docs-search-open">
            <Search className="h-4 w-4" aria-hidden /><span className="flex-1">Search the docs</span><kbd className="rounded border border-slate-200 bg-white px-1.5 text-[11px]">⌘K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setSearching(true)} className="rounded-lg p-2 md:hidden" aria-label="Search the docs"><Search className="h-5 w-5" /></button>
            <Link href="/" className="hidden rounded-lg px-3 py-2 text-[14px] font-semibold text-slate-600 hover:text-ink sm:block">Website</Link>
            <Link href={signedIn ? '/app' : '/signup'} className="btn-site-primary">{signedIn ? 'Open the app' : 'Start free trial'}</Link>
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-[1400px]">
        <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 px-3 py-8 lg:block">{sidebar}</aside>
        {open && <div className="fixed inset-0 top-16 z-20 overflow-y-auto bg-white px-4 py-6 lg:hidden">{sidebar}</div>}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      {searching && <SearchDialog index={index} onClose={() => setSearching(false)} />}
    </div>
  );
}

function SearchDialog({ index, onClose }: { index: SearchEntry[]; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const results = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return index.filter((e) => !e.href.includes('#')).slice(0, 8);
    return index.map((e) => {
      const t = e.title.toLowerCase(); const x = e.text.toLowerCase();
      let score = 0;
      for (const term of terms) { if (t.includes(term)) score += 10; else if (x.includes(term)) score += 2; else return null; }
      if (!e.href.includes('#')) score += 1;
      return { e, score };
    }).filter((r): r is { e: SearchEntry; score: number } => !!r).sort((a, b) => b.score - a.score).slice(0, 12).map((r) => r.e);
  }, [q, index]);
  useEffect(() => { setSel(0); }, [q]);
  const go = (href: string) => { onClose(); router.push(href); };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 p-4 pt-[12vh]" onMouseDown={onClose} role="dialog" aria-modal="true" aria-label="Search documentation">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-slate-200 px-4">
          <Search className="h-4 w-4 text-slate-400" aria-hidden />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search guides and API endpoints" className="h-14 flex-1 bg-transparent text-[15px] outline-none" aria-label="Search"
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); } if (e.key === 'Enter' && results[sel]) go(results[sel].href); }} />
          <kbd className="rounded border border-slate-200 px-1.5 text-[11px] text-slate-500">Esc</kbd>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto p-2" role="listbox">
          {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-500">No results for “{q}”. Try a shorter word, like “webhook” or “DNS”.</li>}
          {results.map((r, i) => (
            <li key={r.href} role="option" aria-selected={i === sel}>
              <button onMouseEnter={() => setSel(i)} onClick={() => go(r.href)} className={`block w-full rounded-lg px-3 py-2 text-left ${i === sel ? 'bg-brand-50' : ''}`}>
                <span className="block text-[14px] font-semibold text-ink">{r.title}</span>
                <span className="block text-[12px] text-slate-500">{r.section}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function Toc({ headings }: { headings: Array<{ depth: number; text: string; id: string }> }) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const els = headings.map((h) => document.getElementById(h.id)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver((entries) => { const v = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (v) setActive(v.target.id); }, { rootMargin: '-80px 0px -70% 0px' });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [headings]);
  if (headings.length < 2) return null;
  return (
    <nav aria-label="On this page" className="sticky top-24 hidden w-56 shrink-0 self-start xl:block">
      <p className="mb-3 text-[12.5px] font-bold text-slate-400">On this page</p>
      <ul className="space-y-1.5 border-l border-slate-200 text-[13px]">
        {headings.map((h) => <li key={h.id}><a href={`#${h.id}`} className={`-ml-px block border-l-2 py-0.5 ${h.depth === 3 ? 'pl-6' : 'pl-3'} ${active === h.id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-slate-500 hover:text-ink'}`}>{h.text}</a></li>)}
      </ul>
    </nav>
  );
}
