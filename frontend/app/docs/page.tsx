import { notFound } from 'next/navigation';
import { DocPage } from '@/components/docs/doc-page';
import { getDoc } from '@/lib/docs';

export default function DocsHome() {
  const doc = getDoc('introduction');
  if (!doc) notFound();
  return <DocPage doc={doc} />;
}
