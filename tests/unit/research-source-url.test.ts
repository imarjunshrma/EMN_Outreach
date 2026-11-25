import { describe, expect, it } from 'vitest';
import { sameResearchHomepage, sourceUrlKey } from '../../integrations/src/research/source-url.js';

describe('research source URL identity', () => {
  it('normalizes casing, default ports, root trailing slash and fragments', () => {
    expect(sourceUrlKey('https://EXAMPLE.com:443#top')).toBe('https://example.com/');
    expect(sameResearchHomepage('https://EXAMPLE.com:443#top', 'https://www.example.com/')).toBe(true);
    expect(sameResearchHomepage('http://example.com:80', 'https://www.example.com/')).toBe(true);
  });

  it('keeps path, query, non-default port and non-homepage host differences', () => {
    expect(sourceUrlKey('https://example.com/articles?id=4#top')).toBe('https://example.com/articles?id=4');
    expect(sameResearchHomepage('https://example.com/?market=us', 'https://www.example.com/?market=ca')).toBe(false);
    expect(sameResearchHomepage('https://example.com/team', 'https://www.example.com/team')).toBe(false);
    expect(sameResearchHomepage('https://example.com/team', 'https://example.com/team/')).toBe(false);
    expect(sameResearchHomepage('https://example.com:8443/', 'https://www.example.com/')).toBe(false);
    expect(sourceUrlKey('https://user:password@example.com/')).toBeNull();
  });
});
