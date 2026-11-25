/** URL identity for fetched evidence. Query strings and resource paths can change content. */
export function sourceUrlKey(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

/** Legacy evidence only stored the final URL. Match bare/www aliases for the site root only. */
export function sameResearchHomepage(requested: string, stored: string): boolean {
  const left = sourceUrlKey(requested);
  const right = sourceUrlKey(stored);
  if (!left || !right) return false;
  if (left === right) return true;
  const a = new URL(left);
  const b = new URL(right);
  return a.pathname === '/' && b.pathname === '/' && !a.search && !b.search && !a.port && !b.port &&
    (a.protocol === b.protocol || (a.protocol === 'http:' && b.protocol === 'https:')) &&
    a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '');
}
