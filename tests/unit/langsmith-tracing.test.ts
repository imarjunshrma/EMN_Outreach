import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitLangSmithAiTrace, resetLangSmithFetchForTests, setLangSmithFetchForTests } from '../../backend/src/services/langsmith-tracing.js';

const input = {
  workspaceId: 'workspace-sensitive-id', task: 'EMAIL_WRITING', provider: 'OPENAI', model: 'test-model', promptVersion: 7,
  generationMode: 'structured', schemaValid: true, inputFields: ['lead', 'claims'], output: { body: 'private generated email' },
  systemPrompt: 'private system prompt', userPrompt: 'Jane Doe at SensitiveCo', entity: { type: 'lead', id: 'prospect-sensitive-id' },
  inputTokens: 42, outputTokens: 21, latencyMs: 100, costUsd: 0.001,
};

afterEach(() => {
  delete process.env.LANGSMITH_TRACING;
  delete process.env.LANGSMITH_API_KEY;
  delete process.env.LANGSMITH_ENDPOINT;
  delete process.env.LANGSMITH_PROJECT;
  resetLangSmithFetchForTests();
  vi.restoreAllMocks();
});

describe('LangSmith redacted tracing', () => {
  it('is disabled unless explicitly configured', async () => {
    const fetch = vi.fn();
    setLangSmithFetchForTests(fetch as unknown as typeof globalThis.fetch);
    expect(await emitLangSmithAiTrace(input)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends execution metadata and content hashes without raw prompts, output, or identifiers', async () => {
    process.env.LANGSMITH_TRACING = 'true';
    process.env.LANGSMITH_API_KEY = 'test-only-secret';
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 202 }));
    setLangSmithFetchForTests(fetch as unknown as typeof globalThis.fetch);
    expect(await emitLangSmithAiTrace(input)).toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://api.smith.langchain.com/runs');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('test-only-secret');
    const body = String(init?.body);
    expect(body).toContain('EMAIL_WRITING');
    expect(body).toContain('content_sha256');
    for (const sensitive of ['private system prompt', 'Jane Doe', 'SensitiveCo', 'private generated email', 'workspace-sensitive-id', 'prospect-sensitive-id']) {
      expect(body).not.toContain(sensitive);
    }
  });
});
