import { z } from 'zod';
import { createHash } from 'node:crypto';
import { db, Prisma } from '../core/db.js';
import { adapters } from '../core/container.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { logger } from '../core/logger.js';
import { AI_OUTPUT_SCHEMAS, AI_TASKS, type AiTaskName } from '../../../shared/src/ai-schemas.js';
import { correctCopilotPrompt, DEFAULT_PROMPTS } from '../../../shared/src/prompts.js';
import { redactForLog } from '../../../integrations/src/ai/guard.js';
import { AI_PROVIDER_NAMES, type AiProviderName } from '../../../integrations/src/ai/types.js';
import { ProviderError } from '../../../integrations/src/http.js';
import { isInstructionCapabilityError } from '../../../integrations/src/ai/prompt-compat.js';
import { decryptSecret, encryptSecret, readSettings } from './workspace.js';
import { emitLangSmithAiTrace } from './langsmith-tracing.js';

type ProviderName = AiProviderName;

async function workspaceDefaultProvider(workspaceId: string): Promise<ProviderName | null> {
  const ws = await db().workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
  const value = (ws?.settings as Record<string, unknown> | null)?.aiDefaultProvider;
  return typeof value === 'string' && AI_PROVIDER_NAMES.includes(value as ProviderName) ? value as ProviderName : null;
}

export async function getDefaultProvider(workspaceId: string): Promise<ProviderName | null> {
  return workspaceDefaultProvider(workspaceId);
}

async function persistWorkspaceDefaultProvider(workspaceId: string, provider: ProviderName | null) {
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
  const settings = (ws.settings && typeof ws.settings === 'object' ? ws.settings : {}) as Record<string, unknown>;
  await db().workspace.update({ where: { id: workspaceId }, data: { settings: { ...settings, aiDefaultProvider: provider } as Prisma.InputJsonValue } });
}

export const SUGGESTED_MODELS: Record<ProviderName, { fast: string; quality: string }> = {
  ANTHROPIC: { fast: 'claude-haiku-5-5', quality: 'claude-sonnet-5-5' },
  OPENAI: { fast: '', quality: '' }, // entered by the user; no default is assumed
  GOOGLE: { fast: 'gemini-2.5-flash', quality: 'gemini-2.5-pro' },
  OPENROUTER: { fast: '', quality: '' }, GROQ: { fast: '', quality: '' }, TOGETHER: { fast: '', quality: '' },
  DEEPSEEK: { fast: '', quality: '' }, MISTRAL: { fast: '', quality: '' }, OLLAMA: { fast: '', quality: '' }, CUSTOM_OPENAI: { fast: '', quality: '' },
};

const FAST_TASKS: AiTaskName[] = ['REPLY_CLASSIFICATION', 'SUBJECT_LINES', 'ICP_FROM_TEXT'];

export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k: string) => vars[k] ?? '');
}

export function jsonSchemaFor(task: AiTaskName): Record<string, unknown> {
  const js = z.toJSONSchema(AI_OUTPUT_SCHEMAS[task], { target: 'draft-7', io: 'output' }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

async function priceFor(provider: ProviderName, model: string) {
  return db().aiModelPrice.findFirst({ where: { provider, model, effectiveFrom: { lte: new Date() } }, orderBy: { effectiveFrom: 'desc' } });
}

export function computeCost(p: { inputPerMTokUsd: Prisma.Decimal; outputPerMTokUsd: Prisma.Decimal; cachedInputPerMTokUsd: Prisma.Decimal | null } | null, u: { inputTokens: number; outputTokens: number; cachedTokens: number }) {
  if (!p) return { cost: 0, priced: false };
  const uncached = Math.max(0, u.inputTokens - u.cachedTokens);
  const cachedRate = Number(p.cachedInputPerMTokUsd ?? p.inputPerMTokUsd);
  const cost = (uncached * Number(p.inputPerMTokUsd) + u.cachedTokens * cachedRate + u.outputTokens * Number(p.outputPerMTokUsd)) / 1_000_000;
  return { cost, priced: true };
}

function monthStart() { const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0); return start; }

/** Convert provider failures into actionable, secret-safe API errors after fallback candidates are exhausted. */
export function aiProviderFailure(error: ProviderError): AppError {
  if (error.code === 'OPENAI_OUTPUT_LIMIT') return new AppError('AI_OUTPUT_LIMIT', 'OpenAI reached this task’s output token limit before completing its response. Increase Max output tokens for the task in AI Studio → Models, or use a shorter input.', 502);
  if (error.code === 'OPENAI_REFUSAL' || error.code === 'OPENAI_CONTENT_FILTER') return new AppError('AI_RESPONSE_FILTERED', 'OpenAI declined to complete this request. Check the supplied content before trying again.', 502);
  if (error.code === 'OPENAI_INCOMPLETE') return new AppError('AI_INVALID_RESPONSE', 'OpenAI returned an incomplete response. Retry the task.', 502);
  if (error.code === 'OPENAI_INVALID_JSON') return new AppError('AI_INVALID_RESPONSE', 'OpenAI returned malformed JSON. Retry the task with a shorter input. If it persists, check the task’s Max output tokens in AI Studio → Models.', 502);
  if (isInstructionCapabilityError(error)) return new AppError('AI_MODEL_UNSUPPORTED', `The selected ${error.provider} model does not support the required instruction format. Choose a compatible model or contact support.`, 400);
  if (error.code === 'json_validate_failed' || /failed to generate JSON|invalid JSON/i.test(error.message)) return new AppError('AI_INVALID_RESPONSE', `${error.provider} could not produce valid JSON for this request. The task output was rejected; retry or select a model with supported JSON Schema output.`, 502);
  if (error.code === 'model_not_found' || error.status === 404) return new AppError('AI_MODEL_NOT_FOUND', `The ${error.provider} provider could not find the selected model. Check the exact API model ID and account access.`, 400);
  if (error.status === 401 || error.status === 403) return new AppError('AI_PROVIDER_AUTH', `The ${error.provider} provider rejected its API key or model access. Check the key and account permissions.`, 502);
  if (error.status === 429) return new AppError('AI_RATE_LIMITED', `The ${error.provider} provider rate limit was reached. Wait or configure a fallback route.`, 429);
  if (error.status !== undefined && error.status >= 500) return new AppError('AI_PROVIDER_UNAVAILABLE', `The ${error.provider} provider is temporarily unavailable. Retry later or use a configured fallback.`, 503);
  if (/empty output|not valid JSON|invalid JSON|no tool_use block/i.test(error.message)) return new AppError('AI_INVALID_RESPONSE', `The ${error.provider} model returned an empty or invalid structured response. Check this model's structured-output support.`, 502);
  return new AppError('AI_PROVIDER_REQUEST_FAILED', `The ${error.provider} request failed${error.status ? ` (HTTP ${error.status})` : ''}. Check its configuration and retry.`, 502);
}

export async function monthSpend(workspaceId: string, task?: AiTaskName) {
  const createdAt = { gte: monthStart() };
  const [tasks, embeddings] = await Promise.all([
    db().aiExecution.aggregate({ where: { workspaceId, ...(task ? { task } : {}), createdAt }, _sum: { costUsd: true } }),
    task ? null : db().usageRecord.aggregate({ where: { workspaceId, kind: 'embedding', createdAt }, _sum: { costUsd: true } }),
  ]);
  return Number(tasks._sum.costUsd ?? 0) + Number(embeddings?._sum.costUsd ?? 0);
}

/** AI spend attributed to one lead within one campaign (all tasks, all time). */
export async function leadSpend(workspaceId: string, campaignId: string, leadId: string) {
  const r = await db().aiExecution.aggregate({ where: { workspaceId, campaignId, leadId }, _sum: { costUsd: true } });
  return Number(r._sum.costUsd ?? 0);
}

/** Upper-bound cost estimate for one call (input chars/4 tokens + full output budget). */
export async function estimateCallCost(workspaceId: string, task: AiTaskName, inputChars: number, outputTokens?: number) {
  const route = await db().aiModelRoute.findUnique({ where: { workspaceId_task: { workspaceId, task } } });
  const inheritedDefault = !route || route.useWorkspaceDefault ? await workspaceDefaultProvider(workspaceId) : null;
  const providerName = inheritedDefault ?? route?.provider;
  const provider = await db().aiProvider.findFirst({ where: { workspaceId, isEnabled: true, ...(providerName ? { provider: providerName } : {}) }, orderBy: { provider: 'asc' } });
  if (!provider) return { usd: 0, priced: false, model: null as string | null };
  const model = inheritedDefault ? provider.defaultModel : route?.model ?? provider.defaultModel;
  const price = await priceFor(provider.provider, model);
  const inputTokens = Math.ceil(inputChars / 4) + 600; // + system prompt
  const out = outputTokens ?? route?.maxOutputTokens ?? 1500;
  const { cost, priced } = computeCost(price, { inputTokens, outputTokens: out, cachedTokens: 0 });
  return { usd: cost, priced, model };
}

export async function routeLimits(workspaceId: string, task: AiTaskName) {
  const route = await db().aiModelRoute.findUnique({ where: { workspaceId_task: { workspaceId, task } } });
  return { maxInputTokens: route?.maxInputTokens ?? null, maxOutputTokens: route?.maxOutputTokens ?? 1500 };
}

async function ensurePrompt(workspaceId: string, task: AiTaskName) {
  const p = await db().promptTemplate.findFirst({ where: { workspaceId, task, isActive: true }, orderBy: { version: 'desc' } });
  if (p) return task === 'COPILOT' ? correctCopilotPrompt(p) : p;
  const d = DEFAULT_PROMPTS[task];
  if (!d || (await db().promptTemplate.count({ where: { workspaceId, task } }))) return null; // user deactivated everything on purpose
  return db().promptTemplate.upsert({ where: { workspaceId_task_version: { workspaceId, task, version: 1 } }, update: {}, create: { workspaceId, task, version: 1, systemPrompt: d.system, userPromptTemplate: d.user, isActive: true, changeNote: 'Built-in default' } });
}

interface Candidate { provider: ProviderName; model: string; fallback: boolean }

export interface FrozenTaskExecution {
  task: AiTaskName; promptTemplateId: string | null; promptVersion: number | null;
  systemPrompt: string; userPromptTemplate: string; schemaHash: string;
  candidates: Array<{ provider: ProviderName; model: string; fallback: boolean; baseUrl: string | null }>;
  maxOutputTokens: number; maxInputTokens: number | null; temperature: number | null; monthlyBudgetUsd: number | null;
}

/** Capture the exact prompt and provider route used by a campaign approval. Secrets are never copied. */
export async function captureCampaignTaskExecution(workspaceId: string, tasks: AiTaskName[], campaignId?: string): Promise<Record<string, FrozenTaskExecution>> {
  if (campaignId) {
    const source = await (await import('./ai-source.js')).resolveAiSource(workspaceId, campaignId);
    if (source.mode !== 'api') throw new AppError('CAMPAIGN_INVALID', 'Campaign approval cannot freeze subscription-based AI execution yet. Select API-key routing before approval; no provider route was changed.', 409, { reasonCode: 'UNSUPPORTED_SNAPSHOT_SOURCE', mode: source.mode });
  }
  const captured: Record<string, FrozenTaskExecution> = {};
  for (const task of [...new Set(tasks)]) {
    const [prompt, resolved, providers] = await Promise.all([
      ensurePrompt(workspaceId, task),
      resolveCandidates(workspaceId, task),
      db().aiProvider.findMany({ where: { workspaceId, isEnabled: true }, select: { provider: true, baseUrl: true } }),
    ]);
    if (!prompt) throw new AppError('PROVIDER_NOT_CONFIGURED', `No active prompt for campaign task ${task}`, 400);
    const providerConfig = new Map(providers.map((p) => [p.provider, p.baseUrl]));
    const limits = await routeLimits(workspaceId, task);
    const schemaHash = createHash('sha256').update(JSON.stringify(jsonSchemaFor(task))).digest('hex');
    captured[task] = {
      task, promptTemplateId: prompt.id, promptVersion: prompt.version, systemPrompt: prompt.systemPrompt,
      userPromptTemplate: prompt.userPromptTemplate, schemaHash,
      candidates: resolved.candidates.map((candidate) => ({ ...candidate, baseUrl: providerConfig.get(candidate.provider) ?? null })),
      maxOutputTokens: resolved.maxOutputTokens, maxInputTokens: limits.maxInputTokens, temperature: resolved.temperature ?? null, monthlyBudgetUsd: resolved.budget,
    };
    if (!captured[task].candidates.length) throw new AppError('PROVIDER_NOT_CONFIGURED', `No configured provider route for campaign task ${task}`, 400);
  }
  return captured;
}

async function resolveCandidates(workspaceId: string, task: AiTaskName): Promise<{ candidates: Candidate[]; maxOutputTokens: number; temperature?: number; budget: number | null }> {
  const providers = await db().aiProvider.findMany({ where: { workspaceId, isEnabled: true } });
  if (providers.length === 0) throw new AppError('PROVIDER_NOT_CONFIGURED', 'No AI provider is configured. Add a provider in AI settings.', 400);
  const route = await db().aiModelRoute.findUnique({ where: { workspaceId_task: { workspaceId, task } } });
  const defaultProviderName = !route || route.useWorkspaceDefault ? await workspaceDefaultProvider(workspaceId) : null;
  const defaultProvider = defaultProviderName ? providers.find((p) => p.provider === defaultProviderName) : undefined;
  const primary = defaultProvider ?? (route ? providers.find((p) => p.provider === route.provider) : undefined);
  const candidates: Candidate[] = [];
  if (primary) candidates.push({ provider: primary.provider, model: defaultProvider ? primary.defaultModel : route?.model ?? primary.defaultModel, fallback: false });
  const fallback = route?.fallbackProvider ? providers.find((p) => p.provider === route.fallbackProvider) : undefined;
  if (fallback && route?.fallbackModel && fallback.provider !== primary?.provider) candidates.push({ provider: fallback.provider, model: route.fallbackModel, fallback: true });
  if (candidates.length === 0) for (const p of providers) candidates.push({ provider: p.provider, model: p.defaultModel, fallback: candidates.length > 0 });
  return { candidates, maxOutputTokens: route?.maxOutputTokens ?? 1500, temperature: route?.temperature ?? undefined, budget: route?.monthlyBudgetUsd ? Number(route.monthlyBudgetUsd) : null };
}

export interface AiRunResult<T> { data: T; executionId: string; provider: ProviderName; model: string }

/**
 * Run one AI task end-to-end: route → prompt → provider call → schema validation (one repair
 * attempt) → fallback provider on failure → cost + execution log.
 */
export async function runAi<T = unknown>(
  workspaceId: string,
  task: AiTaskName,
  vars: Record<string, string>,
  opts: {
    entity?: { type: string; id: string };
    critical?: boolean;
    /** Attribute cost to a campaign/lead (enables per-lead cost limits). */
    attribution?: { campaignId?: string | null; leadId?: string | null; profileVersionId?: string | null };
    /** Refuse if the estimated call would exceed the campaign-lead or standalone research budget. */
    maxLeadCostUsd?: number | null;
  } = {},
): Promise<AiRunResult<T>> {
  const frozenCampaign = opts.attribution?.campaignId ? await db().campaign.findFirst({ where: { id: opts.attribution.campaignId, workspaceId }, select: { status: true, aiConfigSnapshot: true } }) : null;
  const frozenSnapshot = frozenCampaign && ['APPROVED', 'RUNNING', 'PAUSED'].includes(frozenCampaign.status) && frozenCampaign.aiConfigSnapshot && typeof frozenCampaign.aiConfigSnapshot === 'object'
    ? frozenCampaign.aiConfigSnapshot as Record<string, unknown> : null;
  const rawFrozenTask = frozenSnapshot?.taskExecution && typeof frozenSnapshot.taskExecution === 'object' ? (frozenSnapshot.taskExecution as Record<string, unknown>)[task] : null;
  // Campaign approval freezes writing and evaluation. Evidence collection can recur while the campaign is active.
  const isProspectResearch = task === 'FACT_EXTRACTION' && opts.entity?.type === 'research_report';
  if (!isProspectResearch && frozenCampaign && ['APPROVED', 'RUNNING', 'PAUSED'].includes(frozenCampaign.status) && !rawFrozenTask) throw new AppError('CAMPAIGN_INVALID', `Approved campaign has no frozen ${task} execution configuration; reapprove it before generation`, 409, { reasonCode: 'FROZEN_TASK_CONFIG_MISSING', task });
  const frozenTask = rawFrozenTask as FrozenTaskExecution | null;
  const campaignSnapshotId = frozenSnapshot && typeof frozenSnapshot.executionSnapshotId === 'string' ? frozenSnapshot.executionSnapshotId : null;
  if (frozenTask && (frozenTask.task !== task || frozenTask.schemaHash !== createHash('sha256').update(JSON.stringify(jsonSchemaFor(task))).digest('hex'))) throw new AppError('CAMPAIGN_INVALID', `Frozen ${task} prompt configuration or output schema is invalid; reapprove the campaign`, 409, { reasonCode: 'FROZEN_TASK_CONFIG_INVALID', task });
  // AI source (Settings → AI providers → "AI source", or the campaign's own choice): a personal subscription runs the
  // call instead of the API keys. No silent fallback to paid API calls unless an admin allowed it.
  const { resolveAiSource, AI_SOURCE_LABEL } = await import('./ai-source.js');
  const source = frozenTask ? { mode: 'api' as const, ownerUserId: null, fallbackToApi: false, from: 'campaign' as const } : await resolveAiSource(workspaceId, opts.attribution?.campaignId ?? null);
  if (source.mode !== 'api') {
    try { return await runAiOnSubscription<T>(workspaceId, task, vars, opts, source); }
    catch (e) {
      if (!source.fallbackToApi) throw e instanceof AppError ? e : new AppError('AI_SUBSCRIPTION_UNAVAILABLE', `${AI_SOURCE_LABEL[source.mode]}: ${(e as Error).message}`, 503);
      logger.warn({ task, err: (e as Error).message }, 'AI subscription failed; falling back to API keys as allowed in AI settings');
    }
  }
  const liveRoute = frozenTask ? null : await resolveCandidates(workspaceId, task);
  const candidates: Candidate[] = frozenTask ? frozenTask.candidates.map(({ provider, model, fallback }) => ({ provider, model, fallback })) : liveRoute!.candidates;
  const maxOutputTokens = frozenTask?.maxOutputTokens ?? liveRoute!.maxOutputTokens;
  const temperature = frozenTask ? frozenTask.temperature ?? undefined : liveRoute!.temperature;
  const budget = frozenTask ? frozenTask.monthlyBudgetUsd : liveRoute!.budget;
  if (budget !== null && !opts.critical && (await monthSpend(workspaceId, task)) >= budget) {
    throw new AppError('AI_BUDGET_EXCEEDED', `Monthly AI budget for ${task} is used up`, 402);
  }
  const ws = await db().workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
  const wsBudget = readSettings(ws?.settings).aiMonthlyBudgetUsd;
  if (wsBudget !== null && !opts.critical && (await monthSpend(workspaceId)) >= wsBudget) {
    throw new AppError('AI_BUDGET_EXCEEDED', `The workspace monthly AI budget ($${wsBudget}) is used up`, 402);
  }
  if (!opts.critical) {
    const ent = await import('./entitlements.js');
    const { orgIdOf } = await import('../core/tenant.js');
    try { await ent.assertMetered(await orgIdOf(workspaceId), 'ai_cost_micro_usd'); } catch (e) {
      throw (e as { code?: string }).code === 'QUOTA_EXCEEDED' ? new AppError('AI_BUDGET_EXCEEDED', (e as Error).message, 402) : e;
    }
  }
  const activePrompt = frozenTask ? null : await ensurePrompt(workspaceId, task);
  const prompt = frozenTask ? { id: frozenTask.promptTemplateId, version: frozenTask.promptVersion, systemPrompt: frozenTask.systemPrompt, userPromptTemplate: frozenTask.userPromptTemplate } : activePrompt;
  if (!prompt) throw new AppError('PROVIDER_NOT_CONFIGURED', `No active prompt for ${task}`, 400);
  const schema = AI_OUTPUT_SCHEMAS[task];
  const jsonSchema = jsonSchemaFor(task);
  let userPrompt = renderPrompt(prompt.userPromptTemplate, vars);
  const limits = { maxInputTokens: frozenTask ? frozenTask.maxInputTokens : (await routeLimits(workspaceId, task)).maxInputTokens, maxOutputTokens };
  if (limits.maxInputTokens && userPrompt.length > limits.maxInputTokens * 4) {
    userPrompt = `${userPrompt.slice(0, limits.maxInputTokens * 4)}\n[input truncated to the ${limits.maxInputTokens}-token limit for ${task}]`;
  }
  const att = { campaignId: opts.attribution?.campaignId ?? null, leadId: opts.attribution?.leadId ?? null, profileVersionId: opts.attribution?.profileVersionId ?? null };
  if (opts.maxLeadCostUsd != null && att.leadId) {
    const spent = att.campaignId ? await leadSpend(workspaceId, att.campaignId, att.leadId) : Number((await db().aiExecution.aggregate({
      where: { workspaceId, leadId: att.leadId, campaignId: null, task: { in: ['FACT_EXTRACTION', 'LEAD_QUALIFICATION'] } },
      _sum: { costUsd: true },
    }))._sum.costUsd ?? 0);
    const est = await estimateCallCost(workspaceId, task, prompt.systemPrompt.length + userPrompt.length, Math.min(maxOutputTokens, 1500));
    if (spent + est.usd > opts.maxLeadCostUsd) {
      throw new AppError('AI_COST_LIMIT', `AI cost limit per lead reached ($${spent.toFixed(4)} spent + ~$${est.usd.toFixed(4)} estimated > $${opts.maxLeadCostUsd})`, 402, { spentUsd: spent, estimateUsd: est.usd, limitUsd: opts.maxLeadCostUsd });
    }
  }
  const preview = redactForLog(userPrompt).slice(0, 1500);
  let lastError = 'unknown error';
  let lastProviderError: ProviderError | null = null;

  for (const cand of candidates) {
    const prov = await db().aiProvider.findUnique({ where: { workspaceId_provider: { workspaceId, provider: cand.provider } } });
    if (!prov || !prov.isEnabled) continue;
    const apiKey = decryptSecret(prov.encryptedApiKey);
    const adapter = adapters().ai[cand.provider];
    if (!adapter) { lastError = `AI adapter ${cand.provider} is not installed`; continue; }
    let user = userPrompt;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const frozenBaseUrl = frozenTask?.candidates.find((c) => c.provider === cand.provider && c.model === cand.model)?.baseUrl;
        const res = await adapter.generateStructured(apiKey, { model: cand.model, system: prompt.systemPrompt, user, jsonSchema, schemaName: task.toLowerCase(), maxOutputTokens, temperature: temperature ?? undefined }, { baseUrl: frozenTask ? frozenBaseUrl ?? undefined : prov.baseUrl });
        const price = await priceFor(cand.provider, cand.model);
        const { cost, priced } = computeCost(price, res.usage);
        const parsed = schema.safeParse(res.data);
        const exec = await db().aiExecution.create({
          data: {
            workspaceId, task, provider: cand.provider, model: cand.model, promptTemplateId: prompt.id,
            status: parsed.success ? 'SUCCEEDED' : 'SCHEMA_INVALID', usedFallback: cand.fallback, generationMode: res.generationMode ?? 'structured',
            inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, cachedTokens: res.usage.cachedTokens,
            costUsd: cost, costIsEstimate: !priced, latencyMs: res.latencyMs,
            entityType: opts.entity?.type, entityId: opts.entity?.id, campaignSnapshotId, ...att,
            inputPreview: preview,
            output: (res.data ?? null) as Prisma.InputJsonValue,
            errorMessage: parsed.success ? null : parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          },
        });
        void emitLangSmithAiTrace({
          workspaceId, task, provider: cand.provider, model: cand.model, promptVersion: prompt.version,
          generationMode: res.generationMode ?? 'structured', schemaValid: parsed.success, inputFields: Object.keys(vars),
          output: res.data, systemPrompt: prompt.systemPrompt, userPrompt: user, entity: opts.entity,
          inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, latencyMs: res.latencyMs, costUsd: Number(cost),
        });
        logger.info({ executionId: exec.id, task, provider: cand.provider, model: cand.model, generationMode: res.generationMode ?? 'structured', schemaValid: parsed.success }, 'AI generation completed');
        const usage = await import('./usage.js');
        usage.meter({ workspaceId, metric: 'ai_requests', quantity: 1, key: `ai:${exec.id}` });
        usage.meter({ workspaceId, metric: 'ai_tokens', quantity: (res.usage.inputTokens ?? 0) + (res.usage.outputTokens ?? 0), key: `ai-tok:${exec.id}` });
        usage.meter({ workspaceId, metric: 'ai_cost_micro_usd', quantity: Math.round(Number(cost ?? 0) * 1_000_000), key: `ai-cost:${exec.id}` });
        if (parsed.success) return { data: parsed.data as T, executionId: exec.id, provider: cand.provider, model: cand.model };
        lastError = `schema invalid: ${exec.errorMessage}`;
        lastProviderError = null;
        user = `${userPrompt}\n\nCONTROLLED SCHEMA REPAIR (one retry only): Your previous JSON response failed validation: ${exec.errorMessage}. Return a corrected complete JSON object. Include every required property exactly as named; never omit a property. Use null for nullable string fields when there is no value, and an empty array when no IDs apply. Follow the JSON Schema supplied with this request and output JSON only.`;
      } catch (e) {
        lastError = (e as Error).message;
        lastProviderError = e instanceof ProviderError ? e : null;
        await db().aiExecution.create({
          data: { workspaceId, task, provider: cand.provider, model: cand.model, promptTemplateId: prompt.id, status: 'FAILED', usedFallback: cand.fallback, errorMessage: redactForLog(lastError).slice(0, 1000), entityType: opts.entity?.type, entityId: opts.entity?.id, campaignSnapshotId, ...att, inputPreview: preview },
        });
        logger.warn({ task, provider: cand.provider, err: lastError }, 'AI call failed');
        if (e instanceof ProviderError && !e.retryable && e.status && e.status < 500 && e.status !== 429) break; // bad key/model → try fallback
        break; // transient errors already retried in the HTTP layer
      }
    }
  }
  if (lastProviderError) throw aiProviderFailure(lastProviderError);
  throw new AppError('AI_OUTPUT_INVALID', `AI task ${task} failed: ${lastError}`, 502);
}


/** runAi() on a personal subscription: same prompt, schema validation (one repair attempt) and execution log; no API cost. */
async function runAiOnSubscription<T>(
  workspaceId: string, task: AiTaskName, vars: Record<string, string>,
  opts: { entity?: { type: string; id: string }; attribution?: { campaignId?: string | null; leadId?: string | null; profileVersionId?: string | null } },
  source: import('./ai-source.js').ResolvedSource,
): Promise<AiRunResult<T>> {
  const { runOnSubscription, AI_SOURCE_LABEL } = await import('./ai-source.js');
  const prompt = await ensurePrompt(workspaceId, task);
  if (!prompt) throw new AppError('PROVIDER_NOT_CONFIGURED', `No active prompt for ${task}`, 400);
  const schema = AI_OUTPUT_SCHEMAS[task];
  const userPrompt = renderPrompt(prompt.userPromptTemplate, vars);
  const att = { campaignId: opts.attribution?.campaignId ?? null, leadId: opts.attribution?.leadId ?? null, profileVersionId: opts.attribution?.profileVersionId ?? null };
  const label = AI_SOURCE_LABEL[source.mode];
  let user = userPrompt;
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    try {
      const r = await runOnSubscription(source, { system: prompt.systemPrompt, user, jsonSchema: jsonSchemaFor(task) });
      const parsed = schema.safeParse(r.data);
      const exec = await db().aiExecution.create({
        data: {
          workspaceId, task, provider: r.provider, model: `${label}${r.model ? ` (${r.model})` : ''}`.slice(0, 120), promptTemplateId: prompt.id,
          status: parsed.success ? 'SUCCEEDED' : 'SCHEMA_INVALID', usedFallback: false,
          inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0, costUsd: 0, costIsEstimate: false, latencyMs: Date.now() - started,
          entityType: opts.entity?.type, entityId: opts.entity?.id, ...att, inputPreview: redactForLog(userPrompt).slice(0, 1500),
          output: (r.data ?? null) as Prisma.InputJsonValue,
          errorMessage: parsed.success ? null : parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
      (await import('./usage.js')).meter({ workspaceId, metric: 'ai_requests', quantity: 1, key: `ai:${exec.id}` });
      if (parsed.success) return { data: parsed.data as T, executionId: exec.id, provider: r.provider, model: exec.model };
      lastError = `schema invalid: ${exec.errorMessage}`;
      user = `${userPrompt}\n\nYour previous answer failed validation (${exec.errorMessage}). Return output that matches the schema exactly.`;
    } catch (e) {
      lastError = (e as Error).message;
      await db().aiExecution.create({ data: { workspaceId, task, provider: source.mode === 'claude_subscription' ? 'ANTHROPIC' : 'OPENAI', model: label, promptTemplateId: prompt.id, status: 'FAILED', usedFallback: false, errorMessage: redactForLog(lastError).slice(0, 1000), entityType: opts.entity?.type, entityId: opts.entity?.id, ...att, inputPreview: redactForLog(userPrompt).slice(0, 1500) } });
      throw new AppError('AI_SUBSCRIPTION_UNAVAILABLE', `${label}: ${lastError}`, 503);
    }
  }
  throw new AppError('AI_OUTPUT_INVALID', `AI task ${task} failed on ${label}: ${lastError}`, 502);
}

// ---------------------------------------------------------------- provider configuration

export async function listProviders(workspaceId: string) {
  const ps = await db().aiProvider.findMany({ where: { workspaceId }, orderBy: { provider: 'asc' } });
  return ps.map(({ encryptedApiKey: _k, ...p }) => p);
}

export const SetDefaultProviderSchema = z.object({
  provider: z.enum(AI_PROVIDER_NAMES).nullable(),
  applyToAll: z.boolean().default(false),
});

export async function setDefaultProvider(workspaceId: string, input: z.infer<typeof SetDefaultProviderSchema>, actor: Actor) {
  if (input.applyToAll && !input.provider) throw new AppError('VALIDATION_FAILED', 'Choose an enabled provider before applying a default to all tasks', 400);
  if (input.provider) {
    const provider = await db().aiProvider.findUnique({ where: { workspaceId_provider: { workspaceId, provider: input.provider } } });
    if (!provider?.isEnabled) throw new AppError('VALIDATION_FAILED', 'The workspace default must be an enabled, configured AI provider', 400);
  }
  await persistWorkspaceDefaultProvider(workspaceId, input.provider);
  if (input.applyToAll) await db().aiModelRoute.updateMany({ where: { workspaceId }, data: { useWorkspaceDefault: true } });
  if (!input.provider) await db().aiModelRoute.updateMany({ where: { workspaceId }, data: { useWorkspaceDefault: false } });
  await ensureDefaultRoutes(workspaceId);
  await audit(workspaceId, actor, 'ai.default_provider.updated', undefined, { provider: input.provider, appliedToAllTasks: input.applyToAll });
  return { defaultProvider: input.provider, appliedToAll: input.applyToAll };
}

function validateBaseUrl(provider: ProviderName, raw?: string | null) {
  if (!raw?.trim()) {
    if (provider === 'CUSTOM_OPENAI') throw new AppError('VALIDATION_FAILED', 'A base URL is required for a custom OpenAI-compatible endpoint', 400);
    return null;
  }
  if (provider !== 'CUSTOM_OPENAI' && provider !== 'OLLAMA') throw new AppError('VALIDATION_FAILED', 'A custom endpoint URL is only supported for Ollama or Custom OpenAI-compatible providers', 400);
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new AppError('VALIDATION_FAILED', 'Endpoint URL must be a valid HTTPS URL or a local HTTP URL', 400); }
  const hostname = url.hostname.toLowerCase();
  const localhost = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'host.docker.internal' || hostname === '::1' || hostname === '[::1]';
  const octets = hostname.split('.').map(Number);
  const privateIpv4 = octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && (octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && (localhost || privateIpv4))) || hostname === '169.254.169.254' || hostname.startsWith('169.254.')) {
    throw new AppError('VALIDATION_FAILED', 'Endpoint must use HTTPS, or HTTP on localhost/private network; credentials, query strings, fragments and link-local addresses are not allowed', 400);
  }
  return url.toString().replace(/\/$/, '');
}

export async function upsertProvider(workspaceId: string, input: { provider: ProviderName; apiKey?: string; defaultModel: string; baseUrl?: string | null; isEnabled?: boolean }, actor: Actor) {
  const baseUrl = validateBaseUrl(input.provider, input.baseUrl);
  if (input.isEnabled === false && await workspaceDefaultProvider(workspaceId) === input.provider) {
    throw new AppError('VALIDATION_FAILED', 'Choose a different workspace default before disabling this provider', 400);
  }
  const existing = await db().aiProvider.findUnique({ where: { workspaceId_provider: { workspaceId, provider: input.provider } } });
  const keyOptional = input.provider === 'OLLAMA' || input.provider === 'CUSTOM_OPENAI';
  if (!existing && !input.apiKey && !keyOptional) throw new AppError('VALIDATION_FAILED', 'API key is required', 400);
  const data = {
    defaultModel: input.defaultModel,
    baseUrl,
    isEnabled: input.isEnabled ?? true,
    ...(input.apiKey ? { encryptedApiKey: encryptSecret(input.apiKey.trim()), keyLast4: input.apiKey.trim().slice(-4), lastTestOk: null, lastTestedAt: null } : {}),
  };
  const p = existing
    ? await db().aiProvider.update({ where: { id: existing.id }, data })
    : await db().aiProvider.create({ data: { workspaceId, provider: input.provider, encryptedApiKey: encryptSecret(input.apiKey?.trim() ?? ''), keyLast4: input.apiKey?.trim().slice(-4) ?? '', baseUrl, defaultModel: input.defaultModel, isEnabled: input.isEnabled ?? true } });
  await ensureDefaultRoutes(workspaceId);
  await audit(workspaceId, actor, input.apiKey ? 'ai_provider.key_updated' : 'ai_provider.updated', { type: 'ai_provider', id: p.id }, { provider: input.provider, model: input.defaultModel });
  const { encryptedApiKey: _k, ...safe } = p;
  return safe;
}

export async function deleteProvider(workspaceId: string, provider: ProviderName, actor: Actor) {
  const wasDefault = await workspaceDefaultProvider(workspaceId) === provider;
  await db().aiProvider.deleteMany({ where: { workspaceId, provider } });
  await db().aiModelRoute.deleteMany({ where: { workspaceId, provider } });
  await db().aiModelRoute.updateMany({ where: { workspaceId, fallbackProvider: provider }, data: { fallbackProvider: null, fallbackModel: null } });
  if (wasDefault) {
    await persistWorkspaceDefaultProvider(workspaceId, null);
    await db().aiModelRoute.updateMany({ where: { workspaceId }, data: { useWorkspaceDefault: false } });
  }
  await ensureDefaultRoutes(workspaceId);
  await audit(workspaceId, actor, 'ai_provider.removed', undefined, { provider });
}

export async function testProvider(workspaceId: string, provider: ProviderName) {
  const p = await db().aiProvider.findUnique({ where: { workspaceId_provider: { workspaceId, provider } } });
  if (!p) throw NotFound('AI provider');
  const adapter = adapters().ai[provider];
  if (!adapter) throw new AppError('PROVIDER_NOT_CONFIGURED', `AI adapter ${provider} is not installed`, 400);
  const r = await adapter.testConnection(decryptSecret(p.encryptedApiKey), p.defaultModel, { baseUrl: p.baseUrl });
  await db().aiProvider.update({ where: { id: p.id }, data: { lastTestedAt: new Date(), lastTestOk: r.ok, lastTestError: r.ok ? null : r.error.slice(0, 500) } });
  return r;
}

export async function providerModels(workspaceId: string, provider: ProviderName) {
  const p = await db().aiProvider.findUnique({ where: { workspaceId_provider: { workspaceId, provider } } });
  if (!p) throw NotFound('AI provider');
  const adapter = adapters().ai[provider];
  if (!adapter?.listModels) return { models: [], warning: 'This provider does not expose a model list. Enter its model ID manually.' };
  try { return { models: await adapter.listModels(decryptSecret(p.encryptedApiKey), { baseUrl: p.baseUrl }), warning: null }; }
  catch { return { models: [], warning: 'Could not load models. Check the provider connection or enter a model ID manually.' }; }
}

/** Make sure every task has a route; add the other provider as fallback when both exist. */
export async function ensureDefaultRoutes(workspaceId: string) {
  const providers = await db().aiProvider.findMany({ where: { workspaceId, isEnabled: true }, orderBy: { provider: 'asc' } });
  if (providers.length === 0) return;
  const defaultName = await workspaceDefaultProvider(workspaceId);
  const primary = providers.find((p) => p.provider === defaultName) ?? providers.find((p) => p.provider === 'ANTHROPIC') ?? providers[0];
  const secondary = providers.find((p) => p.provider !== primary.provider) ?? null;
  for (const task of AI_TASKS) {
    const existing = await db().aiModelRoute.findUnique({ where: { workspaceId_task: { workspaceId, task } } });
    const model = primary.provider === 'ANTHROPIC' && FAST_TASKS.includes(task) ? SUGGESTED_MODELS.ANTHROPIC.fast : primary.defaultModel;
    if (!existing) {
      await db().aiModelRoute.create({ data: { workspaceId, task, provider: primary.provider, model, useWorkspaceDefault: !!defaultName, fallbackProvider: secondary?.provider ?? null, fallbackModel: secondary?.defaultModel ?? null } });
    } else if (!existing.fallbackProvider && secondary && secondary.provider !== existing.provider) {
      await db().aiModelRoute.update({ where: { id: existing.id }, data: { fallbackProvider: secondary.provider, fallbackModel: secondary.defaultModel } });
    }
  }
}

export const RouteUpdateSchema = z.object({
  task: z.enum(AI_TASKS as [AiTaskName, ...AiTaskName[]]),
  provider: z.enum(AI_PROVIDER_NAMES),
  model: z.string().min(1),
  useWorkspaceDefault: z.boolean().optional(),
  fallbackProvider: z.enum(AI_PROVIDER_NAMES).nullable().optional(),
  fallbackModel: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxOutputTokens: z.number().int().min(100).max(16000).optional(),
  maxInputTokens: z.number().int().min(500).max(200000).nullable().optional(),
  monthlyBudgetUsd: z.number().min(0).nullable().optional(),
});

export async function listRoutes(workspaceId: string) {
  const [routes, defaultName] = await Promise.all([
    db().aiModelRoute.findMany({ where: { workspaceId }, orderBy: { task: 'asc' } }),
    workspaceDefaultProvider(workspaceId),
  ]);
  if (!defaultName) return routes;
  const provider = await db().aiProvider.findUnique({ where: { workspaceId_provider: { workspaceId, provider: defaultName } }, select: { provider: true, defaultModel: true } });
  if (!provider) return routes;
  return routes.map(route => route.useWorkspaceDefault ? { ...route, provider: provider.provider, model: provider.defaultModel } : route);
}

export async function updateRoute(workspaceId: string, input: z.infer<typeof RouteUpdateSchema>, actor: Actor) {
  if (input.useWorkspaceDefault && !await workspaceDefaultProvider(workspaceId)) {
    throw new AppError('VALIDATION_FAILED', 'Set a workspace default provider before switching a task to it', 400);
  }
  const data = {
    provider: input.provider, model: input.model,
    useWorkspaceDefault: input.useWorkspaceDefault ?? false,
    fallbackProvider: input.fallbackProvider ?? null, fallbackModel: input.fallbackProvider ? input.fallbackModel ?? null : null,
    temperature: input.temperature ?? null, maxOutputTokens: input.maxOutputTokens ?? 1500,
    maxInputTokens: input.maxInputTokens ?? null,
    monthlyBudgetUsd: input.monthlyBudgetUsd ?? null,
  };
  const r = await db().aiModelRoute.upsert({ where: { workspaceId_task: { workspaceId, task: input.task } }, update: data, create: { workspaceId, task: input.task, ...data } });
  await audit(workspaceId, actor, 'ai_route.updated', { type: 'ai_route', id: r.id }, { task: input.task, provider: input.provider, model: input.model });
  return r;
}

// ---------------------------------------------------------------- prompts

export async function listPrompts(workspaceId: string, task?: AiTaskName) {
  return db().promptTemplate.findMany({ where: { workspaceId, ...(task ? { task } : {}) }, orderBy: [{ task: 'asc' }, { version: 'desc' }] });
}

export async function createPromptVersion(workspaceId: string, input: { task: AiTaskName; systemPrompt: string; userPromptTemplate: string; changeNote?: string; activate?: boolean }, actor: Actor) {
  const last = await db().promptTemplate.findFirst({ where: { workspaceId, task: input.task }, orderBy: { version: 'desc' } });
  const version = (last?.version ?? 0) + 1;
  const p = await db().$transaction(async (tx) => {
    if (input.activate) await tx.promptTemplate.updateMany({ where: { workspaceId, task: input.task }, data: { isActive: false } });
    return tx.promptTemplate.create({ data: { workspaceId, task: input.task, version, systemPrompt: input.systemPrompt, userPromptTemplate: input.userPromptTemplate, changeNote: input.changeNote, isActive: !!input.activate, createdById: actor.userId ?? null } });
  });
  await audit(workspaceId, actor, 'prompt.version_created', { type: 'prompt', id: p.id }, { task: input.task, version, activated: !!input.activate });
  return p;
}

export async function activatePrompt(workspaceId: string, id: string, actor: Actor) {
  const p = await db().promptTemplate.findFirst({ where: { id, workspaceId } });
  if (!p) throw NotFound('Prompt');
  await db().$transaction([
    db().promptTemplate.updateMany({ where: { workspaceId, task: p.task }, data: { isActive: false } }),
    db().promptTemplate.update({ where: { id }, data: { isActive: true } }),
  ]);
  await audit(workspaceId, actor, 'prompt.activated', { type: 'prompt', id }, { task: p.task, version: p.version });
}

// ---------------------------------------------------------------- usage & prices

export async function usageReport(workspaceId: string, days: number) {
  const since = new Date(Date.now() - days * 86400_000);
  const byTask = await db().aiExecution.groupBy({ by: ['task', 'provider', 'model'], where: { workspaceId, createdAt: { gte: since } }, _sum: { inputTokens: true, outputTokens: true, costUsd: true }, _count: { _all: true } });
  const failures = await db().aiExecution.count({ where: { workspaceId, createdAt: { gte: since }, status: { not: 'SUCCEEDED' } } });
  const unpriced = await db().aiExecution.count({ where: { workspaceId, createdAt: { gte: since }, costIsEstimate: true, status: 'SUCCEEDED' } });
  const daily = await db().$queryRaw<Array<{ day: Date; calls: bigint; cost: Prisma.Decimal | null; tokens: bigint | null }>>`
    SELECT date_trunc('day', "createdAt") AS day, count(*) AS calls, sum("costUsd") AS cost, sum("inputTokens" + "outputTokens") AS tokens
    FROM "AiExecution" WHERE "workspaceId" = ${workspaceId}::uuid AND "createdAt" >= ${since}
    GROUP BY 1 ORDER BY 1`;
  return {
    byTask: byTask.map((r) => ({ task: r.task, provider: r.provider, model: r.model, calls: r._count._all, inputTokens: r._sum.inputTokens ?? 0, outputTokens: r._sum.outputTokens ?? 0, costUsd: Number(r._sum.costUsd ?? 0) })),
    daily: daily.map((d) => ({ day: d.day.toISOString().slice(0, 10), calls: Number(d.calls), costUsd: Number(d.cost ?? 0), tokens: Number(d.tokens ?? 0) })),
    failures,
    note: unpriced > 0 ? `${unpriced} successful calls used models with no price configured; their cost is shown as 0 (estimate).` : 'Costs are estimates computed from token counts reported by the provider and the configured price table.',
  };
}

export async function listExecutions(workspaceId: string, q: { page: number; pageSize: number; task?: AiTaskName; status?: string }) {
  const where: Prisma.AiExecutionWhereInput = { workspaceId, ...(q.task ? { task: q.task } : {}), ...(q.status ? { status: q.status as never } : {}) };
  const [items, total] = await Promise.all([
    db().aiExecution.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    db().aiExecution.count({ where }),
  ]);
  return { items, total };
}

export async function listPrices() {
  return db().aiModelPrice.findMany({ orderBy: [{ provider: 'asc' }, { model: 'asc' }, { effectiveFrom: 'desc' }] });
}

export async function upsertPrice(input: { provider: ProviderName; model: string; inputPerMTokUsd: number; outputPerMTokUsd: number; cachedInputPerMTokUsd?: number | null }, actor: Actor) {
  const p = await db().aiModelPrice.create({ data: { ...input, cachedInputPerMTokUsd: input.cachedInputPerMTokUsd ?? null, effectiveFrom: new Date() } });
  await audit(null, actor, 'ai_price.added', { type: 'ai_price', id: p.id }, input);
  return p;
}
