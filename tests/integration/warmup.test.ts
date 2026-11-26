import { beforeEach, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import { processWarmup, tickWarmup, countWarmupReservations, ingestWarmup } from '../../backend/src/services/warmup.js';
import { parseRawMessage } from '../../integrations/src/email/mime.js';
import { addLead, addMailbox, createUserSession, installFakes, resetDb } from '../helpers/harness.js';

let fakes: ReturnType<typeof installFakes>;
beforeEach(async () => { await resetDb(); fakes = installFakes(); });

it('requires explicit admin enrollment and consent, shares quota and holds interrupted sends', async () => {
  const owner = await createUserSession('warmup-owner@example.test');
  const mailbox = await addMailbox(owner.workspaceId, 'sender@warmup.example.test', 'GMAIL', { dailySendLimit: 1 });
  const domain = await db().domain.upsert({ where: { workspaceId_name: { workspaceId: owner.workspaceId, name: 'warmup.example.test' } }, update: { spfStatus: 'PASS', dkimStatus: 'PASS', dmarcStatus: 'PASS', lastCheckedAt: new Date() }, create: { workspaceId: owner.workspaceId, name: 'warmup.example.test', spfStatus: 'PASS', dkimStatus: 'PASS', dmarcStatus: 'PASS', lastCheckedAt: new Date() } });
  await db().emailAccount.update({ where: { id: mailbox.id }, data: { domainId: domain.id } });
  const base = `/api/v1/w/${owner.workspaceId}/warmup`;
  const post = (path: string) => owner.agent.post(base + path).set('x-csrf-token', owner.csrf);
  const config = {
    startAt: new Date(Date.now() - 3600_000).toISOString(), durationDays: 21,
    window: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59', timezone: 'UTC' }, mode: 'CUSTOM',
    startingTarget: 1, maximumTarget: 2, hourlyLimit: 1, minIntervalSeconds: 60, increment: 1, observationDays: 3, minimumSample: 3,
    maxBouncePct: 2, subject: 'Operations update', body: 'An agreed operations update for the authorized test mailbox.',
  };
  const enrolled = await post(`/mailboxes/${mailbox.id}`).send(config);
  expect(enrolled.status).toBe(201);
  const id = enrolled.body.id as string;
  expect(enrolled.body.status).toBe('READY_TO_START');
  expect((await post(`/mailboxes/${mailbox.id}`).send(config)).status).toBe(409);
  await processWarmup(owner.workspaceId, id);
  expect(fakes.gmail.sent).toHaveLength(0);
  const start = () => post(`/${id}/actions`).send({ action: 'START', confirmed: true });
  expect((await start()).status).toBe(409);
  const prospect = await addLead(owner.workspaceId, 'prospect@example.test');
  const authorize = (email: string) => post(`/${id}/recipients`).send({ recipients: [{ email, evidence: 'Explicit written authorization', dailyLimit: 1, authorized: true }] });
  expect((await authorize(prospect.email)).status).toBe(409);
  expect((await authorize('controlled@example.test')).status).toBe(201);
  await db().domain.update({ where: { id: domain.id }, data: { dkimStatus: 'FAIL' } });
  const blocked = await start();
  expect(blocked.status).toBe(409);
  expect(blocked.body.error.message).toContain('DKIM FAIL');
  await db().domain.update({ where: { id: domain.id }, data: { dkimStatus: 'PASS' } });
  expect((await start()).status).toBe(201);
  const now = new Date(Date.now() + 1000);
  await Promise.all([processWarmup(owner.workspaceId, id, now), processWarmup(owner.workspaceId, id, now)]);
  expect(fakes.gmail.sent).toHaveLength(1);
  expect(fakes.gmail.sent[0].to).toBe('controlled@example.test');
  expect(await countWarmupReservations(owner.workspaceId, new Date(+now - 3000), mailbox.id)).toBe(1);
  expect(await db().outboundEmail.count()).toBe(0);
  expect(await db().emailEvent.count()).toBe(0);
  const warmup = await db().warmupMessage.findFirstOrThrow({ where: { programId: id } });
  const response = await parseRawMessage(Buffer.from([
    'From: controlled@example.test', 'To: sender@warmup.example.test', 'Subject: Re: Operations update',
    `In-Reply-To: ${warmup.internetMessageId}`, '', 'I received the internal update.',
  ].join('\r\n')), { providerMessageId: 'controlled-response' });
  expect(await ingestWarmup(owner.workspaceId, mailbox.id, response, false)).toBe(true);
  expect(await db().warmupMessage.findUnique({ where: { id: warmup.id } })).toMatchObject({ repliedAt: expect.any(Date) });
  expect(await db().emailEvent.count()).toBe(0);
  const outsider = await createUserSession('warmup-outsider@example.test');
  expect((await outsider.agent.get(`/api/v1/w/${outsider.workspaceId}/warmup/${id}`)).status).toBe(404);
  const otherBase = `/api/v1/w/${outsider.workspaceId}/warmup`;
  expect((await outsider.agent.get(otherBase)).body.programs).toEqual([]);
  expect((await outsider.agent.post(`${otherBase}/mailboxes/${mailbox.id}`).set('x-csrf-token', outsider.csrf).send(config)).status).toBe(404);
  const otherMailbox = await addMailbox(outsider.workspaceId, 'other@warmup.example.test');
  const otherProgram = await outsider.agent.post(`${otherBase}/mailboxes/${otherMailbox.id}`).set('x-csrf-token', outsider.csrf).send(config);
  expect(otherProgram.status).toBe(201);
  expect((await outsider.agent.get(otherBase)).body.programs.map((row: { id: string }) => row.id)).toEqual([otherProgram.body.id]);
  expect((await owner.agent.get(base)).body.programs.map((row: { id: string }) => row.id)).toEqual([id]);
  expect((await outsider.agent.get(base)).status).toBe(404);
  const member = await createUserSession('warmup-member@example.test', 'MEMBER', owner.workspaceId);
  expect((await member.agent.get(base)).status).toBe(403);
  await processWarmup(outsider.workspaceId, id, new Date(+now + 86_400_000));
  expect(fakes.gmail.sent).toHaveLength(1);

  const sent = await db().warmupMessage.findFirstOrThrow({ where: { programId: id } });
  await db().warmupMessage.update({ where: { id: sent.id }, data: { status: 'RESERVED', reservedAt: new Date(+now - 16 * 60_000) } });
  await tickWarmup(now);
  expect(await db().warmupMessage.findUnique({ where: { id: sent.id } })).toMatchObject({ status: 'UNCERTAIN' });
  expect(await db().warmupProgram.findUnique({ where: { id } })).toMatchObject({ status: 'HEALTH_HOLD' });
  expect((await post(`/${id}/actions`).send({ action: 'RESUME', confirmed: true })).status).toBe(409);
  expect((await post(`/${id}/messages/${sent.id}/reconcile`).send({
    decision: 'MANUALLY_CLOSED', reason: 'Operator reviewed the uncertain test attempt.', confirmed: true,
  })).status).toBe(201);
  expect((await post(`/${id}/actions`).send({ action: 'RESUME', confirmed: true })).status).toBe(201);
  expect((await post(`/${id}/actions`).send({ action: 'PAUSE', confirmed: true })).status).toBe(201);
  expect((await post(`/${id}/actions`).send({ action: 'STOP', confirmed: true })).status).toBe(201);
  expect(fakes.gmail.sent).toHaveLength(1);
});
