export type AiProviderName = 'OPENAI' | 'ANTHROPIC';

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface StructuredRequest {
  model: string;
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  maxOutputTokens: number;
  temperature?: number;
}

export interface StructuredResponse {
  data: unknown;
  usage: AiUsage;
  latencyMs: number;
}

export interface AiProviderAdapter {
  readonly name: AiProviderName;
  generateStructured(apiKey: string, req: StructuredRequest): Promise<StructuredResponse>;
  testConnection(apiKey: string, model: string): Promise<{ ok: true } | { ok: false; error: string }>;
}
