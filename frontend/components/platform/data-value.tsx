'use client';
import { Lock } from 'lucide-react';
import { fmtDate } from '@/lib/format';

export type DataField = { name: string; type: string; kind: string; isList: boolean; isOptional: boolean; secret: boolean; enumValues?: string[]; editable: boolean };

/** Shows one database value readably: dates, yes/no, JSON, lists, hidden secrets and empty values. */
export function DataValue({ field, value, compact }: { field: DataField; value: unknown; compact?: boolean }) {
  if (field.secret) return value === null ? <span className="text-slate-400">—</span> : <span className="inline-flex items-center gap-1 text-xs text-slate-500"><Lock className="h-3 w-3" aria-hidden />hidden</span>;
  if (value === null || value === undefined) return <span className="text-slate-400">—</span>;
  if (field.type === 'Boolean' && !field.isList) return <span className={value ? 'font-semibold text-emerald-700' : 'text-slate-500'}>{value ? 'yes' : 'no'}</span>;
  if (field.type === 'DateTime' && !field.isList) return <span className="whitespace-nowrap">{fmtDate(String(value))}</span>;
  if (field.type === 'Json' || field.isList || typeof value === 'object') {
    const text = JSON.stringify(value, null, compact ? 0 : 2);
    return compact ? <code className="text-xs text-slate-600">{text.length > 80 ? `${text.slice(0, 80)}…` : text}</code> : <pre className="max-h-80 overflow-auto rounded-md bg-slate-50 p-2 text-xs dark:bg-slate-900">{text}</pre>;
  }
  const s = String(value);
  if (field.name === 'id' || /Id$/.test(field.name)) return <code className="text-xs">{compact ? `${s.slice(0, 8)}…` : s}</code>;
  if (field.kind === 'enum') return <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold dark:bg-slate-800">{s}</span>;
  return <span title={compact && s.length > 60 ? s : undefined}>{compact && s.length > 60 ? `${s.slice(0, 60)}…` : s}</span>;
}
