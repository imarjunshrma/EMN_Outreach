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
process.env.QUEUE_PREFIX = 'emntest';
