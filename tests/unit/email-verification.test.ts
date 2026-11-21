import { describe, expect, it, vi } from 'vitest';
import { Resolver } from 'node:dns/promises';
import { calculateEmailRisk, inspectEmail, validateEmailSyntax } from '../../integrations/src/email-verification.js';
import { classifySmtpReply, isPublicMxAddress, probeRecipientSmtp } from '../../integrations/src/email-verification-smtp.js';
import { chooseEmailColumn, csvSafe } from '../../backend/src/services/verification-csv.js';

const resolver = (overrides: Record<string, unknown> = {}) => ({
  resolveMx: vi.fn().mockResolvedValue([{ exchange: 'mx.example.com', priority: 10 }]),
  resolve4: vi.fn().mockResolvedValue(['192.0.2.10']),
  resolve6: vi.fn().mockRejectedValue(Object.assign(new Error('no AAAA'), { code: 'ENODATA' })),
  ...overrides,
}) as unknown as Resolver;

describe('first-party email verification primitives', () => {
  it('normalizes an internationalized domain and rejects malformed addresses with a reason', () => {
    expect(validateEmailSyntax('person@bücher.de').domain).toBe('xn--bcher-kva.de');
    expect(validateEmailSyntax('a..b@example.com')).toMatchObject({ valid: false, reason: expect.any(String) });
    expect(validateEmailSyntax('a@@example.com').valid).toBe(false);
  });

  it('keeps DNS-backed addresses unknown and identifies independent free/role attributes', async () => {
    const result = await inspectEmail('support@gmail.com', resolver());
    expect(result).toMatchObject({ primaryStatus: 'UNKNOWN', dns: { status: 'MX' }, attributes: { freeProvider: true, roleBased: true } });
    expect(result.limitations).toContain('No SMTP recipient probe or email delivery was performed');
  });

  it('recognizes null MX and does not claim a mailbox exists', async () => {
    const result = await inspectEmail('person@example.com', resolver({ resolveMx: vi.fn().mockResolvedValue([{ exchange: '.', priority: 0 }]) }));
    expect(result.dns.status).toBe('NULL_MX');
    expect(result.primaryStatus).toBe('INVALID');
  });

  it('uses A/AAAA fallback only when MX is absent', async () => {
    const result = await inspectEmail('person@example.com', resolver({ resolveMx: vi.fn().mockRejectedValue(Object.assign(new Error('no MX'), { code: 'ENODATA' })) }));
    expect(result.dns.status).toBe('A_FALLBACK');
    expect(result.primaryStatus).toBe('UNKNOWN');
  });

  it('handles an empty MX response as implicit MX fallback and reports NXDOMAIN distinctly', async () => {
    const noMx = await inspectEmail('person@example.com', resolver({ resolveMx: vi.fn().mockResolvedValue([]) }));
    expect(noMx.dns.status).toBe('A_FALLBACK');
    const nx = await inspectEmail('person@missing.example', resolver({ resolveMx: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOTFOUND' })) }));
    expect(nx.dns).toMatchObject({ status: 'NXDOMAIN', error: 'Domain does not resolve' });
    expect(nx.primaryStatus).toBe('INVALID');
  });

  it('treats SMTP acceptance as unconfirmed and classifies temporary and permanent replies conservatively', () => {
    expect(classifySmtpReply('250 2.1.5 Recipient OK').classification).toBe('ACCEPTED_BUT_UNCONFIRMED');
    expect(classifySmtpReply('550 5.1.1 User unknown').classification).toBe('USER_UNKNOWN');
    expect(classifySmtpReply('550 5.7.1 Policy block').classification).toBe('POLICY_REJECTION');
    expect(classifySmtpReply('550 Recipient address rejected: access denied').classification).toBe('POLICY_REJECTION');
    expect(classifySmtpReply('451 4.7.1 Greylisted, try again later').classification).toBe('GREYLISTED');
    expect(classifySmtpReply('451 4.3.0 Temporary failure').classification).toBe('TEMPORARY_FAILURE');
  });

  it('permits SMTP connections only to public MX addresses', () => {
    expect(isPublicMxAddress('127.0.0.1')).toBe(false);
    expect(isPublicMxAddress('10.2.3.4')).toBe(false);
    expect(isPublicMxAddress('192.0.2.10')).toBe(false);
    expect(isPublicMxAddress('8.8.8.8')).toBe(true);
    expect(isPublicMxAddress('2001:4860:4860::8888')).toBe(true);
    expect(isPublicMxAddress('::1')).toBe(false);
  });

  it('uses workspace domain and role dictionaries without removing built-in role tokens', async () => {
    const result = await inspectEmail('procurement@sub.temporary.example', resolver(), 50, { disposableDomains: new Set(['temporary.example']), disposableExclusions: new Set(), roleLocals: new Set(['procurement']) });
    expect(result.attributes).toMatchObject({ disposable: true, roleBased: true });
    const excluded = await inspectEmail('person@temporary.example', resolver(), 50, { disposableDomains: new Set(['temporary.example']), disposableExclusions: new Set(['temporary.example']) });
    expect(excluded.attributes.disposable).toBe(false);
    const builtIn = await inspectEmail('support@example.com', resolver(), 50, { roleLocals: new Set(['procurement']) });
    expect(builtIn.attributes.roleBased).toBe(true);
  });

  it('explains risk without describing it as a delivery probability', async () => {
    const check = await inspectEmail('support@gmail.com', resolver());
    const risk = calculateEmailRisk(check, ['Suppressed in this workspace (COMPLAINT)']);
    expect(risk.score).toBeGreaterThan(0);
    expect(risk.signals).toContain('Suppressed in this workspace (COMPLAINT)');
    expect(risk.meaning).toContain('not a probability');
  });

  it('does not probe SMTP when the feature is disabled', async () => {
    const result = await probeRecipientSmtp({ email: 'person@example.com', domain: 'example.com', mx: [] }, { enabled: false });
    expect(result.classification).toBe('SMTP_UNAVAILABLE');
    expect(result.reason).toMatch(/disabled/);
  });

  it('maps CSV email headers and neutralizes spreadsheet formulas on export', () => {
    expect(chooseEmailColumn(['First name','Email address','Company'])).toBe(1);
    expect(chooseEmailColumn(['Name','Email'], 'Email')).toBe(1);
    expect(chooseEmailColumn(['Name','Email'], '0')).toBe(0);
    expect(csvSafe('=HYPERLINK("https://bad")')).toBe("'=HYPERLINK(\"https://bad\")");
    expect(csvSafe('normal@example.com')).toBe('normal@example.com');
  });
});
