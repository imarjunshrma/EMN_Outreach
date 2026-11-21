// Prompt-injection and hallucination guards that do not depend on the model.

/** Wrap third-party text so the model treats it as data. Neutralises attempts to close the tag. */
export function wrapUntrusted(source: string, text: string, maxChars = 30_000): string {
  const cleaned = text
    .slice(0, maxChars)
    .replace(/<\/?\s*untrusted_content[^>]*>/gi, '[tag removed]');
  return `<untrusted_content source="${source.replace(/[^a-z0-9_-]/gi, '')}">\n${cleaned}\n</untrusted_content>`;
}

export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9'"%$.,\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A claim is only kept if its quote appears (normalised) in the cited evidence text. */
export function quoteIsSupported(quote: string, evidenceText: string): boolean {
  const q = normalizeForMatch(quote);
  if (q.length < 8) return false;
  return normalizeForMatch(evidenceText).includes(q);
}

/** Detect unresolved template variables that would leak into an email. */
export function hasUnresolvedVariables(text: string): boolean {
  return /\{\{[^}]*\}\}/.test(text);
}

/** Remove any attempt to open/close our untrusted-content delimiters inside third-party text. */
export function neutralizeTags(text: string): string {
  return text.replace(/<\/?\s*untrusted_content[^>]*>/gi, '[tag removed]').replace(/<\/?\s*document[^>]*>/gi, '[tag removed]');
}

/** Redact contact details and secrets before anything prompt-related is written to logs/DB previews. */
export function redactForLog(text: string): string {
  return text
    .replace(/\b(sk|rk|pk)[-_][A-Za-z0-9_-]{12,}\b/g, '[secret]')
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._-]{16,}/g, 'Bearer [secret]')
    .replace(/\bemn_[a-z0-9]+_[A-Za-z0-9_-]{16,}\b/g, '[api-key]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(?<![\w-])\+?\d[\d\s().-]{8,}\d(?![\w-])/g, '[phone]');
}
