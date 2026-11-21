import { describe, expect, it } from 'vitest';
import { renderTemplate, extractVariables, lintTemplate } from '../../shared/src/template.js';
import { isInWindow, nextWindowStart, computeNextStepAt } from '../../shared/src/schedule.js';
import { evaluateCompliance, DEFAULT_COMPLIANCE_RULES, resolveRule } from '../../shared/src/compliance.js';
import { hasRole } from '../../shared/src/permissions.js';
import { checkRuleTriggerTerms, deriveLearningCandidates, findRuleConflicts, renderRelevantExamples, retrieveRelevantExamples } from '../../shared/src/outreach-brain.js';
import { classifyMailboxHealth } from '../../shared/src/mailbox-health.js';

describe('template rendering', () => {
  it('renders nested vars, fallbacks and reports missing', () => {
    const r = renderTemplate('Hi {{firstName|there}}, {{company.name}} {{custom.niche}} {{missing}}', { firstName: '', company: { name: 'Acme' }, custom: { niche: 'podcasts' } });
    expect(r.text).toBe('Hi there, Acme podcasts ');
    expect(r.missing).toEqual(['missing']);
  });
  it('extracts and lints variables', () => {
    expect(extractVariables('{{a}} {{ b.c }} {{a}}')).toEqual(['a', 'b.c']);
    expect(lintTemplate('{{firstName}} {{custom.x}} {{bogus}}')).toEqual(['bogus']);
  });
});

describe('sending windows & time zones', () => {
  const win = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };
  it('detects inside/outside window in the recipient zone', () => {
    // 2026-11-23 is a Monday. 14:00 UTC = 09:00 New York.
    expect(isInWindow(new Date('2026-11-23T14:00:00Z'), win, 'America/New_York')).toBe(true);
    expect(isInWindow(new Date('2026-11-23T13:59:00Z'), win, 'America/New_York')).toBe(false);
  });
  it('moves Friday evening sends to Monday morning (business days only)', () => {
    const next = nextWindowStart(new Date('2026-11-27T20:00:00Z'), win, 'Europe/London'); // Friday 20:00 London
    expect(next.toISOString()).toBe('2026-11-30T09:00:00.000Z');
  });
  it('computes follow-up dates from delays', () => {
    const next = computeNextStepAt(new Date('2026-11-23T10:00:00Z'), 3, win, 'UTC');
    expect(next.toISOString()).toBe('2026-11-26T10:00:00.000Z');
  });
  it('falls back to UTC for invalid zones', () => {
    expect(nextWindowStart(new Date('2026-11-23T10:00:00Z'), win, 'Not/AZone').toISOString()).toBe('2026-11-23T10:00:00.000Z');
  });
});

describe('compliance rules (technical safeguards)', () => {
  it('blocks restricted countries by default and EU group membership', () => {
    expect(evaluateCompliance(DEFAULT_COMPLIANCE_RULES, { country: 'CA', lawfulBasis: 'CONSENT', workspaceHasPostalAddress: true }).allowed).toBe(false);
    expect(resolveRule(DEFAULT_COMPLIANCE_RULES, 'DE')?.countryCode).toBe('EU');
    expect(evaluateCompliance(DEFAULT_COMPLIANCE_RULES, { country: null, lawfulBasis: 'CONSENT', workspaceHasPostalAddress: true }).allowed).toBe(false);
  });
  it('requires lawful basis and postal address', () => {
    const ok = evaluateCompliance(DEFAULT_COMPLIANCE_RULES, { country: 'US', lawfulBasis: 'LEGITIMATE_INTEREST', workspaceHasPostalAddress: true });
    expect(ok.allowed).toBe(true);
    const noAddr = evaluateCompliance(DEFAULT_COMPLIANCE_RULES, { country: 'US', lawfulBasis: 'LEGITIMATE_INTEREST', workspaceHasPostalAddress: false });
    expect(noAddr.reasons.join()).toMatch(/postal address/);
    expect(evaluateCompliance(DEFAULT_COMPLIANCE_RULES, { country: 'GB', lawfulBasis: 'UNKNOWN', workspaceHasPostalAddress: true }).allowed).toBe(false);
  });
});

describe('roles', () => {
  it('ranks roles', () => {
    expect(hasRole('ADMIN', 'MANAGER')).toBe(true);
    expect(hasRole('MEMBER', 'MANAGER')).toBe(false);
  });
});

describe('AI Outreach Brain deterministic helpers', () => {
  it('warns on same-category rules with opposite direction and ignores inactive rules', () => {
    const avoid = { id: 'a', title: 'Fake urgency', description: 'Never use false urgency', category: 'EMAIL_OPENING', priority: 'AVOID' };
    const conflict = { id: 'b', title: 'Fake urgency', description: 'Use false urgency', category: 'EMAIL_OPENING', priority: 'PREFERRED' };
    expect(findRuleConflicts([avoid, conflict])).toHaveLength(1);
    expect(findRuleConflicts([avoid, { ...conflict, status: 'INACTIVE' }])).toHaveLength(0);
  });
  it('retrieves bounded positive and negative examples and marks them untrusted', () => {
    const examples = [
      { id: 'p1', name: 'Founder case', content: 'A thoughtful founder email about product launch', category: 'EMAIL_BODY', polarity: 'POSITIVE' },
      { id: 'n1', name: 'Bad launch pitch', content: 'Generic product launch founder email', category: 'EMAIL_BODY', polarity: 'NEGATIVE' },
      { id: 'off', name: 'Unrelated', content: 'gardening and soil', category: 'EMAIL_BODY', polarity: 'POSITIVE' },
    ];
    const selected = retrieveRelevantExamples(examples, 'founder product launch');
    expect(selected.map((e) => e.id)).toContain('p1');
    expect(selected.map((e) => e.id)).toContain('n1');
    expect(selected.map((e) => e.id)).not.toContain('off');
    expect(renderRelevantExamples(selected)).toContain('<untrusted_content');
  });
  it('blocks only configured deterministic trigger terms on active avoid/mandatory rules', () => {
    const checks = checkRuleTriggerTerms([
      { id: 'a', title: 'No guaranteed results', description: 'Avoid promising outcomes', category: 'DELIVERABILITY_COMPLIANCE', priority: 'AVOID', triggerTerms: ['guarantee'] },
      { id: 'i', title: 'Old rule', description: 'inactive', category: 'DELIVERABILITY_COMPLIANCE', priority: 'AVOID', status: 'INACTIVE', triggerTerms: ['guarantee'] },
    ], 'We guarantee results');
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('fail');
  });
  it('suggests a preference only after repeated matching global edits', () => {
    const event = { originalContent: { body: 'I hope this finds you well. We should book a meeting call.' }, finalContent: { body: 'Your launch looks interesting.' }, changedFields: ['body'] };
    expect(deriveLearningCandidates([event, event], 3)).toEqual([]);
    expect(deriveLearningCandidates([event, event, event], 3).map((s) => s.signature)).toContain('remove-generic-opening');
  });
});

describe('measured mailbox health classification', () => {
  const now = new Date('2026-11-21T12:00:00.000Z');
  const healthy = { connectionStatus: 'CONNECTED', sent30d: 100, hardBounces30d: 1, complaints30d: 0, domainHealth: 'HEALTHY', domainVerified: true, lastSyncedAt: '2026-11-21T11:00:00.000Z', lastErrorAt: null, now };
  it('reports Healthy only for connected, verified and recent measured signals', () => {
    expect(classifyMailboxHealth(healthy).status).toBe('Healthy');
  });
  it('distinguishes limited evidence, provider risk, pause and lost authorization', () => {
    expect(classifyMailboxHealth({ ...healthy, sent30d: 0 }).status).toBe('Monitoring');
    expect(classifyMailboxHealth({ ...healthy, complaints30d: 1 }).status).toBe('Warning');
    expect(classifyMailboxHealth({ ...healthy, connectionStatus: 'PAUSED' }).status).toBe('Paused');
    expect(classifyMailboxHealth({ ...healthy, connectionStatus: 'NEEDS_REAUTH' }).status).toBe('Disconnected');
  });
  it('states that classification is not inbox-placement measurement', () => {
    expect(classifyMailboxHealth(healthy).disclaimer).toMatch(/does not measure spam placement/);
  });
});
