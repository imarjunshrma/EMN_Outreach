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

// Only the greeting itself ("Hi {{firstName|there}},", "Hello Priya!"), never the rest of that line.
const GREETING = /^\s*(hi|hello|hey|dear|good (morning|afternoon|evening)|greetings)\b(\s+(\{\{[^}]*\}\}|[\p{L}.'-]+)){0,3}\s*[,!:.\u2014-]?/iu;
const SIGN_OFF = /^\s*(best|best regards|regards|kind regards|warm regards|thanks|thank you|many thanks|cheers|sincerely|talk soon|--)\b[^\n]{0,40}$/i;
const PLACEHOLDER = /^\s*(…|\.{2,}|-+|_+|x{3,}|tbd|todo|lorem ipsum.*)\s*$|\[(write|your|add|insert|type|enter)[^\]]*\]|<(write|your|add|insert)[^>]*>/im;

/**
 * Why an email body is not a real message, or null when it is. Used before approval and again right before
 * anything is sent, so a starter placeholder, an empty AI result or a greeting-plus-sign-off is never mailed.
 * Works on templates ({{variables}} are ignored) and on rendered text.
 */
export function bodyContentProblem(body: string): string | null {
  const text = (body ?? '').replace(/\r\n/g, '\n');
  if (!text.trim()) return 'The email body is empty';
  if (PLACEHOLDER.test(text)) return 'The email body still contains placeholder text (such as "…" or "[Write your message here]")';
  const lines = text.split('\n');
  const cut = lines.findIndex((l, i) => i > 0 && SIGN_OFF.test(l)); // the sign-off and everything after it (name, signature)
  const core = (cut >= 0 ? lines.slice(0, cut) : lines).map((l, i) => (i === 0 ? l.replace(GREETING, '') : l)).join(' ');
  const letters = core.replace(/\{\{[^}]*\}\}/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
  if (letters.length < 4) return 'The email body has no message between the greeting and the sign-off';
  return null;
}
