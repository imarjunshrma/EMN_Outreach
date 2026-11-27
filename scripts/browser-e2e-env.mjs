// Pass only fixture settings to child processes. Never load the workspace's .env.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const storage = '/private/tmp/outvexa-browser-e2e';
mkdirSync(storage, { recursive: true, mode: 0o700 });
const passwordFile = `${storage}/fixture-password`;
try { writeFileSync(passwordFile, randomBytes(24).toString('hex'), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }

const database = 'postgresql://outvexa_browser_e2e@127.0.0.1:5432/outvexa_browser_e2e';
const secret = readFileSync(passwordFile, 'utf8');
const env = {
  PATH: process.env.PATH, NODE_ENV: 'development', EMN_ENV_FILE: '/dev/null',
  OUTVEXA_BROWSER_E2E: '1', OUTVEXA_EMAIL_MODE: 'mock',
  DATABASE_URL: database, DATABASE_MIGRATION_URL: database, REDIS_URL: 'redis://127.0.0.1:6387/0',
  QUEUE_PREFIX: 'outvexa-browser-e2e', STORAGE_ROOT: storage,
  API_PORT: '4128', API_HOST: '127.0.0.1', APP_URL: 'http://127.0.0.1:3128',
  SESSION_SECRET: secret, ENCRYPTION_KEYS: `1:${Buffer.from(secret.slice(0, 32)).toString('base64')}`,
  GRAPH_WEBHOOKS_ENABLED: 'false', EMAIL_VERIFY_SMTP_ENABLED: 'false', EMAIL_VERIFY_CATCH_ALL_ENABLED: 'false',
  REGISTRATION_OPEN: 'false', PLATFORM_MFA_REQUIRED: 'false', LOG_LEVEL: 'warn',
  NEXT_DIST_DIR: '.next-e2e', EMN_API_INTERNAL_URL: 'http://127.0.0.1:4128', NEXT_TELEMETRY_DISABLED: '1',
};
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Pass a command to run under the isolated browser profile.');
const child = spawn(command, args, { env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
