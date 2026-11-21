// Seed global reference data. Workspace defaults (compliance rules, prompts) are created when a
// workspace is created. Safe to run repeatedly.
import { createPrisma } from '../backend/src/core/db.js';

try { process.loadEnvFile('.env'); } catch { /* optional */ }
const prisma = createPrisma(process.env.DATABASE_URL!);

// Prices in USD per million tokens. These are editable in AI Settings → Prices; verify them against
// the provider's current pricing page before relying on cost reports. OpenAI models are not seeded:
// add the models you configure (costs show as unpriced estimates until you do).
const PRICES = [
  { provider: 'ANTHROPIC' as const, model: 'claude-haiku-5-5', inputPerMTokUsd: 0.1, outputPerMTokUsd: 0.5, cachedInputPerMTokUsd: 0.01 },
  { provider: 'ANTHROPIC' as const, model: 'claude-sonnet-5-5', inputPerMTokUsd: 2, outputPerMTokUsd: 10, cachedInputPerMTokUsd: 0.1 },
  { provider: 'ANTHROPIC' as const, model: 'claude-opus-5-5', inputPerMTokUsd: 4, outputPerMTokUsd: 20, cachedInputPerMTokUsd: null },
];

const effectiveFrom = new Date('2026-10-01T00:00:00Z');
for (const p of PRICES) {
  await prisma.aiModelPrice.upsert({
    where: { provider_model_effectiveFrom: { provider: p.provider, model: p.model, effectiveFrom } },
    update: {},
    create: { ...p, effectiveFrom },
  });
}
console.log(`seeded ${PRICES.length} model prices`);
await prisma.$disconnect();
