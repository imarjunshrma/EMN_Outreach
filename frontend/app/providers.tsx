'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ToastProvider } from '@/components/toast';
import { ApiError } from '@/lib/api';
import { AppBanners } from '@/components/platform/impersonation-banner';

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 } },
  }));
  return <QueryClientProvider client={qc}><ToastProvider><AppBanners />{children}</ToastProvider></QueryClientProvider>;
}
