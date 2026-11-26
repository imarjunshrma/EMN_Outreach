import { requireDatabaseExtensions } from './core/database-preflight.js';
import { config } from './core/config.js';
import { createApp } from './app.js';
import { logger } from './core/logger.js';
import { disconnectDb } from './core/db.js';
import { closeRedis } from './core/redis.js';
import { closeQueues } from './core/queues.js';
import { keyring } from './core/crypto.js';

process.env.EMN_SERVICE ??= 'emn-api';
const cfg = config(); // validates env and exits on misconfiguration
keyring(); // validates encryption keys at boot
await requireDatabaseExtensions();

const server = createApp().listen(cfg.API_PORT, cfg.API_HOST, () => logger.info({ port: cfg.API_PORT }, 'Outvexa API listening'));
server.headersTimeout = 65_000;
server.requestTimeout = 120_000;

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down API');
  server.close();
  (await import('./services/ai-subscriptions.js')).shutdownSubscriptionLogins();
  const force = setTimeout(() => process.exit(1), 15_000);
  await Promise.allSettled([closeQueues(), closeRedis(), disconnectDb()]);
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (e) => logger.error({ err: e }, 'unhandled rejection'));
