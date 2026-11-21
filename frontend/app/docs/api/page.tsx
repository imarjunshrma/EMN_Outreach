import Link from 'next/link';
import type { Metadata } from 'next';
import { apiErrors, apiOperations, apiTags, apiVersion } from '@/lib/docs';
import { CodeBlock } from '@/components/docs/blocks';

export const metadata: Metadata = { title: 'API reference' };

export default function ApiIndex() {
  const groups = apiTags();
  return (
    <div className="max-w-[1000px] px-5 py-10 sm:px-10 lg:px-14">
      <p className="text-[13px] font-bold text-brand-600">Developers</p>
      <h1 className="font-display mt-1 text-[38px] font-bold tracking-[-0.03em]">API reference</h1>
      <p className="mt-3 max-w-2xl text-[17px] leading-relaxed text-slate-600">Every endpoint the web app uses is part of this API — {apiOperations().length} operations, generated from the server’s route registry (version {apiVersion()}). Start with <Link className="font-semibold text-brand-700 underline" href="/docs/api-overview">authentication and conventions</Link>, or download the <a className="font-semibold text-brand-700 underline" href="/api/v1/openapi.json">OpenAPI 3.1 document</a>.</p>
      <CodeBlock lang="bash" title="Your first request" code={`curl https://app.example.com/api/v1/w/$WORKSPACE_ID/leads?pageSize=5 \\\n  -H "Authorization: Bearer $EMN_API_KEY"`} />
      <div className="mt-10 grid gap-8 sm:grid-cols-2">
        {groups.map((g) => (
          <div key={g.group}>
            <h2 className="text-[15px] font-bold text-ink">{g.group}</h2>
            <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200">
              {g.tags.map((t) => <li key={t.slug}><Link href={`/docs/api/${t.slug}`} className="flex justify-between px-4 py-2.5 text-[14px] hover:bg-paper"><span className="font-semibold">{t.tag}</span><span className="text-slate-400 tnum">{t.count}</span></Link></li>)}
            </ul>
          </div>
        ))}
      </div>
      <h2 id="errors" className="font-display mt-14 scroll-mt-24 text-[24px] font-bold">Error codes</h2>
      <p className="mt-2 text-slate-600">Errors use one shape: <code>{'{ "error": { "code", "message", "details", "requestId" } }'}</code>. Match on <code>code</code>, never on the message text.</p>
      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-left text-[13.5px]"><tbody>{apiErrors().map(([c, d]) => <tr key={c} className="border-b border-slate-100 last:border-0"><td className="px-4 py-2"><code className="font-semibold">{c}</code></td><td className="px-4 py-2 text-slate-600">{d}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}
