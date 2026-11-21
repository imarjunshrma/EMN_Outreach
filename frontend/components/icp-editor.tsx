'use client';

import { Checkbox, Field, Input, Textarea } from '@/components/ui';

export interface Criteria { titles: string[]; seniorities: string[]; industries: string[]; keywords: string[]; countries: string[]; employeeMin: number | null; employeeMax: number | null; mustHave: string[]; disqualifiers: string[] }
export interface Icp { id: string; name: string; description: string | null; criteria: Criteria; minScore: number; isActive: boolean }
export const EMPTY: Criteria = { titles: [], seniorities: [], industries: [], keywords: [], countries: [], employeeMin: null, employeeMax: null, mustHave: [], disqualifiers: [] };
export const LIST_FIELDS: Array<[keyof Criteria, string, string]> = [['titles', 'Job titles', 'Founder, Managing Partner, Fractional CMO'], ['industries', 'Industries', 'Management consulting, Coaching'], ['keywords', 'Keywords', 'podcast, advisory'], ['countries', 'Countries (ISO-2)', 'US, GB'], ['seniorities', 'Seniority', 'owner, c_suite'], ['mustHave', 'Must have', 'Publishes content regularly'], ['disqualifiers', 'Disqualifiers', 'Agency, competitor']];

export function IcpEditor({ value, onChange }: { value: { name: string; description: string; criteria: Criteria; minScore: number; isActive: boolean }; onChange: (v: typeof value) => void }) {
  const c = value.criteria;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field label="Name"><Input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} /></Field>
      <Field label="Qualification threshold (0-100)"><Input type="number" min={0} max={100} value={value.minScore} onChange={(e) => onChange({ ...value, minScore: Number(e.target.value) })} /></Field>
      {LIST_FIELDS.map(([k, label, ph]) => (
        <Field key={k} label={label} hint="Comma separated"><Input placeholder={ph} value={(c[k] as string[]).join(', ')} onChange={(e) => onChange({ ...value, criteria: { ...c, [k]: e.target.value.split(',').map((x) => (k === 'countries' ? x.trim().toUpperCase() : x.trim())).filter(Boolean) } })} /></Field>
      ))}
      <Field label="Employees min"><Input type="number" value={c.employeeMin ?? ''} onChange={(e) => onChange({ ...value, criteria: { ...c, employeeMin: e.target.value ? Number(e.target.value) : null } })} /></Field>
      <Field label="Employees max"><Input type="number" value={c.employeeMax ?? ''} onChange={(e) => onChange({ ...value, criteria: { ...c, employeeMax: e.target.value ? Number(e.target.value) : null } })} /></Field>
      <div className="md:col-span-2"><Field label="Description"><Textarea rows={2} value={value.description} onChange={(e) => onChange({ ...value, description: e.target.value })} /></Field></div>
      <Checkbox label="Active (default ICP for scoring if it is the oldest active one)" checked={value.isActive} onChange={(v) => onChange({ ...value, isActive: v })} />
    </div>
  );
}

