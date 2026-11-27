/**
 * A lead import left RUNNING by a worker that died must become retryable, while one whose worker is alive (it holds the
 * import lock) must be left alone. The end-to-end crash (SIGKILL of a real worker process) is exercised by
 * `scripts/knowledge-import-recovery-smoke.ts --lead-import-crash`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import { acquireLock, redis } from '../../backend/src/core/redis.js';
import { recoverInterruptedLeadImports } from '../../backend/src/services/leads.js';
import { createUserSession, resetDb } from '../helpers/harness.js';

beforeEach(async () => { await resetDb(); await redis().flushdb(); });

async function runningImport(workspaceId: string, fileName: string) {
  return db().importJob.create({ data: { workspaceId, fileName, storageKey: `imports/${fileName}`, headers: ['email'], status: 'RUNNING' } });
}

describe('interrupted lead imports', () => {
  it('marks an import without a live worker FAILED and leaves a live one RUNNING', async () => {
    const { workspaceId } = await createUserSession('lead-recovery@x.com');
    const orphan = await runningImport(workspaceId, 'orphan.csv');
    const live = await runningImport(workspaceId, 'live.csv');
    const release = await acquireLock(`import-csv:${workspaceId}:${live.id}`, 60_000);
    try {
      expect(await recoverInterruptedLeadImports()).toEqual({ recovered: 1 });
      expect((await db().importJob.findUniqueOrThrow({ where: { id: orphan.id } })).status).toBe('FAILED');
      expect((await db().importJob.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('RUNNING');
      expect(await db().auditLog.count({ where: { workspaceId, action: 'import.interrupted', entityId: orphan.id } })).toBe(1);
      expect(await recoverInterruptedLeadImports()).toEqual({ recovered: 0 });
    } finally {
      await release?.();
    }
  });

  it('keeps a renewed lock alive past its time-to-live', async () => {
    const release = await acquireLock('renewal-fixture', 300, { renewEveryMs: 100 });
    try {
      await new Promise(resolve => setTimeout(resolve, 900));
      expect(await redis().exists('lock:renewal-fixture')).toBe(1);
    } finally {
      await release?.();
    }
    expect(await redis().exists('lock:renewal-fixture')).toBe(0);
  });
});
