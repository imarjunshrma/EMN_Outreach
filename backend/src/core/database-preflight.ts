import { db } from './db.js';

export async function requireDatabaseExtensions() {
  const extensions = await db().$queryRaw<{ extname: string }[]>`
    SELECT extname::text FROM pg_extension WHERE extname = 'vector'
  `;
  if (!extensions.length) {
    throw new Error('Required PostgreSQL extension missing: vector. Provision pgvector in the target database using an administrator role, then retry.');
  }
}
