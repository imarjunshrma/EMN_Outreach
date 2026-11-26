import { Redis } from 'ioredis';
import { config } from '../backend/src/core/config.js';
import { db, disconnectDb } from '../backend/src/core/db.js';
import { adapters } from '../backend/src/core/container.js';
import { assertWarmupTestSafety, WARMUP_DEV_WORKSPACE } from '../backend/src/core/warmup-test-safety.js';
import { readSettings } from '../backend/src/services/workspace.js';

if (process.env.OUTVEXA_WARMUP_TEST !== 'dev') throw new Error('Use the original development warm-up launcher.');
assertWarmupTestSafety();
const cfg = config();
const database = new URL(cfg.DATABASE_URL);
const redisUrl = new URL(cfg.REDIS_URL);
const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 0, retryStrategy: () => null });
try {
  const result = await db().$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const [target] = await tx.$queryRaw<{ name: string; migrated: boolean }[]>`
      SELECT current_database() AS name, EXISTS (SELECT 1 FROM "_prisma_migrations"
        WHERE migration_name = '20261127100000_native_warmup' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS migrated`;
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { slug: WARMUP_DEV_WORKSPACE } });
    const s = readSettings(workspace.settings);
    const where = { workspaceId: workspace.id };
    return {
      database: target.name, migrationApplied: target.migrated, workspace: workspace.slug,
      emergencyPause: s.emergencyPause, automaticCampaignSending: s.automaticCampaignSending,
      automaticFollowups: s.automaticFollowups, automaticReplies: s.replyMode === 'auto_narrow',
      automationRules: await tx.automationRule.count({ where }), mailboxes: await tx.emailAccount.count({ where }),
      programs: await tx.warmupProgram.count({ where }), recipients: await tx.warmupRecipient.count({ where }),
      runningCampaigns: await tx.campaign.count({ where: { ...where, status: 'RUNNING' } }),
    };
  });
  const prefix = process.env.QUEUE_PREFIX;
  let cursor = '0';
  let queueKeys = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', '1000');
    cursor = next;
    queueKeys += keys.length;
  } while (cursor !== '0');
  const connection = await redis.ping();
  const services = {
    profile: '.env', environment: cfg.NODE_ENV, databaseHost: database.host, database: result.database,
    redisHost: redisUrl.host, redisDb: redisUrl.pathname.slice(1) || '0', prefix, mode: process.env.OUTVEXA_EMAIL_MODE,
    providers: Object.keys(adapters().email), realOAuth: Object.keys(adapters().oauth).length > 0,
    graphSubscriptions: Boolean(adapters().graphSubscriptions), systemSmtp: Boolean(process.env.SYSTEM_SMTP_URL),
  };
  console.log(JSON.stringify({ api: services, worker: { ...services, allowedJob: 'scheduler/warmup.tick' }, ...result, redis: connection, queueKeys }, null, 2));
  if (!result.migrationApplied || !result.emergencyPause || result.automaticCampaignSending || result.automaticFollowups ||
      result.automaticReplies || result.automationRules || result.mailboxes || result.programs || result.recipients ||
      result.runningCampaigns || connection !== 'PONG' || queueKeys || services.realOAuth || services.graphSubscriptions || services.systemSmtp) process.exitCode = 1;
} finally {
  redis.disconnect();
  await disconnectDb();
}
