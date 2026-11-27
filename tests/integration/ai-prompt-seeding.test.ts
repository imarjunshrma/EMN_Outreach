/**
 * The built-in prompt for a task is seeded on first use. Concurrent first uses in a new workspace (for example two import
 * extraction stages, or a personalization batch) must all receive that prompt instead of failing on the unique version
 * constraint or reporting "No active prompt".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import { captureImportExtractionPrompt } from '../../backend/src/services/ai.js';
import { createUserSession, resetDb } from '../helpers/harness.js';

beforeEach(async () => { await resetDb(); });

describe('built-in prompt seeding', () => {
  it('gives every concurrent first caller the same seeded prompt', async () => {
    for (let round = 0; round < 5; round++) {
      const { workspaceId } = await createUserSession(`prompt-seed-${round}@x.com`);
      await db().promptTemplate.deleteMany({ where: { workspaceId, task: 'KNOWLEDGE_IMPORT_EXTRACTION' } });
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => captureImportExtractionPrompt(workspaceId)));
      expect(results.filter(result => result.status === 'rejected').map(result => String((result as PromiseRejectedResult).reason))).toEqual([]);
      const ids = new Set(results.map(result => (result as PromiseFulfilledResult<{ id: string }>).value.id));
      expect(ids.size).toBe(1);
      expect(await db().promptTemplate.count({ where: { workspaceId, task: 'KNOWLEDGE_IMPORT_EXTRACTION' } })).toBe(1);
    }
  });

  it('still respects a workspace that deactivated every version of a prompt', async () => {
    const { workspaceId } = await createUserSession('prompt-off@x.com');
    await captureImportExtractionPrompt(workspaceId);
    await db().promptTemplate.updateMany({ where: { workspaceId, task: 'KNOWLEDGE_IMPORT_EXTRACTION' }, data: { isActive: false } });
    await expect(captureImportExtractionPrompt(workspaceId)).rejects.toThrow(/Activate an importer extraction prompt/);
  });
});
