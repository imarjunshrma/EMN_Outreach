import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { DocPage } from '@/components/docs/doc-page';
import { allDocs, getDoc } from '@/lib/docs';

export const dynamicParams = false;
export function generateStaticParams() { return allDocs().filter((d) => d.slug !== 'introduction').map((d) => ({ slug: d.slug })); }
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const d = getDoc((await params).slug);
  return d ? { title: d.title, description: d.description } : {};
}
export default async function Doc({ params }: { params: Promise<{ slug: string }> }) {
  const doc = getDoc((await params).slug);
  if (!doc) notFound();
  return <DocPage doc={doc} />;
}
