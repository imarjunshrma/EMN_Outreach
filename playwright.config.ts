import { defineConfig } from '@playwright/test';

// Browser tests against the real API + built Next.js frontend, with a dedicated database (emn_e2e)
// and Redis DB 14. Run: npm run test:e2e  (requires `npm run build:frontend` first and a local Chrome/Chromium;
// set CHROME_PATH or run `npx playwright install chromium`). External providers are not contacted.
const API_PORT = 4100;
const WEB_PORT = 3100;
const env = {
  NODE_ENV: 'development', APP_URL: `http://127.0.0.1:${WEB_PORT}`, API_PORT: String(API_PORT), API_HOST: '127.0.0.1',
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgresql://emn:emn@127.0.0.1:5432/emn_e2e', REDIS_URL: process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/14',
  SESSION_SECRET: 'e2e-session-secret-that-is-long-enough-1234567890', ENCRYPTION_KEYS: `1:${Buffer.alloc(32, 3).toString('base64')}`, ENCRYPTION_ACTIVE_KEY: '1',
  STORAGE_ROOT: '/tmp/emn-e2e-storage', REGISTRATION_OPEN: 'true', LOG_LEVEL: 'warn', QUEUE_PREFIX: 'emne2e', EMN_API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`,
};

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'e2e-results.json' }]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    { command: 'node --import tsx backend/src/main.ts', url: `http://127.0.0.1:${API_PORT}/healthz`, env, reuseExistingServer: false, timeout: 60_000 },
    { command: `npx next start -p ${WEB_PORT} -H 127.0.0.1`, cwd: 'frontend', url: `http://127.0.0.1:${WEB_PORT}/login`, env: { EMN_API_INTERNAL_URL: env.EMN_API_INTERNAL_URL, NODE_ENV: 'production', NEXT_DIST_DIR: '.next-e2e' }, reuseExistingServer: false, timeout: 60_000 },
  ],
});
