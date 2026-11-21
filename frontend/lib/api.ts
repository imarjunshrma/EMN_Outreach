'use client';

// Thin typed client for the EMN API. Cookies carry the session; the CSRF token is read from the
// non-httpOnly emn_csrf cookie and sent as X-CSRF-Token on every state-changing request.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

function csrf(): string {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.match(/(?:^|;\s*)emn_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined || init.form ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-csrf-token'] = csrf();
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string; details?: unknown } })?.error;
    if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login') && !path.startsWith('/auth/')) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    }
    if (err?.code === 'MFA_REQUIRED' && typeof window !== 'undefined') {
      const m = window.location.pathname.match(/^\/w\/([^/]+)/);
      if (m && !window.location.pathname.endsWith('/settings/account')) window.location.href = `/w/${m[1]}/settings/account?mfa=required`;
    }
    throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

export interface Paged<T> { data: T[]; page: number; pageSize: number; total: number; totalPages: number }

export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    const details = Array.isArray(e.details) ? (e.details as Array<{ path?: string; message?: string }>).map((d) => `${d.path ? `${d.path}: ` : ''}${d.message ?? ''}`).join('; ') : '';
    const blocking = (e.details as { blocking?: string[] } | undefined)?.blocking;
    return [e.message, details, blocking?.length ? blocking.join(' • ') : ''].filter(Boolean).join(' — ');
  }
  return (e as Error)?.message ?? 'Something went wrong';
}
