import { Worker } from 'bullmq';
import { config } from '../../backend/src/core/config.js';
import { logger } from '../../backend/src/core/logger.js';
import { newRedis, closeRedis } from '../../backend/src/core/redis.js';
import { disconnectDb } from '../../backend/src/core/db.js';
import { closeQueues, queue, QUEUES, type QueueName } from '../../backend/src/core/queues.js';
import { keyring } from '../../backend/src/core/crypto.js';
import { processorFor, HANDLERS } from './processors.js';

process.env.EMN_SERVICE ??= 'emn-worker';
const cfg = config();
keyring();

const CONCURRENCY: Partial<Record<QueueName, number>> = {
  [QUEUES.send]: cfg.WORKER_CONCURRENCY_SEND,
  [QUEUES.prepare]: 4,
  [QUEUES.sync]: 4,
  [QUEUES.ai]: 4,
  [QUEUES.research]: 2,
  [QUEUES.imports]: 1,
  [QUEUES.scheduler]: 1,
  [QUEUES.webhooks]: 4,
  [QUEUES.replySend]: 2,
  [QUEUES.personalize]: 3,
  // Real per-provider concurrency (default 1 for subscriptions) is enforced by the AI settings slot limiter.
  [QUEUES.aiClaude]: 2,
  [QUEUES.aiCodex]: 2,
  [QUEUES.aiApi]: 4,
};

const workers: Worker[] = [];
for (const name of Object.keys(HANDLERS) as QueueName[]) {
  if (Object.keys(HANDLERS[name]).length === 0) continue;
  const w = new Worker(name, processorFor(name), {
    connection: newRedis(), concurrency: name === QUEUES.verify ? cfg.EMAIL_VERIFY_WORKER_CONCURRENCY : CONCURRENCY[name] ?? 2, prefix: process.env.QUEUE_PREFIX ?? 'emn',
    settings: { backoffStrategy: (attempt, type) => {
      if (type !== 'emnVerify') return -1;
      const base = cfg.EMAIL_VERIFY_RETRY_DELAYS_MS[Math.min(attempt - 1, cfg.EMAIL_VERIFY_RETRY_DELAYS_MS.length - 1)];
      return Math.round(base * (0.9 + Math.random() * 0.2));
    } },
  });
  w.on('failed', (job, err) => {
    const final = !!job && job.attemptsMade >= (job.opts.attempts ?? 1);
    // Final failures are "dead letters": kept by BullMQ for 7 days, listed in /platform/operations, retryable by staff.
    logger[final ? 'error' : 'warn']({ queue: name, job: job?.name, jobId: job?.id, attempts: job?.attemptsMade, deadLetter: final, err: err.message }, final ? 'job dead-lettered' : 'job failed');
  });
  w.on('error', (err) => logger.error({ queue: name, err }, 'worker error'));
  workers.push(w);
}

// Repeatable schedules (idempotent upserts)
async function schedules() {
  await queue(QUEUES.scheduler).upsertJobScheduler('campaign-tick', { every: 60_000 }, { name: 'campaign.tick', data: {} });
  await queue(QUEUES.sync).upsertJobScheduler('mailbox-poll', { every: 120_000 }, { name: 'sync.pollAll', data: {} });
  await queue(QUEUES.sync).upsertJobScheduler('graph-renew', { every: 12 * 3600_000 }, { name: 'graph.renew', data: {} });
  await queue(QUEUES.domain).upsertJobScheduler('domain-daily', { pattern: '17 3 * * *' }, { name: 'domain.checkAll', data: {} });
  await queue(QUEUES.automation).upsertJobScheduler('workflow-daily', { pattern: '11 6 * * *' }, { name: 'workflow.daily', data: {} });
  await queue(QUEUES.domain).upsertJobScheduler('domain-renewals', { pattern: '7 4 * * *' }, { name: 'domain.renewals', data: {} });
  await queue(QUEUES.maintenance).upsertJobScheduler('retention-nightly', { pattern: '43 2 * * *' }, { name: 'maintenance.retention', data: {} });
  await queue(QUEUES.maintenance).upsertJobScheduler('reports-daily', { pattern: '29 7 * * *' }, { name: 'reports.daily', data: {} });
  await queue(QUEUES.maintenance).upsertJobScheduler('tenant-sync', { every: 15 * 60_000 }, { name: 'tenant.sync', data: {} });
  await queue(QUEUES.maintenance).upsertJobScheduler('storage-reconcile', { pattern: '37 0 * * *' }, { name: 'storage.reconcile', data: {} });
  await queue(QUEUES.maintenance).upsertJobScheduler('billing-reconcile', { pattern: '53 */6 * * *' }, { name: 'billing.reconcile', data: {} });
  await queue(QUEUES.maintenance).upsertJobScheduler('ai-subscription-limits', { pattern: '*/5 * * * *' }, { name: 'aiSubscriptions.refreshLimits', data: {} });
  await queue(QUEUES.maintenance).upsertJobScheduler('tenant-purge', { pattern: '23 1 * * *' }, { name: 'tenant.purge', data: {} });
  await queue(QUEUES.maintenance).upsertJobScheduler('task-reminders', { every: 300_000 }, { name: 'maintenance.taskReminders', data: {} });
  await queue(QUEUES.maintenance).upsertJobScheduler('verification-datasets-daily', { pattern: '41 2 * * *' }, { name: 'emailVerification.datasets.refresh', data: {} });
  await queue(QUEUES.maintenance).upsertJobScheduler('mailbox-readiness-daily', { pattern: '31 5 * * *' }, { name: 'maintenance.mailboxReadiness', data: {} });
}
schedules()
  .then(async () => { const r = await (await import('../../backend/src/services/ai-workflow-runs.js')).recoverAiRuns(); if (r.requeued) logger.info(r, 'AI workflow runs recovered after restart'); })
  .then(() => logger.info({ queues: workers.length }, 'EMN worker started')).catch((e) => { logger.fatal({ err: e }, 'failed to register schedules'); process.exit(1); });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'worker draining active jobs');
  const force = setTimeout(() => process.exit(1), 60_000);
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([closeQueues(), closeRedis(), disconnectDb()]);
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (e) => logger.error({ err: e }, 'unhandled rejection'));
