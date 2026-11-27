import { appendFileSync, mkdirSync } from 'node:fs';
import { AppError } from './errors.js';
import type { EmailProvider, EmailProviderName } from '../../../integrations/src/email/types.js';

export const browserE2e = () => process.env.OUTVEXA_BROWSER_E2E !== undefined ||
  [process.env.DATABASE_URL, process.env.DATABASE_MIGRATION_URL].some(value => value?.includes('/outvexa_browser_e2e'));
export const E2E_QUEUE_PREFIX = 'outvexa-browser-e2e';
export const E2E_STORAGE_ROOT = '/private/tmp/outvexa-browser-e2e';

export function assertBrowserE2eSafety(env: NodeJS.ProcessEnv = process.env) {
  const targets = [env.DATABASE_URL, env.DATABASE_MIGRATION_URL];
  const dedicated = targets.some(value => value?.includes('/outvexa_browser_e2e'));
  if (!dedicated && env.OUTVEXA_BROWSER_E2E === undefined) return false;
  const validDatabase = (value?: string) => {
    try {
      const url = new URL(value ?? '');
      return ['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1' &&
        url.port === '5432' && url.pathname === '/outvexa_browser_e2e' && url.username === 'outvexa_browser_e2e' && !url.search && !url.hash;
    } catch { return false; }
  };
  if (env.OUTVEXA_BROWSER_E2E !== '1' || env.NODE_ENV !== 'development' || env.EMN_ENV_FILE !== '/dev/null' ||
      !validDatabase(env.DATABASE_URL) || (env.DATABASE_MIGRATION_URL !== undefined && !validDatabase(env.DATABASE_MIGRATION_URL)) ||
      env.API_HOST !== '127.0.0.1' || env.REDIS_URL !== 'redis://127.0.0.1:6387/0' ||
      env.QUEUE_PREFIX !== E2E_QUEUE_PREFIX || env.STORAGE_ROOT !== E2E_STORAGE_ROOT ||
      env.OUTVEXA_EMAIL_MODE !== 'mock' || (env.STORAGE_DRIVER && env.STORAGE_DRIVER !== 'local') ||
      ['SYSTEM_SMTP_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'].some(key => env[key]) ||
      env.GRAPH_WEBHOOKS_ENABLED !== 'false' || env.EMAIL_VERIFY_SMTP_ENABLED !== 'false' || env.EMAIL_VERIFY_CATCH_ALL_ENABLED !== 'false') {
    throw new Error('Browser E2E safety requires the isolated database, Redis, loopback API, mock email and disabled external email configuration.');
  }
  return true;
}

export function blockBrowserE2eDelivery(operation: string) {
  if (!browserE2e()) return;
  assertBrowserE2eSafety();
  mkdirSync(E2E_STORAGE_ROOT, { recursive: true, mode: 0o700 });
  appendFileSync(`${E2E_STORAGE_ROOT}/blocked-delivery.jsonl`, JSON.stringify({ at: new Date().toISOString(), operation }) + '\n', { mode: 0o600 });
  throw new AppError('E2E_DELIVERY_BLOCKED', 'Delivery and mailbox connections are disabled in browser E2E.', 403);
}

export function browserE2eEmail(name: EmailProviderName): EmailProvider {
  return {
    name,
    async testConnection() { blockBrowserE2eDelivery('provider.connect'); throw new Error('Browser E2E provider is offline'); },
    async send() { blockBrowserE2eDelivery('provider.send'); throw new Error('Browser E2E provider is offline'); },
    async findSentByOutboundId() { return null; },
    async sync(_auth, cursor) { return { messages: [], nextCursor: cursor ?? 'browser-e2e' }; },
  };
}

const draftQueues = new Set(['import', 'knowledge-import', 'ai', 'research', 'personalize']);
export function guardBrowserE2eQueue(queue: string, boundary: 'publish' | 'process') {
  if (!draftQueues.has(queue)) blockBrowserE2eDelivery(`queue.${boundary}.${queue}`);
}
