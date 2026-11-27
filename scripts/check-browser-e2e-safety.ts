import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertBrowserE2eSafety } from '../backend/src/core/browser-e2e-safety.js';
import { adapters } from '../backend/src/core/container.js';
import { db, disconnectDb } from '../backend/src/core/db.js';
import { enqueue, QUEUES } from '../backend/src/core/queues.js';
import { startCampaign } from '../backend/src/services/engine.js';
import { changeWarmup } from '../backend/src/services/warmup.js';
import { GmailProvider } from '../integrations/src/email/gmail.js';
import { MicrosoftGraphProvider } from '../integrations/src/email/microsoft.js';
import { SmtpImapProvider } from '../integrations/src/email/smtp-imap.js';
import { processorFor } from '../worker/src/processors.js';

assert.equal(assertBrowserE2eSafety(), true);
for (const override of [
  { OUTVEXA_BROWSER_E2E: undefined },
  { OUTVEXA_EMAIL_MODE: undefined },
  { DATABASE_URL: 'postgresql://emn@127.0.0.1:5432/emn_dev' },
  { REDIS_URL: 'redis://127.0.0.1:6379/0' },
  { SYSTEM_SMTP_URL: 'smtp://example.test' },
  { GRAPH_WEBHOOKS_ENABLED: 'true' },
]) assert.throws(() => assertBrowserE2eSafety({ ...process.env, ...override }), /Browser E2E safety/);
for (const Provider of [GmailProvider, MicrosoftGraphProvider, SmtpImapProvider]) {
  assert.throws(() => new Provider(), /Real email provider initialization is blocked/);
}

try {
  const workspace = await db().workspace.findUniqueOrThrow({ where: { slug: 'elite-media-e2e' } });
  const campaign = await db().campaign.findFirstOrThrow({ where: { workspaceId: workspace.id, name: 'E2E TEST — EMN — DRAFT ONLY' } });
  const actor = { type: 'SYSTEM' as const };
  const blocked = { code: 'E2E_DELIVERY_BLOCKED', status: 403 };
  await assert.rejects(startCampaign(workspace.id, campaign.id, actor), blocked);
  await assert.rejects(changeWarmup(workspace.id, randomUUID(), 'START', actor), blocked);
  await assert.rejects(enqueue(QUEUES.send, 'outbound.send', { workspaceId: workspace.id }), blocked);
  await assert.rejects(processorFor(QUEUES.send)({ name: 'outbound.send', data: { workspaceId: workspace.id } } as never), blocked);
  await assert.rejects(adapters().email.GMAIL.send({} as never, {} as never), blocked);
  assert.equal(await db().providerCredential.count(), 0);
  assert.equal(await db().outboundEmail.count(), 0);
  assert.equal(await db().warmupMessage.count(), 0);
  assert.equal(await db().emailAccount.count({ where: { OR: [{ status: 'CONNECTED' }, { lastSentAt: { not: null } }] } }), 0);
  assert.equal((await db().campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, 'DRAFT');
  console.log('PASS: startup fences, real constructors, activation, warm-up, queue publication, queue execution, and mock send. No credentials, outbound records, or warm-up messages.');
} finally { await disconnectDb(); }
