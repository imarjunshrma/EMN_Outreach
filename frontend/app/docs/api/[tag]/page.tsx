import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { apiOperations, apiTags } from '@/lib/docs';
import { ApiOperation, MethodBadge } from '@/components/docs/api-op';

export const dynamicParams = false;
export function generateStaticParams() { return apiTags().flatMap((g) => g.tags.map((t) => ({ tag: t.slug }))); }
export async function generateMetadata({ params }: { params: Promise<{ tag: string }> }): Promise<Metadata> {
  const { tag } = await params;
  const t = apiTags().flatMap((g) => g.tags).find((x) => x.slug === tag);
  return t ? { title: `${t.tag} API` } : {};
}

export default async function ApiTag({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  const ops = apiOperations().filter((o) => o.tagSlug === tag);
  if (!ops.length) notFound();
  return (
    <div className="max-w-[1180px] px-5 py-10 sm:px-10 lg:px-14">
      <p className="text-[13px] font-bold text-brand-600">API reference</p>
      <h1 className="font-display mt-1 text-[38px] font-bold tracking-[-0.03em]">{ops[0].tag}</h1>
      <p className="mt-2 text-slate-600">{ops.length} endpoint{ops.length === 1 ? '' : 's'}. All paths are relative to your installation, for example <code>https://app.example.com</code>.</p>
      <ul className="mt-6 space-y-1 rounded-xl border border-slate-200 bg-paper p-4">
        {ops.map((o) => <li key={o.id}><a href={`#${o.id}`} className="flex items-center gap-3 rounded-md px-2 py-1 text-[13.5px] hover:bg-white"><MethodBadge method={o.method} /><code className="!bg-transparent !p-0 text-ink">{o.path}</code><span className="hidden truncate text-slate-500 md:inline">{o.summary}</span></a></li>)}
      </ul>
      {ops.map((o) => <ApiOperation key={o.id} op={o} />)}
    </div>
  );
}
