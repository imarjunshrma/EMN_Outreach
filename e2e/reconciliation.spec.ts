import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createPrisma } from '../backend/src/core/db.js';
import { login, workspaceBase } from './helpers';

test('reviews and closes an uncertain send without requeueing it', async ({ page }) => {
  const url = new URL(process.env.E2E_DATABASE_URL ?? '');
  if (url.hostname !== '127.0.0.1' || !/^\/emn_(?:e2e|outvexa_browser_\d+)$/.test(url.pathname)) throw new Error('Expected a local browser fixture database');
  await login(page);
  const base = await workspaceBase(page);
  const workspaceId = base.split('/').at(-1)!;
  const suffix = randomUUID().slice(0, 8);
  const email = `uncertain-${suffix}@fixture.test`;
  const reason = `Fixture ${suffix} closed without provider evidence.`;
  const prisma = createPrisma(url.href);
  try {
    const outbound = await prisma.$transaction(async tx => {
      const campaign = await tx.campaign.create({ data: { workspaceId, name: `Reconciliation fixture ${suffix}`, sendingWindow: {}, tags: [] } });
      const sequence = await tx.sequence.create({ data: { workspaceId, campaignId: campaign.id } });
      const step = await tx.sequenceStep.create({ data: { workspaceId, sequenceId: sequence.id, order: 1 } });
      const variant = await tx.sequenceStepVariant.create({ data: { workspaceId, stepId: step.id, label: 'A', subject: 'Fixture', body: 'Fixture' } });
      const mailbox = await tx.emailAccount.create({ data: { workspaceId, provider: 'GMAIL', emailAddress: `sender-${suffix}@fixture.test`, status: 'PAUSED', sendingWindow: {} } });
      const lead = await tx.lead.create({ data: { workspaceId, email, emailNormalized: email, tags: [] } });
      const enrollment = await tx.sequenceEnrollment.create({ data: { workspaceId, campaignId: campaign.id, leadId: lead.id, emailAccountId: mailbox.id, variantSeed: 0, status: 'FAILED' } });
      return tx.outboundEmail.create({ data: {
        workspaceId, campaignId: campaign.id, enrollmentId: enrollment.id, stepId: step.id, variantId: variant.id,
        emailAccountId: mailbox.id, idempotencyKey: suffix, internetMessageId: `<${suffix}@fixture.test>`,
        status: 'UNCERTAIN', attempts: 1, uncertainAt: new Date(), sendStartedAt: new Date(), scheduledFor: new Date(),
        toAddress: email, usedClaimIds: [],
      } });
    });
    await page.goto(base + '/mailbox-health');
    await page.getByRole('link', { name: 'Send reconciliation' }).click();
    await expect(page.getByRole('heading', { name: 'Send reconciliation' })).toBeVisible();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    await page.getByLabel('Decision').selectOption('MANUALLY_CLOSED');
    await page.getByLabel('Reason').fill(reason);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Record decision' }).click();
    await expect(page.getByText(email, { exact: true })).toHaveCount(0);
    await page.getByLabel('Show closed reviews').check();
    await expect(page.getByText(reason)).toBeVisible();
    const saved = await prisma.outboundEmail.findUniqueOrThrow({ where: { id: outbound.id } });
    expect(saved.status).toBe('UNCERTAIN');
    expect(saved.sentAt).toBeNull();
    expect(saved.attempts).toBe(1);
  } finally { await prisma.$disconnect(); }
});
