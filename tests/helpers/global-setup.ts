import { execSync } from 'node:child_process';

// Applies migrations + raw SQL to the test database once per run.
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://emn:emn@127.0.0.1:5432/emn_test';
  const env = { ...process.env, DATABASE_URL: url, DATABASE_MIGRATION_URL: url };
  execSync('npx prisma migrate deploy', { env, stdio: 'pipe' });
  execSync('node --import tsx scripts/apply-sql.ts', { env, stdio: 'pipe' });
}
