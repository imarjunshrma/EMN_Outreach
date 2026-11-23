import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { adapters } from '../core/container.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { decryptSecret, encryptSecret } from './workspace.js';

// Third-party provider credentials (lead data, verification, web search, Smartlead, booking).

export const INTEGRATION_TYPES = ['apollo', 'millionverifier', 'zerobounce', 'neverbounce', 'hunter', 'brave', 'serper', 'smartlead', 'booking', 'cloudflare'] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

export const INTEGRATION_INFO: Record<IntegrationType, { label: string; category: string; secretLabel: string; publicFields: string[]; docs: string }> = {
  apollo: { label: 'Apollo.io', category: 'Lead data', secretLabel: 'API key', publicFields: ['searchPath'], docs: 'Prospect search + email enrichment (consumes Apollo credits). Verify endpoint paths against current Apollo API docs.' },
  millionverifier: { label: 'MillionVerifier', category: 'Email verification', secretLabel: 'API key', publicFields: [], docs: 'Single-email verification API (consumes credits).' },
  zerobounce: { label: 'ZeroBounce', category: 'Email verification', secretLabel: 'API key', publicFields: [], docs: 'Waterfall verifier (credits per check).' },
  neverbounce: { label: 'NeverBounce', category: 'Email verification', secretLabel: 'API key', publicFields: [], docs: 'Waterfall verifier (credits per check).' },
  hunter: { label: 'Hunter.io (email finder)', category: 'Email discovery', secretLabel: 'API key', publicFields: [], docs: 'Finds a likely work email from name + company domain. Discovered emails are always verified before use.' },
  cloudflare: { label: 'Cloudflare DNS', category: 'Domains', secretLabel: 'API token (Zone.DNS edit)', publicFields: [], docs: 'Reads and creates DNS records (verification TXT, SPF, DMARC) only when you click to apply them. Cannot register domains.' },
  brave: { label: 'Brave Search API', category: 'Web search', secretLabel: 'Subscription token', publicFields: [], docs: 'Used by research to find public pages about a company.' },
  serper: { label: 'Serper.dev', category: 'Web search', secretLabel: 'API key', publicFields: [], docs: 'Alternative web-search provider for research.' },
  smartlead: { label: 'Smartlead (optional)', category: 'Export', secretLabel: 'API key', publicFields: [], docs: 'Optional: push a lead list into an existing Smartlead campaign. Not required by Outvexa.' },
  booking: { label: 'Booking webhook (Cal.com / Calendly)', category: 'Calendar', secretLabel: 'Webhook signing secret', publicFields: ['bookingLink'], docs: 'Point your booking tool webhook to /api/v1/hooks/booking/<workspaceId>. Marks the lead MEETING_BOOKED.' },
};

export const IntegrationUpsertSchema = z.object({
  type: z.enum(INTEGRATION_TYPES),
  secret: z.string().min(4).max(500).optional(),
  publicConfig: z.record(z.string(), z.string()).optional(),
  isEnabled: z.boolean().optional(),
});

export async function listIntegrations(workspaceId: string) {
  const rows = await db().integration.findMany({ where: { workspaceId } });
  return INTEGRATION_TYPES.map((type) => {
    const r = rows.find((x) => x.type === type);
    return { type, ...INTEGRATION_INFO[type], configured: !!r?.encryptedConfig, isEnabled: r?.isEnabled ?? false, publicConfig: r?.publicConfig ?? {}, lastTestedAt: r?.lastTestedAt ?? null, lastTestOk: r?.lastTestOk ?? null, lastError: r?.lastError ?? null };
  });
}

export async function upsertIntegration(workspaceId: string, input: z.infer<typeof IntegrationUpsertSchema>, actor: Actor) {
  await (await import('./entitlements.js')).ws.integration(workspaceId, input.type);
  const existing = await db().integration.findUnique({ where: { workspaceId_type: { workspaceId, type: input.type } } });
  if (!existing && !input.secret) throw new AppError('VALIDATION_FAILED', 'Secret/API key is required', 400);
  const data = {
    ...(input.secret ? { encryptedConfig: encryptSecret(input.secret.trim()), lastTestOk: null } : {}),
    ...(input.publicConfig ? { publicConfig: input.publicConfig as Prisma.InputJsonValue } : {}),
    ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
  };
  const r = existing
    ? await db().integration.update({ where: { id: existing.id }, data })
    : await db().integration.create({ data: { workspaceId, type: input.type, encryptedConfig: encryptSecret(input.secret!.trim()), publicConfig: (input.publicConfig ?? {}) as Prisma.InputJsonValue, isEnabled: input.isEnabled ?? true } });
  await audit(workspaceId, actor, input.secret ? 'integration.secret_updated' : 'integration.updated', { type: 'integration', id: r.id }, { type: input.type });
  return { type: r.type, isEnabled: r.isEnabled, configured: true };
}

export async function deleteIntegration(workspaceId: string, type: IntegrationType, actor: Actor) {
  await db().integration.deleteMany({ where: { workspaceId, type } });
  await audit(workspaceId, actor, 'integration.removed', undefined, { type });
}

export async function getSecret(workspaceId: string, type: IntegrationType): Promise<{ secret: string; publicConfig: Record<string, string> } | null> {
  const r = await db().integration.findUnique({ where: { workspaceId_type: { workspaceId, type } } });
  if (!r || !r.isEnabled || !r.encryptedConfig) return null;
  return { secret: decryptSecret(r.encryptedConfig), publicConfig: (r.publicConfig ?? {}) as Record<string, string> };
}

export async function requireSecret(workspaceId: string, type: IntegrationType) {
  const s = await getSecret(workspaceId, type);
  if (!s) throw new AppError('PROVIDER_NOT_CONFIGURED', `${INTEGRATION_INFO[type].label} is not configured. Add the key under Integrations.`, 400);
  return s;
}

export async function testIntegration(workspaceId: string, type: IntegrationType) {
  const s = await requireSecret(workspaceId, type);
  let result: { ok: boolean; error?: string };
  try {
    switch (type) {
      case 'apollo': result = await adapters().leadData.apollo.test(s.secret); break;
      case 'millionverifier': case 'zerobounce': case 'neverbounce': await adapters().verifiers[type].verify(s.secret, 'test@example.com'); result = { ok: true }; break;
      case 'hunter': result = await adapters().finders.hunter.test(s.secret); break;
      case 'cloudflare': result = await adapters().dnsProviders.cloudflare.verifyToken(s.secret); break;
      case 'brave': await adapters().search.brave.search(s.secret, 'example', 1); result = { ok: true }; break;
      case 'serper': await adapters().search.serper.search(s.secret, 'example', 1); result = { ok: true }; break;
      case 'smartlead': result = await adapters().smartlead.test(s.secret); break;
      case 'booking': result = { ok: true }; break;
    }
  } catch (e) {
    result = { ok: false, error: (e as Error).message };
  }
  await db().integration.update({ where: { workspaceId_type: { workspaceId, type } }, data: { lastTestedAt: new Date(), lastTestOk: result.ok, lastError: result.ok ? null : result.error?.slice(0, 500) } });
  return result;
}

export async function recordUsage(workspaceId: string, provider: string, kind: string, units = 1, metadata: Record<string, unknown> = {}) {
  await db().usageRecord.create({ data: { workspaceId, provider, kind, units, metadata: metadata as Prisma.InputJsonValue, isEstimate: true } });
}

export async function ensureIntegrationExists(workspaceId: string, type: IntegrationType) {
  const r = await db().integration.findUnique({ where: { workspaceId_type: { workspaceId, type } } });
  if (!r) throw NotFound('Integration');
  return r;
}
