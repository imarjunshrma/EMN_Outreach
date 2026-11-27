import { defineConfig } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

function connectionSettings() {
  const local = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
  const database = new URL(process.env.KNOWLEDGE_IMPORT_E2E_DATABASE_URL ?? local.DATABASE_URL ?? 'postgresql://emn:emn@127.0.0.1:5432/postgres');
  if (!process.env.KNOWLEDGE_IMPORT_E2E_DATABASE_URL) database.pathname = '/outvexa_knowledge_import_acceptance';
  const redis = new URL(process.env.KNOWLEDGE_IMPORT_E2E_REDIS_URL ?? local.REDIS_URL ?? 'redis://127.0.0.1:6379');
  if (!process.env.KNOWLEDGE_IMPORT_E2E_REDIS_URL) redis.pathname = '/13';
  const loopback = ['localhost', '127.0.0.1', '[::1]'];
  if (!loopback.includes(database.hostname) || database.pathname !== '/outvexa_knowledge_import_acceptance' || !loopback.includes(redis.hostname) || redis.pathname !== '/13') {
    throw new Error('Knowledge Importer acceptance requires local outvexa_knowledge_import_acceptance and Redis DB 13.');
  }
  return { DATABASE_URL: database.toString(), REDIS_URL: redis.toString() };
}

const webPort = 3105;
const apiPort = 4105;
const env = {
  ...connectionSettings(),
  EMN_ENV_FILE: '/dev/null',
  EMN_SERVICE: 'emn-knowledge-import-e2e',
  KNOWLEDGE_IMPORT_E2E: '1',
  NODE_ENV: 'development',
  API_HOST: '127.0.0.1',
  API_PORT: String(apiPort),
  APP_URL: `http://127.0.0.1:${webPort}`,
  SESSION_SECRET: 'knowledge-import-acceptance-local-session-key-123456789',
  ENCRYPTION_KEYS: `1:${Buffer.alloc(32, 9).toString('base64')}`,
  ENCRYPTION_ACTIVE_KEY: '1',
  STORAGE_ROOT: '/tmp/outvexa-knowledge-import-acceptance',
  REGISTRATION_OPEN: 'true',
  // The synthetic AI provider listens on localhost; sign-up is open here, so private endpoints need the explicit opt-in.
  AI_ALLOW_PRIVATE_ENDPOINTS: 'true',
  LOG_LEVEL: 'warn',
  QUEUE_PREFIX: process.env.KNOWLEDGE_IMPORT_E2E_QUEUE_PREFIX ?? `outvexa-import-e2e-${process.pid}`,
  E2E_REDIS_URL: '',
};
Object.assign(process.env, env);
process.env.KNOWLEDGE_IMPORT_E2E_QUEUE_PREFIX = env.QUEUE_PREFIX;

export default defineConfig({
  testDir: './e2e',
  testMatch: 'knowledge-import.spec.ts',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: env.APP_URL,
    acceptDownloads: true,
    actionTimeout: 15_000,
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    { command: 'node --import tsx backend/src/main.ts', url: `http://127.0.0.1:${apiPort}/healthz`, env, reuseExistingServer: false, timeout: 60_000 },
    {
      command: `npx next dev -p ${webPort} -H 127.0.0.1`,
      cwd: 'frontend',
      url: `${env.APP_URL}/login`,
      env: { EMN_API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`, NODE_ENV: 'development', NEXT_DIST_DIR: '.next-e2e' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
