import { httpJson, ProviderError, type FetchLike } from '../http.js';
import type { AiProviderAdapter, StructuredRequest, StructuredResponse } from './types.js';
import { withPromptCompatibility } from './prompt-compat.js';

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
}
interface GeminiModelsResponse { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> }

/** Convert the shared JSON Schema subset into Gemini Schema fields. */
export function toGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(input)) {
    if (key === '$schema' || key === 'additionalProperties' || key === 'default') continue;
    if (key === 'type' && Array.isArray(field)) {
      const nonNull = field.filter((t) => t !== 'null');
      output.type = nonNull.length === 1 ? nonNull[0] : nonNull;
      if (nonNull.length !== field.length) output.nullable = true;
    } else if (key === 'anyOf' && Array.isArray(field)) {
      const variants = field as Array<Record<string, unknown>>;
      const concrete = variants.filter((v) => v.type !== 'null');
      if (concrete.length === 1) Object.assign(output, toGeminiSchema(concrete[0]));
      else output.anyOf = concrete.map(toGeminiSchema);
      if (concrete.length !== variants.length) output.nullable = true;
    } else {
      output[key] = toGeminiSchema(field);
    }
  }
  return output;
}

/** Google Gemini generateContent adapter with JSON response mode. */
export class GoogleAiAdapter implements AiProviderAdapter {
  readonly name = 'GOOGLE' as const;
  constructor(private readonly fetchImpl?: FetchLike, private readonly baseUrl = 'https://generativelanguage.googleapis.com') {}

  async listModels(apiKey: string): Promise<string[]> {
    const res = await httpJson<GeminiModelsResponse>(`${this.baseUrl}/v1beta/models?key=${encodeURIComponent(apiKey)}`, {}, { provider: 'google', fetchImpl: this.fetchImpl, timeoutMs: 20_000, retries: 0 });
    return [...new Set((res.models ?? []).filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((m) => m.name?.replace(/^models\//, '')).filter((name): name is string => !!name))].sort();
  }

  async generateStructured(apiKey: string, req: StructuredRequest): Promise<StructuredResponse> {
    const started = Date.now();
    let generationMode: StructuredResponse['generationMode'] = 'structured';
    const res = await withPromptCompatibility({
      provider: 'GOOGLE', model: req.model, endpoint: this.baseUrl, system: req.system, user: req.user,
      send: (prompt) => {
        generationMode = prompt.generationMode;
        return httpJson<GeminiResponse>(`${this.baseUrl}/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(prompt.system !== null ? { systemInstruction: { parts: [{ text: prompt.system }] } } : {}),
          contents: [{ role: 'user', parts: [{ text: `${prompt.user}\n\nReturn JSON matching this schema:\n${JSON.stringify(req.jsonSchema)}` }] }],
          generationConfig: {
            ...(prompt.structuredOutput ? { responseMimeType: 'application/json', responseJsonSchema: toGeminiSchema(req.jsonSchema) } : {}),
            maxOutputTokens: req.maxOutputTokens,
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          },
        }),
        }, { provider: 'google', fetchImpl: this.fetchImpl, timeoutMs: 90_000, retries: 2 });
      },
    });
    const text = res.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
    if (!text) throw new ProviderError('google', 'empty output');
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new ProviderError('google', 'output was not valid JSON'); }
    return { data, usage: { inputTokens: res.usageMetadata?.promptTokenCount ?? 0, outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0, cachedTokens: res.usageMetadata?.cachedContentTokenCount ?? 0 }, latencyMs: Date.now() - started, generationMode };
  }

  async testConnection(apiKey: string, model: string) {
    try {
      await httpJson(`${this.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }], generationConfig: { maxOutputTokens: 5 } }),
      }, { provider: 'google', fetchImpl: this.fetchImpl, timeoutMs: 20_000, retries: 0 });
      return { ok: true as const };
    } catch (e) { return { ok: false as const, error: (e as Error).message }; }
  }
}
