import { describe, expect, it } from 'vitest';
import { DEFAULT_KNOWLEDGE, KnowledgeSchema, knowledgeText } from '../../shared/src/ai-studio.js';

describe('business knowledge claim readiness', () => {
  it('does not expose a verified case-study flag with unfinished placeholders', () => {
    const knowledge = KnowledgeSchema.parse({
      ...DEFAULT_KNOWLEDGE,
      caseStudies: [{
        title: 'Methodex Health — Case Study',
        summary: 'Work performed: [Enter the exact services delivered]. Reported result: 10 lakh [Specify the exact metric]. Evidence: [Add a supporting report]. Approved usage: Pending human review.',
        result: '',
        url: '',
        verified: true,
      }],
    });

    const text = knowledgeText(knowledge);
    expect(text).not.toContain('Verified case studies (may be referenced)');
    expect(text).not.toContain('Methodex Health');
    expect(text).toContain('unverified case studies/achievements exist');
  });

  it('retains a complete, verified case study and excludes an unverified achievement', () => {
    const knowledge = KnowledgeSchema.parse({
      ...DEFAULT_KNOWLEDGE,
      caseStudies: [{ title: 'Approved study', summary: 'A documented engagement summary.', result: 'Delivered 25 published video assets over 90 days.', url: '', verified: true }],
      achievements: [{ text: '2B+ views across digital platforms.', source: '', verified: false }],
    });

    const text = knowledgeText(knowledge);
    expect(text).toContain('Approved study');
    expect(text).toContain('25 published video assets');
    expect(text).not.toContain('2B+ views');
  });
});
