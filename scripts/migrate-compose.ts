import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!migrationUrl) throw new Error('DATABASE_MIGRATION_URL is required');

execFileSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit' });

const client = new pg.Client({ connectionString: migrationUrl });
await client.connect();
try {
  await client.query('GRANT CONNECT ON DATABASE emn TO emn_app');
  await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  await client.query('GRANT USAGE ON SCHEMA public TO emn_app');
  for (const file of readdirSync(join(process.cwd(), 'prisma/sql')).filter((f) => f.endsWith('.sql')).sort()) {
    await client.query(readFileSync(join(process.cwd(), 'prisma/sql', file), 'utf8'));
    console.log(`applied ${file}`);
  }
  await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE emn_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO emn_app');
  await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE emn_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO emn_app');
  await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO emn_app');
  await client.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO emn_app');
} finally {
  await client.end();
}

execFileSync(process.execPath, ['--import', 'tsx', 'prisma/seed.ts'], { stdio: 'inherit', env: process.env });
