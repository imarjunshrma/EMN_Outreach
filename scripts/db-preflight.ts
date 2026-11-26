import { disconnectDb } from '../backend/src/core/db.js';
import { requireDatabaseExtensions } from '../backend/src/core/database-preflight.js';

try { process.loadEnvFile(process.env.EMN_ENV_FILE ?? '.env'); } catch { /* environment can be injected */ }
try {
  await requireDatabaseExtensions();
  console.log('PostgreSQL extension preflight passed.');
} finally {
  await disconnectDb();
}
