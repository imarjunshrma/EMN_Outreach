import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { Job } from 'bullmq';
import { z } from 'zod';
import { db, Prisma, type KnowledgeImportItemStatus } from '../core/db.js';
import { AppError } from '../core/errors.js';
import { audit, WORKER_ACTOR } from '../core/audit.js';
import { ImportEntityTypeSchema, validateImportPayload } from '../../../shared/src/knowledge-import.js';
import { assertImportAdmin, enqueueImportStage, importJson, importStages, StageSchema } from './knowledge-import.js';
import { applyImportItem, destinationFor, importStableKey, inspectImportItem, syncImportRetrieval } from './knowledge-import-apply.js';
import { captureImportExtraction, describeLeftOut, extractImportRowsDetailed, LEFT_OUT_PREFIX, type ImportExtractedItem, type ImportExtractionSnapshot } from './knowledge-import-extraction.js';
import { tenantStateForWorkspace } from './entitlements.js';
import { EMPTY_TEMPLATE_NOTICE, parseImportFileDetailed, type ParsedImportRow } from './knowledge-import-parser.js';

const jobData = z.object({ workspaceId: z.uuid(), sessionId: z.uuid(), run: z.number().int().nonnegative() });
const activeStatus = ['UPLOADED', 'PROCESSING', 'READY'] as const;
const applicationStart = importStages.indexOf('IMPORT_APPROVED_APPLICATION');

function workerError(error: unknown) {
  return error instanceof AppError ? error.message.slice(0, 500) : 'The background step could not complete. Retry from the import detail page.';
}

export async function processImportJob(job: Job) {
  const { workspaceId, sessionId, run } = jobData.parse(job.data);
  const stage = StageSchema.parse(job.name);
  const index = importStages.indexOf(stage);
  const scope = { workspaceId, sessionId };
  const sessionWhere = { id: sessionId, workspaceId, run };
  const session = await db().knowledgeImportSession.findFirst({ where: sessionWhere });
  if (!session || !activeStatus.some(status => status === session.status)) return;
  if (session.processingStep !== stage) {
    // A completed transaction can outlive an interrupted Redis publish.
    if (session.processingStep === importStages[index + 1]) await enqueueImportStage(session);
    return;
  }
  const currentStage = { ...sessionWhere, processingStep: stage };

  try {
    const tenancy = await tenantStateForWorkspace(workspaceId);
    if (!tenancy.operational) throw new AppError('TENANT_INACTIVE', 'The organization cannot process imports at its current status.', 403);
    if (stage === 'IMPORT_FILE_PARSE') {
      const claimed = await db().knowledgeImportSession.updateMany({
        where: { ...currentStage, status: { in: ['UPLOADED', 'PROCESSING'] } }, data: { status: 'PROCESSING' },
      });
      if (!claimed.count) return;
      const files = await db().knowledgeImportFile.findMany({
        where: { ...scope, status: 'PENDING' }, orderBy: { createdAt: 'asc' },
        select: { id: true, fileName: true, mimeType: true },
      });
      for (const [position, file] of files.entries()) {
        try {
          const pending = await db().knowledgeImportFile.findFirst({ where: { ...scope, id: file.id, status: 'PENDING', session: currentStage }, select: { content: true } });
          if (!pending) return;
          if (!pending.content) throw new AppError('VALIDATION_FAILED', 'The file has no stored upload to parse.', 400);
          const { rows, emptyTemplate } = await parseImportFileDetailed(Buffer.from(pending.content), file.fileName, file.mimeType);
          // An unfilled official template is a valid upload with nothing to import; any other empty file is refused.
          if (!rows.length && !emptyTemplate) throw new AppError('VALIDATION_FAILED', 'The file contains no importable rows.', 400);
          await db().knowledgeImportFile.updateMany({
            where: { ...scope, id: file.id, status: 'PENDING' },
            data: { parsedRows: importJson(rows), status: 'PARSED', content: null, error: null },
          });
        } catch (error) {
          if (!(error instanceof AppError) || error.status >= 500) throw error;
          await db().knowledgeImportFile.updateMany({
            where: { ...scope, id: file.id, status: 'PENDING' },
            data: { status: 'FAILED', content: null, error: workerError(error) },
          });
        }
        await job.updateProgress(Math.round(100 * (position + 1) / files.length));
      }
    }

    if (stage === 'IMPORT_EXTRACTION') {
      const files = await db().knowledgeImportFile.findMany({
        where: { ...scope, status: 'PARSED' }, orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (files.length) {
        // Captured on first use: an unfilled template has nothing to extract and needs no AI route.
        let snapshot = session.extractionRoute as unknown as ImportExtractionSnapshot | null;
        const extractionSnapshot = async () => {
          if (snapshot) return snapshot;
          snapshot = await captureImportExtraction(workspaceId);
          await db().knowledgeImportSession.updateMany({ where: currentStage, data: { extractionRoute: importJson(snapshot) } });
          return snapshot;
        };
        for (const [position, file] of files.entries()) {
          const parsed = await db().knowledgeImportFile.findFirst({
            where: { ...scope, id: file.id, status: 'PARSED', session: currentStage }, select: { parsedRows: true },
          });
          if (!parsed) return;
          const parsedRows = parsed.parsedRows as unknown as ParsedImportRow[];
          if (!parsedRows.length) {
            // Only an unfilled official template is accepted with no rows (see the parse stage).
            await db().knowledgeImportFile.updateMany({
              where: { ...scope, id: file.id, status: 'PARSED' },
              data: { extracted: importJson([]), parsedRows: Prisma.DbNull, status: 'EXTRACTED', error: EMPTY_TEMPLATE_NOTICE },
            });
            await job.updateProgress(Math.round(100 * (position + 1) / files.length));
            continue;
          }
          try {
            const { items: result, rejected } = await extractImportRowsDetailed(workspaceId, parsedRows, sessionId, await extractionSnapshot());
            // Records that failed validation are left out of review; say which, and why, without quoting their content.
            const note = rejected.length ? `${LEFT_OUT_PREFIX}: ${describeLeftOut(rejected)}` : null;
            await db().knowledgeImportFile.updateMany({
              where: { ...scope, id: file.id, status: 'PARSED' },
              data: { extracted: importJson(result), parsedRows: Prisma.DbNull, status: 'EXTRACTED', error: note },
            });
          } catch (error) {
            // A file the model cannot extract consistently (output that fails the schema or cites text it was not
            // given, even after the repair attempt) fails on its own; other files in the import continue. Provider,
            // network and configuration errors still throw so the stage retries and nothing is lost.
            const fileLevel = error instanceof AppError && ((error.code === 'VALIDATION_FAILED' && error.status === 400) || error.code === 'AI_OUTPUT_INVALID');
            if (!fileLevel) throw error;
            await db().knowledgeImportFile.updateMany({
              where: { ...scope, id: file.id, status: 'PARSED' },
              data: { status: 'FAILED', parsedRows: Prisma.DbNull, error: workerError(error) },
            });
          }
          await job.updateProgress(Math.round(100 * (position + 1) / files.length));
        }
      }
    }

    if (stage === 'IMPORT_SCHEMA_VALIDATION' || stage === 'IMPORT_SEMANTIC_MAPPING') {
      const files = await db().knowledgeImportFile.findMany({
        where: { ...scope, status: stage === 'IMPORT_SCHEMA_VALIDATION' ? 'EXTRACTED' : 'VALIDATED' },
        select: { id: true, extracted: true, error: true },
      });
      for (const file of files) {
        const items = file.extracted as unknown as ImportExtractedItem[];
        if (stage === 'IMPORT_SCHEMA_VALIDATION') {
          // An item that fails destination validation is kept and goes to review with the reason (duplicate detection
          // marks it NEEDS_REVIEW). Throwing here used to fail the whole import, every file, for one bad record.
          const invalid = items.filter(item => {
            const type = ImportEntityTypeSchema.safeParse(item.entityType);
            if (!type.success) return true;
            try { validateImportPayload(type.data, item.payload); return false; } catch { return true; }
          }).length;
          await db().knowledgeImportFile.updateMany({
            where: { ...scope, id: file.id, status: 'EXTRACTED' },
            data: { status: 'VALIDATED', ...(invalid ? { error: [`${invalid} extracted record(s) need corrections during review.`, file.error?.startsWith(LEFT_OUT_PREFIX) ? file.error : null].filter(Boolean).join(' ').slice(0, 1000) } : {}) },
          });
          continue;
        }
        await db().$transaction(async tx => {
          await tx.knowledgeImportItem.createMany({
            skipDuplicates: true,
            data: items.map((item, ordinal) => ({
              ...scope, fileId: file.id, entityType: item.entityType, destination: destinationFor(item.entityType),
              sourceLocator: item.source.locator, sourceExcerpt: item.source.excerpt,
              sourceMetadata: importJson({
                sheet: item.source.sheet, row: item.source.row, page: item.source.page, paragraph: item.source.paragraph,
                warnings: item.source.warnings, executionId: item.executionId,
              }),
              payload: importJson(item.payload), proposedValue: importJson(item.payload), confidence: item.confidence,
              classification: item.classification, verificationStatus: item.verificationStatus,
              relationships: importJson(item.relationships), mappingExplanation: item.mappingExplanation,
              extractionKey: createHash('sha256').update(`${file.id}:${ordinal}:${item.source.locator}`).digest('hex'),
              // No key for a record with neither an ID nor a name: it must not be grouped with other unnamed records.
              stableKey: /:name:$/.test(importStableKey(item.entityType, item.payload)) ? null : importStableKey(item.entityType, item.payload),
            })),
          });
          await tx.knowledgeImportFile.updateMany({
            where: { ...scope, id: file.id, status: 'VALIDATED' },
            data: { status: 'REVIEW', extracted: Prisma.DbNull, error: file.error?.includes(LEFT_OUT_PREFIX) ? file.error.slice(file.error.indexOf(LEFT_OUT_PREFIX))
              : items.length ? null : file.error === EMPTY_TEMPLATE_NOTICE ? EMPTY_TEMPLATE_NOTICE : 'No structured knowledge was identified in this file.' },
          });
        });
      }
    }

    if (stage === 'IMPORT_DUPLICATE_DETECTION') {
      const items = await db().knowledgeImportItem.findMany({ where: scope, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      for (const item of items) {
        const review = await inspectImportItem(db(), workspaceId, item);
        await db().knowledgeImportItem.updateMany({ where: { ...scope, id: item.id }, data: {
          stableKey: review.stableKey || null, duplicateCandidates: importJson(review.duplicateCandidates),
          existingValue: review.existingValue ? importJson(review.existingValue) : Prisma.DbNull,
          conflictReason: review.conflictReason ?? ((item.confidence ?? 0) < 0.6 && review.status === 'CREATE' ? 'Low extraction confidence. Check this proposal against its source.' : null),
          status: (item.confidence ?? 0) < 0.6 && review.status === 'CREATE' ? 'NEEDS_REVIEW' : review.status,
        } });
      }
    }

    if (stage === 'IMPORT_CONFLICT_DETECTION') {
      const items = await db().knowledgeImportItem.findMany({ where: scope, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const groups = new Map<string, typeof items>();
      for (const item of items) {
        if (!item.stableKey) continue;
        const siblings = groups.get(item.stableKey) ?? [];
        siblings.push(item);
        groups.set(item.stableKey, siblings);
      }
      for (const siblings of groups.values()) {
        const [first, ...others] = siblings;
        if (!others.length) continue;
        const consistent = others.every(other => isDeepStrictEqual(other.payload, first.payload));
        for (const item of consistent ? others : siblings) {
          const data: { status: KnowledgeImportItemStatus; conflictReason: string; duplicateCandidates: Prisma.InputJsonValue } = {
            status: consistent ? 'SKIP' : 'CONFLICT',
            conflictReason: consistent ? 'Identical proposal in another source in this import.' : 'Sources in this import propose different values for the same record. Approve one proposal.',
            duplicateCandidates: importJson([
              ...(Array.isArray(item.duplicateCandidates) ? item.duplicateCandidates.filter(candidate => !candidate || typeof candidate !== 'object' || !('source' in candidate)) : []),
              ...siblings.filter(other => other.id !== item.id).map(other => ({ id: other.id, source: other.sourceLocator, name: 'Other import proposal', reason: 'Stable identifier matches' })),
            ]),
          };
          await db().knowledgeImportItem.updateMany({ where: { ...scope, id: item.id }, data });
        }
      }
      await db().knowledgeImportSession.updateMany({ where: currentStage, data: {
        errorSummary: await db().knowledgeImportFile.count({ where: { ...scope, status: 'FAILED' } })
          ? 'One or more files could not be processed. See file details.' : null,
      } });
    }

    if (stage === 'IMPORT_APPROVED_APPLICATION') {
      await applySession(workspaceId, sessionId, run, session.applyActor, job);
    }

    if (stage === 'IMPORT_EMBEDDING') {
      const items = await db().knowledgeImportItem.findMany({
        where: { ...scope, status: 'APPLIED', destinationDocumentId: { not: null }, applicationResult: { not: 'UNCHANGED' } },
        select: { id: true },
      });
      for (const [position, item] of items.entries()) {
        await syncImportRetrieval(workspaceId, item.id);
        await job.updateProgress(Math.round(100 * (position + 1) / items.length));
      }
    }

    const reviewReady = stage === 'IMPORT_CONFLICT_DETECTION';
    const applicationDone = stage === 'IMPORT_RETRIEVAL_SYNC';
    const next = reviewReady || applicationDone ? null : importStages[index + 1];
    const progress = reviewReady || applicationDone ? 100
      : index < applicationStart ? Math.round(100 * (index + 1) / applicationStart)
        : Math.round(100 * (index + 1 - applicationStart) / (importStages.length - applicationStart));
    const updated = await db().$transaction(async tx => {
      const counts = applicationDone ? await tx.knowledgeImportItem.groupBy({ by: ['status'], where: scope, _count: { _all: true } }) : [];
      const statusCounts = Object.fromEntries(counts.map(entry => [entry.status, entry._count._all]));
      const result = await tx.knowledgeImportSession.updateMany({
        where: currentStage, data: {
          processingStep: next, progress,
          ...(reviewReady ? { status: 'REVIEW', extractionRoute: Prisma.DbNull } : {}),
          ...(applicationDone ? {
            status: 'APPLIED', applyActor: Prisma.DbNull,
            errorSummary: statusCounts.FAILED ? 'One or more changes need review before they can be applied.' : null,
          } : {}),
        },
      });
      if (result.count && applicationDone) await audit(workspaceId, WORKER_ACTOR, 'knowledge_import.applied', { type: 'knowledge_import', id: sessionId }, statusCounts, tx);
      return result;
    });
    if (updated.count && next) await enqueueImportStage({ ...session, processingStep: next });
    await job.updateProgress(100);
  } catch (error) {
    const message = workerError(error);
    if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
      await db().knowledgeImportSession.updateMany({ where: currentStage, data: { status: 'FAILED', errorSummary: message } });
    }
    // Provider errors can include imported text. Keep the queue failure sanitized.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(message);
  }
}

const dependencyOrder = [
  'COMPANY_PROFILE', 'PRODUCT', 'SERVICE', 'COMMERCIAL_OFFER', 'TARGET_AUDIENCE', 'TARGET_PERSONA',
  'ICP_CRITERIA', 'BUSINESS_OPPORTUNITY', 'COMPETITOR', 'RESEARCH_SETTINGS', 'WRITING_SETTINGS', 'RESEARCH_RULE', 'OUTREACH_RULE', 'EXCLUSION', 'PROOF_CASE_STUDY', 'CAMPAIGN_PREFERENCE',
];

/**
 * Concurrent imports in different workspaces can still collide on PostgreSQL's serializable predicate locks over shared
 * tables and indexes (Prisma P2034). The transaction is rolled back in full and re-reads its state, so retry it briefly
 * instead of failing the whole stage and waiting for the queue's exponential backoff.
 */
async function serializableWithRetry<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db().$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || attempt >= attempts) throw error;
      await delay(20 * 2 ** attempt + Math.floor(Math.random() * 40));
    }
  }
}

function relationshipKeys(input: unknown) {
  const parsed = z.array(z.object({ entityType: ImportEntityTypeSchema, externalId: z.string() })).safeParse(input ?? []);
  return parsed.success ? parsed.data.map(ref => importStableKey(ref.entityType, { externalId: ref.externalId })) : [];
}

async function applySession(workspaceId: string, sessionId: string, run: number, actorData: unknown, job: Job) {
  const scope = { workspaceId, sessionId };
  await assertImportAdmin(db(), workspaceId, actorData);
  const items = await db().knowledgeImportItem.findMany({ where: { ...scope, status: 'APPROVED' }, orderBy: { createdAt: 'asc' } });
  items.sort((a, b) => dependencyOrder.indexOf(a.entityType) - dependencyOrder.indexOf(b.entityType));
  const ordered: typeof items = [];
  const pending = new Map(items.map(item => [item.stableKey ?? item.id, item]));
  while (pending.size) {
    const ready = [...pending].filter(([, item]) => !relationshipKeys(item.relationships).some(key => pending.has(key)));
    if (!ready.length) break;
    for (const [key, item] of ready) {
      pending.delete(key);
      ordered.push(item);
    }
  }
  if (pending.size) {
    await db().$transaction(async tx => {
      const blockedIds = [...pending.values()].map(item => item.id);
      const reason = 'A circular relationship blocks this record. Edit its references or apply the dependencies separately.';
      const changed = await tx.knowledgeImportItem.updateMany({
        where: { ...scope, id: { in: blockedIds }, status: 'APPROVED', session: { workspaceId, run, status: 'READY' } },
        data: { status: 'FAILED', error: reason },
      });
      if (changed.count) await audit(workspaceId, WORKER_ACTOR, 'knowledge_import.relationship_cycle', { type: 'knowledge_import', id: sessionId }, { itemIds: blockedIds }, tx);
    });
  }
  for (const [position, item] of ordered.entries()) {
    try {
      await serializableWithRetry(async tx => {
        const session = await tx.knowledgeImportSession.findFirst({
          where: { workspaceId, id: sessionId, status: 'READY', run, processingStep: 'IMPORT_APPROVED_APPLICATION' },
        });
        if (!session) return;
        const actor = await assertImportAdmin(tx, workspaceId, session.applyActor);
        const current = await tx.knowledgeImportItem.findFirst({ where: { ...scope, id: item.id, status: 'APPROVED' } });
        if (!current) return;
        const result = await applyImportItem(tx, workspaceId, current, actor);
        const updated = await tx.knowledgeImportItem.updateMany({
          where: { ...scope, id: item.id, status: 'APPROVED', updatedAt: current.updatedAt },
          data: { ...result, status: 'APPLIED', appliedAt: new Date(), error: null },
        });
        if (!updated.count) throw new AppError('IMPORT_REVIEW_CHANGED', 'Item changed during application.', 409);
        await audit(workspaceId, actor, 'knowledge_import.item_applied', { type: 'knowledge_import_item', id: item.id }, { sessionId, ...result }, tx);
      });
    } catch (error) {
      if (!(error instanceof AppError || error instanceof z.ZodError)) throw error;
      const message = error instanceof z.ZodError ? 'Destination validation failed. Review the proposed fields.' : workerError(error);
      await db().$transaction(async tx => {
        const updated = await tx.knowledgeImportItem.updateMany({
          where: { ...scope, id: item.id, status: 'APPROVED', session: { workspaceId, run, status: 'READY' } },
          data: { status: 'FAILED', error: message },
        });
        if (updated.count) await audit(workspaceId, WORKER_ACTOR, 'knowledge_import.item_failed', { type: 'knowledge_import_item', id: item.id }, { sessionId, error: message }, tx);
      });
    }
    await job.updateProgress(Math.round(100 * (position + 1) / items.length));
  }
}
