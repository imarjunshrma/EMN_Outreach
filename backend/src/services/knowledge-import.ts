import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { logger } from '../core/logger.js';
import { db, Prisma } from '../core/db.js';
import { AppError, Conflict, Forbidden, NotFound } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { accessOf } from '../core/tenant.js';
import { cfg } from '../core/platform-config.js';
import { enqueue, QUEUES, queue } from '../core/queues.js';
import { ImportEntityTypeSchema, validateImportPayload } from '../../../shared/src/knowledge-import.js';
import { destinationFor, inspectImportItem } from './knowledge-import-apply.js';
import { MAX_IMPORT_BYTES, TEMPLATE_VERSION, validateImportUpload } from './knowledge-import-parser.js';

export { MAX_IMPORT_BYTES, templateWorkbook, TEMPLATE_VERSION } from './knowledge-import-parser.js';

export const importStages = [
  'IMPORT_FILE_PARSE', 'IMPORT_EXTRACTION', 'IMPORT_SCHEMA_VALIDATION',
  'IMPORT_SEMANTIC_MAPPING', 'IMPORT_DUPLICATE_DETECTION', 'IMPORT_CONFLICT_DETECTION',
  'IMPORT_APPROVED_APPLICATION', 'IMPORT_EMBEDDING', 'IMPORT_RETRIEVAL_SYNC',
] as const;
export type ImportStage = typeof importStages[number];
export const StageSchema = z.enum(importStages);

export const ImportItemDecision = z.enum(['APPROVED', 'REJECTED', 'SKIP', 'NEEDS_REVIEW']);
export const ReviewSchema = z.strictObject({
  status: ImportItemDecision,
  proposedValue: z.record(z.string(), z.unknown()).optional(),
  relationships: z.array(z.strictObject({ entityType: ImportEntityTypeSchema, externalId: z.string().trim().min(1).max(200) })).max(40).optional(),
  reviewNote: z.string().trim().max(2000).optional(),
  expectedUpdatedAt: z.iso.datetime().optional(),
  resolveConflict: z.boolean().optional(),
});
export const BulkReviewSchema = z.strictObject({
  ids: z.array(z.uuid()).min(1).max(100),
  status: z.enum(['REJECTED', 'SKIP']),
});

export const importJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const appActorSchema = z.object({ type: z.literal('USER'), userId: z.uuid(), impersonatorUserId: z.uuid().nullable().optional() });
const editableSession = ['REVIEW', 'APPLIED'] as const;
const uploadTypes = { fileName: true, id: true, mimeType: true, sha256: true, byteCount: true, status: true, error: true, createdAt: true } as const;
export const MAX_IMPORT_TOTAL_BYTES = 40 * 1024 * 1024;

export async function enqueueImportStage(session: { id: string; workspaceId: string; run: number; processingStep: string | null }) {
  const stage = StageSchema.parse(session.processingStep);
  const jobId = `knowledge-import-${session.id}-${session.run}-${stage}`;
  const data = { workspaceId: session.workspaceId, sessionId: session.id, run: session.run };
  await enqueue(QUEUES.knowledgeImport, stage, data, { jobId });
}

async function publishCommittedImport(session: Parameters<typeof enqueueImportStage>[0]) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      enqueueImportStage(session),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Import queue publication timed out')), 1500);
      }),
    ]);
  } catch {
    // The maintenance worker can publish the committed checkpoint once Redis becomes available.
    logger.warn({ workspaceId: session.workspaceId, sessionId: session.id, stage: session.processingStep, run: session.run }, 'Import queue publication deferred');
  } finally {
    clearTimeout(timer);
  }
}

export async function createImport(workspaceId: string, files: Array<{ originalname: string; mimetype: string; buffer: Buffer }>, actor: Actor, idempotencyKey?: string) {
  if (!files.length || files.length > 20) throw new AppError('VALIDATION_FAILED', 'Upload between one and twenty files', 400);
  if (files.some(file => file.buffer.length > MAX_IMPORT_BYTES) || files.reduce((size, file) => size + file.buffer.length, 0) > MAX_IMPORT_TOTAL_BYTES) {
    throw new AppError('VALIDATION_FAILED', 'Upload at most 20 MB per file and 40 MB per import', 400);
  }
  if (idempotencyKey && idempotencyKey.length > 200) throw new AppError('VALIDATION_FAILED', 'Idempotency key is too long', 400);
  const uploads = new Map(files.map(file => {
    validateImportUpload(file.buffer, file.originalname, file.mimetype);
    return [createHash('sha256').update(file.buffer).digest('hex'), file];
  }));
  const session = await db().$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`knowledge-import:${workspaceId}`}))`;
    if (idempotencyKey) {
      const found = await tx.knowledgeImportSession.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } } });
      if (found) return found;
    }
    // A copy that failed (for example to a parser defect since fixed) must not block a new attempt: re-uploading the same
    // file would otherwise keep returning the failed session. Retire it in its own session so the upload is processed again.
    const failed = await tx.knowledgeImportFile.findMany({
      where: { workspaceId, sha256: { in: [...uploads.keys()] }, status: 'FAILED' }, select: { id: true, error: true },
    });
    for (const file of failed) {
      await tx.knowledgeImportFile.updateMany({
        where: { workspaceId, id: file.id, status: 'FAILED' },
        data: { status: 'CANCELLED', content: null, error: `${file.error ?? 'The file could not be processed'} (replaced by a later upload of the same file)`.slice(0, 1000) },
      });
    }
    const previous = await tx.knowledgeImportFile.findMany({
      where: { workspaceId, sha256: { in: [...uploads.keys()] }, status: { not: 'CANCELLED' } },
      select: { sha256: true, sessionId: true }, orderBy: { createdAt: 'desc' },
    });
    // Compare distinct files, not rows: the same file can appear in several earlier sessions, and counting rows made a
    // new file look already imported when another file in the upload had been imported twice before.
    const seen = new Set(previous.map(file => file.sha256));
    if (seen.size === uploads.size) {
      return tx.knowledgeImportSession.findFirstOrThrow({ where: { id: previous[0].sessionId, workspaceId } });
    }
    const pending = [...uploads].filter(([hash]) => !seen.has(hash));
    const created = await tx.knowledgeImportSession.create({
      data: {
        workspaceId, createdById: actor.userId ?? null, templateVersion: TEMPLATE_VERSION,
        idempotencyKey: idempotencyKey ?? null, status: pending.length ? 'UPLOADED' : 'REVIEW',
        processingStep: pending.length ? 'IMPORT_FILE_PARSE' : null, progress: pending.length ? 0 : 100,
      },
    });
    await tx.knowledgeImportFile.createMany({ data: pending.map(([sha256, file]) => ({
      workspaceId, sessionId: created.id, sha256, fileName: file.originalname.split(/[\\/]/).at(-1)!.replace(/\p{Cc}/gu, '').slice(0, 255), mimeType: file.mimetype,
      byteCount: file.buffer.length, content: new Uint8Array(file.buffer),
    })) });
    await audit(workspaceId, actor, 'knowledge_import.created', { type: 'knowledge_import', id: created.id }, {
      files: pending.length, duplicateFiles: files.length - pending.length,
      previousSessions: [...new Set(previous.map(file => file.sessionId))],
    }, tx);
    return created;
  });
  if (session.status === 'UPLOADED' && session.processingStep) await publishCommittedImport(session);
  return sessionView(session);
}

function sessionView<T extends { applyActor: unknown; extractionRoute: unknown; run: number }>(session: T) {
  const { applyActor: _actor, extractionRoute: _route, run: _run, ...view } = session;
  return view;
}

export async function listImports(workspaceId: string) {
  const [sessions, counts] = await Promise.all([
    db().knowledgeImportSession.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 100, include: { _count: { select: { items: true, files: true } } } }),
    db().knowledgeImportItem.groupBy({ by: ['sessionId', 'status'], where: { workspaceId }, _count: { _all: true } }),
  ]);
  const bySession = new Map<string, Record<string, number>>();
  for (const entry of counts) {
    const statuses = bySession.get(entry.sessionId) ?? {};
    statuses[entry.status] = entry._count._all;
    bySession.set(entry.sessionId, statuses);
  }
  return sessions.map(session => ({ ...sessionView(session), counts: bySession.get(session.id) ?? {} }));
}

export async function getImport(workspaceId: string, id: string) {
  const session = await db().knowledgeImportSession.findFirst({
    where: { workspaceId, id },
    include: {
      files: { where: { workspaceId }, select: uploadTypes, orderBy: { createdAt: 'asc' } },
      items: { where: { workspaceId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
  if (!session) throw NotFound('Import session');
  const auditEvents = await db().auditLog.findMany({
    where: { workspaceId, action: { startsWith: 'knowledge_import.' }, OR: [{ entityId: id }, { metadata: { path: ['sessionId'], equals: id } }] },
    orderBy: { createdAt: 'desc' }, take: 200,
    select: { id: true, action: true, createdAt: true, actorUserId: true, entityId: true, metadata: true },
  });
  return { ...sessionView(session), auditEvents };
}

function assertEditable(status: string) {
  if (!editableSession.some(value => value === status)) throw Conflict('IMPORT_BUSY', 'This import is currently processing. Wait until review is available.');
}

async function lockReview(tx: Prisma.TransactionClient, workspaceId: string, sessionId: string) {
  await tx.$queryRaw`SELECT 1 AS locked FROM "KnowledgeImportSession" WHERE "workspaceId" = ${workspaceId}::uuid AND "id" = ${sessionId}::uuid FOR UPDATE`;
}

export async function decideItem(workspaceId: string, id: string, decision: z.infer<typeof ReviewSchema>, actor: Actor) {
  return db().$transaction(async tx => {
    const lookup = await tx.knowledgeImportItem.findFirst({ where: { workspaceId, id }, select: { sessionId: true } });
    if (!lookup) throw NotFound('Import item');
    await lockReview(tx, workspaceId, lookup.sessionId);
    const item = await tx.knowledgeImportItem.findFirst({ where: { workspaceId, id }, include: { session: true } });
    if (!item || item.session.workspaceId !== workspaceId) throw NotFound('Import item');
    assertEditable(item.session.status);
    if (item.status === 'APPLIED') throw Conflict('IMPORT_APPLIED', 'This item was already applied.');
    if (decision.expectedUpdatedAt && item.updatedAt.toISOString() !== decision.expectedUpdatedAt) throw Conflict('IMPORT_REVIEW_CHANGED', 'The item changed. Reload it before reviewing.');
    const type = ImportEntityTypeSchema.safeParse(item.entityType === 'KNOWLEDGE' ? 'COMPANY_PROFILE' : item.entityType);
    const proposed = decision.proposedValue ?? item.proposedValue ?? item.payload;
    const destination = type.success ? destinationFor(type.data) : item.destination;
    const update: Prisma.KnowledgeImportItemUpdateManyMutationInput = {
      status: decision.status, reviewNote: decision.reviewNote, error: null,
      ...(decision.relationships ? { relationships: importJson(decision.relationships) } : {}),
    };
    if (decision.proposedValue || decision.status === 'APPROVED') {
      if (!type.success) throw new AppError('VALIDATION_FAILED', 'The item has no supported destination', 400);
      const data = validateImportPayload(type.data, proposed);
      const result = await inspectImportItem(tx, workspaceId, { ...item, entityType: type.data, destination, payload: data, stableKey: null });
      if (decision.status === 'APPROVED' && (
        result.duplicateCandidates.length > 1 || result.existingValue?.data.isArchived === true ||
        (!result.stableKey || (result.status === 'NEEDS_REVIEW' && result.conflictReason && !result.conflictReason.startsWith('The source contains unverified')))
      )) {
        throw new AppError('VALIDATION_FAILED', result.conflictReason ?? 'Fix the destination fields before approval', 400);
      }
      if (decision.status === 'APPROVED' && await tx.knowledgeImportItem.findFirst({
        where: { workspaceId, sessionId: item.sessionId, stableKey: result.stableKey, status: 'APPROVED', id: { not: id } }, select: { id: true },
      })) throw Conflict('IMPORT_DUPLICATE_APPROVAL', 'An approved proposal already represents this record. Reject or skip that proposal before approving this one.');
      const changed = !isDeepStrictEqual(item.existingValue ?? null, result.existingValue);
      const newConflict = result.status === 'CONFLICT' || item.status === 'CONFLICT';
      if (decision.status === 'APPROVED' && (changed || newConflict) && !decision.resolveConflict) {
        throw Conflict('IMPORT_CONFLICT_REVIEW', 'Review the current and proposed values and confirm the update.');
      }
      if (decision.status === 'APPROVED' && changed) {
        throw Conflict('IMPORT_DESTINATION_CHANGED', 'The destination has changed. Save the edited proposal for review before approving.');
      }
      Object.assign(update, {
        entityType: type.data, destination, proposedValue: importJson(data),
        stableKey: result.stableKey || null, existingValue: result.existingValue ? importJson(result.existingValue) : Prisma.DbNull,
        duplicateCandidates: importJson(result.duplicateCandidates), conflictReason: result.conflictReason,
      });
    }
    const updated = await tx.knowledgeImportItem.updateMany({
      where: { workspaceId, id, updatedAt: item.updatedAt, session: { workspaceId, status: item.session.status } }, data: update,
    });
    if (!updated.count) throw Conflict('IMPORT_REVIEW_CHANGED', 'The import changed. Reload it before reviewing.');
    await audit(workspaceId, actor, 'knowledge_import.item_decided', { type: 'knowledge_import_item', id }, {
      sessionId: item.sessionId, status: decision.status, previousStatus: item.status,
      edited: !!decision.proposedValue, conflictResolved: !!decision.resolveConflict,
    }, tx);
    return tx.knowledgeImportItem.findFirstOrThrow({ where: { workspaceId, id } });
  });
}

export async function decideItems(workspaceId: string, sessionId: string, input: z.infer<typeof BulkReviewSchema>, actor: Actor) {
  return db().$transaction(async tx => {
    await lockReview(tx, workspaceId, sessionId);
    const session = await tx.knowledgeImportSession.findFirst({ where: { id: sessionId, workspaceId } });
    if (!session) throw NotFound('Import session');
    assertEditable(session.status);
    const ids = [...new Set(input.ids)];
    const updated = await tx.knowledgeImportItem.updateMany({
      where: { workspaceId, sessionId, id: { in: ids }, status: { not: 'APPLIED' } }, data: { status: input.status, error: null },
    });
    if (updated.count !== ids.length) throw Conflict('IMPORT_REVIEW_CHANGED', 'One or more selected items are no longer available for review.');
    await audit(workspaceId, actor, 'knowledge_import.bulk_decided', { type: 'knowledge_import', id: sessionId }, { ids, status: input.status }, tx);
    return { updated: updated.count };
  });
}

export async function assertImportAdmin(client: Prisma.TransactionClient, workspaceId: string, input: unknown) {
  const parsed = appActorSchema.safeParse(input);
  if (!parsed.success) throw Forbidden('A signed-in workspace administrator must apply knowledge imports.');
  const actor = parsed.data;
  const workspace = await client.workspace.findFirst({ where: { id: workspaceId, archivedAt: null }, select: { organizationId: true, settings: true, organization: { select: { status: true } } } });
  if (!workspace) throw NotFound('Workspace');
  if (accessOf(workspace.organization.status) !== 'full') throw Forbidden('The organization cannot apply changes at its current status.');
  const [user, membership, organizationMember] = await Promise.all([
    client.user.findFirst({ where: { id: actor.userId, status: 'ACTIVE' }, select: { mfaEnabled: true } }),
    client.workspaceMember.findFirst({ where: { workspaceId, userId: actor.userId }, select: { role: true } }),
    client.organizationMember.findFirst({ where: { organizationId: workspace.organizationId, userId: actor.userId }, select: { role: true } }),
  ]);
  if (!user || (!actor.impersonatorUserId && !user.mfaEnabled && (cfg().security.requireMfaForAllUsers || (workspace.settings as { requireMfa?: boolean } | null)?.requireMfa)) ||
      !['OWNER', 'ADMIN'].includes(membership?.role ?? organizationMember?.role ?? '')) {
    throw Forbidden('Current workspace administrator permission is required.');
  }
  if (actor.impersonatorUserId && !(await client.user.findFirst({ where: { id: actor.impersonatorUserId, status: 'ACTIVE', platformRole: 'SUPER_ADMIN' } }))) {
    throw Forbidden('The impersonation grant is no longer active.');
  }
  return actor;
}

export async function applyApproved(workspaceId: string, id: string, actor: Actor) {
  const session = await db().$transaction(async tx => {
    await lockReview(tx, workspaceId, id);
    const session = await tx.knowledgeImportSession.findFirst({ where: { workspaceId, id } });
    if (!session) throw NotFound('Import session');
    const checkedActor = await assertImportAdmin(tx, workspaceId, actor);
    if (session.status === 'READY' && session.processingStep === 'IMPORT_APPROVED_APPLICATION') return session;
    assertEditable(session.status);
    const approved = await tx.knowledgeImportItem.count({ where: { workspaceId, sessionId: id, status: 'APPROVED' } });
    if (!approved) throw new AppError('VALIDATION_FAILED', 'Approve at least one import item before applying', 400);
    const changed = await tx.knowledgeImportSession.updateMany({
      where: { workspaceId, id, run: session.run, status: session.status }, data: {
        status: 'READY', run: { increment: 1 }, progress: 0, errorSummary: null,
        processingStep: 'IMPORT_APPROVED_APPLICATION', applyActor: importJson(checkedActor),
      },
    });
    if (!changed.count) throw Conflict('IMPORT_BUSY', 'The import is already processing.');
    await audit(workspaceId, actor, 'knowledge_import.apply_requested', { type: 'knowledge_import', id }, { approved }, tx);
    return tx.knowledgeImportSession.findFirstOrThrow({ where: { workspaceId, id } });
  });
  await publishCommittedImport(session);
  return sessionView(session);
}

export async function cancelImport(workspaceId: string, id: string, actor: Actor) {
  return db().$transaction(async tx => {
    await lockReview(tx, workspaceId, id);
    const session = await tx.knowledgeImportSession.findFirst({ where: { workspaceId, id } });
    if (!session) throw NotFound('Import session');
    if (!['UPLOADED', 'PROCESSING'].includes(session.status) || !['IMPORT_FILE_PARSE', 'IMPORT_EXTRACTION', 'IMPORT_SCHEMA_VALIDATION'].includes(session.processingStep ?? '')) {
      throw Conflict('IMPORT_NOT_CANCELLABLE', 'Cancellation is available before semantic mapping starts.');
    }
    const updated = await tx.knowledgeImportSession.updateMany({
      where: { workspaceId, id, run: session.run, status: session.status, processingStep: session.processingStep },
      data: { status: 'CANCELLED', processingStep: null, run: { increment: 1 } },
    });
    if (!updated.count) throw Conflict('IMPORT_BUSY', 'This import has already started processing.');
    await tx.knowledgeImportFile.updateMany({
      where: { workspaceId, sessionId: id },
      data: { status: 'CANCELLED', content: null, parsedRows: Prisma.DbNull, extracted: Prisma.DbNull },
    });
    await audit(workspaceId, actor, 'knowledge_import.cancelled', { type: 'knowledge_import', id }, {}, tx);
    return sessionView(await tx.knowledgeImportSession.findFirstOrThrow({ where: { workspaceId, id } }));
  });
}

export async function retryImport(workspaceId: string, id: string, actor: Actor) {
  const session = await db().$transaction(async tx => {
    const found = await tx.knowledgeImportSession.findFirst({ where: { workspaceId, id } });
    if (!found) throw NotFound('Import session');
    if (!found.processingStep || found.status !== 'FAILED') throw Conflict('IMPORT_NOT_RETRYABLE', 'This import has no failed background step to retry.');
    const applying = importStages.indexOf(StageSchema.parse(found.processingStep)) >= importStages.indexOf('IMPORT_APPROVED_APPLICATION');
    const checked = applying ? await assertImportAdmin(tx, workspaceId, actor) : null;
    const updated = await tx.knowledgeImportSession.updateMany({
      where: { workspaceId, id, status: 'FAILED', run: found.run },
      data: { status: applying ? 'READY' : 'UPLOADED', errorSummary: null, run: { increment: 1 }, ...(checked ? { applyActor: importJson(checked) } : {}) },
    });
    if (!updated.count) throw Conflict('IMPORT_BUSY', 'The import is already processing.');
    await audit(workspaceId, actor, 'knowledge_import.retried', { type: 'knowledge_import', id }, { step: found.processingStep }, tx);
    return tx.knowledgeImportSession.findFirstOrThrow({ where: { workspaceId, id } });
  });
  await publishCommittedImport(session);
  return sessionView(session);
}

export async function recoverImportJobs() {
  const sessions = await db().knowledgeImportSession.findMany({
    where: { status: { in: ['UPLOADED', 'PROCESSING', 'READY'] }, processingStep: { not: null } },
    select: { id: true, workspaceId: true, run: true, processingStep: true },
  });
  for (const session of sessions) {
    const jobId = `knowledge-import-${session.id}-${session.run}-${session.processingStep}`;
    // Releases before the dedicated queue published stages on the shared lead-import queue; still honour those.
    const job = await queue(QUEUES.knowledgeImport).getJob(jobId) ?? await queue(QUEUES.imports).getJob(jobId);
    if (!job) {
      await enqueueImportStage(session);
      continue;
    }
    const state = await job.getState();
    if (state === 'completed') {
      // Queue bookkeeping may complete without committing the database checkpoint.
      // Use a new run so a delayed copy of the old job cannot write to this session.
      const advanced = await db().knowledgeImportSession.updateMany({
        where: { id: session.id, workspaceId: session.workspaceId, run: session.run, processingStep: session.processingStep, status: { in: ['UPLOADED', 'PROCESSING', 'READY'] } },
        data: { run: { increment: 1 } },
      });
      if (advanced.count) await enqueueImportStage({ ...session, run: session.run + 1 });
    }
    if (state === 'failed') {
      await db().knowledgeImportSession.updateMany({
        where: { id: session.id, workspaceId: session.workspaceId, run: session.run, processingStep: session.processingStep },
        data: { status: 'FAILED', errorSummary: 'The background step exhausted its retries.' },
      });
    }
  }
}
