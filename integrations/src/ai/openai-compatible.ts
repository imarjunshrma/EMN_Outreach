import { httpJson, ProviderError, type FetchLike } from '../http.js';
import type { AiProviderAdapter, AiProviderName, StructuredRequest, StructuredResponse } from './types.js';

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
    const res = await httpJson<ChatResponse>(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: 'system', content: `${req.system}\n\nReturn only JSON matching this schema:\n${JSON.stringify(req.jsonSchema)}` }, { role: 'user', content: req.user }],
        max_tokens: req.maxOutputTokens,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        response_format: { type: 'json_object' },
      }),
    }, { provider: this.name.toLowerCase(), fetchImpl: this.fetchImpl, timeoutMs: 90_000, retries: 2 });
    const content = res.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : content?.map((part) => part.text ?? '').join('');
    if (!text) throw new ProviderError(this.name.toLowerCase(), 'empty output');
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new ProviderError(this.name.toLowerCase(), 'output was not valid JSON'); }
    return {
      data,
      usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0, cachedTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0 },
      latencyMs: Date.now() - started,
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
