'use client';
import { useEffect, useState } from 'react';

// Theme: 'light' | 'dark' | 'system' stored per browser. Applied before paint by the inline script in layout.tsx.
export type Theme = 'light' | 'dark' | 'system';

function apply(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    let t: Theme = 'system';
    try { t = (localStorage.getItem('emn-theme') as Theme) || 'system'; } catch { /* storage unavailable */ }
    setTheme(t); apply(t);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => { let cur: Theme = 'system'; try { cur = (localStorage.getItem('emn-theme') as Theme) || 'system'; } catch { /* ignore */ } if (cur === 'system') apply('system'); };
    const sync = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    mq.addEventListener('change', on);
    window.addEventListener('emn-theme', sync);
    return () => { mq.removeEventListener('change', on); window.removeEventListener('emn-theme', sync); };
  }, []);
  return [theme, (t) => { try { localStorage.setItem('emn-theme', t); } catch { /* ignore */ } setTheme(t); apply(t); window.dispatchEvent(new CustomEvent('emn-theme', { detail: t })); }];
}

export function ThemeToggle() {
  const [theme, set] = useTheme();
  const next: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' };
  const label = { light: '☀ Light', dark: '☾ Dark', system: '◐ Auto' }[theme];
  return <button type="button" data-testid="theme-toggle" title="Theme: light / dark / follow system" className="text-slate-500 hover:text-slate-900 dark:hover:text-white" onClick={() => set(next[theme])}>{label}</button>;
}
