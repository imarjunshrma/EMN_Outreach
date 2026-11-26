import { beforeEach, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import { domainAuthenticationReason, mailboxSendingPolicy } from '../../backend/src/services/deliverability.js';
import { addMailbox, createUserSession, installFakes, resetDb } from '../helpers/harness.js';

beforeEach(async () => { await resetDb(); installFakes(); });

it('shares the most restrictive policy, preserves mailbox evidence, and holds only the affected domain', async () => {
  const s = await createUserSession('deliverability-owner@example.test');
  const other = await createUserSession('deliverability-other@example.test');
  const mailbox = await addMailbox(s.workspaceId, 'sender@checks.example.test');
  const alternate = await addMailbox(s.workspaceId, 'alternate@unrelated.example.test');
  const now = new Date('2026-11-26T12:00:00Z');
  const domain = await db().domain.upsert({ where: { workspaceId_name: { workspaceId: s.workspaceId, name: 'checks.example.test' } }, update: { spfStatus: 'PASS', dkimStatus: 'PASS', dmarcStatus: 'PASS', lastCheckedAt: now }, create: { workspaceId: s.workspaceId, name: 'checks.example.test', spfStatus: 'PASS', dkimStatus: 'PASS', dmarcStatus: 'PASS', lastCheckedAt: now } });
  const addPolicy = (workspaceId: string, emailAccountId: string, sendingPolicy?: object) => db().campaign.create({
    data: { name: 'Fixture', workspaceId, status: 'RUNNING', sendingWindow: {}, sendingPolicy, accounts: { create: { workspaceId, emailAccountId } } },
  });
  const gradual = { mode: 'GRADUAL', starting: 2, maximum: 10, increase: 2, qualifyingDays: 2, minimumDailySample: 1 };
  await addPolicy(s.workspaceId, mailbox.id, gradual);
  const policy = () => mailboxSendingPolicy(s.workspaceId, mailbox.id, mailbox.emailAddress, 'UTC', now);
  expect(await policy()).toMatchObject({ target: 2, blocked: false });
  await db().emailEvent.createMany({ data: [1, 2].map(day => ({ workspaceId: s.workspaceId, emailAccountId: mailbox.id, type: 'SENT', dedupeKey: `SENT:fixture-${day}`, occurredAt: new Date(+now - day * 86_400_000) })) });
  expect(await policy()).toMatchObject({ target: 4 });
  await addPolicy(s.workspaceId, mailbox.id);
  expect(await policy()).toMatchObject({ target: 4 });
  await addPolicy(s.workspaceId, mailbox.id, { mode: 'MANUAL', maximum: 3 });
  expect(await policy()).toMatchObject({ target: 3 });
  await db().domain.update({ where: { id: domain.id }, data: { dkimStatus: 'FAIL' } });
  expect(await policy()).toMatchObject({ blocked: true, reason: expect.stringContaining('DKIM') });
  expect(await mailboxSendingPolicy(s.workspaceId, alternate.id, alternate.emailAddress, 'UTC', now)).toMatchObject({ blocked: false });
  expect(await mailboxSendingPolicy(other.workspaceId, mailbox.id, mailbox.emailAddress, 'UTC', now)).toMatchObject({ target: null, blocked: true });
});

it('blocks missing, incomplete and stale domain authentication, but permits fresh triple PASS', () => {
  const now = new Date('2026-11-26T12:00:00Z');
  expect(domainAuthenticationReason(null, now)).toMatch(/not been configured/);
  expect(domainAuthenticationReason({ spfStatus: 'PASS', dkimStatus: null, dmarcStatus: 'PASS', lastCheckedAt: now }, now)).toMatch(/DKIM/);
  expect(domainAuthenticationReason({ spfStatus: 'PASS', dkimStatus: 'PASS', dmarcStatus: 'PASS', lastCheckedAt: new Date(+now - 3 * 86_400_001) }, now)).toMatch(/stale/);
  expect(domainAuthenticationReason({ spfStatus: 'PASS', dkimStatus: 'PASS', dmarcStatus: 'PASS', lastCheckedAt: now }, now)).toBeNull();
});
