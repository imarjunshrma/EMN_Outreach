import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { DocsShell } from '@/components/docs/docs-shell';
import { apiTags, docsNav, searchIndex } from '@/lib/docs';

export const metadata: Metadata = { title: { default: 'Documentation — Outvexa', template: '%s — Outvexa Docs' }, description: 'Guides and API reference for Outvexa.' };

export default function DocsLayout({ children }: { children: ReactNode }) {
  return <DocsShell nav={docsNav()} index={searchIndex()} apiGroups={apiTags()}>{children}</DocsShell>;
}
