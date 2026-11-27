import { randomUUID } from 'node:crypto';
import { Worker, QueueEvents } from 'bullmq';
import { beforeEach, describe, expect, it } from 'vitest';
import { redis } from '../../backend/src/core/redis.js';
import { db } from '../../backend/src/core/db.js';
import { newRedis } from '../../backend/src/core/redis.js';
import { QUEUES, queue } from '../../backend/src/core/queues.js';
import { cancelImport, createImport, decideItem, getImport, applyApproved, recoverImportJobs } from '../../backend/src/services/knowledge-import.js';
import { processImportJob } from '../../backend/src/services/knowledge-import-worker.js';
import { createUserSession } from '../helpers/harness.js';

const upload = (text: string) => [{ originalname: 'company.txt', mimetype: 'text/plain', buffer: Buffer.from(text) }];
const actor = (userId: string) => ({ type: 'USER' as const, userId });

// Start every test from an empty Redis DB, like the rest of the suite; otherwise the per-IP sign-in limiter
// accumulates across runs and logins start failing with 429.
beforeEach(async () => { await redis().flushdb(); });

describe('Knowledge Importer review and application state', () => {
  it('deduplicates concurrent uploads and permits a cancelled file to be uploaded again', async () => {
    const owner = await createUserSession(`import-cancel-${randomUUID()}@example.test`);
    const { workspaceId, userId } = owner;
    const files = upload('Synthetic workbook supporting text');
    const [first, second] = await Promise.all([
      createImport(workspaceId, files, actor(userId), randomUUID()),
      createImport(workspaceId, files, actor(userId), randomUUID()),
    ]);
    expect(second.id).toBe(first.id);
    expect((await getImport(workspaceId, first.id)).files).toHaveLength(1);
    await expect(cancelImport(workspaceId, first.id, actor(userId))).resolves.toMatchObject({ status: 'CANCELLED' });
    const queued = await queue(QUEUES.knowledgeImport).getJob(`knowledge-import-${first.id}-0-IMPORT_FILE_PARSE`);
    expect(queued).toBeDefined();
    await processImportJob(queued!);
    expect((await getImport(workspaceId, first.id)).status).toBe('CANCELLED');
    expect((await createImport(workspaceId, files, actor(userId))).id).not.toBe(first.id);
  });

  it('requeues a completed delivery whose database checkpoint stayed active', async () => {
    const owner = await createUserSession(`import-recovery-${randomUUID()}@example.test`);
    const { workspaceId } = owner;
    const prefix = `${process.env.QUEUE_PREFIX ?? 'emn'}:importer-recovery-${randomUUID()}`;
    const shared = queue(QUEUES.knowledgeImport);
    const jobEvents = new QueueEvents(QUEUES.knowledgeImport, { connection: newRedis(), prefix: shared.opts.prefix });
    const worker = new Worker(QUEUES.knowledgeImport, async job => {
      if (job.data.recoveryFixture === prefix) return;
      await job.moveToDelayed(Date.now() + 60_000, job.token);
      throw new (await import('bullmq')).DelayedError();
    }, { connection: newRedis(), prefix: shared.opts.prefix });
    try {
      // Subscribe before adding the job; otherwise its completion event can arrive before the listener is connected.
      await jobEvents.waitUntilReady();
      const session = await db().knowledgeImportSession.create({
        data: { workspaceId, status: 'PROCESSING', processingStep: 'IMPORT_FILE_PARSE' },
      });
      const job = await shared.add('IMPORT_FILE_PARSE', { workspaceId, sessionId: session.id, run: 0, recoveryFixture: prefix }, {
        jobId: `knowledge-import-${session.id}-0-IMPORT_FILE_PARSE`,
      });
      await job.waitUntilFinished(jobEvents, 5000);
      await worker.pause();
      await recoverImportJobs();
      expect(await db().knowledgeImportSession.findUnique({ where: { id: session.id } })).toMatchObject({ run: 1, status: 'PROCESSING' });
      expect(await shared.getJob(`knowledge-import-${session.id}-1-IMPORT_FILE_PARSE`)).toBeDefined();
      await cancelImport(workspaceId, session.id, actor(owner.userId));
    } finally {
      await Promise.all([worker.close(), jobEvents.close()]);
    }
  });

  it('returns cyclic proposals for explicit relationship review without writing destinations', async () => {
    const owner = await createUserSession(`import-cycle-${randomUUID()}@example.test`);
    const { workspaceId, userId } = owner;
    const currentActor = actor(userId);
    const session = await db().knowledgeImportSession.create({ data: { workspaceId, status: 'REVIEW' } });
    const data = { workspaceId, sessionId: session.id, entityType: 'TARGET_AUDIENCE', destination: 'TARGET_AUDIENCE', classification: 'EXPLICIT_FACT' };
    const proposals = await Promise.all(['first', 'second'].map((name, index) => db().knowledgeImportItem.create({
      data: { ...data, payload: { name, externalId: name }, relationships: [{ entityType: 'TARGET_AUDIENCE', externalId: index ? 'first' : 'second' }] },
    })));
    for (const item of proposals) await decideItem(workspaceId, item.id, { status: 'APPROVED' }, currentActor);
    await applyApproved(workspaceId, session.id, currentActor);
    const delivery = await queue(QUEUES.knowledgeImport).getJob(`knowledge-import-${session.id}-1-IMPORT_APPROVED_APPLICATION`);
    await processImportJob(delivery!);
    const review = await getImport(workspaceId, session.id);
    expect(review.items).toHaveLength(2);
    for (const item of review.items) {
      expect(item).toMatchObject({ status: 'FAILED', destinationEntityId: null });
      expect(item.error).toContain('circular relationship');
    }
    expect(await db().businessKnowledgeRecord.count({ where: { workspaceId } })).toBe(0);
  });

  it('enforces tenant boundaries, serializes approval, and rechecks application permissions', async () => {
    const owner = await createUserSession(`import-review-${randomUUID()}@example.test`);
    const stranger = await createUserSession(`import-stranger-${randomUUID()}@example.test`);
    const { workspaceId, userId } = owner;
    const session = await db().knowledgeImportSession.create({ data: { workspaceId, status: 'REVIEW' } });
    const data = { workspaceId, sessionId: session.id, entityType: 'COMPANY_PROFILE', destination: 'AI_CONFIG_KNOWLEDGE', payload: { name: 'Concurrency fixture' }, classification: 'EXPLICIT_FACT' };
    const [first, second] = await Promise.all([
      db().knowledgeImportItem.create({ data }), db().knowledgeImportItem.create({ data }),
    ]);
    await expect(getImport(stranger.workspaceId, session.id)).rejects.toMatchObject({ status: 404 });
    await expect(decideItem(stranger.workspaceId, first.id, { status: 'REJECTED' }, actor(stranger.userId))).rejects.toMatchObject({ status: 404 });
    await expect(db().knowledgeImportItem.create({ data: { ...data, workspaceId: stranger.workspaceId } })).rejects.toMatchObject({ code: 'P2003' });
    const reviews = await Promise.allSettled([first, second].map(item => decideItem(workspaceId, item.id, { status: 'APPROVED' }, actor(userId))));
    expect(reviews.map(review => review.status).sort()).toEqual(['fulfilled', 'rejected']);
    await expect(applyApproved(workspaceId, session.id, actor(stranger.userId))).rejects.toMatchObject({ status: 403 });
    await expect(applyApproved(workspaceId, session.id, actor(userId))).resolves.toMatchObject({ status: 'READY' });
    await db().user.update({ where: { id: userId }, data: { status: 'DISABLED' } });
    const queued = await queue(QUEUES.knowledgeImport).getJob(`knowledge-import-${session.id}-1-IMPORT_APPROVED_APPLICATION`);
    expect(queued).toBeDefined();
    await expect(processImportJob(queued!)).rejects.toThrow('Current workspace administrator permission is required');
    expect(await db().knowledgeImportItem.count({ where: { workspaceId, sessionId: session.id, status: 'APPLIED' } })).toBe(0);
  });
});
