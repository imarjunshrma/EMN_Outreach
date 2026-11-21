'use client';

import { useState } from 'react';
import { useWsMutation, useWsQuery } from '@/lib/hooks';
import { Button, Checkbox, Input, Select } from '@/components/ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Save / apply / delete named filter sets for a list screen. Private by default, optionally shared. */
export function SavedFilters({ entity, current, onApply }: { entity: 'leads' | 'conversations' | 'campaigns' | 'opportunities'; current: Record<string, unknown>; onApply: (q: Record<string, any>) => void }) {
  const list = useWsQuery<any[]>(`/saved-filters?entity=${entity}`);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [open, setOpen] = useState(false);
  const clean = Object.fromEntries(Object.entries(current).filter(([k, v]) => k !== 'page' && v !== '' && v !== undefined && v !== null && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')));
  const save = useWsMutation(() => ({ path: '/saved-filters', body: { entity, name, query: clean, isShared: shared } }), { success: 'Filter saved', onSuccess: () => { setName(''); setOpen(false); } });
  const del = useWsMutation<string>((id) => ({ path: `/saved-filters/${id}`, method: 'DELETE' }), { success: 'Removed' });
  const items = list.data ?? [];
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="saved-filters">
      <Select className="!w-auto" value="" onChange={(e) => { const f = items.find((x) => x.id === e.target.value); if (f) onApply(f.query); }} options={[{ value: '', label: items.length ? 'Saved filters…' : 'No saved filters' }, ...items.map((f) => ({ value: f.id, label: `${f.name}${f.isShared ? ' (shared)' : ''}` }))]} />
      {open ? (
        <>
          <Input className="!w-48" value={name} onChange={(e) => setName(e.target.value)} placeholder="Filter name" />
          <Checkbox label="Share" checked={shared} onChange={setShared} />
          <Button variant="secondary" disabled={!name.trim() || Object.keys(clean).length === 0} onClick={() => save.mutate()}>Save</Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        </>
      ) : <Button variant="ghost" onClick={() => setOpen(true)}>Save current filter</Button>}
      {items.length > 0 && <details className="text-xs"><summary className="cursor-pointer text-slate-500">manage</summary>{items.map((f) => <div key={f.id} className="flex gap-2">{f.name}<button className="text-red-600" onClick={() => del.mutate(f.id)}>delete</button></div>)}</details>}
    </div>
  );
}
