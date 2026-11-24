import { httpJson, ProviderError, type FetchLike } from '../http.js';
import type { AiProviderAdapter, StructuredRequest, StructuredResponse } from './types.js';
import { withPromptCompatibility } from './prompt-compat.js';

// Anthropic Messages API. Structured output is obtained by forcing a single tool whose
// input_schema is the task's JSON schema; the tool input is the structured result.
// Requires live verification with a real API key.

interface AnthropicResponse {
  content: Array<{ type: string; name?: string; input?: unknown; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  stop_reason?: string;
}
interface AnthropicModelsResponse { data?: Array<{ id?: string }>; has_more?: boolean; last_id?: string | null }

export class AnthropicAdapter implements AiProviderAdapter {
  readonly name = 'ANTHROPIC' as const;
  constructor(private readonly fetchImpl?: FetchLike, private readonly baseUrl = 'https://api.anthropic.com') {}

  async listModels(apiKey: string): Promise<string[]> {
    const res = await httpJson<AnthropicModelsResponse>(`${this.baseUrl}/v1/models?limit=100`, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } }, { provider: 'anthropic', fetchImpl: this.fetchImpl, timeoutMs: 20_000, retries: 0 });
    return [...new Set((res.data ?? []).map((m) => m.id).filter((id): id is string => !!id))].sort();
  }

  async generateStructured(apiKey: string, req: StructuredRequest): Promise<StructuredResponse> {
    const started = Date.now();
    let generationMode: StructuredResponse['generationMode'] = 'structured';
    const res = await withPromptCompatibility({
      provider: 'ANTHROPIC', model: req.model, endpoint: this.baseUrl, system: req.system, user: req.user,
      send: (prompt) => {
        generationMode = prompt.generationMode;
        return httpJson<AnthropicResponse>(
        `${this.baseUrl}/v1/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: req.model,
            max_tokens: req.maxOutputTokens,
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            ...(prompt.system !== null ? { system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }] } : {}),
            messages: [{ role: 'user', content: prompt.structuredOutput ? prompt.user : `${prompt.user}\n\nReturn JSON matching this schema:\n${JSON.stringify(req.jsonSchema)}` }],
            ...(prompt.structuredOutput ? {
              tools: [{ name: req.schemaName, description: 'Return the structured result.', input_schema: req.jsonSchema }],
              tool_choice: { type: 'tool', name: req.schemaName },
            } : {}),
          }),
        },
        { provider: 'anthropic', fetchImpl: this.fetchImpl, timeoutMs: 90_000, retries: 2 },
        );
      },
    });
    const tool = res.content?.find((c) => c.type === 'tool_use');
    let data: unknown;
    if (tool) data = tool.input;
    else {
      const text = res.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      if (!text) throw new ProviderError('anthropic', `no structured or text output in response (stop_reason=${res.stop_reason})`);
      try { data = JSON.parse(text); } catch { throw new ProviderError('anthropic', 'output was not valid JSON'); }
    }
    return {
      data,
      usage: {
        inputTokens: res.usage?.input_tokens ?? 0,
        outputTokens: res.usage?.output_tokens ?? 0,
        cachedTokens: res.usage?.cache_read_input_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
      generationMode,
    };
  }

  async testConnection(apiKey: string, model: string) {
    try {
      await httpJson(
        `${this.baseUrl}/v1/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] }),
        },
        { provider: 'anthropic', fetchImpl: this.fetchImpl, timeoutMs: 20_000, retries: 0 },
      );
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }
}
