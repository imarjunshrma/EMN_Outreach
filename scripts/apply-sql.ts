// Applies prisma/sql/*.sql in name order. Every file must be idempotent.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

try { process.loadEnvFile('.env'); } catch { /* optional */ }
const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const dir = join(process.cwd(), 'prisma', 'sql');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await client.query(readFileSync(join(dir, f), 'utf8'));
    console.log(`applied ${f}`);
  }
} finally {
  await client.end();
}
