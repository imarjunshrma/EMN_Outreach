import { httpJson, ProviderError, type FetchLike } from '../http.js';
import type { AiProviderAdapter, AiProviderName, StructuredRequest, StructuredResponse } from './types.js';
import { withPromptCompatibility } from './prompt-compat.js';
import { toStrictSchema } from './openai.js';

export const AI_PROVIDER_BASE_URLS: Partial<Record<AiProviderName, string>> = {
  OPENROUTER: 'https://openrouter.ai/api/v1',
  GROQ: 'https://api.groq.com/openai/v1',
  TOGETHER: 'https://api.together.xyz/v1',
  DEEPSEEK: 'https://api.deepseek.com/v1',
  MISTRAL: 'https://api.mistral.ai/v1',
  OLLAMA: 'http://127.0.0.1:11434/v1',
};

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}
interface ModelsResponse { data?: Array<{ id?: string }> }

/** Groq's documented strict JSON Schema model IDs. Unknown IDs use JSON Object Mode only. */
const GROQ_STRICT_JSON_SCHEMA_MODELS = new Set([
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'meta-models/muse-spark-open',
]);

export function groqSupportsStrictJsonSchema(model: string): boolean {
  return GROQ_STRICT_JSON_SCHEMA_MODELS.has(model);
}

/** OpenAI Chat Completions protocol used by OpenRouter, Groq, Together, DeepSeek, Mistral, Ollama, vLLM and compatible endpoints. */
export class OpenAiCompatibleAdapter implements AiProviderAdapter {
  constructor(readonly name: AiProviderName, private readonly defaultBaseUrl: string, private readonly fetchImpl?: FetchLike) {}

  async listModels(apiKey: string, options?: { baseUrl?: string | null }): Promise<string[]> {
    const base = (options?.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const res = await httpJson<ModelsResponse>(`${base}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} }, { provider: this.name.toLowerCase(), fetchImpl: this.fetchImpl, timeoutMs: 20_000, retries: 0 });
    return [...new Set((res.data ?? []).map((m) => m.id).filter((id): id is string => !!id))].sort();
  }

  async generateStructured(apiKey: string, req: StructuredRequest, options?: { baseUrl?: string | null }): Promise<StructuredResponse> {
    const started = Date.now();
    const base = (options?.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const groqSchemaMode = this.name === 'GROQ' && groqSupportsStrictJsonSchema(req.model);
    let generationMode: StructuredResponse['generationMode'] = 'structured';
    const res = await withPromptCompatibility({
      provider: this.name, model: req.model, endpoint: base, system: `${req.system}\n\nReturn only JSON matching this schema:\n${JSON.stringify(req.jsonSchema)}`, user: req.user,
      send: (prompt) => {
        generationMode = prompt.generationMode === 'structured' && this.name !== 'GROQ'
          ? 'json_object'
          : prompt.generationMode === 'structured' && !groqSchemaMode ? 'json_object' : prompt.generationMode;
        const responseFormat = prompt.structuredOutput
          ? groqSchemaMode
            ? { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: toStrictSchema(req.jsonSchema) } }
            : { type: 'json_object' }
          : this.name === 'GROQ' && groqSchemaMode
            ? { type: 'json_object' }
            : undefined;
        return httpJson<ChatResponse>(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model: req.model,
          messages: prompt.system !== null
            ? [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }]
            : [{ role: 'user', content: prompt.user }],
          ...(this.name === 'GROQ' ? { max_completion_tokens: req.maxOutputTokens } : { max_tokens: req.maxOutputTokens }),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(responseFormat ? { response_format: responseFormat } : {}),
        }),
        }, { provider: this.name.toLowerCase(), fetchImpl: this.fetchImpl, timeoutMs: 90_000, retries: 2 });
      },
    });
    const content = res.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : content?.map((part) => part.text ?? '').join('');
    if (!text) throw new ProviderError(this.name.toLowerCase(), 'empty output');
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new ProviderError(this.name.toLowerCase(), 'output was not valid JSON'); }
    return {
      data,
      usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0, cachedTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0 },
      latencyMs: Date.now() - started,
      generationMode,
    };
  }

  async testConnection(apiKey: string, model: string, options?: { baseUrl?: string | null }) {
    try {
      const base = (options?.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
      await httpJson(`${base}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 5 }),
      }, { provider: this.name.toLowerCase(), fetchImpl: this.fetchImpl, timeoutMs: 20_000, retries: 0 });
      return { ok: true as const };
    } catch (e) { return { ok: false as const, error: (e as Error).message }; }
  }
}
