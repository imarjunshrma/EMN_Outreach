'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from '@/components/toast';

// Owner-level (not workspace-scoped) API helpers for the personal AI subscription screens.

export function useAiOwner() {
  const q = useQuery<{ allowed: boolean }>({ queryKey: ['ai-sub', '/ai-subscriptions/access'], queryFn: () => api('/ai-subscriptions/access'), staleTime: 60_000, retry: false });
  return { allowed: !!q.data?.allowed, loading: q.isLoading };
}

export function useOwnerQuery<T>(path: string | null, opts: { refetchInterval?: number | false } = {}) {
  return useQuery<T>({ queryKey: ['ai-sub', path], queryFn: () => api<T>(path as string), enabled: path !== null, refetchInterval: opts.refetchInterval });
}

export function useOwnerMutation<TBody = unknown, TRes = unknown>(
  build: (body: TBody) => { path: string; method?: string; body?: unknown },
  opts: { success?: string | ((r: TRes) => string); onSuccess?: (r: TRes) => void } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<TRes, Error, TBody>({
    mutationFn: (b) => { const r = build(b); return api<TRes>(r.path, { method: r.method ?? 'POST', body: r.body ?? {} }); },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['ai-sub'] });
      void qc.invalidateQueries({ queryKey: ['ws'] });
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      opts.onSuccess?.(r);
    },
    onError: (e) => toast.error(e),
  });
}

export function useCopy() {
  const toast = useToast();
  return (text: string, label = 'Copied') => { void navigator.clipboard.writeText(text).then(() => toast.success(label), () => toast.error('Copy failed — select the text and copy it manually')); };
}

export const fmtWhen = (d: string | null | undefined) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
