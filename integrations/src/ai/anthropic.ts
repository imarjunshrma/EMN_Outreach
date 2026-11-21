import { httpJson, ProviderError, type FetchLike } from '../http.js';
import type { AiProviderAdapter, StructuredRequest, StructuredResponse } from './types.js';

// Anthropic Messages API. Structured output is obtained by forcing a single tool whose
// input_schema is the task's JSON schema; the tool input is the structured result.
// Requires live verification with a real API key.

interface AnthropicResponse {
  content: Array<{ type: string; name?: string; input?: unknown; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  stop_reason?: string;
}

export class AnthropicAdapter implements AiProviderAdapter {
  readonly name = 'ANTHROPIC' as const;
  constructor(private readonly fetchImpl?: FetchLike, private readonly baseUrl = 'https://api.anthropic.com') {}

  async generateStructured(apiKey: string, req: StructuredRequest): Promise<StructuredResponse> {
    const started = Date.now();
    const body = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: req.user }],
      tools: [{ name: req.schemaName, description: 'Return the structured result.', input_schema: req.jsonSchema }],
      tool_choice: { type: 'tool', name: req.schemaName },
    };
    const res = await httpJson<AnthropicResponse>(
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      },
      { provider: 'anthropic', fetchImpl: this.fetchImpl, timeoutMs: 90_000, retries: 2 },
    );
    const tool = res.content?.find((c) => c.type === 'tool_use');
    if (!tool) throw new ProviderError('anthropic', `no tool_use block in response (stop_reason=${res.stop_reason})`);
    return {
      data: tool.input,
      usage: {
        inputTokens: res.usage?.input_tokens ?? 0,
        outputTokens: res.usage?.output_tokens ?? 0,
        cachedTokens: res.usage?.cache_read_input_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
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
