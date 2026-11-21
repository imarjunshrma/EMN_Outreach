'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Menu, X } from 'lucide-react';
import { api } from '@/lib/api';

const NAV = [
  { href: '/features', label: 'Product' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/security', label: 'Security' },
  { href: '/docs', label: 'Docs' },
];

export function Logo({ invert = false }: { invert?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5" aria-label="EMN Outreach OS home">
      <span className="font-display grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 text-[14px] font-bold text-white shadow-brand">em</span>
      <span className={`font-display text-[18px] font-bold tracking-[-0.02em] ${invert ? 'text-white' : 'text-ink'}`}>Outreach OS</span>
    </Link>
  );
}

/** Signed-in visitors get "Open the app" instead of sign-up prompts. Failure (signed out) is silent. */
export function useSignedIn() {
  const q = useQuery({ queryKey: ['me-public'], queryFn: () => api<{ user: { id: string } }>('/auth/me').then(() => true).catch(() => false), staleTime: 60_000, retry: false });
  return q.data === true;
}

export function SiteShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const signedIn = useSignedIn();
  const [open, setOpen] = useState(false);
  // The public site is light-only; restore the app theme when navigating back into the app.
  useEffect(() => {
    const el = document.documentElement;
    const was = el.classList.contains('dark');
    el.classList.remove('dark');
    return () => { if (was) el.classList.add('dark'); };
  }, []);
  return (
    <div className="site min-h-screen bg-white text-ink dark:bg-white">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:shadow-pop">Skip to content</a>
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-5">
          <Logo />
          <nav className="hidden flex-1 items-center gap-1 md:flex" aria-label="Site">
            {NAV.map((n) => <Link key={n.href} href={n.href} aria-current={path.startsWith(n.href) ? 'page' : undefined} className={`rounded-lg px-3 py-2 text-[14px] font-semibold ${path.startsWith(n.href) ? 'text-brand-700' : 'text-slate-600 hover:text-ink'}`}>{n.label}</Link>)}
          </nav>
          <div className="ml-auto hidden items-center gap-2 md:flex">
            {signedIn ? <Link href="/app" className="btn-site-primary">Open the app</Link> : <>
              <Link href="/login" className="rounded-lg px-3 py-2 text-[14px] font-semibold text-slate-600 hover:text-ink">Sign in</Link>
              <Link href="/signup" className="btn-site-primary">Start free trial</Link>
            </>}
          </div>
          <button className="ml-auto rounded-lg p-2 md:hidden" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Close menu' : 'Open menu'}>{open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}</button>
        </div>
        {open && (
          <nav className="border-t border-slate-200 px-5 py-3 md:hidden" aria-label="Site mobile">
            {NAV.map((n) => <Link key={n.href} href={n.href} className="block rounded-lg px-2 py-2.5 font-semibold" onClick={() => setOpen(false)}>{n.label}</Link>)}
            <div className="mt-2 flex gap-2">{signedIn ? <Link href="/app" className="btn-site-primary flex-1 text-center">Open the app</Link> : <><Link href="/login" className="btn-site-ghost flex-1 text-center">Sign in</Link><Link href="/signup" className="btn-site-primary flex-1 text-center">Start free trial</Link></>}</div>
          </nav>
        )}
      </header>
      <main id="main">{children}</main>
      <footer className="border-t border-slate-200 bg-paper">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-600">Research-led cold email for teams and agencies. Built and run by Elite Media Networks, Jaipur.</p>
            <p className="mt-4 text-sm text-slate-600"><a className="underline decoration-slate-300 underline-offset-4 hover:text-ink" href="mailto:info@elitemedianetworks.com">info@elitemedianetworks.com</a></p>
          </div>
          <FooterCol title="Product" links={[['/features', 'How it works'], ['/pricing', 'Pricing'], ['/security', 'Security'], ['/signup', 'Start a trial']]} />
          <FooterCol title="Developers" links={[['/docs', 'Documentation'], ['/docs/api', 'API reference'], ['/docs/quickstart', 'Quickstart'], ['/docs/webhooks', 'Webhooks']]} />
          <FooterCol title="Company" links={[['/legal/terms', 'Terms of service'], ['/legal/privacy', 'Privacy policy'], ['/legal/acceptable-use', 'Acceptable use'], ['/login', 'Sign in']]} />
        </div>
        <div className="mx-auto max-w-6xl border-t border-slate-200 px-5 py-6 text-xs text-slate-500">© {new Date().getFullYear()} Elite Media Networks. EMN Outreach OS is a product of Elite Media Networks.</div>
      </footer>
    </div>
  );
}

function FooterCol({ title, links }: { title: string; links: Array<[string, string]> }) {
  return (
    <div>
      <p className="text-sm font-bold text-ink">{title}</p>
      <ul className="mt-3 space-y-2 text-sm text-slate-600">{links.map(([h, l]) => <li key={h}><Link className="hover:text-ink" href={h}>{l}</Link></li>)}</ul>
    </div>
  );
}

/** Section wrapper with consistent rhythm. */
export function Section({ children, className = '', id }: { children: ReactNode; className?: string; id?: string }) {
  return <section id={id} className={`mx-auto max-w-6xl px-5 ${className}`}>{children}</section>;
}
