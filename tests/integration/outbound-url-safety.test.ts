/**
 * Server-side request forgery guards for destinations a tenant controls.
 * - Webhook deliveries must not follow redirects, which could lead past the public-address check to an internal host.
 * - On an instance with open sign-up, a custom AI endpoint must be a public address; private installs may use local
 *   models (Ollama, localhost), and operators can opt in explicitly with AI_ALLOW_PRIVATE_ENDPOINTS=true.
 * No request leaves the machine: the webhook transport is an in-process stub and endpoints are IP literals.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import { upsertProvider } from '../../backend/src/services/ai.js';
import * as webhooks from '../../backend/src/services/webhooks.js';
import { createUserSession, resetDb } from '../helpers/harness.js';

const actor = (userId: string) => ({ type: 'USER' as const, userId });

beforeEach(async () => { await resetDb(); });
afterEach(() => { delete process.env.REGISTRATION_OPEN; delete process.env.AI_ALLOW_PRIVATE_ENDPOINTS; });

describe('webhook delivery', () => {
  it('refuses to follow redirects', async () => {
    const { workspaceId, userId } = await createUserSession('hooks@x.com');
    const hook = await webhooks.createWebhook(workspaceId, { name: 'Fixture hook', url: 'https://93.184.216.34/hook', events: ['lead.scored'], isEnabled: true }, actor(userId));
    const delivery = await db().webhookDelivery.create({ data: { workspaceId, webhookId: hook.id, event: 'lead.scored', payload: { ok: true } } });
    const seen: RequestInit[] = [];
    const transport = (async (_url: string, init: RequestInit) => { seen.push(init); return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
    await webhooks.deliver(workspaceId, delivery.id, transport);
    expect(seen).toHaveLength(1);
    expect(seen[0].redirect).toBe('error');
  });
});

describe('custom AI endpoints', () => {
  const local = { provider: 'OLLAMA' as const, defaultModel: 'llama3', baseUrl: 'http://localhost:11434' };
  const privateNetwork = { provider: 'CUSTOM_OPENAI' as const, apiKey: 'sk-fixture', defaultModel: 'fixture', baseUrl: 'http://10.0.0.5/v1' };
  const publicAddress = { provider: 'CUSTOM_OPENAI' as const, apiKey: 'sk-fixture', defaultModel: 'fixture', baseUrl: 'https://93.184.216.34/v1' };

  it('rejects local and private endpoints while sign-up is open', async () => {
    const { workspaceId, userId } = await createUserSession('saas-ai@x.com');
    process.env.REGISTRATION_OPEN = 'true';
    await expect(upsertProvider(workspaceId, local, actor(userId))).rejects.toMatchObject({ status: 400 });
    await expect(upsertProvider(workspaceId, privateNetwork, actor(userId))).rejects.toMatchObject({ status: 400 });
    await expect(upsertProvider(workspaceId, publicAddress, actor(userId))).resolves.toBeTruthy();
  });

  it('allows local models on a private instance, or when the operator opts in', async () => {
    const { workspaceId, userId } = await createUserSession('private-ai@x.com');
    process.env.REGISTRATION_OPEN = 'false';
    await expect(upsertProvider(workspaceId, local, actor(userId))).resolves.toBeTruthy();
    process.env.REGISTRATION_OPEN = 'true';
    process.env.AI_ALLOW_PRIVATE_ENDPOINTS = 'true';
    await expect(upsertProvider(workspaceId, privateNetwork, actor(userId))).resolves.toBeTruthy();
  });
});
