'use client';

import Link from 'next/link';
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { describeError } from '@/lib/api';
import { titleCase } from '@/lib/format';
import ianaTimeZones from '@/lib/timezones.json';
import { AlertTriangle, CheckCircle2, Info, Inbox as InboxIcon, Loader2, Search, X, type LucideIcon } from 'lucide-react';
import { iconFor } from './action-icons';
import { usePageMeta } from './shell/page-context';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white shadow-brand hover:bg-brand-700 active:bg-brand-800 disabled:bg-brand-300 disabled:shadow-none',
  secondary: 'border border-slate-300 bg-white text-ink-700 shadow-sm hover:border-slate-400 hover:bg-slate-50 disabled:text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
  danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700 disabled:bg-red-300',
  ghost: 'text-ink-600 hover:bg-slate-100 hover:text-ink dark:text-slate-300 dark:hover:bg-slate-800',
};

/** Children that are plain text get a matching leading icon (see action-icons.ts). icon={null} turns it off. */
function textOf(children: ReactNode): string | null {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) { const first = children.find((c) => typeof c === 'string' && c.trim()); return typeof first === 'string' ? first : null; }
  return null;
}

export function Button({ variant = 'primary', size = 'md', loading, icon, className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: LucideIcon | null }) {
  // "★ Star" style labels: the icon replaces the typed symbol.
  if (typeof children === 'string' && /^[☆★]\s?/.test(children) && icon !== null) children = children.replace(/^[☆★]\s?/, '');
  const Icon = icon === null ? null : icon ?? iconFor(textOf(children));
  const isz = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  return (
    <button type="button" {...rest} disabled={rest.disabled || loading} className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-semibold transition-colors disabled:cursor-not-allowed ${size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-10 px-4 text-sm'} ${VARIANTS[variant]} ${className}`}>
      {loading ? <Loader2 className={`${isz} animate-spin`} aria-hidden /> : Icon && <Icon className={`${isz} shrink-0`} aria-hidden strokeWidth={2.25} />}
      {children}
    </button>
  );
}

export function Input({ icon, ...props }: InputHTMLAttributes<HTMLInputElement> & { icon?: LucideIcon }) {
  const Icon = icon ?? (typeof props.placeholder === 'string' && /^search/i.test(props.placeholder) ? Search : undefined);
  if (!Icon) return <input {...props} className={`input ${props.className ?? ''}`} />;
  return (
    <span className={`relative block ${props.className?.match(/(?:md:)?col-span-\d+/g)?.join(' ') ?? ''}`}>
      <Icon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <input {...props} className={`input pl-9 ${props.className ?? ''}`} />
    </span>
  );
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...props} className={`input leading-relaxed ${props.className ?? ''}`} />; }
export function Select({ options, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { options: Array<{ value: string; label: string }> | string[] }) {
  return (
    <select {...props} className={`input ${props.className ?? ''}`}>
      {options.map((o) => (typeof o === 'string' ? <option key={o} value={o}>{titleCase(o)}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
    </select>
  );
}

export function TimezoneSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const current = props.value == null ? '' : String(props.value);
  const options = current && !ianaTimeZones.includes(current) ? [current, ...ianaTimeZones] : ianaTimeZones;
  return <Select {...props} options={options} />;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="mb-3.5 block last:mb-0">
      <span className="label">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

export function Checkbox({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-0.5 text-sm">
      <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-brand-600" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{hint && <span className="block text-xs text-slate-500">{hint}</span>}</span>
    </label>
  );
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
          <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">{title}</h2>
          <div className="flex flex-wrap gap-2">{actions}</div>
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, icon }: { title: string; subtitle?: ReactNode; actions?: ReactNode; icon?: LucideIcon }) {
  const meta = usePageMeta();
  const Icon = icon ?? meta?.icon;
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 items-start gap-4">
        {Icon && <span className="mt-0.5 hidden h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100 sm:grid dark:ring-brand-900"><Icon className="h-5 w-5" aria-hidden strokeWidth={2} /></span>}
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-[1.15] tracking-[-0.025em] text-ink">{title}</h1>
          {subtitle && <div className="mt-1.5 max-w-[72ch] text-sm leading-relaxed text-slate-500">{subtitle}</div>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

const BADGE: Record<string, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', red: 'bg-red-50 text-red-700 ring-red-600/20', yellow: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  blue: 'bg-blue-50 text-blue-700 ring-blue-600/20', gray: 'bg-slate-100 text-slate-600 ring-slate-500/20', purple: 'bg-violet-50 text-violet-700 ring-violet-600/20',
};
const DOT: Record<string, string> = { green: 'bg-emerald-500', red: 'bg-red-500', yellow: 'bg-amber-500', blue: 'bg-blue-500', gray: 'bg-slate-400', purple: 'bg-violet-500' };
const STATUS_COLOR: Record<string, keyof typeof BADGE> = {
  CONNECTED: 'green', RUNNING: 'green', SENT: 'green', VALID: 'green', PASS: 'green', HEALTHY: 'green', COMPLETED: 'green', SUPPORTED: 'green', QUALIFIED: 'green', INTERESTED: 'green', WANTS_MEETING: 'green', WANTS_PRICING: 'green', MEETING_BOOKED: 'green', CUSTOMER: 'green', WON: 'green', DELIVERED: 'green', PASSED: 'green', ACTIVE: 'green', APPROVED: 'blue',
  NEEDS_REAUTH: 'red', ERROR: 'red', FAILED: 'red', INVALID: 'red', FAIL: 'red', CRITICAL: 'red', BOUNCED: 'red', COMPLAINT: 'red', UNSUBSCRIBED: 'red', UNSUBSCRIBE: 'red', REJECTED: 'red', LOST: 'red', DISQUALIFIED: 'red', NOT_INTERESTED: 'red', CANCELLED: 'gray',
  PAUSED: 'yellow', WARN: 'yellow', WARNING: 'yellow', RISKY: 'yellow', CATCH_ALL: 'yellow', PENDING_APPROVAL: 'yellow', AWAITING_APPROVAL: 'yellow', PENDING: 'yellow', QUEUED: 'blue', SENDING: 'blue', RUNNING_JOB: 'blue', NEEDS_INFO: 'blue', REPLIED: 'purple', CONTACTED: 'blue', RESEARCHED: 'blue',
};

export function Badge({ children, color }: { children: ReactNode; color?: keyof typeof BADGE }) {
  const c = color ?? (typeof children === 'string' ? STATUS_COLOR[children] : undefined) ?? 'gray';
  return <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${BADGE[c]}`}><span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DOT[c]}`} />{typeof children === 'string' ? titleCase(children) : children}</span>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div role="status" className="flex items-center gap-2 p-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin text-brand-600" aria-hidden />{label}</div>;
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div role="alert" className="flex gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div><p className="font-semibold">Couldn’t load this data</p><p className="mt-1">{describeError(error)}</p>{retry && <button className="mt-2 font-semibold underline" onClick={retry}>Try again</button>}</div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white/60 px-6 py-10 text-center">
      <span className="mb-3 grid h-10 w-10 place-items-center rounded-full bg-brand-50 text-brand-600"><InboxIcon className="h-5 w-5" aria-hidden /></span>
      <p className="text-sm font-bold text-ink">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-slate-500">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Renders loading / error / empty states for a query, otherwise children(data). */
export function QueryView<T>({ q, empty, isEmpty, children }: { q: { data?: T; isLoading: boolean; error: unknown; refetch: () => unknown }; empty?: ReactNode; isEmpty?: (d: T) => boolean; children: (d: T) => ReactNode }) {
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (q.data === undefined) return <Loading />;
  if (isEmpty?.(q.data) && empty) return <>{empty}</>;
  return <>{children(q.data)}</>;
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg">
      <table className="min-w-full divide-y divide-slate-200">
        <thead><tr>{head.map((h, i) => <th key={i} className="th">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100 bg-white [&>tr:hover]:bg-slate-50/70">{children}</tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
      <span>{total.toLocaleString()} total</span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <span>Page {page} of {totalPages}</span>
        <Button variant="secondary" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}

export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/50 p-4 pt-16 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`card w-full shadow-pop ${wide ? 'max-w-4xl' : 'max-w-lg'}`}>
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h3 className="text-[15px] font-bold">{title}</h3>
          <button aria-label="Close" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose}><X className="h-4 w-4" /></button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: Array<{ id: string; label: string; count?: number }>; active: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200 [scrollbar-width:thin]">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={active === t.id} onClick={() => onChange(t.id)} className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${active === t.id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-ink'}`}>
          {t.label}{t.count !== undefined && <span className={`ml-1.5 rounded-md px-1.5 py-px text-xs tnum ${active === t.id ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-500'}`}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, hint, href }: { label: string; value: ReactNode; hint?: string; href?: string }) {
  const body = (
    <div className={`card h-full p-4 ${href ? 'transition-colors group-hover:border-brand-200' : ''}`}>
      <p className="text-[13px] font-semibold text-slate-500">{label}</p>
      <p className="font-display mt-2 text-[30px] font-bold leading-none tracking-[-0.03em] text-ink tnum">{value}</p>
      {hint && <p className="mt-2 text-xs text-slate-500">{hint}</p>}
    </div>
  );
  return href ? <Link href={href} className="group block">{body}</Link> : body;
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warning' | 'danger' | 'success'; children: ReactNode }) {
  const c = kind === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-900' : kind === 'danger' ? 'border-red-200 bg-red-50 text-red-800' : kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-brand-100 bg-brand-50/60 text-ink-700';
  const Icon = kind === 'info' ? Info : kind === 'success' ? CheckCircle2 : AlertTriangle;
  return <div className={`flex gap-2.5 rounded-xl border px-4 py-3 text-sm leading-relaxed ${c}`}><Icon className={`mt-0.5 h-4 w-4 shrink-0 ${kind === 'info' ? 'text-brand-600' : ''}`} aria-hidden /><div className="min-w-0 flex-1">{children}</div></div>;
}

export function ConfirmButton({ confirm, onConfirm, children, ...rest }: Parameters<typeof Button>[0] & { confirm: string; onConfirm: () => void }) {
  return <Button {...rest} onClick={() => { if (window.confirm(confirm)) onConfirm(); }}>{children}</Button>;
}
