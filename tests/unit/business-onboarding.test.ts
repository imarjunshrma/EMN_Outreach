import { describe, expect, it } from 'vitest';
import { selectIntakePages } from '../../backend/src/services/business-onboarding.js';

describe('business website intake page selection', () => {
  it('keeps the crawl on the supplied host, drops fragments, and deduplicates', () => {
    const result = selectIntakePages(
      'https://example.com/',
      ['https://example.com/services#offers', 'https://other.example/case-studies'],
      ['/about', 'https://example.com/services?utm_source=x', '/about'],
    );
    expect(result).toEqual(['https://example.com/', 'https://example.com/services', 'https://example.com/about']);
  });

  it('caps the work to six pages', () => {
    const links = Array.from({ length: 20 }, (_, i) => `https://example.com/services/${i}`);
    expect(selectIntakePages('https://example.com', [], links)).toHaveLength(6);
  });

  it('rejects unsafe root schemes and ignores cross-host crawl candidates', () => {
    expect(() => selectIntakePages('file:///etc/passwd', [], [])).toThrow();
    expect(() => selectIntakePages('https://example.com', ['https://other.example/services'], [])).not.toThrow();
    expect(selectIntakePages('https://example.com', ['https://other.example/services'], [])).toEqual(['https://example.com/']);
  });
});
