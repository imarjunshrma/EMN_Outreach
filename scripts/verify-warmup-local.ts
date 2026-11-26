import { Redis } from 'ioredis';
import { config } from '../backend/src/core/config.js';
import { db, disconnectDb } from '../backend/src/core/db.js';
import { adapters } from '../backend/src/core/container.js';
import { assertWarmupTestSafety } from '../backend/src/core/warmup-test-safety.js';
import { readSettings } from '../backend/src/services/workspace.js';

if (process.env.OUTVEXA_WARMUP_TEST !== '1') throw new Error('Use the isolated warm-up launcher.');
assertWarmupTestSafety();
const cfg = config();
const dbUrl = new URL(cfg.DATABASE_URL);
const redisUrl = new URL(cfg.REDIS_URL);
const redis = new Redis(cfg.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
try {
  const result = await db().$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const [target] = await tx.$queryRaw<{ database: string }[]>`SELECT current_database() AS database`;
    const [migration] = await tx.$queryRaw<{ applied: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261127100000_native_warmup'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied
    `;
    const workspaces = (await tx.workspace.findMany({ select: { settings: true } })).map(row => readSettings(row.settings));
    return {
      database: target.database,
      warmupMigrationApplied: migration.applied,
      workspaceCount: workspaces.length,
      automaticCampaignSending: workspaces.some(s => s.automaticCampaignSending),
      automaticFollowups: workspaces.some(s => s.automaticFollowups),
      automaticReplies: workspaces.some(s => s.replyMode === 'auto_narrow'),
      emergencyPause: workspaces.every(s => s.emergencyPause),
      automationRules: await tx.automationRule.count(),
      mailboxes: await tx.emailAccount.count(),
      providerCredentials: await tx.providerCredential.count(),
      programs: await tx.warmupProgram.count(),
      recipients: await tx.warmupRecipient.count(),
      runningCampaigns: await tx.campaign.count({ where: { status: 'RUNNING' } }),
    };
  });
  const status = await redis.ping();
  const redisKeys = await redis.dbsize();
  const services = {
    databaseHost: dbUrl.hostname, databasePort: dbUrl.port, database: result.database, environment: cfg.NODE_ENV,
    redisHost: redisUrl.hostname, redisPort: redisUrl.port, redisDb: redisUrl.pathname.slice(1),
    bullMqPrefix: process.env.QUEUE_PREFIX, emailMode: process.env.OUTVEXA_EMAIL_MODE,
    providerAdapters: Object.keys(adapters().email), oauthProviders: Object.keys(adapters().oauth),
    graphSubscriptions: Boolean(adapters().graphSubscriptions),
  };
  console.log(JSON.stringify({ api: services, worker: services, ...result, redis: status, redisKeys }, null, 2));
  if (!result.warmupMigrationApplied || result.workspaceCount !== 1 || !result.emergencyPause ||
      result.automaticCampaignSending || result.automaticFollowups || result.automaticReplies || result.automationRules ||
      result.mailboxes || result.providerCredentials || result.programs || result.recipients || result.runningCampaigns ||
      status !== 'PONG' || redisKeys !== 0) process.exitCode = 1;
} finally {
  redis.disconnect();
  await disconnectDb();
}
