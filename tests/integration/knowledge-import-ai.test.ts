import { describe, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import { createPromptVersion, updateRoute } from '../../backend/src/services/ai.js';
import { captureImportExtraction, extractImportRows } from '../../backend/src/services/knowledge-import-extraction.js';
import { parseImportFile } from '../../backend/src/services/knowledge-import-parser.js';
import { addAiProvider, createUserSession, installFakes } from '../helpers/harness.js';
import { randomUUID } from 'node:crypto';

const task = 'KNOWLEDGE_IMPORT_EXTRACTION';

describe('Knowledge Importer provider routing', () => {
  it('pins the workspace prompt and model route, repairs malformed output and records usage without document content', async () => {
    const fakes = installFakes();
    const session = await createUserSession(`knowledge-import-${randomUUID()}@example.test`);
    const { workspaceId } = session;
    const actor = { type: 'USER' as const, userId: session.userId };
    await addAiProvider(workspaceId, 'OPENAI', 'synthetic-model-v1');
    const snapshot = await captureImportExtraction(workspaceId);

    await updateRoute(workspaceId, { task, provider: 'OPENAI', model: 'synthetic-model-v2' }, actor);
    await createPromptVersion(workspaceId, {
      task, systemPrompt: 'New workspace prompt', userPromptTemplate: '{{catalog}}\n{{source}}', activate: true,
    }, actor);

    let attempts = 0;
    fakes.openai.on(task, () => {
      if (++attempts === 1) return { invalid: true };
      return {
        items: [{
          entityType: 'COMPANY_PROFILE', sourceIndex: 0, fields: [{ key: 'name', values: ['Synthetic Company'] }],
          classification: 'EXPLICIT_FACT', confidence: 0.8, sourceExcerpt: 'Synthetic Company',
          relationships: [], mappingExplanation: 'The source names a company.',
        }],
      };
    });
    const rows = await parseImportFile(Buffer.from('Synthetic Company'), 'company.txt');
    const [result] = await extractImportRows(workspaceId, rows, undefined, snapshot);
    expect(result.payload).toEqual({ name: 'Synthetic Company' });
    expect(result.verificationStatus).toBe('UNVERIFIED');
    expect(fakes.openai.calls.map(call => call.model)).toEqual(['synthetic-model-v1', 'synthetic-model-v1']);
    expect(fakes.openai.calls[1].user).toContain('CONTROLLED SCHEMA REPAIR');
    expect(fakes.openai.calls[0].system).toBe(snapshot.prompt.systemPrompt);

    const executions = await db().aiExecution.findMany({ where: { workspaceId, task } });
    expect(executions.map(row => row.status).sort()).toEqual(['SCHEMA_INVALID', 'SUCCEEDED']);
    for (const execution of executions) {
      expect(execution).toMatchObject({
        model: 'synthetic-model-v1', promptTemplateId: snapshot.prompt.id,
        inputTokens: 1000, outputTokens: 200, inputPreview: null, output: null,
      });
    }
  });
});
