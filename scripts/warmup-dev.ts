import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertWarmupTestSafety, WARMUP_DEV_PREFIX } from '../backend/src/core/warmup-test-safety.js';

const profile = resolve('.env');
const values = parseEnv(readFileSync(profile, 'utf8'));
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, ...values,
  EMN_ENV_FILE: profile, OUTVEXA_WARMUP_TEST: 'dev', OUTVEXA_EMAIL_MODE: 'mock', QUEUE_PREFIX: WARMUP_DEV_PREFIX,
  GRAPH_WEBHOOKS_ENABLED: 'false', EMAIL_VERIFY_SMTP_ENABLED: 'false', EMAIL_VERIFY_CATCH_ALL_ENABLED: 'false',
};
for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'SYSTEM_SMTP_URL']) env[key] = '';
assertWarmupTestSafety(env);
const mode = process.argv[2];
const entry = mode === 'api' ? 'backend/src/main.ts' : mode === 'worker' ? 'worker/src/main.ts'
  : mode === 'verify' ? 'scripts/verify-warmup-dev.ts' : undefined;
if (!entry) throw new Error('Use api, worker, or verify.');
if (mode === 'api' || mode === 'worker') {
  const processes = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' });
  if (processes.split('\n').some(line => /^\s*\d+\s+\S*(?:node|tsx)\b/.test(line) &&
      /(?:^|\s|\/)worker\/src\/main\.(?:ts|js)\b/.test(line))) {
    throw new Error('Stop the existing development worker before starting the shared-database warm-up test.');
  }
}
const child = spawnSync(process.execPath, ['--import', 'tsx', entry], { env, stdio: 'inherit' });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
