import { readFileSync } from 'node:fs';
import path from 'node:path';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { SiteShell } from '@/components/site/site-shell';
import { Markdown, parseFrontmatter } from '@/lib/markdown';

const DOCS = ['terms', 'privacy', 'acceptable-use'] as const;
export const dynamicParams = false;
export function generateStaticParams() { return DOCS.map((doc) => ({ doc })); }

function load(doc: string) {
  if (!(DOCS as readonly string[]).includes(doc)) return null;
  return parseFrontmatter(readFileSync(path.join(process.cwd(), 'content', 'legal', `${doc}.md`), 'utf8'));
}
export async function generateMetadata({ params }: { params: Promise<{ doc: string }> }): Promise<Metadata> {
  const d = load((await params).doc);
  return d ? { title: `${d.meta.title} — EMN Outreach OS` } : {};
}
export default async function Legal({ params }: { params: Promise<{ doc: string }> }) {
  const d = load((await params).doc);
  if (!d) notFound();
  return (
    <SiteShell>
      <article className="mx-auto max-w-[720px] px-5 py-16">
        <h1 className="font-display text-[40px] font-bold tracking-[-0.03em]">{d.meta.title}</h1>
        <p className="mt-2 text-sm text-slate-500">Last updated {d.meta.updated}</p>
        <div className="mt-8"><Markdown source={d.body} /></div>
      </article>
    </SiteShell>
  );
}
