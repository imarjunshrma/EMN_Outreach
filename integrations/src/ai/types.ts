export const AI_PROVIDER_NAMES = ['OPENAI', 'ANTHROPIC', 'GOOGLE', 'OPENROUTER', 'GROQ', 'TOGETHER', 'DEEPSEEK', 'MISTRAL', 'OLLAMA', 'CUSTOM_OPENAI'] as const;
export type AiProviderName = typeof AI_PROVIDER_NAMES[number];

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
  generationMode?: 'structured' | 'json_object' | 'instruction_fallback' | 'schema_fallback' | 'prompt_fallback';
}

export interface AiProviderAdapter {
  readonly name: AiProviderName;
  listModels?(apiKey: string, options?: { baseUrl?: string | null }): Promise<string[]>;
  generateStructured(apiKey: string, req: StructuredRequest, options?: { baseUrl?: string | null }): Promise<StructuredResponse>;
  testConnection(apiKey: string, model: string, options?: { baseUrl?: string | null }): Promise<{ ok: true } | { ok: false; error: string }>;
}
