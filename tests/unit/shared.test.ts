import { describe, expect, it } from 'vitest';
import { renderTemplate, extractVariables, lintTemplate } from '../../shared/src/template.js';
import { isInWindow, nextWindowStart, computeNextStepAt } from '../../shared/src/schedule.js';
import { evaluateCompliance, DEFAULT_COMPLIANCE_RULES, resolveRule } from '../../shared/src/compliance.js';
import { hasRole } from '../../shared/src/permissions.js';

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
