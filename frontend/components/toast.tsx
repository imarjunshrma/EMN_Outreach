'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { describeError } from '@/lib/api';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';

interface Toast { id: number; kind: 'success' | 'error' | 'info'; text: string }
const Ctx = createContext<{ push: (t: Omit<Toast, 'id'>) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { ...t, id }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), t.kind === 'error' ? 8000 : 4000);
  }, []);
  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="flex items-start gap-2.5 rounded-xl bg-ink px-4 py-3 text-sm text-white shadow-pop ring-1 ring-white/10">
            {t.kind === 'error' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden /> : t.kind === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-300" aria-hidden />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const c = useContext(Ctx);
  if (!c) throw new Error('ToastProvider missing');
  return {
    success: (text: string) => c.push({ kind: 'success', text }),
    info: (text: string) => c.push({ kind: 'info', text }),
    error: (e: unknown) => c.push({ kind: 'error', text: typeof e === 'string' ? e : describeError(e) }),
  };
}
