import { describe, expect, it } from 'vitest';
import { emailVerificationPolicyReasons } from '../../backend/src/services/compliance.js';

const settings = {
  verificationFreshnessDays: 90,
  verificationUnknownPolicy: 'hold',
  verificationDisposablePolicy: 'block',
  verificationRolePolicy: 'review',
} as const;
const fresh = new Date('2026-11-20T00:00:00Z');
const now = new Date('2026-11-21T00:00:00Z').getTime();

describe('campaign email verification safety policy', () => {
  it('holds unknown results by default, including fresh first-party checks', () => {
    expect(emailVerificationPolicyReasons({ status: 'UNKNOWN', verifiedAt: fresh }, settings, now)).toContain('email not eligible for sending (UNKNOWN)');
  });

  it('allows unknown only when explicitly configured and the result is fresh', () => {
    const explicit = { ...settings, verificationUnknownPolicy: 'allow' } as const;
    expect(emailVerificationPolicyReasons({ status: 'UNKNOWN', verifiedAt: fresh }, explicit, now)).toEqual([]);
    expect(emailVerificationPolicyReasons({ status: 'UNKNOWN', verifiedAt: null }, explicit, now)).toContain('email verification is stale or has no verification timestamp');
  });

  it('blocks invalid and disposable addresses regardless of otherwise eligible status', () => {
    expect(emailVerificationPolicyReasons({ status: 'INVALID', verifiedAt: fresh }, settings, now)).toContain('email verified as invalid');
    expect(emailVerificationPolicyReasons({ status: 'VALID', verifiedAt: fresh, disposable: true }, settings, now)).toContain('email uses a known disposable domain');
  });

  it('holds role-based addresses unless the workspace explicitly allows them', () => {
    expect(emailVerificationPolicyReasons({ status: 'VALID', verifiedAt: fresh, roleBased: true }, settings, now)).toContain('role-based address policy is review');
    expect(emailVerificationPolicyReasons({ status: 'VALID', verifiedAt: fresh, roleBased: true }, { ...settings, verificationRolePolicy: 'allow' }, now)).toEqual([]);
  });

  it('rejects stale otherwise-valid results', () => {
    const stale = new Date(now - 91 * 86_400_000);
    expect(emailVerificationPolicyReasons({ status: 'VALID', verifiedAt: stale }, settings, now)).toContain('email verification is stale or has no verification timestamp');
  });
});
