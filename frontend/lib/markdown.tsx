import Link from 'next/link';
import type { ReactNode } from 'react';
import { CodeBlock, Callout } from '@/components/docs/blocks';

/**
 * A small, dependency-free Markdown renderer for the documentation site. Supports the subset the
 * docs use: frontmatter, headings (with anchors), paragraphs, lists, fenced code, tables,
 * call-outs (`> [!note]`, `> [!warning]`, `> [!tip]`), step blocks (`:::steps … :::`), and inline
 * code / bold / italic / links. Content is authored in the repository, never by users, and it is
 * rendered as React elements (no raw HTML), so there is no injection surface.
 */

export interface Heading { depth: number; text: string; id: string }
export const slugify = (s: string) => s.toLowerCase().replace(/[`*_]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, ''); }
  return { meta, body: src.slice(m[0].length) };
}

export function inline(text: string, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const key = `${keyBase}-${k++}`;
    if (t.startsWith('`')) out.push(<code key={key}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('**')) out.push(<strong key={key} className="font-bold text-ink">{inline(t.slice(2, -2), key)}</strong>);
    else if (t.startsWith('*')) out.push(<em key={key}>{inline(t.slice(1, -1), key)}</em>);
    else {
      const [, label, href] = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      const external = /^https?:/.test(href);
      out.push(external
        ? <a key={key} href={href} target="_blank" rel="noreferrer" className="font-semibold text-brand-700 underline decoration-brand-200 underline-offset-4 hover:decoration-brand-600">{inline(label, key)}</a>
        : <Link key={key} href={href} className="font-semibold text-brand-700 underline decoration-brand-200 underline-offset-4 hover:decoration-brand-600">{inline(label, key)}</Link>);
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { t: 'h'; depth: number; text: string } | { t: 'p'; text: string } | { t: 'code'; lang: string; code: string; title?: string }
  | { t: 'ul' | 'ol'; items: string[]; start?: number } | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'callout'; kind: string; body: string } | { t: 'steps'; body: string } | { t: 'hr' };

function parse(md: string): Block[] {
  const lines = md.replace(/\r/g, '').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const fence = l.match(/^```(\w+)?(?:\s+title="([^"]+)")?/);
    if (fence) {
      const code: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++; blocks.push({ t: 'code', lang: fence[1] ?? 'text', code: code.join('\n'), title: fence[2] }); continue;
    }
    if (l.trim() === ':::steps') {
      const body: string[] = []; i++;
      while (i < lines.length && lines[i].trim() !== ':::') body.push(lines[i++]);
      i++; blocks.push({ t: 'steps', body: body.join('\n') }); continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) { blocks.push({ t: 'h', depth: h[1].length, text: h[2].trim() }); i++; continue; }
    if (/^---+$/.test(l.trim())) { blocks.push({ t: 'hr' }); i++; continue; }
    if (l.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^>\s?/, ''));
      const kind = body[0]?.match(/^\[!(\w+)\]/)?.[1]?.toLowerCase() ?? 'note';
      if (body[0]?.startsWith('[!')) body[0] = body[0].replace(/^\[!\w+\]\s*/, '');
      blocks.push({ t: 'callout', kind, body: body.join('\n').trim() }); continue;
    }
    if (l.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) { rows.push(lines[i].replace(/^\||\|$/g, '').split('|').map((c) => c.trim())); i++; }
      const [head, , ...body] = rows;
      blocks.push({ t: 'table', head, rows: body }); continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      const items: string[] = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*[-*]\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*[-*]\s+/, '')); else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      blocks.push({ t: 'ul', items }); continue;
    }
    const ol = l.match(/^(\d+)\.\s+/);
    if (ol) {
      const items: string[] = [];
      while (i < lines.length && (/^\d+\.\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\d+\.\s+/.test(lines[i])) items.push(lines[i].replace(/^\d+\.\s+/, '')); else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      blocks.push({ t: 'ol', items, start: Number(ol[1]) }); continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\||\s*[-*]\s+|\d+\.\s+|:::)/.test(lines[i])) para.push(lines[i++].trim());
    blocks.push({ t: 'p', text: para.join(' ') });
  }
  return blocks;
}

export function headingsOf(md: string): Heading[] {
  return parse(md).filter((b): b is Extract<Block, { t: 'h' }> => b.t === 'h' && b.depth >= 2 && b.depth <= 3).map((b) => ({ depth: b.depth, text: b.text.replace(/[`*]/g, ''), id: slugify(b.text) }));
}

export function plainText(md: string): string {
  return md.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*`|[\]()_-]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function Markdown({ source }: { source: string }) {
  return <>{parse(source).map((b, i) => render(b, `b${i}`))}</>;
}

function render(b: Block, key: string): ReactNode {
  switch (b.t) {
    case 'h': {
      const id = slugify(b.text);
      const cls = { 1: 'font-display text-[34px] font-bold tracking-[-0.03em] mt-2 mb-4', 2: 'font-display text-[24px] font-bold tracking-[-0.02em] mt-12 mb-3 pt-2 border-t border-slate-200', 3: 'text-[17px] font-bold mt-8 mb-2', 4: 'text-[15px] font-bold mt-6 mb-2' }[b.depth as 1 | 2 | 3 | 4];
      const Tag = `h${b.depth}` as 'h1';
      return <Tag key={key} id={id} className={`group scroll-mt-24 text-ink ${cls}`}>{inline(b.text, key)}{b.depth > 1 && <a href={`#${id}`} className="ml-2 text-slate-300 opacity-0 transition group-hover:opacity-100" aria-label={`Link to ${b.text}`}>#</a>}</Tag>;
    }
    case 'p': return <p key={key} className="my-4 text-[15.5px] leading-[1.75] text-slate-700">{inline(b.text, key)}</p>;
    case 'hr': return <hr key={key} className="my-10 border-slate-200" />;
    case 'code': return <CodeBlock key={key} lang={b.lang} code={b.code} title={b.title} />;
    case 'ul': return <ul key={key} className="my-4 list-disc space-y-2 pl-6 text-[15.5px] leading-[1.7] text-slate-700 marker:text-brand-500">{b.items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>)}</ul>;
    case 'ol': return <ol key={key} start={b.start} className="my-4 list-decimal space-y-2 pl-6 text-[15.5px] leading-[1.7] text-slate-700 marker:font-bold marker:text-slate-400">{b.items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>)}</ol>;
    case 'table': return (
      <div key={key} className="my-6 overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-left text-[14px]">
          <thead className="bg-paper"><tr>{b.head.map((h, j) => <th key={j} className="border-b border-slate-200 px-4 py-2.5 font-bold text-ink">{inline(h, `${key}-h${j}`)}</th>)}</tr></thead>
          <tbody>{b.rows.map((r, j) => <tr key={j} className="border-b border-slate-100 last:border-0 align-top">{r.map((c, k) => <td key={k} className="px-4 py-2.5 text-slate-700">{inline(c, `${key}-${j}-${k}`)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
    case 'callout': return <Callout key={key} kind={b.kind}><Markdown source={b.body} /></Callout>;
    case 'steps': {
      // Each "### Title" inside :::steps starts a numbered step; the content below it belongs to that step.
      const parts = b.body.split(/^###\s+/m).filter((s) => s.trim());
      return (
        <ol key={key} className="relative my-8 space-y-8 border-l-2 border-slate-200 pl-8">
          {parts.map((p, j) => {
            const [title, ...rest] = p.split('\n');
            return (
              <li key={j} className="relative">
                <span className="absolute -left-[45px] grid h-7 w-7 place-items-center rounded-full bg-ink text-[13px] font-bold text-white tnum" aria-hidden>{j + 1}</span>
                <h3 id={slugify(title)} className="scroll-mt-24 text-[17px] font-bold text-ink">{inline(title.trim(), `${key}-${j}`)}</h3>
                <div className="-mt-2"><Markdown source={rest.join('\n')} /></div>
              </li>
            );
          })}
        </ol>
      );
    }
  }
}
