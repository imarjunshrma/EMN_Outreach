import { describe, expect, it } from 'vitest';
import { evaluateProgress, WarmupConfig, WarmupRecipients } from '../../backend/src/services/warmup.js';

const config = WarmupConfig.parse({
  startAt: '2026-11-23T09:00:00Z', durationDays: 21, window: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', timezone: 'UTC' },
  startingTarget: 1, maximumTarget: 4, hourlyLimit: 1, minIntervalSeconds: 600, mode: 'RECOMMENDED', increment: 1,
  observationDays: 3, minimumSample: 3, maxBouncePct: 2, subject: 'Weekly operations update',
  body: 'This is the operations update for our cooperating test mailbox.',
});
describe('controlled warm-up policy', () => {
  it('requires distinct observation days and an accepted sample before progression', () => {
    expect(evaluateProgress(config, 1, 4, 2, 50, 0, 0)).toBe('OBSERVE');
    expect(evaluateProgress(config, 1, 4, 3, 2, 0, 0)).toBe('OBSERVE');
    expect(evaluateProgress(config, 1, 4, 3, 3, 0, 0)).toBe('INCREASE');
  });
  it('holds at the exact bounce threshold and does not finish on time alone', () => {
    expect(evaluateProgress(config, 1, 4, 3, 50, 1, 0)).toBe('HOLD');
    expect(evaluateProgress(config, 1, 21, 1, 3, 0, 0)).toBe('HOLD');
    expect(evaluateProgress(config, 4, 21, 3, 3, 0, 0)).toBe('COMPLETE');
  });
  it('requires affirmative authorization and rejects contradictory quotas', () => {
    expect(WarmupRecipients.safeParse({ recipients: [{ email: 'test@example.test', evidence: 'Written permission', dailyLimit: 1, authorized: false }] }).success).toBe(false);
    expect(WarmupConfig.safeParse({ ...config, startingTarget: 5, maximumTarget: 2 }).success).toBe(false);
  });
});
