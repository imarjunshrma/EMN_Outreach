import { describe, expect, it } from 'vitest';
import { embeddingBaseUrl, embeddingEndpoint, parseEmbeddingResponse } from '../../backend/src/services/intelligence-memory.js';

const vector = (n: number) => Array.from({ length: 1536 }, () => n);

describe('pgvector embedding adapter compatibility', () => {
  it('uses native Ollama endpoint unless an OpenAI-compatible /v1 base is configured', () => {
    expect(embeddingEndpoint('OLLAMA', 'http://localhost:11434')).toBe('http://localhost:11434/api/embed');
    expect(embeddingEndpoint('OLLAMA', 'http://localhost:11434/v1/')).toBe('http://localhost:11434/v1/embeddings');
    expect(embeddingEndpoint('OPENAI', 'https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/embeddings');
  });

  it('uses the official OpenAI embeddings endpoint unless a workspace override exists', () => {
    expect(embeddingBaseUrl('OPENAI')).toBe('https://api.openai.com/v1');
    expect(embeddingBaseUrl('OPENAI', 'https://proxy.example/v1')).toBe('https://proxy.example/v1');
  });

  it('parses OpenAI-compatible data in index order and captures token usage', () => {
    const result = parseEmbeddingResponse('OPENAI', { data: [{ index: 1, embedding: vector(2) }, { index: 0, embedding: vector(1) }], usage: { total_tokens: 28 } }, 2);
    expect(result.vectors[0]?.[0]).toBe(1);
    expect(result.totalTokens).toBe(28);
  });

  it('parses Ollama native batches', () => {
    const result = parseEmbeddingResponse('OLLAMA', { embeddings: [vector(1)] }, 1);
    expect(result.vectors[0]).toHaveLength(1536);
  });

  it('rejects missing, wrong-sized, or non-finite vectors instead of storing them', () => {
    expect(() => parseEmbeddingResponse('OPENAI', { data: [] }, 1)).toThrow(/incomplete batch/);
    expect(() => parseEmbeddingResponse('OPENAI', { data: [{ index: 0, embedding: [1, 2] }] }, 1)).toThrow(/1536/);
    const bad = vector(1); bad[10] = Number.NaN;
    expect(() => parseEmbeddingResponse('OLLAMA', { embeddings: [bad] }, 1)).toThrow(/finite/);
  });
});
