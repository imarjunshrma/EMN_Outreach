import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertWarmupTestSafety } from '../backend/src/core/warmup-test-safety.js';

const profile = resolve('.env.warmup-local');
const values = parseEnv(readFileSync(profile, 'utf8'));
const env = { PATH: process.env.PATH, ...values, EMN_ENV_FILE: profile };
if (values.OUTVEXA_WARMUP_TEST !== '1') throw new Error('Missing warm-up test profile marker.');
assertWarmupTestSafety(env);
const commands: Record<string, string[]> = {
  api: ['--import', 'tsx', 'backend/src/main.ts'],
  worker: ['--import', 'tsx', 'worker/src/main.ts'],
  migrate: ['--import', 'tsx', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'],
  'apply-sql': ['--import', 'tsx', 'scripts/apply-sql.ts'],
  verify: ['--import', 'tsx', 'scripts/verify-warmup-local.ts'],
};
const command = commands[process.argv[2] ?? ''];
if (!command) throw new Error('Use api, worker, migrate, apply-sql, or verify.');
const child = spawnSync(process.execPath, command, { env, stdio: 'inherit' });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
