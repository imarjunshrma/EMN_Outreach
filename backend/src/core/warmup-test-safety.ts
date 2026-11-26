import { basename } from 'node:path';
import type { EmailProvider, EmailProviderName } from '../../../integrations/src/email/types.js';

export const WARMUP_DEV_WORKSPACE = 'outvexa-native-warmup-dev-test';
export const WARMUP_DEV_PREFIX = 'emn-warmup-dev-test';

export function assertWarmupTestSafety(env: NodeJS.ProcessEnv = process.env) {
  const dedicatedTarget = [env.DATABASE_URL, env.DATABASE_MIGRATION_URL].some(value => value?.includes('/emn_outvexa_warmup_local'));
  if (!dedicatedTarget && !env.EMN_ENV_FILE?.endsWith('.env.warmup-local') && env.OUTVEXA_WARMUP_TEST === undefined && env.OUTVEXA_EMAIL_MODE === undefined) return;
  const fail = () => { throw new Error('Warm-up test requires test mode, mock-only providers, and the dedicated loopback database and queue namespace.'); };
  const dev = env.OUTVEXA_WARMUP_TEST === 'dev';
  if ((!dev && env.OUTVEXA_WARMUP_TEST !== '1') || env.OUTVEXA_EMAIL_MODE !== 'mock' || env.NODE_ENV !== (dev ? 'development' : 'test')) fail();
  if (dev && (!env.EMN_ENV_FILE || basename(env.EMN_ENV_FILE) !== '.env')) fail();
  const parse = (value: string | undefined) => { try { return new URL(value ?? ''); } catch { throw new Error('Warm-up test target is missing or invalid.'); } };
  for (const value of [env.DATABASE_URL, (dev ? env.DATABASE_MIGRATION_URL || env.DATABASE_URL : env.DATABASE_MIGRATION_URL)]) {
    const db = parse(value);
    if (!['postgresql:', 'postgres:'].includes(db.protocol) || db.hostname !== '127.0.0.1' || db.port !== '5432' ||
        db.pathname !== (dev ? '/emn_dev' : '/emn_outvexa_warmup_local') || (!dev && db.username !== 'outvexa_warmup_local') || db.search || db.hash) fail();
  }
  const redis = parse(env.REDIS_URL);
  if (dev) {
    if (redis.protocol !== 'redis:' || redis.hostname !== '127.0.0.1' || redis.port !== '6379' ||
        !['', '/', '/0'].includes(redis.pathname) || redis.search || redis.hash || env.QUEUE_PREFIX !== WARMUP_DEV_PREFIX) fail();
  } else if (redis.href !== 'redis://127.0.0.1:6379/13' || env.QUEUE_PREFIX !== 'emn-warmup-local') fail();
  if (['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'SYSTEM_SMTP_URL'].some(key => !!env[key]) ||
      !['false', '0'].includes(env.GRAPH_WEBHOOKS_ENABLED ?? '') ||
      !['false', '0'].includes(env.EMAIL_VERIFY_SMTP_ENABLED ?? '')) fail();
}

export function mockWarmupEmail(name: EmailProviderName): EmailProvider {
  return {
    name,
    async testConnection(auth) { return { email: auth.email, providerAccountId: 'local-warmup-mock' }; },
    async send(_auth, message) {
      return { providerMessageId: `mock:${message.messageId}`, providerThreadId: message.messageId, internetMessageId: message.messageId };
    },
    async findSentByOutboundId() { return null; },
    async sync(_auth, cursor) { return { messages: [], nextCursor: cursor ?? 'mock' }; },
  };
}
