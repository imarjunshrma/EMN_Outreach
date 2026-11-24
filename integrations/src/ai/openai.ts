import { httpJson, ProviderError, type FetchLike } from '../http.js';
import type { AiProviderAdapter, StructuredRequest, StructuredResponse } from './types.js';
import { withPromptCompatibility } from './prompt-compat.js';

// OpenAI Responses API with strict JSON-schema structured output.
// Requires live verification with a real API key.

interface OpenAiResponse {
  output_text?: string;
  output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  status?: string;
}
interface OpenAiModelsResponse { data?: Array<{ id?: string }> }

/** Strict JSON Schema mode requires every object property to be required and objects to be closed. */
export function toStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const s = { ...(schema as Record<string, unknown>) };
  delete s.$schema;
  if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
    const props = s.properties as Record<string, unknown>;
    s.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toStrictSchema(v)]));
    s.required = Object.keys(props);
    s.additionalProperties = false;
  }
  for (const key of ['items', 'anyOf', 'oneOf', 'allOf']) if (key in s) s[key] = toStrictSchema(s[key]);
  delete s.default;
  return s;
}

export class OpenAiAdapter implements AiProviderAdapter {
  readonly name = 'OPENAI' as const;
  constructor(private readonly fetchImpl?: FetchLike, private readonly baseUrl = 'https://api.openai.com') {}

  async listModels(apiKey: string): Promise<string[]> {
    const res = await httpJson<OpenAiModelsResponse>(`${this.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` } }, { provider: 'openai', fetchImpl: this.fetchImpl, timeoutMs: 20_000, retries: 0 });
    return [...new Set((res.data ?? []).map((m) => m.id).filter((id): id is string => !!id))].sort();
  }

  async generateStructured(apiKey: string, req: StructuredRequest): Promise<StructuredResponse> {
    const started = Date.now();
    let generationMode: StructuredResponse['generationMode'] = 'structured';
    const res = await withPromptCompatibility({
      provider: 'OPENAI', model: req.model, endpoint: this.baseUrl, system: `${req.system}\n\nReturn JSON matching this schema:\n${JSON.stringify(req.jsonSchema)}`, user: req.user,
      send: (prompt) => {
        generationMode = prompt.generationMode;
        return httpJson<OpenAiResponse>(
        `${this.baseUrl}/v1/responses`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: req.model,
            max_output_tokens: req.maxOutputTokens,
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            input: prompt.system !== null
              ? [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }]
              : [{ role: 'user', content: prompt.user }],
            text: { format: prompt.structuredOutput
              ? { type: 'json_schema', name: req.schemaName, strict: true, schema: toStrictSchema(req.jsonSchema) }
              : { type: 'json_object' } },
          }),
        },
        { provider: 'openai', fetchImpl: this.fetchImpl, timeoutMs: 90_000, retries: 2 },
        );
      },
    });
    const text =
      res.output_text ??
      res.output?.flatMap((o) => o.content ?? []).find((c) => c.type === 'output_text')?.text;
    if (!text) throw new ProviderError('openai', `empty output (status=${res.status})`);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ProviderError('openai', 'output was not valid JSON');
    }
    return {
      data,
      usage: {
        inputTokens: res.usage?.input_tokens ?? 0,
        outputTokens: res.usage?.output_tokens ?? 0,
        cachedTokens: res.usage?.input_tokens_details?.cached_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
      generationMode,
    };
  }

  async testConnection(apiKey: string, model: string) {
    try {
      await httpJson(`${this.baseUrl}/v1/models/${encodeURIComponent(model)}`, { headers: { authorization: `Bearer ${apiKey}` } }, {
        provider: 'openai', fetchImpl: this.fetchImpl, timeoutMs: 20_000, retries: 0,
      });
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }
}
