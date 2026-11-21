import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/bricolage-grotesque';
import './globals.css';
import { Providers } from './providers';
import { THEME_SCRIPT } from '@/lib/theme-script';

export const metadata: Metadata = { title: 'EMN Outreach OS', description: 'Elite Media Networks outreach platform', robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /></head>
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
