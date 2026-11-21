import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export { Prisma } from '../generated/prisma/client.js';
export * from '../generated/prisma/enums.js';
export type { PrismaClient };

let client: PrismaClient | null = null;

export function createPrisma(url: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
  return new PrismaClient({ adapter });
}

export function db(): PrismaClient {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    client = createPrisma(url);
  }
  return client;
}

export function setDbForTests(c: PrismaClient) {
  client = c;
}

export async function disconnectDb() {
  if (client) await client.$disconnect();
  client = null;
}
