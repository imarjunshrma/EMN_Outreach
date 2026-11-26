import { expect, it } from 'vitest';
import { CampaignSendingPolicy, policyTarget } from '../../backend/src/services/deliverability.js';

const gradual = CampaignSendingPolicy.parse({ mode: 'GRADUAL', starting: 2, maximum: 7, increase: 2, qualifyingDays: 3, minimumDailySample: 2 });
it('requires qualifying history and caps gradual progression', () => {
  expect(policyTarget(gradual, 2, true)).toBe(2);
  expect(policyTarget(gradual, 3, true)).toBe(4);
  expect(policyTarget(gradual, 18, true)).toBe(7);
  expect(policyTarget(gradual, 18, false)).toBe(2);
});
it('rejects contradictory policy caps and preserves a manual cap', () => {
  expect(CampaignSendingPolicy.safeParse({ ...gradual, starting: 9 }).success).toBe(false);
  expect(policyTarget({ mode: 'MANUAL', maximum: 3 }, 0, false)).toBe(3);
});

it('keeps mailbox-full and policy bounces separate from permanent recipient suppression', async () => {
  const { bounceFailureClass, providerFailureClass } = await import('../../backend/src/services/deliverability.js');
  expect(bounceFailureClass('5.1.1')).toBe('INVALID_RECIPIENT');
  expect(bounceFailureClass('5.2.2')).toBe('MAILBOX_FULL');
  expect(bounceFailureClass('4.1.0')).toBe('TEMPORARY_RECIPIENT_FAILURE');
  expect(bounceFailureClass('5.7.1')).toBe('POLICY_REJECTION');
  expect(providerFailureClass(429)).toBe('THROTTLED');
  expect(providerFailureClass(undefined)).toBe('CONNECTION_OR_UNKNOWN');
});
