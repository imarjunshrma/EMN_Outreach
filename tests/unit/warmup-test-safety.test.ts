import { describe, expect, it } from 'vitest';
import { assertWarmupTestSafety } from '../../backend/src/core/warmup-test-safety.js';

const db = 'postgresql://outvexa_warmup_local@127.0.0.1:5432/emn_outvexa_warmup_local';
const isolated = {
  OUTVEXA_WARMUP_TEST: '1', OUTVEXA_EMAIL_MODE: 'mock', NODE_ENV: 'test',
  DATABASE_URL: db, DATABASE_MIGRATION_URL: db, REDIS_URL: 'redis://127.0.0.1:6379/13',
  QUEUE_PREFIX: 'emn-warmup-local', GRAPH_WEBHOOKS_ENABLED: 'false', EMAIL_VERIFY_SMTP_ENABLED: 'false',
};

describe('local warm-up startup fence', () => {
  it('accepts the dedicated mock profile and leaves ordinary startup configuration alone', () => {
    expect(() => assertWarmupTestSafety(isolated)).not.toThrow();
    expect(() => assertWarmupTestSafety({ NODE_ENV: 'production' })).not.toThrow();
  });

  it.each([
    { DATABASE_URL: db.replace('emn_outvexa_warmup_local', 'emn_dev') },
    { DATABASE_MIGRATION_URL: db.replace('127.0.0.1', 'production.example') },
    { NODE_ENV: 'production' },
    { OUTVEXA_EMAIL_MODE: 'real' },
    { OUTVEXA_WARMUP_TEST: undefined, OUTVEXA_EMAIL_MODE: undefined },
    { REDIS_URL: 'redis://127.0.0.1:6379/0' },
    { QUEUE_PREFIX: 'emn' },
    { GOOGLE_CLIENT_ID: 'fixture' },
    { SYSTEM_SMTP_URL: 'smtp://fixture.example' },
  ])('rejects unsafe override %#', change => {
    expect(() => assertWarmupTestSafety({ ...isolated, ...change })).toThrow();
  });
});

describe('original development warm-up profile', () => {
  const original = {
    ...isolated, NODE_ENV: 'development', EMN_ENV_FILE: '/repo/.env', OUTVEXA_WARMUP_TEST: 'dev',
    DATABASE_URL: 'postgresql://fixture@127.0.0.1:5432/emn_dev',
    DATABASE_MIGRATION_URL: 'postgresql://fixture@127.0.0.1:5432/emn_dev',
    REDIS_URL: 'redis://127.0.0.1:6379/0', QUEUE_PREFIX: 'emn-warmup-dev-test',
  };
  it('accepts the original stack only with the dedicated mock override', () => {
    expect(() => assertWarmupTestSafety(original)).not.toThrow();
    expect(() => assertWarmupTestSafety({ ...original, OUTVEXA_EMAIL_MODE: 'real' })).toThrow();
    expect(() => assertWarmupTestSafety({ ...original, QUEUE_PREFIX: 'emn' })).toThrow();
    expect(() => assertWarmupTestSafety({ ...original, EMN_ENV_FILE: '/repo/.env.warmup-local' })).toThrow();
  });
});
