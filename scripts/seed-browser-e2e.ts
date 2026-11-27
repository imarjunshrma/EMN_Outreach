import { readFileSync } from 'node:fs';
import { assertBrowserE2eSafety, E2E_STORAGE_ROOT } from '../backend/src/core/browser-e2e-safety.js';
import { db, disconnectDb } from '../backend/src/core/db.js';
import { hashPassword } from '../backend/src/services/auth.js';
import { encryptSecret, initWorkspaceDefaults } from '../backend/src/services/workspace.js';
import { CampaignSettingsSchema, createCampaign } from '../backend/src/services/engine.js';

if (!assertBrowserE2eSafety()) throw new Error('Run the seed in the isolated browser E2E profile.');
const email = 'owner@elite-media.e2e.test';
const slug = 'elite-media-e2e';
const draftName = 'E2E TEST — EMN — DRAFT ONLY';

try {
  if (await db().user.count({ where: { email: { not: email } } }) ||
      await db().organization.count({ where: { slug: { not: slug } } }) ||
      await db().workspace.count({ where: { slug: { not: slug } } }) ||
      await db().providerCredential.count()) {
    throw new Error('Fixture database contains records from outside the browser E2E seed.');
  }
  const passwordHash = await hashPassword(readFileSync(`${E2E_STORAGE_ROOT}/fixture-password`, 'utf8'));
  const user = await db().user.upsert({
    where: { email }, update: { passwordHash },
    create: { email, passwordHash, name: 'Elite Media E2E Owner', emailVerifiedAt: new Date() },
  });
  const org = await db().organization.upsert({
    where: { slug }, update: {},
    create: { slug, name: 'Elite Media Networks E2E', ownerId: user.id, status: 'ACTIVE', members: { create: { userId: user.id, role: 'OWNER' } } },
  });
  const settings = { automaticCampaignSending: false, automaticFollowups: false, emergencyPause: true, verificationSmtpProbeEnabled: false };
  const workspace = await db().workspace.upsert({
    where: { slug }, update: { settings },
    create: { slug, organizationId: org.id, name: 'Elite Media Networks E2E', settings, members: { create: { userId: user.id, role: 'OWNER' } } },
  });
  await initWorkspaceDefaults(workspace.id);
  await db().aiProvider.upsert({
    where: { workspaceId_provider: { workspaceId: workspace.id, provider: 'OPENAI' } },
    create: { workspaceId: workspace.id, provider: 'OPENAI', defaultModel: 'outvexa-e2e-fixture-v1',
      encryptedApiKey: encryptSecret('synthetic-fixture-key'), keyLast4: '-key', isEnabled: true },
    update: {},
  });
  await db().emailAccount.upsert({
    where: { workspaceId_emailAddress: { workspaceId: workspace.id, emailAddress: 'offline-mailbox@elite-media.e2e.test' } }, update: {},
    create: { workspaceId: workspace.id, provider: 'SMTP_IMAP', emailAddress: 'offline-mailbox@elite-media.e2e.test',
      status: 'DISCONNECTED', operatorPaused: true, dailySendLimit: 20, sendingWindow: {} },
  });
  if (!await db().campaign.findFirst({ where: { workspaceId: workspace.id, name: draftName } })) {
    await createCampaign(workspace.id, CampaignSettingsSchema.parse({ name: draftName }), { type: 'SYSTEM' });
  }
  console.log(JSON.stringify({ database: 'outvexa_browser_e2e', workspaceId: workspace.id, login: email }));
} finally {
  await disconnectDb();
}
