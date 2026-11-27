// Test environment: separate database and Redis DB. Never point these at production.
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'http://localhost:3000';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://emn:emn@127.0.0.1:5432/emn_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';
process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough-123456';
process.env.ENCRYPTION_KEYS = `1:${Buffer.alloc(32, 7).toString('base64')},2:${Buffer.alloc(32, 9).toString('base64')}`;
process.env.ENCRYPTION_ACTIVE_KEY = '2';
process.env.STORAGE_ROOT = '/tmp/emn-test-storage';
process.env.LOG_LEVEL = 'silent';
process.env.QUEUE_PREFIX = process.env.TEST_QUEUE_PREFIX ?? 'emntest';
// Production-grade authorization defaults for tests must not inherit permissive local .env flags.
process.env.PLATFORM_MFA_REQUIRED = 'true';
process.env.AI_SUBSCRIPTION_ACCESS = 'owners';
// The warm-up test-safety guard (backend/src/core/warmup-test-safety.ts) only lets test mode run with explicit mock
// email and no real mail or OAuth credentials. Declare that profile here so `npm test` works without shell flags;
// the guard still rejects any non-loopback database or Redis target.
process.env.OUTVEXA_WARMUP_TEST = '1';
process.env.OUTVEXA_EMAIL_MODE = 'mock';
process.env.GRAPH_WEBHOOKS_ENABLED = 'false';
process.env.EMAIL_VERIFY_SMTP_ENABLED = 'false';
process.env.DATABASE_MIGRATION_URL = process.env.DATABASE_URL;
for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'SYSTEM_SMTP_URL']) delete process.env[key];
