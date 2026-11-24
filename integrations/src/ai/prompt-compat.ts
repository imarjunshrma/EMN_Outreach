/**
 * Provider/model prompt capability handling shared by all structured AI adapters.
 * Some APIs expose native system/developer instructions, while a subset of models
 * reject that channel. Explicitly rejected native instructions or structured
 * output are retried with the corresponding capability disabled. The bounded
 * fallbacks stay on the selected model and are remembered for this process.
 */

export interface CompatiblePrompt {
  /** `null` means the provider/model requires instructions in the user message. */
  system: string | null;
  user: string;
  /** False means the adapter should omit its native JSON/structured-output parameter. */
  structuredOutput: boolean;
  generationMode: GenerationMode;
}

export type GenerationMode = 'structured' | 'json_object' | 'instruction_fallback' | 'schema_fallback' | 'prompt_fallback';

type PromptMode = { instructions: 'native' | 'inline'; structuredOutput: boolean };
const modes = new Map<string, PromptMode>();

function keyFor(provider: string, model: string, endpoint?: string | null) {
  return `${provider.toLowerCase()}|${(endpoint ?? '').replace(/\/+$/, '').toLowerCase()}|${model.toLowerCase()}`;
}

export function inlineSystemInstructions(system: string, user: string): string {
  return [
    'Instructions for this task (follow these instructions while completing the user request):',
    system.trim(),
    '',
    'User request and task data:',
    user,
  ].join('\n');
}

export function promptForMode(system: string, user: string, mode: PromptMode): CompatiblePrompt {
  const instructionsInline = mode.instructions === 'inline';
  const generationMode: GenerationMode = instructionsInline
    ? (mode.structuredOutput ? 'instruction_fallback' : 'prompt_fallback')
    : (mode.structuredOutput ? 'structured' : 'schema_fallback');
  return {
    system: mode.instructions === 'native' ? system : null,
    user: instructionsInline ? inlineSystemInstructions(system, user) : user,
    structuredOutput: mode.structuredOutput,
    generationMode,
  };
}

/** Only retry errors that explicitly say the instruction role/channel is unsupported. */
export function isInstructionCapabilityError(error: unknown): boolean {
  const e = error as { message?: unknown; status?: unknown };
  const message = String(e?.message ?? error ?? '');
  return (e?.status === undefined || e.status === 400 || e.status === 404 || e.status === 422)
    && /(?:developer|system) instruction(?:s)?[^\n]{0,100}(?:not enabled|not supported|unsupported)|(?:developer|system) (?:role|message|channel)[^\n]{0,100}(?:not supported|unsupported|not enabled)|does not support[^\n]{0,100}(?:developer|system) instruction/i.test(message);
}

export function isStructuredOutputCapabilityError(error: unknown): boolean {
  const e = error as { message?: unknown; status?: unknown };
  const message = String(e?.message ?? error ?? '');
  return (e?.status === undefined || e.status === 400 || e.status === 404 || e.status === 422)
    && /(?:response_format|responseMimeType|responseJsonSchema|json_schema|json_object|structured output)[^\n]{0,120}(?:not supported|unsupported|not enabled|not available|invalid for|does not support)|(?:not supported|unsupported|not enabled|not available)[^\n]{0,120}(?:response_format|responseMimeType|responseJsonSchema|json_schema|json_object|structured output)/i.test(message);
}

export async function withPromptCompatibility<T>(args: {
  provider: string;
  model: string;
  endpoint?: string | null;
  system: string;
  user: string;
  send: (prompt: CompatiblePrompt) => Promise<T>;
}): Promise<T> {
  const key = keyFor(args.provider, args.model, args.endpoint);
  const mode = modes.get(key) ?? { instructions: 'native', structuredOutput: true };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await args.send(promptForMode(args.system, args.user, mode));
    } catch (error) {
      if (mode.instructions === 'native' && isInstructionCapabilityError(error)) {
        mode.instructions = 'inline';
        modes.set(key, mode);
        continue;
      }
      if (mode.structuredOutput && isStructuredOutputCapabilityError(error)) {
        mode.structuredOutput = false;
        modes.set(key, mode);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Provider ${args.provider} rejected supported prompt compatibility fallbacks for model ${args.model}`);
}

/** Test helper; production callers should not clear learned provider capabilities. */
export function resetPromptCompatibilityForTests() { modes.clear(); }
