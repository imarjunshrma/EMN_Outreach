import type { ReactNode } from 'react';
import { BrandLogo } from '@/components/brand';

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="grid min-h-screen lg:grid-cols-[1fr_minmax(440px,560px)]">
      <section className="relative hidden overflow-hidden bg-ink p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center"><BrandLogo height={36} tone="dark" /></div>
        <div className="max-w-md">
          <p className="font-display text-[44px] font-bold leading-[1.02] tracking-[-0.035em]">Research every prospect. Write to each one. Send only what you approved.</p>
          <ul className="mt-8 space-y-3 border-l-2 border-brand-500 pl-5 text-[15px] text-ink-300">
            <li>Each email is grounded in sources you can check.</li>
            <li>Nothing is sent without approval, and replies come back to one inbox.</li>
            <li>Your mailboxes stay yours: no rotation, no warm-up networks.</li>
          </ul>
        </div>
        <p className="text-xs text-ink-400">© {new Date().getFullYear()} Outvexa</p>
      </section>
      <section className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center lg:hidden"><BrandLogo height={30} /></div>
          <h1 className="text-[30px] font-bold tracking-[-0.03em] text-ink">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-7">{children}</div>
        </div>
      </section>
    </main>
  );
}
