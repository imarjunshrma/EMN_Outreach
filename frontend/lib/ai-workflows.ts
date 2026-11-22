// Mirror of shared/src/ai-workflows.ts vocabulary for the workflow builder UI
// (kept in sync by tests/unit/frontend-sync.test.ts — the frontend bundle does not import shared/).

export const SUBSCRIPTION_PROVIDERS = ['CLAUDE_SUBSCRIPTION', 'CODEX_SUBSCRIPTION'] as const;
export const API_PROVIDERS = ['OPENAI', 'ANTHROPIC', 'GOOGLE', 'OPENROUTER', 'GROQ', 'TOGETHER', 'DEEPSEEK', 'MISTRAL', 'OLLAMA', 'CUSTOM_OPENAI'] as const;
export const STAGE_PROVIDERS = [...SUBSCRIPTION_PROVIDERS, ...API_PROVIDERS.map((p) => `API:${p}`)] as string[];

export const PROVIDER_LABELS: Record<string, string> = {
  CLAUDE_SUBSCRIPTION: 'Claude — My Subscription',
  CODEX_SUBSCRIPTION: 'Codex — My ChatGPT Subscription',
  'API:OPENAI': 'OpenAI API', 'API:ANTHROPIC': 'Anthropic API', 'API:GOOGLE': 'Google Gemini API', 'API:OPENROUTER': 'OpenRouter API',
  'API:GROQ': 'Groq API', 'API:TOGETHER': 'Together AI API', 'API:DEEPSEEK': 'DeepSeek API', 'API:MISTRAL': 'Mistral API',
  'API:OLLAMA': 'Ollama (local)', 'API:CUSTOM_OPENAI': 'Custom OpenAI-compatible API',
};
export const SHORT_PROVIDER: Record<string, string> = { CLAUDE_SUBSCRIPTION: 'Claude', CODEX_SUBSCRIPTION: 'Codex' };
export const shortProvider = (p: string) => SHORT_PROVIDER[p] ?? (PROVIDER_LABELS[p] ?? p).replace(/ API$/, '');
export const isSubscription = (p: string) => (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(p);

export const TASK_TYPES = [
  'PROSPECT_RESEARCH', 'WEBSITE_ANALYSIS', 'SOCIAL_MEDIA_ANALYSIS', 'BUSINESS_ANALYSIS', 'PAIN_POINT_IDENTIFICATION',
  'EMAIL_ANGLE_SELECTION', 'COLD_EMAIL_GENERATION', 'EMAIL_HUMANIZATION', 'GRAMMAR_REVIEW', 'PERSONALIZATION_REVIEW',
  'FINAL_QUALITY_CHECK', 'CUSTOM',
] as const;
export type TaskType = typeof TASK_TYPES[number];
export const TASK_LABELS: Record<TaskType, string> = {
  PROSPECT_RESEARCH: 'Prospect research', WEBSITE_ANALYSIS: 'Website analysis', SOCIAL_MEDIA_ANALYSIS: 'Social media analysis',
  BUSINESS_ANALYSIS: 'Business analysis', PAIN_POINT_IDENTIFICATION: 'Pain-point identification', EMAIL_ANGLE_SELECTION: 'Email angle selection',
  COLD_EMAIL_GENERATION: 'Cold email generation', EMAIL_HUMANIZATION: 'Email humanization', GRAMMAR_REVIEW: 'Grammar and clarity review',
  PERSONALIZATION_REVIEW: 'Personalization review', FINAL_QUALITY_CHECK: 'Final quality check', CUSTOM: 'Custom task',
};
export const OUTPUT_FORMATS = ['RESEARCH_JSON', 'ANGLES_JSON', 'EMAIL_VARIANTS_JSON', 'QUALITY_REVIEW_JSON', 'TEXT'] as const;
export type OutputFormat = typeof OUTPUT_FORMATS[number];
export const OUTPUT_FORMAT_LABELS: Record<OutputFormat, string> = {
  RESEARCH_JSON: 'Research (JSON)', ANGLES_JSON: 'Email angles (JSON)', EMAIL_VARIANTS_JSON: 'Email variants (JSON)', QUALITY_REVIEW_JSON: 'Quality review with final variants (JSON)', TEXT: 'Free text',
};
export const DEFAULT_OUTPUT_FORMAT: Record<TaskType, OutputFormat> = {
  PROSPECT_RESEARCH: 'RESEARCH_JSON', WEBSITE_ANALYSIS: 'RESEARCH_JSON', SOCIAL_MEDIA_ANALYSIS: 'RESEARCH_JSON', BUSINESS_ANALYSIS: 'RESEARCH_JSON',
  PAIN_POINT_IDENTIFICATION: 'RESEARCH_JSON', EMAIL_ANGLE_SELECTION: 'ANGLES_JSON', COLD_EMAIL_GENERATION: 'EMAIL_VARIANTS_JSON',
  EMAIL_HUMANIZATION: 'EMAIL_VARIANTS_JSON', GRAMMAR_REVIEW: 'EMAIL_VARIANTS_JSON', PERSONALIZATION_REVIEW: 'EMAIL_VARIANTS_JSON',
  FINAL_QUALITY_CHECK: 'QUALITY_REVIEW_JSON', CUSTOM: 'TEXT',
};
export const WEB_TASKS: TaskType[] = ['PROSPECT_RESEARCH', 'WEBSITE_ANALYSIS', 'SOCIAL_MEDIA_ANALYSIS', 'BUSINESS_ANALYSIS', 'PAIN_POINT_IDENTIFICATION'];
export const INPUT_SOURCE_LABELS: Record<string, string> = {
  prospect: 'Prospect profile (lead + company)', research_evidence: 'Saved research evidence', playbook: 'Writing playbook',
  previous: 'Previous stage output', all: 'All earlier stage outputs',
};
export const CONDITIONS = ['always', 'if_previous_succeeded', 'skip_if_provider_unavailable'] as const;
export const CONDITION_LABELS: Record<typeof CONDITIONS[number], string> = {
  always: 'Always run (pause the workflow if the provider is unavailable)',
  if_previous_succeeded: 'Only if the previous stage succeeded',
  skip_if_provider_unavailable: 'Skip this stage if its provider is disconnected or limited',
};

export interface Stage {
  id: string; name: string; enabled: boolean; provider: string; model: string | null; taskType: TaskType; instructions: string;
  inputs: string[]; outputFormat: OutputFormat; variants: number; temperature: number | null; reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | null;
  allowWebResearch: boolean; retry: { maxAttempts: number; backoffSec: number }; timeoutSec: number; continueOnError: boolean; condition: typeof CONDITIONS[number];
}

export function newStageId() { return `stage-${Math.random().toString(36).slice(2, 9)}`; }

export function newStage(taskType: TaskType, provider = 'CLAUDE_SUBSCRIPTION'): Stage {
  return {
    id: newStageId(), name: TASK_LABELS[taskType], enabled: true, provider, model: null, taskType, instructions: '',
    inputs: ['prospect', 'research_evidence', 'playbook', 'previous'], outputFormat: DEFAULT_OUTPUT_FORMAT[taskType], variants: 3,
    temperature: null, reasoningEffort: null, allowWebResearch: WEB_TASKS.includes(taskType), retry: { maxAttempts: 2, backoffSec: 30 },
    timeoutSec: 300, continueOnError: false, condition: 'always',
  };
}
