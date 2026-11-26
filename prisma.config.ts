import { defineConfig } from 'prisma/config';

try { process.loadEnvFile(process.env.EMN_ENV_FILE ?? '.env'); } catch { /* .env is optional; real env vars take precedence */ }

// Migrations run with the owner role (DATABASE_MIGRATION_URL) when provided.
const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || 'postgresql://invalid:invalid@127.0.0.1:5432/invalid';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'node --import tsx prisma/seed.ts' },
  datasource: { url },
});
