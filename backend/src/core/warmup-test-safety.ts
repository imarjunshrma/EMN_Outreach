import type { EmailProvider, EmailProviderName } from '../../../integrations/src/email/types.js';

export function assertWarmupTestSafety(env: NodeJS.ProcessEnv = process.env) {
  const dedicatedTarget = [env.DATABASE_URL, env.DATABASE_MIGRATION_URL].some(value => value?.includes('/emn_outvexa_warmup_local'));
  const testProfile = env.NODE_ENV === 'test' || dedicatedTarget || env.EMN_ENV_FILE?.endsWith('.env.warmup-local') || env.OUTVEXA_WARMUP_TEST !== undefined || env.OUTVEXA_EMAIL_MODE !== undefined;
  if (!testProfile) return;
  const fail = () => { throw new Error('Test mode requires isolated loopback database/Redis targets and explicit mock email providers.'); };
  if (env.OUTVEXA_WARMUP_TEST !== '1' || env.OUTVEXA_EMAIL_MODE !== 'mock' || env.NODE_ENV !== 'test') fail();
  const parse = (value: string | undefined) => { try { return new URL(value ?? ''); } catch { throw new Error('Warm-up test target is missing or invalid.'); } };
  const allowedDb = new Map([['/emn_outvexa_warmup_local', 'outvexa_warmup_local'], ['/emn_test', 'emn']]);
  for (const value of [env.DATABASE_URL, env.DATABASE_MIGRATION_URL]) {
    const db = parse(value);
    if (!['postgresql:', 'postgres:'].includes(db.protocol) || db.hostname !== '127.0.0.1' || db.port !== '5432' ||
        !allowedDb.has(db.pathname) || db.username !== allowedDb.get(db.pathname) || db.search || db.hash) fail();
  }
  const redisHref = parse(env.REDIS_URL).href;
  if (!new Set(['redis://127.0.0.1:6379/13', 'redis://127.0.0.1:6379/15']).has(redisHref) ||
      !new Set(['emn-warmup-local', 'emntest']).has(env.QUEUE_PREFIX ?? '')) fail();
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
