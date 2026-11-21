// Template rendering for email subjects/bodies.
// Syntax: {{firstName}}, {{company.name}}, {{firstName|there}} (fallback after the pipe).
// Unknown variables without a fallback are reported so campaigns cannot be approved with gaps.

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

export interface RenderResult {
  text: string;
  missing: string[];
}

export function extractVariables(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) out.add(m[1]);
  return [...out];
}

function lookup(vars: Record<string, unknown>, path: string): unknown {
  let cur: unknown = vars;
  for (const part of path.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function renderTemplate(template: string, vars: Record<string, unknown>): RenderResult {
  const missing: string[] = [];
  const text = template.replace(VAR_RE, (_all, name: string, fallback: string | undefined) => {
    const v = lookup(vars, name);
    if (v === undefined || v === null || String(v).trim() === '') {
      if (fallback !== undefined) return fallback;
      missing.push(name);
      return '';
    }
    return String(v);
  });
  return { text, missing: [...new Set(missing)] };
}

/** Variables available to every template. Kept in one place so the UI and validator agree. */
export const STANDARD_VARIABLES = [
  'firstName', 'lastName', 'fullName', 'email', 'title', 'company.name', 'company.website',
  'company.industry', 'city', 'country', 'sender.name', 'sender.email', 'aiFirstLine',
  'bookingLink', 'unsubscribeUrl',
] as const;

export function lintTemplate(template: string, allowCustom: string[] = []): string[] {
  const allowed = new Set<string>([...STANDARD_VARIABLES, ...allowCustom]);
  return extractVariables(template).filter((v) => !allowed.has(v) && !v.startsWith('custom.'));
}
