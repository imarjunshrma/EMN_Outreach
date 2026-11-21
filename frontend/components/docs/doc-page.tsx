import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Markdown, headingsOf } from '@/lib/markdown';
import { allDocs, type Doc } from '@/lib/docs';
import { Toc } from './docs-shell';

const hrefOf = (d: Doc) => (d.slug === 'introduction' ? '/docs' : `/docs/${d.slug}`);

export function DocPage({ doc }: { doc: Doc }) {
  const docs = allDocs();
  const i = docs.findIndex((d) => d.slug === doc.slug);
  const prev = docs[i - 1]; const next = docs[i + 1];
  return (
    <div className="flex gap-10 px-5 py-10 sm:px-10 lg:px-14">
      <article className="min-w-0 max-w-[760px] flex-1" data-testid="doc-article">
        <p className="text-[13px] font-bold text-brand-600">{doc.section}</p>
        <h1 className="font-display mt-1 text-[38px] font-bold leading-tight tracking-[-0.03em] text-ink">{doc.title}</h1>
        {doc.description && <p className="mt-3 text-[18px] leading-relaxed text-slate-600">{doc.description}</p>}
        <div className="mt-6"><Markdown source={doc.body} /></div>
        <nav className="mt-16 grid gap-3 border-t border-slate-200 pt-6 sm:grid-cols-2" aria-label="Previous and next">
          {prev ? <Link href={hrefOf(prev)} className="group rounded-xl border border-slate-200 p-4 hover:border-ink"><span className="flex items-center gap-1 text-[12px] font-semibold text-slate-500"><ChevronLeft className="h-3.5 w-3.5" aria-hidden />Previous</span><span className="mt-1 block font-bold">{prev.title}</span></Link> : <span />}
          {next && <Link href={hrefOf(next)} className="group rounded-xl border border-slate-200 p-4 text-right hover:border-ink"><span className="flex items-center justify-end gap-1 text-[12px] font-semibold text-slate-500">Next<ChevronRight className="h-3.5 w-3.5" aria-hidden /></span><span className="mt-1 block font-bold">{next.title}</span></Link>}
        </nav>
      </article>
      <Toc headings={headingsOf(doc.body)} />
    </div>
  );
}
