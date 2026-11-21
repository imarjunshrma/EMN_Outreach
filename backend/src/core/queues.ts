import { Queue, type JobsOptions } from 'bullmq';
import { newRedis } from './redis.js';

// Queue names and producers. Processors live in worker/src.

export const QUEUES = {
  scheduler: 'scheduler',
  prepare: 'outbound-prepare',
  send: 'send',
  replySend: 'reply-send',
  sync: 'mailbox-sync',
  ai: 'ai',
  research: 'research',
  imports: 'import',
  verify: 'verify',
  domain: 'domain-health',
  maintenance: 'maintenance',
  automation: 'automation',
  webhooks: 'webhooks',
  privacy: 'privacy',
  personalize: 'personalize',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

const DEFAULTS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 5_000 },
  removeOnFail: { age: 7 * 86_400 },
};

const queues = new Map<string, Queue>();
let connection: ReturnType<typeof newRedis> | null = null;

export function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    connection ??= newRedis();
    q = new Queue(name, { connection, defaultJobOptions: DEFAULTS, prefix: process.env.QUEUE_PREFIX ?? 'emn' });
    queues.set(name, q);
  }
  return q;
}

export async function enqueue(name: QueueName, jobName: string, data: Record<string, unknown>, opts: JobsOptions = {}) {
  return queue(name).add(jobName, data, opts);
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  if (connection) { await connection.quit().catch(() => undefined); connection = null; }
}

export const ALL_QUEUE_NAMES = Object.values(QUEUES);
