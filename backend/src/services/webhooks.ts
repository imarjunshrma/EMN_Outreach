import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { hmac, randomToken } from '../core/crypto.js';
import { NotFound } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { enqueue, QUEUES } from '../core/queues.js';
import { assertPublicUrl } from '../../../integrations/src/research/fetcher.js';
import { WEBHOOK_EVENTS } from './automation.js';
import { decryptSecret, encryptSecret } from './workspace.js';

export const WebhookSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url().refine((u) => u.startsWith('https://') || process.env.NODE_ENV !== 'production', 'Webhook URLs must use https'),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  isEnabled: z.boolean().default(true),
});

export async function listWebhooks(workspaceId: string) {
  const hooks = await db().webhook.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
  return hooks.map(({ encryptedSecret: _s, ...h }) => h);
}

export async function createWebhook(workspaceId: string, input: z.infer<typeof WebhookSchema>, actor: Actor) {
  await assertPublicUrl(input.url);
  const secret = `whsec_${randomToken(24)}`;
  const h = await db().webhook.create({ data: { workspaceId, name: input.name, url: input.url, events: input.events, isEnabled: input.isEnabled, encryptedSecret: encryptSecret(secret) } });
  await audit(workspaceId, actor, 'webhook.created', { type: 'webhook', id: h.id });
  return { id: h.id, secret, note: 'Copy the signing secret now; it is not shown again.' };
}

export async function updateWebhook(workspaceId: string, id: string, input: z.infer<typeof WebhookSchema>, actor: Actor) {
  await assertPublicUrl(input.url);
  const r = await db().webhook.updateMany({ where: { id, workspaceId }, data: { ...input, failureCount: 0 } });
  if (!r.count) throw NotFound('Webhook');
  await audit(workspaceId, actor, 'webhook.updated', { type: 'webhook', id });
  return { ok: true };
}

export async function deleteWebhook(workspaceId: string, id: string, actor: Actor) {
  const r = await db().webhook.deleteMany({ where: { id, workspaceId } });
  if (!r.count) throw NotFound('Webhook');
  await audit(workspaceId, actor, 'webhook.deleted', { type: 'webhook', id });
}

export async function listDeliveries(workspaceId: string, webhookId: string) {
  return db().webhookDelivery.findMany({ where: { workspaceId, webhookId }, orderBy: { createdAt: 'desc' }, take: 100 });
}

export async function sendTest(workspaceId: string, id: string) {
  const h = await db().webhook.findFirst({ where: { id, workspaceId } });
  if (!h) throw NotFound('Webhook');
  const d = await db().webhookDelivery.create({ data: { workspaceId, webhookId: h.id, event: 'webhook.test', payload: { event: 'webhook.test', occurredAt: new Date().toISOString(), data: { message: 'Test delivery from Outvexa' } } } });
  await enqueue(QUEUES.webhooks, 'webhook.deliver', { workspaceId, deliveryId: d.id }, { attempts: 1 });
  return { deliveryId: d.id };
}

export function signWebhook(secret: string, timestamp: string, body: string) {
  return `t=${timestamp},v1=${hmac(secret, `${timestamp}.${body}`)}`;
}

/** Worker: deliver one webhook. Throws on failure so BullMQ retries with backoff. */
export async function deliver(workspaceId: string, deliveryId: string, fetchImpl: typeof fetch = fetch) {
  const d = await db().webhookDelivery.findFirst({ where: { id: deliveryId, workspaceId }, include: { webhook: true } });
  if (!d || d.status === 'DELIVERED') return;
  await assertPublicUrl(d.webhook.url);
  const body = JSON.stringify(d.payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = signWebhook(decryptSecret(d.webhook.encryptedSecret), ts, body);
  let status: number | undefined;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetchImpl(d.webhook.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-emn-event': d.event, 'x-emn-signature': sig, 'x-emn-delivery': d.id }, body, signal: ctrl.signal, redirect: 'error' }).finally(() => clearTimeout(t));
    status = res.status;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await db().webhookDelivery.update({ where: { id: d.id }, data: { status: 'DELIVERED', attempts: { increment: 1 }, responseStatus: status, deliveredAt: new Date(), error: null } });
    await db().webhook.update({ where: { id: d.webhookId }, data: { failureCount: 0 } });
  } catch (e) {
    const failures = d.webhook.failureCount + 1;
    await db().webhookDelivery.update({ where: { id: d.id }, data: { status: 'FAILED', attempts: { increment: 1 }, responseStatus: status ?? null, error: (e as Error).message.slice(0, 500) } });
    await db().webhook.update({ where: { id: d.webhookId }, data: { failureCount: failures, ...(failures >= 50 ? { isEnabled: false } : {}) } });
    throw e;
  }
}

export type WebhookPayload = Prisma.JsonValue;
