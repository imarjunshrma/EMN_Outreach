import type { ReactNode } from 'react';
import { PlatformShell } from '@/components/platform/shell';

export const metadata = { title: 'EMN Platform', robots: { index: false } };
export default function PlatformLayout({ children }: { children: ReactNode }) { return <PlatformShell>{children}</PlatformShell>; }
