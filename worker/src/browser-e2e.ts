import { Worker } from 'bullmq';
import { appendFileSync } from 'node:fs';
import { assertBrowserE2eSafety, blockBrowserE2eDelivery, E2E_QUEUE_PREFIX, E2E_STORAGE_ROOT } from '../../backend/src/core/browser-e2e-safety.js';
import { requireDatabaseExtensions } from '../../backend/src/core/database-preflight.js';
import { db, disconnectDb } from '../../backend/src/core/db.js';
import { closeQueues, QUEUES } from '../../backend/src/core/queues.js';
import { closeRedis, newRedis } from '../../backend/src/core/redis.js';
import { processorFor } from './processors.js';

if (!assertBrowserE2eSafety()) throw new Error('The draft worker requires the isolated browser E2E profile.');
await requireDatabaseExtensions();
if (await db().providerCredential.count() || await db().emailAccount.count({ where: { status: { not: 'DISCONNECTED' } } })) {
  throw new Error('The draft worker requires an offline mailbox fixture with no credentials.');
}
const allowlist = [
  [QUEUES.imports, ['import.csv']],
  [QUEUES.research, ['research.lead', 'research.company']],
  [QUEUES.ai, ['ai.qualify']],
  [QUEUES.personalize, ['personalize.lead', 'personalize.single']],
] as const;

const workers = allowlist.map(([queue, jobs]) => {
  const permitted = new Set<string>(jobs);
  const processJob = processorFor(queue);
  return new Worker(queue, async (job, token) => {
    const record = (status: string, detail?: unknown) => appendFileSync(
      `${E2E_STORAGE_ROOT}/draft-jobs.jsonl`,
      JSON.stringify({ at: new Date().toISOString(), queue, job: job.name, id: job.id, attempt: job.attemptsMade + 1, status, detail }) + '\n',
      { mode: 0o600 },
    );
    record('started');
    try {
      if (!permitted.has(job.name)) blockBrowserE2eDelivery(`draft-worker.${queue}.${job.name}`);
      const result = await processJob(job, token);
      record('completed', result);
      return result;
    } catch (error) {
      record('rejected', (error as Error).message);
      throw error;
    }
  }, { connection: newRedis(), prefix: E2E_QUEUE_PREFIX }).on('error', error => console.error(queue, error.message));
});

async function shutdown() {
  const timeout = setTimeout(() => process.exit(1), 30_000);
  await Promise.allSettled(workers.map(worker => worker.close()));
  await Promise.allSettled([closeQueues(), closeRedis(), disconnectDb()]);
  clearTimeout(timeout);
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
await Promise.all(workers.map(worker => worker.waitUntilReady()));
console.log('Isolated browser E2E draft worker ready.');
