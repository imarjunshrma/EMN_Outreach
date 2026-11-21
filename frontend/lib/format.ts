export const fmtDate = (d?: string | Date | null) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const fmtDay = (d?: string | Date | null) => (d ? new Date(d).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
export const fmtMoney = (cents: number, currency = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((cents ?? 0) / 100);
export const fmtUsd = (v: number) => `$${(v ?? 0).toFixed(v < 1 ? 4 : 2)}`;
export const fmtPct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);
export const fullName = (l: { firstName?: string | null; lastName?: string | null; email?: string }) => [l.firstName, l.lastName].filter(Boolean).join(' ') || l.email || '—';
export const titleCase = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
