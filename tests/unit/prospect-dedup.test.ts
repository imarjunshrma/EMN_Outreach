import { describe, expect, it } from 'vitest';
import { canonicalLinkedInProfile } from '../../backend/src/services/leads.js';

describe('prospect profile deduplication', () => {
  it('canonicalizes the same LinkedIn profile across host, case, query, and slash variants', () => {
    expect(canonicalLinkedInProfile('https://www.linkedin.com/in/Arjun-Kumar/?trk=abc')).toBe('linkedin.com/in/arjun-kumar');
    expect(canonicalLinkedInProfile('linkedin.com/in/arjun-kumar')).toBe('linkedin.com/in/arjun-kumar');
  });

  it('does not infer profile identity from a name or accept non-profile URLs', () => {
    expect(canonicalLinkedInProfile('https://linkedin.com/company/example')).toBeNull();
    expect(canonicalLinkedInProfile('https://example.com/in/arjun-kumar')).toBeNull();
    expect(canonicalLinkedInProfile(null)).toBeNull();
  });
});
