// Prompt builder: renders custom prompt profiles with dynamic variables and conditional blocks.
//
//   {{lead.firstName}}            variable (dotted path)
//   {{lead.title|their role}}     variable with fallback
//   {{#if research.hasClaims}} … {{else}} … {{/if}}
//   {{#unless lead.title}} … {{/unless}}
//   {{#if lead.country == "US"}} … {{/if}}   simple equality test (string literal)
//
// Blocks can nest. Unknown variables are reported (lint) so a profile can't be saved with typos.

export const PROMPT_VARIABLES: Array<{ name: string; description: string }> = [
  { name: 'lead.firstName', description: 'Prospect first name' },
  { name: 'lead.lastName', description: 'Prospect last name' },
  { name: 'lead.fullName', description: 'Prospect full name' },
  { name: 'lead.title', description: 'Job title' },
  { name: 'lead.seniority', description: 'Seniority (from data provider), if known' },
  { name: 'lead.city', description: 'City' },
  { name: 'lead.country', description: 'ISO country code' },
  { name: 'lead.score', description: 'ICP score 0–100, if scored' },
  { name: 'company.name', description: 'Company name' },
  { name: 'company.website', description: 'Company website' },
  { name: 'company.industry', description: 'Industry' },
  { name: 'company.size', description: 'Employee count, if known' },
  { name: 'company.description', description: 'Company description from research' },
  { name: 'research.hasClaims', description: 'true when at least one evidence-backed claim exists' },
  { name: 'research.claimCount', description: 'Number of evidence-backed claims available' },
  { name: 'research.summary', description: 'Research summary (only set when backed by claims)' },
  { name: 'step.order', description: 'Sequence step number (1 = first email)' },
  { name: 'step.isFollowUp', description: 'true for steps after the first' },
  { name: 'campaign.name', description: 'Campaign name' },
  { name: 'icp.name', description: 'ICP linked to the campaign' },
  { name: 'sender.name', description: 'Sender display name' },
  { name: 'our.companyName', description: 'Our company name (AI Studio → Business knowledge)' },
];

const KNOWN = new Set(PROMPT_VARIABLES.map((v) => v.name));

function lookup(vars: Record<string, unknown>, path: string): unknown {
  let cur: unknown = vars;
  for (const part of path.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

function truthy(v: unknown) {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim() !== '' && v !== 'false' && v !== '0';
  return !!v;
}

const COND_RE = /^\s*([a-zA-Z0-9_.]+)\s*(?:(==|!=)\s*"([^"]*)")?\s*$/;

function evalCond(expr: string, vars: Record<string, unknown>, used: Set<string>): boolean {
  const m = COND_RE.exec(expr);
  if (!m) throw new Error(`Invalid condition: ${expr}`);
  used.add(m[1]);
  const v = lookup(vars, m[1]);
  if (!m[2]) return truthy(v);
  const s = v === undefined || v === null ? '' : String(v);
  return m[2] === '==' ? s === m[3] : s !== m[3];
}

type Node = { t: 'text'; v: string } | { t: 'var'; name: string; fallback?: string } | { t: 'if'; cond: string; neg: boolean; then: Node[]; else: Node[] };

const TOKEN_RE = /\{\{\s*(#if|#unless|else|\/if|\/unless)?\s*([^}]*?)\s*\}\}/g;

export function parsePrompt(src: string): Node[] {
  const root: Node[] = [];
  const stack: Array<{ node: Extract<Node, { t: 'if' }>; inElse: boolean; kind: 'if' | 'unless' }> = [];
  const target = () => (stack.length ? (stack[stack.length - 1].inElse ? stack[stack.length - 1].node.else : stack[stack.length - 1].node.then) : root);
  let last = 0;
  for (const m of src.matchAll(TOKEN_RE)) {
    if (m.index! > last) target().push({ t: 'text', v: src.slice(last, m.index) });
    last = m.index! + m[0].length;
    const kw = m[1];
    const arg = m[2];
    if (kw === '#if' || kw === '#unless') {
      const node: Extract<Node, { t: 'if' }> = { t: 'if', cond: arg, neg: kw === '#unless', then: [], else: [] };
      target().push(node);
      stack.push({ node, inElse: false, kind: kw === '#if' ? 'if' : 'unless' });
    } else if (kw === 'else') {
      if (!stack.length) throw new Error('{{else}} without {{#if}}');
      stack[stack.length - 1].inElse = true;
    } else if (kw === '/if' || kw === '/unless') {
      const top = stack.pop();
      if (!top || (kw === '/if' ? 'if' : 'unless') !== top.kind) throw new Error(`Unexpected {{${kw}}}`);
    } else {
      const [name, ...fb] = arg.split('|');
      if (!/^[a-zA-Z0-9_.]+$/.test(name.trim())) throw new Error(`Invalid variable: {{${arg}}}`);
      target().push({ t: 'var', name: name.trim(), fallback: fb.length ? fb.join('|').trim() : undefined });
    }
  }
  if (last < src.length) target().push({ t: 'text', v: src.slice(last) });
  if (stack.length) throw new Error(`Unclosed {{#${stack[stack.length - 1].kind}}}`);
  return root;
}

export interface PromptRender { text: string; missing: string[]; used: string[] }

export function renderPromptTemplate(src: string, vars: Record<string, unknown>): PromptRender {
  const missing = new Set<string>();
  const used = new Set<string>();
  const walk = (nodes: Node[]): string => nodes.map((n) => {
    if (n.t === 'text') return n.v;
    if (n.t === 'var') {
      used.add(n.name);
      const v = lookup(vars, n.name);
      if (v === undefined || v === null || String(v).trim() === '') {
        if (n.fallback !== undefined) return n.fallback;
        missing.add(n.name);
        return '';
      }
      return String(v);
    }
    const ok = evalCond(n.cond, vars, used);
    return walk((n.neg ? !ok : ok) ? n.then : n.else);
  }).join('');
  const text = walk(parsePrompt(src)).replace(/\n{3,}/g, '\n\n').trim();
  return { text, missing: [...missing], used: [...used] };
}

/** Syntax + unknown-variable check (custom.* fields are always allowed). */
export function lintPromptTemplate(src: string): { errors: string[]; unknownVariables: string[] } {
  try {
    const nodes = parsePrompt(src);
    const names = new Set<string>();
    const collect = (ns: Node[]) => ns.forEach((n) => {
      if (n.t === 'var') names.add(n.name);
      if (n.t === 'if') { const m = COND_RE.exec(n.cond); if (!m) throw new Error(`Invalid condition: ${n.cond}`); names.add(m[1]); collect(n.then); collect(n.else); }
    });
    collect(nodes);
    return { errors: [], unknownVariables: [...names].filter((n) => !KNOWN.has(n) && !n.startsWith('lead.custom.')) };
  } catch (e) {
    return { errors: [(e as Error).message], unknownVariables: [] };
  }
}

export const EXAMPLE_PROFILE_PROMPT = `Research this prospect's company and public content. Identify ONE relevant business observation that is backed by the evidence list.
{{#if research.hasClaims}}Use that observation in the opening line and connect it to how our service could help {{company.name|their company}}.{{else}}No research is available: do not reference anything specific about the prospect. Write a short, honest note based only on their role ({{lead.title|their role}}) and our offer.{{/if}}
{{#if step.isFollowUp}}This is a follow-up: do not repeat the previous opening or offer; add one new, useful angle.{{/if}}
Write a short, conversational email. Do not use generic compliments. Do not invent problems. End with one natural question.`;
