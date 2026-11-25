import { createHash, randomUUID } from 'node:crypto';
import { logger } from '../core/logger.js';

export interface LangSmithAiTrace {
  workspaceId: string;
  task: string;
  provider: string;
  model: string;
  promptVersion: number | null;
  generationMode: string;
  schemaValid: boolean;
  inputFields: string[];
  output: unknown;
  systemPrompt: string;
  userPrompt: string;
  entity?: { type: string; id: string };
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
}

type TraceFetch = typeof fetch;
let fetchImpl: TraceFetch = fetch;
export function setLangSmithFetchForTests(f: TraceFetch) { fetchImpl = f; }
export function resetLangSmithFetchForTests() { fetchImpl = fetch; }

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Sends metadata-only traces. Prompt, prospect, email, evidence text, raw IDs and secrets stay local. */
export async function emitLangSmithAiTrace(trace: LangSmithAiTrace) {
  const key = process.env.LANGSMITH_API_KEY;
  if (process.env.LANGSMITH_TRACING !== 'true' || !key) return false;
  const configured = process.env.LANGSMITH_ENDPOINT || 'https://api.smith.langchain.com';
  let endpoint: URL;
  try { endpoint = new URL(configured); } catch { return false; }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) return false;
  const now = new Date();
  const outputText = JSON.stringify(trace.output ?? null);
  const workspaceTag = digest(trace.workspaceId).slice(0, 24);
  const body = {
    id: randomUUID(),
    name: `Outvexa ${trace.task}`,
    run_type: 'llm',
    start_time: new Date(now.getTime() - Math.max(0, trace.latencyMs)).toISOString(),
    end_time: now.toISOString(),
    session_name: process.env.LANGSMITH_PROJECT || 'outvexa',
    inputs: { field_names: trace.inputFields, content_sha256: digest(`${trace.systemPrompt}\n${trace.userPrompt}`) },
    outputs: { field_names: trace.output && typeof trace.output === 'object' && !Array.isArray(trace.output) ? Object.keys(trace.output) : [], content_sha256: digest(outputText), schema_valid: trace.schemaValid },
    extra: { metadata: {
      application: 'outvexa', workspace_tag: workspaceTag, task: trace.task, provider: trace.provider, model: trace.model,
      prompt_version: trace.promptVersion, generation_mode: trace.generationMode, schema_valid: trace.schemaValid,
      entity_type: trace.entity?.type ?? null, entity_tag: trace.entity ? digest(trace.entity.id).slice(0, 24) : null,
      input_tokens: trace.inputTokens, output_tokens: trace.outputTokens, latency_ms: trace.latencyMs, cost_usd: trace.costUsd,
      redaction: 'content omitted; identifiers hashed',
    } },
  };
  try {
    const response = await fetchImpl(`${endpoint.origin}${endpoint.pathname.replace(/\/$/, '')}/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) logger.warn({ status: response.status, task: trace.task }, 'LangSmith trace was rejected');
    return response.ok;
  } catch {
    logger.warn({ task: trace.task }, 'LangSmith trace could not be delivered');
    return false;
  }
}
