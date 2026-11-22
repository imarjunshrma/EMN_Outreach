import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import { createVerification } from '../../backend/src/services/first-party-verification.js';
import { resetDb, installFakes, createUserSession } from '../helpers/harness.js';

beforeEach(async () => { await resetDb(); installFakes(); });

describe('first-party email verification persistence and tenant boundaries', () => {
  it('reuses one queued record for concurrent duplicate requests', async () => {
    const owner = await createUserSession('verify-owner@example.test');
    const results = await Promise.all(Array.from({ length: 8 }, () => createVerification(owner.workspaceId, ' Person@Example.com ')));
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await db().emailVerification.count({ where: { workspaceId: owner.workspaceId, email: 'person@example.com', provider: 'first-party-dns', rawResult: 'queued' } })).toBe(1);
  });

  it('does not expose another workspace batch through the authenticated API', async () => {
    const owner = await createUserSession('verify-owner@example.test');
    const other = await createUserSession('verify-other@example.test');
    const batch = await db().emailVerificationBatch.create({ data: { workspaceId: owner.workspaceId, total: 1 } });
    await db().emailVerification.create({ data: { workspaceId: owner.workspaceId, batchId: batch.id, email: 'person@example.com', provider: 'first-party-dns', result: 'UNKNOWN', rawResult: 'queued', details: { state: 'QUEUED' } } });
    await expect(db().emailVerification.create({ data: { workspaceId: other.workspaceId, batchId: batch.id, email: 'other@example.com', provider: 'first-party-dns', result: 'UNKNOWN', rawResult: 'queued', details: { state: 'QUEUED' } } })).rejects.toThrow();
    const response = await other.agent.get(`/api/v1/w/${other.workspaceId}/email-verification/batches/${batch.id}`);
    expect(response.status).toBe(404);
  });
});
