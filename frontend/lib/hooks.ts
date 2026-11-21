'use client';

import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { api } from './api';
import { useToast } from '@/components/toast';

export function useWs(): string {
  const p = useParams<{ ws: string }>();
  return p.ws;
}

/** GET a workspace-relative path: useWsQuery('/leads?x=1') → /w/<ws>/leads?x=1 */
export function useWsQuery<T>(path: string | null, opts: { refetchInterval?: number; enabled?: boolean } = {}) {
  const ws = useWs();
  return useQuery<T>({
    queryKey: ['ws', ws, path],
    queryFn: () => api<T>(`/w/${ws}${path}`),
    enabled: path !== null && (opts.enabled ?? true),
    refetchInterval: opts.refetchInterval,
  });
}

export function useWsMutation<TBody = unknown, TRes = unknown>(
  build: (body: TBody) => { path: string; method?: string; body?: unknown; form?: FormData },
  opts: { success?: string | ((r: TRes) => string); invalidate?: boolean; onSuccess?: (r: TRes) => void } = {},
) {
  const ws = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<TRes, Error, TBody>({
    mutationFn: async (body) => {
      const req = build(body);
      return api<TRes>(`/w/${ws}${req.path}`, { method: req.method, body: req.body, form: req.form });
    },
    onSuccess: (r) => {
      if (opts.invalidate !== false) void qc.invalidateQueries({ queryKey: ['ws', ws] });
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      opts.onSuccess?.(r);
    },
    onError: (e) => toast.error(e),
  });
}

/** Subscribe to server-sent events and refresh cached queries when something changes. */
export function useRealtime(ws: string) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!ws) return;
    const es = new EventSource(`/api/v1/w/${ws}/events`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; void qc.invalidateQueries({ queryKey: ['ws', ws] }); }, 800);
    };
    return () => { es.close(); if (timer) clearTimeout(timer); };
  }, [ws, qc]);
}

export type { QueryKey };
