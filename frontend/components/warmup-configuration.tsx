'use client';

import { useState } from 'react';
import { useWsMutation } from '@/lib/hooks';
import { Card, ConfirmButton, Field, Input, Select, Textarea } from '@/components/ui';

interface Mailbox { id: string; emailAddress: string; status: string; dailySendLimit: number }

export function WarmupConfiguration({ mailboxes = [], program }: {
  mailboxes?: Mailbox[];
  program?: { id: string; config: Record<string, unknown> };
}) {
  const [mailboxId, setMailboxId] = useState('');
  const defaults = {
    startAt: new Date().toISOString().slice(0, 10), durationDays: 21, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    days: '1,2,3,4,5', start: '09:00', end: '17:00', pauseDates: '', mode: 'RECOMMENDED',
    startingTarget: 1, maximumTarget: 5, hourlyLimit: 1, minIntervalSeconds: 900, increment: 1,
    observationDays: 3, minimumSample: 3, maxBouncePct: 2, subject: '', body: '',
  };
  const [form, setForm] = useState(() => {
    if (!program) return defaults;
    const config = program.config as unknown as Partial<Omit<typeof defaults, 'pauseDates'>> & { window: { days: number[]; start: string; end: string; timezone: string }; pauseDates: string[] };
    return { ...defaults, ...config, days: config.window.days.join(','), start: config.window.start,
      end: config.window.end, timezone: config.window.timezone, startAt: config.startAt?.slice(0, 10) ?? defaults.startAt,
      pauseDates: Array.from(config.pauseDates).join(', '),
    };
  });
  const enroll = useWsMutation<unknown>(() => ({ path: program ? `/warmup/${program.id}` : `/warmup/mailboxes/${mailboxId}`, method: program ? 'PATCH' : 'POST', body: {
    ...form, startAt: new Date(form.startAt + 'T00:00:00').toISOString(), pauseDates: form.pauseDates.split(',').map(s => s.trim()).filter(Boolean),
    window: { days: form.days.split(',').map(Number), start: form.start, end: form.end, timezone: form.timezone },
  } }), { success: program ? 'Program configuration updated.' : 'Mailbox enrolled. Review recipients before starting.' });
  const textFields = { startAt: 'Start date', timezone: 'Time zone', days: 'Sending days (1–7)', start: 'Window starts', end: 'Window ends', pauseDates: 'Pause dates (comma-separated)', subject: 'Reviewed subject' } as const;
  const numberFields = { durationDays: 'Duration (days)', startingTarget: 'Starting daily target', maximumTarget: 'Maximum daily target', hourlyLimit: 'Hourly limit', minIntervalSeconds: 'Minimum interval (seconds)', increment: 'Custom increment', observationDays: 'Observation days', minimumSample: 'Minimum accepted sample', maxBouncePct: 'Maximum hard-bounce percentage' } as const;
  return <Card title={program ? "Edit program configuration" : "Enroll a mailbox"}>
    <div className="grid gap-3 sm:grid-cols-2">
      {!program && <Field label="Mailbox"><Select value={mailboxId} onChange={e => setMailboxId(e.target.value)} options={[{ value: '', label: 'Choose a connected mailbox' }, ...mailboxes.filter(m => m.status === 'CONNECTED').map(m => ({ value: m.id, label: m.emailAddress }))]} /></Field>}
      <Field label="Progression mode"><Select value={form.mode} onChange={e => setForm({ ...form, mode: e.target.value })} options={[{ value: 'RECOMMENDED', label: 'Recommended, evidence-gated' }, { value: 'CUSTOM', label: 'Custom, evidence-gated' }]} /></Field>
      {Object.entries(textFields).map(([key, label]) => {
        const field = key as keyof typeof textFields;
        return <Field key={key} label={label}><Input type={field === 'startAt' ? 'date' : field === 'start' || field === 'end' ? 'time' : 'text'} value={form[field]} onChange={e => setForm({ ...form, [field]: e.target.value })} /></Field>;
      })}
      {Object.entries(numberFields).map(([key, label]) => {
        const field = key as keyof typeof numberFields;
        return <Field key={key} label={label}><Input type="number" value={form[field]} onChange={e => setForm({ ...form, [field]: Number(e.target.value) })} /></Field>;
      })}
    </div>
    <Field label="Reviewed message for authorized recipients"><Textarea value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} /></Field>
    <p className="my-2 text-sm">Proposed starting target {Math.min(form.startingTarget, form.mode === 'RECOMMENDED' ? 2 : form.maximumTarget, mailboxes.find(m => m.id === mailboxId)?.dailySendLimit ?? form.maximumTarget)} per day. Increases require accepted submissions on separate days and healthy mailbox evidence.</p>
    <ConfirmButton confirm={program ? "Save the reviewed schedule and message?" : "Enroll this mailbox? Sending starts only after a separate confirmation."} onConfirm={() => enroll.mutate({})} disabled={(!program && !mailboxId) || form.subject.trim().length < 5 || form.body.trim().length < 30} loading={enroll.isPending}>{program ? "Save program settings" : "Enroll mailbox"}</ConfirmButton>
  </Card>;
}

