import { randomUUID } from 'node:crypto';
import { db } from '../core/db.js';
import { AppError } from '../core/errors.js';
import { store } from '../core/storage.js';
import { orgIdOf } from '../core/tenant.js';
import { logger } from '../core/logger.js';

// Storage accounting: every object the application stores for a customer is recorded in StoredObject
// with its real size (the Buffer we write — never a client-declared size). Limits are enforced per
// organization under a transaction-scoped advisory lock, so concurrent uploads cannot overshoot.
// Compliance writes (privacy exports) and inbound email attachments are recorded but never refused:
// blocking them would lose customer mail or break a legal request.

const MB = 1024 * 1024;
const lockKey = (organizationId: string) => `storage:${organizationId}`;

export async function storageBytes(organizationId: string): Promise<number> {
  const r = await db().storedObject.aggregate({ where: { organizationId }, _sum: { bytes: true } });
  return Number(r._sum.bytes ?? 0n);
}

export async function storageLimitBytes(organizationId: string): Promise<number> {
  const { tenantState } = await import('./entitlements.js');
  const st = await tenantState(organizationId);
  if (st.source === 'unlimited') return Number.MAX_SAFE_INTEGER;
  return st.entitlements.storageMb >= 1e9 ? Number.MAX_SAFE_INTEGER : st.entitlements.storageMb * MB;
}

/** Stores an object and records it. With `enforce`, refuses (QUOTA_EXCEEDED, 402) if the organization would exceed its storage limit. */
export async function putTracked(workspaceId: string, kind: string, data: Buffer, ext: string, opts: { enforce: boolean }) {
  const organizationId = await orgIdOf(workspaceId);
  const bytes = BigInt(data.length);
  const reservation = `pending:${randomUUID()}`;
  const limit = opts.enforce ? await storageLimitBytes(organizationId) : Number.MAX_SAFE_INTEGER;
  await db().$transaction(async (tx) => {
    await tx.$queryRaw`WITH l AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtext(${lockKey(organizationId)}))) SELECT 1 FROM l`;
    if (opts.enforce) {
      const used = Number((await tx.storedObject.aggregate({ where: { organizationId }, _sum: { bytes: true } }))._sum.bytes ?? 0n);
      if (used + data.length > limit) {
        throw new AppError('QUOTA_EXCEEDED', `Storage limit reached: ${(used / MB).toFixed(1)} MB of ${(limit / MB).toFixed(0)} MB used, this file needs ${(data.length / MB).toFixed(1)} MB. Delete old files or upgrade your plan.`, 402, { limit: 'storageMb' });
      }
    }
    await tx.storedObject.create({ data: { organizationId, workspaceId, key: reservation, kind, bytes } });
  });
  try {
    const key = await store().put(workspaceId, kind, data, ext);
    await db().storedObject.update({ where: { key: reservation }, data: { key } });
    return key;
  } catch (e) {
    await db().storedObject.deleteMany({ where: { key: reservation } });
    throw e;
  }
}

/** Deletes an object and releases its storage. Missing objects are fine (idempotent). */
export async function deleteTracked(key: string) {
  await store().delete(key).catch(() => undefined);
  await db().storedObject.deleteMany({ where: { key } });
}

/**
 * Daily: objects written before accounting existed (or by hand) are covered by a per-workspace
 * baseline row = actual bytes in storage − tracked bytes, so totals match what is really stored.
 */
export async function reconcileStorage() {
  const workspaces = await db().workspace.findMany({ select: { id: true, organizationId: true } });
  let adjusted = 0;
  for (const w of workspaces) {
    try {
      const actual = await store().usage(w.id);
      const baselineKey = `${w.id}/__untracked_baseline__`;
      const tracked = Number((await db().storedObject.aggregate({ where: { workspaceId: w.id, NOT: { key: baselineKey } }, _sum: { bytes: true } }))._sum.bytes ?? 0n);
      const baseline = BigInt(Math.max(0, actual - tracked));
      await db().storedObject.upsert({ where: { key: baselineKey }, update: { bytes: baseline }, create: { key: baselineKey, organizationId: w.organizationId, workspaceId: w.id, kind: 'baseline', bytes: baseline } });
      adjusted++;
    } catch (e) { logger.warn({ err: (e as Error).message, workspaceId: w.id }, 'storage reconcile failed'); }
  }
  return { workspaces: adjusted };
}
