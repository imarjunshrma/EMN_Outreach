import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { redis } from '../core/redis.js';
import { adapters } from '../core/container.js';
import { AppError, NotFound } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { enqueue, queue, QUEUES, type QueueName } from '../core/queues.js';
import { platformAudit } from '../core/tenant.js';
import { computeCost } from './ai.js';
import { decryptSecret } from './workspace.js';
import { isAiSubscriptionOwner, recordProviderOutcome, runnerFor, loadConnection } from './ai-subscriptions.js';
import { currentPlaybook, defaultWorkflow, getWorkflow, workflowByPreset } from './ai-workflows.js';
import { SubscriptionError, scrubSecrets } from '../../../integrations/src/ai/subscription/types.js';
import { neutralizeTags, redactForLog } from '../../../integrations/src/ai/guard.js';
import {
  OUTPUT_JSON_SCHEMAS, OUTPUT_ZOD, PROVIDER_LABELS, SAFETY_RULES, STAGE_PROVIDERS, StageSchema, TASK_INSTRUCTIONS, TASK_LABELS, WEB_TASKS,
  apiProviderOf, isResearchTask, isSubscriptionProvider, makeStage, producesVariants, type EmailVariant, type Stage, type StageProvider,
} from '../../../shared/src/ai-workflows.js';

// Workflow execution engine. One queue job runs one stage; the next stage is enqueued when it finishes.
// Rules: never fall back to another provider on its own; a usage limit or disconnected subscription pauses
// the run until the owner resumes it (or the limit resets and the owner asked for automatic resume).

type StageOutputRecord = { status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED'; provider: string; model: string | null; output: unknown; error?: string; finishedAt: string };
type Outputs = Record<string, StageOutputRecord>;

export function queueForProvider(p: string): QueueName {
  return p === 'CLAUDE_SUBSCRIPTION' ? QUEUES.aiClaude : p === 'CODEX_SUBSCRIPTION' ? QUEUES.aiCodex : QUEUES.aiApi;
}
const providerLabel = (p: string) => (p === 'CLAUDE_SUBSCRIPTION' ? 'Claude' : p === 'CODEX_SUBSCRIPTION' ? 'Codex' : PROVIDER_LABELS[p] ?? p);
const snapshotStages = (run: { workflowSnapshot: unknown }) => z.array(StageSchema).parse((run.workflowSnapshot as { stages: unknown }).stages);

// ------------------------------------------------------------------ prompt building

type LeadCtx = Prisma.LeadGetPayload<{ include: { company: true } }>;

function prospectBlock(lead: LeadCtx): string {
  const c = lead.company;
  const lines = [
    `Name: ${[lead.firstName, lead.lastName].filter(Boolean).join(' ') || '(unknown)'}`,
    lead.title ? `Title: ${lead.title}` : null,
    `Company: ${c?.name ?? '(unknown)'}`,
    lead.website || c?.website ? `Website: ${lead.website ?? c?.website}` : null,
    c?.domain ? `Domain: ${c.domain}` : null,
    lead.linkedinUrl ? `LinkedIn: ${lead.linkedinUrl}` : null,
    c?.industry ? `Industry: ${c.industry}` : null,
    lead.country || lead.city ? `Location: ${[lead.city, lead.country].filter(Boolean).join(', ')}` : null,
    c?.description ? `Company description (from our records): ${c.description.slice(0, 1500)}` : null,
    lead.tags.length ? `Tags: ${lead.tags.join(', ')}` : null,
  ].filter(Boolean);
  const cf = lead.customFields as Record<string, unknown> | null;
  if (cf && typeof cf === 'object') for (const [k, v] of Object.entries(cf).slice(0, 15)) if (typeof v === 'string' && v.length < 500) lines.push(`${k}: ${v}`);
  return `<untrusted_content source="prospect">\n${neutralizeTags(lines.join('\n'))}\n</untrusted_content>`;
}

async function evidenceBlock(workspaceId: string, lead: LeadCtx): Promise<string> {
  const claims = await db().researchClaim.findMany({
    where: { workspaceId, status: 'SUPPORTED', report: { status: 'COMPLETED', OR: [{ leadId: lead.id }, ...(lead.companyId ? [{ companyId: lead.companyId }] : [])] } },
    include: { evidence: { select: { url: true, fetchedAt: true } } }, orderBy: { createdAt: 'desc' }, take: 25,
  });
  if (!claims.length) return '(No saved research evidence for this prospect.)';
  return `<untrusted_content source="research_evidence">\n${neutralizeTags(claims.map((c) => `- ${c.text}\n  quote: "${c.quote}"\n  source: ${c.evidence.url} (retrieved ${c.evidence.fetchedAt.toISOString().slice(0, 10)})`).join('\n'))}\n</untrusted_content>`;
}

function formatGuidance(stage: Stage, priorVariantCount: number): string {
  const n = stage.taskType === 'COLD_EMAIL_GENERATION' || stage.taskType === 'CUSTOM' || priorVariantCount === 0 ? stage.variants : priorVariantCount;
  switch (stage.outputFormat) {
    case 'RESEARCH_JSON': return 'Return the research JSON. observations: only things you saw in a source, with verified=true and the URL in source; otherwise verified=false and source="". Inferences go in assumptions. research_sources: every URL you used.';
    case 'ANGLES_JSON': return `Return ${stage.variants} distinct angles, best first.`;
    case 'EMAIL_VARIANTS_JSON': return `Return exactly ${n} email variants in "variants" (subject, body, pain_point, angle, reasoning). Body is plain text with line breaks, no signature block, no links unless the playbook allows. "notes": anything the sender should check.`;
    case 'QUALITY_REVIEW_JSON': return `Return exactly ${n} final variants, plus one "checks" entry per variant (variant = 1-based index) and "notes".`;
    default: return 'Return {"text": "..."} with your answer.';
  }
}

interface BuiltPrompt { system: string; user: string }

/** One-off instructions given when this generation was started ("Extra instructions" box). */
const runInstructions = (run: { workflowSnapshot?: unknown }) => {
  const v = (run.workflowSnapshot as { instructions?: unknown } | null | undefined)?.instructions;
  return typeof v === 'string' ? v.trim() : '';
};

export async function buildStagePrompt(run: { workspaceId: string; leadId: string; ownerUserId: string; playbookVersionId: string | null; workflowSnapshot?: unknown }, stages: Stage[], index: number, outputs: Outputs): Promise<BuiltPrompt> {
  const stage = stages[index];
  const lead = await db().lead.findFirst({ where: { id: run.leadId, workspaceId: run.workspaceId }, include: { company: true } });
  if (!lead) throw NotFound('Lead');
  const playbook = run.playbookVersionId ? await db().aiPlaybookVersion.findFirst({ where: { id: run.playbookVersionId, ownerUserId: run.ownerUserId } }) : null;
  const earlier = stages.slice(0, index).filter((s) => outputs[s.id]?.status === 'SUCCEEDED');
  const prev = earlier[earlier.length - 1];
  const sections: string[] = [];
  const wanted = new Set(stage.inputs);
  if (wanted.has('prospect')) sections.push(`## Prospect\n${prospectBlock(lead)}`);
  if (wanted.has('research_evidence')) sections.push(`## Saved research evidence\n${await evidenceBlock(run.workspaceId, lead)}`);
  if (wanted.has('playbook')) sections.push(`## Writing playbook (follow it)\n${playbook?.content ?? '(no playbook)'}`);
  const include = new Map<string, Stage>();
  if (wanted.has('all')) for (const s of earlier) include.set(s.id, s);
  if (wanted.has('previous') && prev) include.set(prev.id, prev);
  for (const inp of stage.inputs) if (inp.startsWith('stage:')) { const s = earlier.find((x) => x.id === inp.slice(6)); if (s) include.set(s.id, s); }
  for (const s of include.values()) sections.push(`## Output of stage "${s.name}" (${TASK_LABELS[s.taskType]}, ${providerLabel(outputs[s.id].provider)})\n\`\`\`json\n${JSON.stringify(outputs[s.id].output, null, 2).slice(0, 20_000)}\n\`\`\``);
  const priorVariants = [...include.values()].reverse().map((s) => (outputs[s.id].output as { variants?: unknown[] })?.variants).find(Array.isArray)?.length ?? 0;
  const web = stage.allowWebResearch && WEB_TASKS.includes(stage.taskType) && isSubscriptionProvider(stage.provider);
  const system = [
    'You are a careful B2B research and cold-email assistant working for the sender. Your output is reviewed by a human before anything is sent; never claim an email was sent.',
    SAFETY_RULES,
    `Task: ${TASK_LABELS[stage.taskType]}. ${TASK_INSTRUCTIONS[stage.taskType]}`,
    web ? 'You may use web search and open public pages (read-only) to research the prospect. Prefer the prospect\'s own website and linked profiles. Do not log in anywhere.' : 'You cannot browse. Use only the inputs provided; if something is unknown, say so instead of guessing.',
    stage.instructions.trim() ? `Additional instructions from the sender (apply them unless they conflict with the rules above):\n${stage.instructions.trim()}` : '',
    runInstructions(run) ? `Instructions for this particular email from the sender (follow them closely unless they conflict with the rules above):\n${runInstructions(run)}` : '',
    formatGuidance(stage, priorVariants),
    'Answer with JSON that matches the required schema exactly.',
  ].filter(Boolean).join('\n\n');
  return { system, user: sections.join('\n\n') || 'No inputs were selected for this stage.' };
}

// ------------------------------------------------------------------ output validation

function validateOutput(stage: Stage, data: unknown, expectedVariants: number | null): unknown {
  const parsed = OUTPUT_ZOD[stage.outputFormat].safeParse(data);
  if (!parsed.success) throw new SubscriptionError('OUTPUT', `Output did not match the ${stage.outputFormat} format: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const out = parsed.data as Record<string, unknown>;
  if (stage.outputFormat === 'RESEARCH_JSON') {
    // A "verified" observation without a source is an assumption.
    const obs = out.observations as Array<{ text: string; verified: boolean; source: string }>;
    const assumptions = out.assumptions as string[];
    out.observations = obs.map((o) => (o.verified && !/^https?:\/\//i.test(o.source.trim()) ? { ...o, verified: false } : o));
    for (const o of obs) if (o.verified && !/^https?:\/\//i.test(o.source.trim())) assumptions.push(`${o.text} (no source given)`);
  }
  if (producesVariants(stage.outputFormat) && expectedVariants) {
    const v = out.variants as EmailVariant[];
    if (v.length !== expectedVariants) throw new SubscriptionError('OUTPUT', `Expected ${expectedVariants} variants, got ${v.length}`);
    for (const x of v) if (/\{\{[^}]*\}\}/.test(`${x.subject} ${x.body}`)) throw new SubscriptionError('OUTPUT', 'A variant contains an unresolved {{placeholder}}');
  }
  return out;
}

function expectedVariantCount(stage: Stage, stages: Stage[], index: number, outputs: Outputs): number | null {
  if (!producesVariants(stage.outputFormat)) return null;
  if (stage.taskType === 'COLD_EMAIL_GENERATION' || stage.taskType === 'CUSTOM') return stage.variants;
  for (let i = index - 1; i >= 0; i--) {
    const o = outputs[stages[i].id];
    const v = o?.status === 'SUCCEEDED' ? (o.output as { variants?: unknown[] })?.variants : undefined;
    if (Array.isArray(v)) return v.length;
  }
  return stage.variants;
}

// ------------------------------------------------------------------ provider execution (shared by the queue and generateEmail)

export interface StageCallResult { data: unknown; model: string | null; provider: string; usage: { inputTokens: number; outputTokens: number } | null; rateLimit?: unknown }

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new SubscriptionError('TIMEOUT', `Stage did not finish within ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(t));
}

export async function callProvider(ctx: { ownerUserId: string; workspaceId: string; leadId: string }, stage: Stage, prompt: BuiltPrompt): Promise<StageCallResult> {
  const jsonSchema = OUTPUT_JSON_SCHEMAS[stage.outputFormat];
  if (isSubscriptionProvider(stage.provider)) {
    const runner = await runnerFor(ctx.ownerUserId, stage.provider);
    const conn = await loadConnection(ctx.ownerUserId, stage.provider);
    try {
      const r = await runner.run({
        system: prompt.system, prompt: prompt.user, jsonSchema, model: stage.model ?? conn?.model ?? null,
        allowWeb: stage.allowWebResearch && WEB_TASKS.includes(stage.taskType), timeoutMs: stage.timeoutSec * 1000, reasoningEffort: stage.reasoningEffort,
      });
      await recordProviderOutcome(ctx.ownerUserId, stage.provider, { ok: true, rateLimit: r.rateLimit });
      return { data: r.data, model: r.model, provider: stage.provider, usage: r.usage, rateLimit: r.rateLimit };
    } catch (e) {
      const err = e instanceof SubscriptionError ? e : new SubscriptionError('FAILED', scrubSecrets((e as Error).message));
      await recordProviderOutcome(ctx.ownerUserId, stage.provider, { ok: false, error: err });
      throw err;
    }
  }
  const api = apiProviderOf(stage.provider);
  if (!api) throw new SubscriptionError('FAILED', `Unknown provider ${stage.provider}`);
  const prov = await db().aiProvider.findUnique({ where: { workspaceId_provider: { workspaceId: ctx.workspaceId, provider: api } } });
  if (!prov || !prov.isEnabled) throw new SubscriptionError('UNAVAILABLE', `${PROVIDER_LABELS[stage.provider]} is not configured in this workspace`);
  const adapter = adapters().ai[api];
  if (!adapter) throw new SubscriptionError('UNAVAILABLE', `AI adapter ${api} is not installed`);
  const model = stage.model || prov.defaultModel;
  const started = Date.now();
  try {
    const res = await withDeadline(adapter.generateStructured(decryptSecret(prov.encryptedApiKey), { model, system: prompt.system, user: prompt.user, jsonSchema, schemaName: stage.outputFormat.toLowerCase(), maxOutputTokens: 4000, temperature: stage.temperature ?? undefined }, { baseUrl: prov.baseUrl }), stage.timeoutSec * 1000);
    const price = await db().aiModelPrice.findFirst({ where: { provider: api, model, effectiveFrom: { lte: new Date() } }, orderBy: { effectiveFrom: 'desc' } });
    const { cost, priced } = computeCost(price, res.usage);
    await db().aiExecution.create({ data: { workspaceId: ctx.workspaceId, task: isResearchTask(stage.taskType) ? 'FACT_EXTRACTION' : 'EMAIL_WRITING', provider: api, model, status: 'SUCCEEDED', inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, cachedTokens: res.usage.cachedTokens, costUsd: cost, costIsEstimate: !priced, latencyMs: Date.now() - started, entityType: 'ai_workflow_stage', entityId: stage.id, leadId: ctx.leadId } });
    return { data: res.data, model, provider: stage.provider, usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens } };
  } catch (e) {
    if (e instanceof SubscriptionError) throw e;
    const msg = redactForLog((e as Error).message ?? String(e)).slice(0, 500);
    await db().aiExecution.create({ data: { workspaceId: ctx.workspaceId, task: isResearchTask(stage.taskType) ? 'FACT_EXTRACTION' : 'EMAIL_WRITING', provider: api, model, status: 'FAILED', errorMessage: msg, latencyMs: Date.now() - started, entityType: 'ai_workflow_stage', entityId: stage.id, leadId: ctx.leadId } }).catch(() => undefined);
    throw new SubscriptionError('FAILED', msg);
  }
}

// ------------------------------------------------------------------ generateEmail(prospect, options, provider)

export const GenerateEmailOptionsSchema = z.object({
  variants: z.number().int().min(1).max(5).default(3),
  instructions: z.string().max(4000).default(''),
  model: z.string().max(120).nullable().default(null),
  allowWebResearch: z.boolean().default(false),
  timeoutSec: z.number().int().min(30).max(1800).default(300),
});

/**
 * Provider-independent single-call email generation: the same prompt rules, playbook and validation for every
 * provider (Claude subscription, Codex subscription, or any existing API-key provider). Synchronous; for queued,
 * multi-stage generation use createRun().
 */
export async function generateEmail(prospect: { ownerUserId: string; workspaceId: string; leadId: string }, options: Partial<z.input<typeof GenerateEmailOptionsSchema>>, provider: StageProvider) {
  const o = GenerateEmailOptionsSchema.parse(options);
  const stage = makeStage({ id: 'generate', name: 'Cold email generation', provider, taskType: 'COLD_EMAIL_GENERATION', variants: o.variants, instructions: o.instructions, model: o.model, allowWebResearch: o.allowWebResearch, timeoutSec: o.timeoutSec, inputs: ['prospect', 'research_evidence', 'playbook'] });
  const pb = await currentPlaybook(prospect.ownerUserId);
  const prompt = await buildStagePrompt({ ...prospect, playbookVersionId: pb.id }, [stage], 0, {});
  const r = await callProvider(prospect, stage, prompt);
  return { ...(validateOutput(stage, r.data, o.variants) as { variants: EmailVariant[]; notes: string }), provider: r.provider, model: r.model };
}

// ------------------------------------------------------------------ runs

export const CreateRunSchema = z.object({
  leadId: z.string().uuid(),
  campaignId: z.string().uuid().nullable().optional(),
  mode: z.enum(['workflow', 'claude', 'codex']).default('workflow'),
  workflowId: z.string().uuid().nullable().optional(),
  /** One-off guidance for this generation only (tone, angle, offer, length…). Kept with the run. */
  instructions: z.string().trim().max(2000).optional(),
});

async function enqueueStage(run: { id: string; workspaceId: string; ownerUserId: string }, stage: Stage, stageIndex: number, attempt = 1, delayMs = 0) {
  const token = randomUUID();
  await db().aiWorkflowRun.update({ where: { id: run.id }, data: { jobToken: token } });
  await enqueue(queueForProvider(stage.provider), 'aiwf.stage', { runId: run.id, workspaceId: run.workspaceId, ownerUserId: run.ownerUserId, stageIndex, attempt, token }, { jobId: `aiwf_${token}_${Date.now()}`, attempts: 1, delay: delayMs });
}

/**
 * Worker start-up recovery: provider slots held by a crashed process are released, and runs whose stage was
 * claimed by a process that died are re-queued with a fresh token (the old job, if BullMQ retries it, is ignored).
 */
export async function recoverAiRuns() {
  const r = redis();
  for (const pattern of ['aiwf:slots:*', 'aiwf:last:*']) {
    let cursor = '0';
    do { const [next, keys] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', 200); cursor = next; if (keys.length) await r.del(...keys); } while (cursor !== '0');
  }
  const stuck = await db().aiWorkflowRun.findMany({ where: { OR: [{ status: 'RUNNING' }, { status: 'QUEUED', jobToken: { startsWith: 'run:' } }] } });
  for (const run of stuck) {
    const stages = snapshotStages(run);
    const stage = stages[run.currentStage];
    if (!stage) { await finish(run.id); continue; }
    await db().aiWorkflowStageExecution.updateMany({ where: { runId: run.id, status: 'RUNNING' }, data: { status: 'FAILED', errorMessage: 'Worker restarted during this stage; it was re-queued', finishedAt: new Date() } });
    await db().aiWorkflowRun.update({ where: { id: run.id }, data: { status: 'QUEUED' } });
    await enqueueStage(run, stage, run.currentStage);
  }
  return { requeued: stuck.length };
}

export async function createRun(ownerUserId: string, workspaceId: string, input: z.infer<typeof CreateRunSchema>) {
  const lead = await db().lead.findFirst({ where: { id: input.leadId, workspaceId }, select: { id: true } });
  if (!lead) throw NotFound('Lead');
  if (input.campaignId && !(await db().campaign.findFirst({ where: { id: input.campaignId, workspaceId }, select: { id: true } }))) throw NotFound('Campaign');
  const wf = input.mode === 'claude' ? await workflowByPreset(ownerUserId, 'claude_only')
    : input.mode === 'codex' ? await workflowByPreset(ownerUserId, 'codex_only')
      : input.workflowId ? await getWorkflow(ownerUserId, input.workflowId) : await defaultWorkflow(ownerUserId);
  const stages = wf.stages.filter((s) => s.enabled);
  if (!stages.length) throw new AppError('VALIDATION_FAILED', 'This workflow has no enabled stages', 400);
  const pb = await currentPlaybook(ownerUserId);
  const run = await db().aiWorkflowRun.create({
    data: { ownerUserId, workspaceId, leadId: input.leadId, campaignId: input.campaignId ?? null, workflowId: wf.id, workflowName: wf.name, workflowSnapshot: { version: wf.version, stages, instructions: input.instructions || null } as unknown as Prisma.InputJsonValue, playbookVersionId: pb.id, status: 'QUEUED' },
  });
  await enqueueStage(run, stages[0], 0);
  return run;
}

/** Concurrency + spacing per provider for this owner (subscriptions: from AI settings; API: env defaults). */
export async function acquireProviderSlot(ownerUserId: string, provider: string, holder: string): Promise<{ release: () => Promise<void> } | { retryInMs: number }> {
  const conn = isSubscriptionProvider(provider) ? await loadConnection(ownerUserId, provider) : null;
  const limit = conn?.concurrency ?? Math.max(1, Number(process.env.AI_API_STAGE_CONCURRENCY ?? 2));
  const spacing = conn?.delayMs ?? Number(process.env.AI_API_STAGE_DELAY_MS ?? 0);
  const r = redis();
  const key = `aiwf:slots:${ownerUserId}:${provider}`;
  const lastKey = `aiwf:last:${ownerUserId}:${provider}`;
  const now = Date.now();
  const last = Number(await r.get(lastKey) ?? 0);
  if (spacing > 0 && now - last < spacing) return { retryInMs: spacing - (now - last) + 100 };
  await r.zremrangebyscore(key, 0, now - 40 * 60_000);
  await r.zadd(key, now, holder);
  const rank = await r.zrank(key, holder);
  await r.pexpire(key, 45 * 60_000);
  if (rank === null || rank >= limit) { await r.zrem(key, holder); return { retryInMs: 4000 + Math.floor(Math.random() * 2000) }; }
  await r.set(lastKey, String(now), 'PX', Math.max(spacing, 1000) * 10);
  return { release: async () => { await r.zrem(key, holder); } };
}

async function setOutputs(runId: string, outputs: Outputs, data: Prisma.AiWorkflowRunUpdateInput = {}) {
  return db().aiWorkflowRun.update({ where: { id: runId }, data: { stageOutputs: outputs as unknown as Prisma.InputJsonValue, ...data } });
}

function limitMessage(provider: string) { return `${providerLabel(provider)} usage limit reached — workflow paused.`; }

export interface StageJobData { runId: string; workspaceId: string; ownerUserId: string; stageIndex: number; attempt: number; token?: string }

/** Worker entry point. Returns { delayMs } when the provider slot is busy (the job is re-queued, not failed). */
export async function processStageJob(data: StageJobData): Promise<{ delayMs?: number; status?: string; skipped?: string }> {
  const run = await db().aiWorkflowRun.findFirst({ where: { id: data.runId, workspaceId: data.workspaceId, ownerUserId: data.ownerUserId } });
  if (!run) return { skipped: 'run not found' };
  if (run.status !== 'QUEUED' && run.status !== 'RUNNING') return { skipped: `run is ${run.status.toLowerCase()}` };
  if (run.currentStage !== data.stageIndex) return { skipped: 'stale stage job' };
  if (data.token && run.jobToken !== data.token) return { skipped: 'superseded stage job' };
  // Background work stays scoped to the authorized owner, who must still belong to the workspace.
  const member = await db().workspaceMember.findFirst({ where: { workspaceId: run.workspaceId, userId: run.ownerUserId }, select: { id: true } });
  if (!(await isAiSubscriptionOwner(run.ownerUserId)) || !member) {
    await db().aiWorkflowRun.update({ where: { id: run.id }, data: { status: 'FAILED', error: 'The run owner is no longer authorized for AI subscriptions in this workspace', finishedAt: new Date() } });
    return { status: 'FAILED' };
  }
  const stages = snapshotStages(run);
  const stage = stages[data.stageIndex];
  if (!stage) return finish(run.id);
  const outputs = (run.stageOutputs ?? {}) as Outputs;

  // Conditional execution.
  const prev = data.stageIndex > 0 ? outputs[stages[data.stageIndex - 1].id] : null;
  if (stage.condition === 'if_previous_succeeded' && prev && prev.status !== 'SUCCEEDED') {
    outputs[stage.id] = { status: 'SKIPPED', provider: stage.provider, model: null, output: null, error: 'previous stage did not succeed', finishedAt: new Date().toISOString() };
    await logExecution(run, stage, data, 'SKIPPED', 0, 'previous stage did not succeed');
    return advance(run, stages, data.stageIndex, outputs);
  }

  const slot = await acquireProviderSlot(run.ownerUserId, stage.provider, `${run.id}:${data.stageIndex}`);
  if ('retryInMs' in slot) return { delayMs: slot.retryInMs };
  if (data.token) {
    const claimed = await db().aiWorkflowRun.updateMany({ where: { id: run.id, jobToken: data.token, status: { in: ['QUEUED', 'RUNNING'] } }, data: { jobToken: `run:${data.token}` } });
    if (claimed.count !== 1) { await slot.release(); return { skipped: 'stage already claimed' }; }
  }
  const started = Date.now();
  await db().aiWorkflowRun.update({ where: { id: run.id }, data: { status: 'RUNNING', startedAt: run.startedAt ?? new Date(), pausedReason: null, pausedProvider: null } });
  const exec = await db().aiWorkflowStageExecution.create({ data: { runId: run.id, workspaceId: run.workspaceId, stageIndex: data.stageIndex, stageId: stage.id, stageName: stage.name, taskType: stage.taskType, provider: stage.provider, model: stage.model, status: 'RUNNING', attempt: data.attempt } });
  try {
    const prompt = await buildStagePrompt(run, stages, data.stageIndex, outputs);
    const r = await callProvider(run, stage, prompt);
    const validated = validateOutput(stage, r.data, expectedVariantCount(stage, stages, data.stageIndex, outputs));
    await db().aiWorkflowStageExecution.update({ where: { id: exec.id }, data: { status: 'SUCCEEDED', model: r.model, durationMs: Date.now() - started, finishedAt: new Date(), inputTokens: r.usage?.inputTokens ?? null, outputTokens: r.usage?.outputTokens ?? null } });
    outputs[stage.id] = { status: 'SUCCEEDED', provider: stage.provider, model: r.model, output: validated, finishedAt: new Date().toISOString() };
    const extra: Prisma.AiWorkflowRunUpdateInput = {};
    if (stage.outputFormat === 'RESEARCH_JSON') extra.research = validated as Prisma.InputJsonValue;
    if (producesVariants(stage.outputFormat)) {
      const v = (validated as { variants: EmailVariant[]; checks?: unknown[] });
      extra.variants = v.variants.map((x, i) => ({ ...x, index: i, stageId: stage.id, provider: stage.provider, checks: (v.checks as Array<{ variant: number }> | undefined)?.find((c) => c.variant === i + 1) ?? null, edited: false })) as unknown as Prisma.InputJsonValue;
    }
    await setOutputs(run.id, outputs, extra);
    return advance(run, stages, data.stageIndex, outputs);
  } catch (e) {
    const err = e instanceof SubscriptionError ? e : new SubscriptionError('FAILED', scrubSecrets((e as Error).message ?? String(e)));
    const msg = scrubSecrets(err.message);
    await db().aiWorkflowStageExecution.update({ where: { id: exec.id }, data: { status: err.kind === 'USAGE_LIMIT' ? 'PAUSED_LIMIT' : 'FAILED', durationMs: Date.now() - started, finishedAt: new Date(), errorMessage: msg } });
    logger.warn({ runId: run.id, stage: stage.id, provider: stage.provider, kind: err.kind, attempt: data.attempt }, 'ai workflow stage failed');
    const now = await db().aiWorkflowRun.findUnique({ where: { id: run.id }, select: { status: true } });
    if (now?.status === 'CANCELLED' || now?.status === 'PAUSED') {
      outputs[stage.id] = { status: 'FAILED', provider: stage.provider, model: null, output: null, error: msg, finishedAt: new Date().toISOString() };
      await setOutputs(run.id, outputs);
      return { status: now.status };
    }
    const unavailable = err.kind === 'USAGE_LIMIT' || err.kind === 'AUTH' || err.kind === 'UNAVAILABLE';
    if (unavailable && stage.condition === 'skip_if_provider_unavailable') {
      outputs[stage.id] = { status: 'SKIPPED', provider: stage.provider, model: null, output: null, error: msg, finishedAt: new Date().toISOString() };
      await setOutputs(run.id, outputs);
      return advance(run, stages, data.stageIndex, outputs);
    }
    if (err.kind === 'USAGE_LIMIT') {
      await db().aiWorkflowRun.update({ where: { id: run.id }, data: { status: 'PAUSED_LIMIT', pausedReason: limitMessage(stage.provider), pausedProvider: stage.provider } });
      return { status: 'PAUSED_LIMIT' };
    }
    if (err.kind === 'AUTH' || err.kind === 'UNAVAILABLE') {
      await db().aiWorkflowRun.update({ where: { id: run.id }, data: { status: 'PAUSED', pausedReason: `${providerLabel(stage.provider)} is unavailable — ${msg}. Reconnect it, then resume, or choose another provider for this stage.`, pausedProvider: stage.provider } });
      return { status: 'PAUSED' };
    }
    if (data.attempt < stage.retry.maxAttempts) {
      const delay = stage.retry.backoffSec * 1000 * 2 ** (data.attempt - 1);
      await enqueueStage(run, stage, data.stageIndex, data.attempt + 1, delay);
      await db().aiWorkflowRun.update({ where: { id: run.id }, data: { status: 'QUEUED', error: `Stage "${stage.name}" attempt ${data.attempt} failed: ${msg}. Retrying in ${Math.round(delay / 1000)} s.` } });
      return { status: 'RETRYING' };
    }
    if (stage.continueOnError) {
      outputs[stage.id] = { status: 'FAILED', provider: stage.provider, model: null, output: null, error: msg, finishedAt: new Date().toISOString() };
      await setOutputs(run.id, outputs);
      return advance(run, stages, data.stageIndex, outputs);
    }
    outputs[stage.id] = { status: 'FAILED', provider: stage.provider, model: null, output: null, error: msg, finishedAt: new Date().toISOString() };
    await setOutputs(run.id, outputs, { status: 'FAILED', error: `Stage "${stage.name}" failed: ${msg}`, finishedAt: new Date() });
    return { status: 'FAILED' };
  } finally {
    await slot.release().catch(() => undefined);
  }
}

async function logExecution(run: { id: string; workspaceId: string }, stage: Stage, data: StageJobData, status: string, durationMs: number, error: string | null) {
  await db().aiWorkflowStageExecution.create({ data: { runId: run.id, workspaceId: run.workspaceId, stageIndex: data.stageIndex, stageId: stage.id, stageName: stage.name, taskType: stage.taskType, provider: stage.provider, status, attempt: data.attempt, durationMs, errorMessage: error, finishedAt: new Date() } });
}

async function finish(runId: string) {
  const run = await db().aiWorkflowRun.findUnique({ where: { id: runId } });
  const variants = (run?.variants ?? []) as unknown[];
  const ok = variants.length > 0 || !!run?.research;
  await db().aiWorkflowRun.update({ where: { id: runId }, data: { status: ok ? 'SUCCEEDED' : 'FAILED', finishedAt: new Date(), currentStage: snapshotStages(run!).length, ...(ok ? { error: null } : { error: 'No stage produced research or email variants' }) } });
  return { status: ok ? 'SUCCEEDED' : 'FAILED' };
}

async function advance(run: { id: string; workspaceId: string; ownerUserId: string }, stages: Stage[], index: number, _outputs: Outputs) {
  const next = index + 1;
  const fresh = await db().aiWorkflowRun.findUnique({ where: { id: run.id }, select: { status: true } });
  if (fresh?.status === 'CANCELLED') return { status: 'CANCELLED' };
  if (next >= stages.length) return finish(run.id);
  if (fresh?.status === 'PAUSED') {
    await db().aiWorkflowRun.update({ where: { id: run.id }, data: { currentStage: next } });
    return { status: fresh.status };
  }
  await db().aiWorkflowRun.update({ where: { id: run.id }, data: { currentStage: next, status: 'QUEUED' } });
  await enqueueStage(run, stages[next], next);
  return { status: 'QUEUED' };
}

// ------------------------------------------------------------------ run control

async function ownRun(ownerUserId: string, workspaceId: string, id: string) {
  const run = await db().aiWorkflowRun.findFirst({ where: { id, ownerUserId, workspaceId } });
  if (!run) throw NotFound('Generation run');
  return run;
}

export async function getRun(ownerUserId: string, workspaceId: string, id: string) {
  const run = await ownRun(ownerUserId, workspaceId, id);
  const executions = await db().aiWorkflowStageExecution.findMany({ where: { runId: id }, orderBy: { startedAt: 'asc' } });
  const lead = await db().lead.findFirst({ where: { id: run.leadId, workspaceId }, select: { id: true, email: true, firstName: true, lastName: true, company: { select: { name: true } } } });
  return { ...run, stages: snapshotStages(run), executions, lead };
}

export async function listRuns(ownerUserId: string, workspaceId: string, q: { leadId?: string; status?: string; page: number; pageSize: number }) {
  const where: Prisma.AiWorkflowRunWhereInput = { ownerUserId, workspaceId, ...(q.leadId ? { leadId: q.leadId } : {}), ...(q.status ? { status: q.status as never } : {}) };
  const [items, total] = await Promise.all([
    db().aiWorkflowRun.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true, leadId: true, campaignId: true, workflowName: true, status: true, currentStage: true, pausedReason: true, error: true, selectedVariant: true, draftSavedAt: true, createdAt: true, finishedAt: true, lead: { select: { email: true, firstName: true, lastName: true } } } }),
    db().aiWorkflowRun.count({ where }),
  ]);
  return { items, total };
}

export async function pauseRun(ownerUserId: string, workspaceId: string, id: string) {
  const run = await ownRun(ownerUserId, workspaceId, id);
  if (run.status !== 'QUEUED' && run.status !== 'RUNNING') throw new AppError('INVALID_STATE', `Cannot pause a ${run.status.toLowerCase()} run`, 409);
  await db().aiWorkflowRun.update({ where: { id }, data: { status: 'PAUSED', pausedReason: 'Paused by you' } });
  return { ok: true };
}

export const ResumeSchema = z.object({
  /** Explicit, owner-chosen provider for the paused stage (never applied automatically). */
  stageProvider: z.enum(STAGE_PROVIDERS).optional(),
  autoResume: z.boolean().optional(),
});

export async function resumeRun(ownerUserId: string, workspaceId: string, id: string, input: z.infer<typeof ResumeSchema> = {}) {
  const run = await ownRun(ownerUserId, workspaceId, id);
  if (input.autoResume !== undefined && run.status === 'PAUSED_LIMIT' && !input.stageProvider) {
    await db().aiWorkflowRun.update({ where: { id }, data: { autoResume: input.autoResume } });
    return { ok: true, autoResume: input.autoResume };
  }
  if (run.status !== 'PAUSED' && run.status !== 'PAUSED_LIMIT' && run.status !== 'FAILED') throw new AppError('INVALID_STATE', `Cannot resume a ${run.status.toLowerCase()} run`, 409);
  const stages = snapshotStages(run);
  const idx = Math.min(run.currentStage, stages.length - 1);
  if (input.stageProvider) {
    stages[idx] = { ...stages[idx], provider: input.stageProvider, model: null, allowWebResearch: isSubscriptionProvider(input.stageProvider) ? stages[idx].allowWebResearch : false };
    await platformAudit({ actorUserId: ownerUserId, action: 'ai_workflow.stage_provider_override', targetType: 'ai_workflow_run', targetId: id, metadata: { stage: stages[idx].id, provider: input.stageProvider } });
  }
  const outputs = (run.stageOutputs ?? {}) as Outputs;
  if (run.status === 'FAILED') delete outputs[stages[idx].id];
  await db().aiWorkflowRun.update({ where: { id }, data: { status: 'QUEUED', pausedReason: null, pausedProvider: null, error: null, finishedAt: null, autoResume: false, stageOutputs: outputs as unknown as Prisma.InputJsonValue, workflowSnapshot: { ...(run.workflowSnapshot as object), stages } as unknown as Prisma.InputJsonValue } });
  await enqueueStage(run, stages[idx], idx);
  return { ok: true };
}

export async function cancelRun(ownerUserId: string, workspaceId: string, id: string) {
  const run = await ownRun(ownerUserId, workspaceId, id);
  if (run.status === 'SUCCEEDED' || run.status === 'CANCELLED') return { ok: true };
  await db().aiWorkflowRun.update({ where: { id }, data: { status: 'CANCELLED', finishedAt: new Date() } });
  return { ok: true };
}

/** Called when a provider becomes available again (limit reset, provider un-paused). */
export async function resumeRunsForProvider(ownerUserId: string, provider: string, reason: string, onlyAuto = false) {
  const runs = await db().aiWorkflowRun.findMany({ where: { ownerUserId, pausedProvider: provider, status: onlyAuto ? 'PAUSED_LIMIT' : { in: ['PAUSED', 'PAUSED_LIMIT'] }, ...(onlyAuto ? { autoResume: true } : {}) } });
  for (const r of runs) {
    if (!onlyAuto && r.status === 'PAUSED_LIMIT' && !r.autoResume) continue; // the owner decides for limit pauses
    if (!onlyAuto && r.pausedReason === 'Paused by you') continue;
    await resumeRun(ownerUserId, r.workspaceId, r.id).catch((e) => logger.warn({ runId: r.id, err: String(e) }, `auto-resume failed (${reason})`));
  }
  return { resumed: runs.length };
}

// ------------------------------------------------------------------ variants, drafts

type StoredVariant = EmailVariant & { index: number; stageId: string; provider: string; checks: unknown; edited: boolean; history?: Array<{ subject: string; body: string; at: string; reason: string }> };

export const EditVariantSchema = z.object({ subject: z.string().trim().max(300), body: z.string().trim().min(1).max(10_000) });

export async function editVariant(ownerUserId: string, workspaceId: string, id: string, index: number, input: z.infer<typeof EditVariantSchema>) {
  const run = await ownRun(ownerUserId, workspaceId, id);
  const variants = (run.variants ?? []) as StoredVariant[];
  const v = variants[index];
  if (!v) throw NotFound('Variant');
  v.history = [...(v.history ?? []), { subject: v.subject, body: v.body, at: new Date().toISOString(), reason: 'edited' }].slice(-10);
  Object.assign(v, { subject: input.subject, body: input.body, edited: true });
  await db().aiWorkflowRun.update({ where: { id }, data: { variants: variants as unknown as Prisma.InputJsonValue } });
  return v;
}

export async function selectVariant(ownerUserId: string, workspaceId: string, id: string, index: number) {
  const run = await ownRun(ownerUserId, workspaceId, id);
  if (!((run.variants ?? []) as unknown[])[index]) throw NotFound('Variant');
  await db().aiWorkflowRun.update({ where: { id }, data: { selectedVariant: index } });
  return { ok: true };
}

/** Saves the chosen variant as a draft on the run. Nothing is sent or scheduled. */
export async function saveDraft(ownerUserId: string, workspaceId: string, id: string, index?: number) {
  const run = await ownRun(ownerUserId, workspaceId, id);
  const i = index ?? run.selectedVariant ?? 0;
  const v = ((run.variants ?? []) as StoredVariant[])[i];
  if (!v) throw NotFound('Variant');
  const updated = await db().aiWorkflowRun.update({ where: { id }, data: { selectedVariant: i, draft: { variantIndex: i, subject: v.subject, body: v.body } as Prisma.InputJsonValue, draftSavedAt: new Date() } });
  return { draft: updated.draft, savedAt: updated.draftSavedAt };
}

export async function requestRegenerateVariant(ownerUserId: string, workspaceId: string, id: string, index: number) {
  const run = await ownRun(ownerUserId, workspaceId, id);
  if (run.status !== 'SUCCEEDED') throw new AppError('INVALID_STATE', 'Wait for the run to finish before regenerating a variant', 409);
  const v = ((run.variants ?? []) as StoredVariant[])[index];
  if (!v) throw NotFound('Variant');
  await enqueue(queueForProvider(v.provider), 'aiwf.regenerate', { runId: id, workspaceId, ownerUserId, index }, { jobId: `aiwf-regen_${id}_${index}_${Date.now()}`, attempts: 1 });
  return { ok: true, queued: true };
}

/** Rewrite one variant with the provider that produced it; the other variants are given so the new one differs. */
export async function processRegenerateJob(data: { runId: string; workspaceId: string; ownerUserId: string; index: number }) {
  const run = await db().aiWorkflowRun.findFirst({ where: { id: data.runId, workspaceId: data.workspaceId, ownerUserId: data.ownerUserId } });
  if (!run) return { skipped: 'run not found' };
  if (!(await isAiSubscriptionOwner(run.ownerUserId))) return { skipped: 'owner not authorized' };
  const variants = (run.variants ?? []) as StoredVariant[];
  const target = variants[data.index];
  if (!target) return { skipped: 'variant not found' };
  const stages = snapshotStages(run);
  const src = stages.find((s) => s.id === target.stageId) ?? stages[stages.length - 1];
  const stage: Stage = { ...src, id: 'regenerate', taskType: 'COLD_EMAIL_GENERATION', outputFormat: 'EMAIL_VARIANTS_JSON', variants: 1, inputs: ['prospect', 'playbook'] };
  const pbRun = { ...run };
  const prompt = await buildStagePrompt(pbRun, [stage], 0, {});
  const others = variants.filter((_, i) => i !== data.index).map((v) => ({ subject: v.subject, body: v.body }));
  prompt.user += `\n\n## Research\n\`\`\`json\n${JSON.stringify(run.research ?? {}, null, 2).slice(0, 15_000)}\n\`\`\`\n\n## Existing variants (write ONE new variant with a different angle from all of these)\n\`\`\`json\n${JSON.stringify(others, null, 2)}\n\`\`\``;
  const r = await callProvider(run, stage, prompt);
  const out = validateOutput(stage, r.data, 1) as { variants: EmailVariant[] };
  const fresh = (await db().aiWorkflowRun.findUnique({ where: { id: run.id } }))!;
  const list = (fresh.variants ?? []) as StoredVariant[];
  const old = list[data.index];
  list[data.index] = { ...out.variants[0], index: data.index, stageId: old.stageId, provider: stage.provider, checks: null, edited: false, history: [...(old.history ?? []), { subject: old.subject, body: old.body, at: new Date().toISOString(), reason: 'regenerated' }].slice(-10) };
  await db().aiWorkflowRun.update({ where: { id: run.id }, data: { variants: list as unknown as Prisma.InputJsonValue } });
  return { ok: true };
}

// ------------------------------------------------------------------ queue dashboard

const AI_QUEUES = [QUEUES.aiClaude, QUEUES.aiCodex, QUEUES.aiApi] as const;

export async function queueDashboard(ownerUserId: string, workspaceId: string) {
  const grouped = await db().aiWorkflowRun.groupBy({ by: ['status'], where: { ownerUserId, workspaceId }, _count: { _all: true } });
  const counts = Object.fromEntries(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PAUSED', 'PAUSED_LIMIT', 'CANCELLED'].map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0]));
  const queues = await Promise.all(AI_QUEUES.map(async (name) => {
    const q = queue(name);
    const [c, paused] = await Promise.all([q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'), q.isPaused()]);
    return { name, paused, ...c };
  }));
  const executions = await db().aiWorkflowStageExecution.findMany({
    where: { workspaceId, run: { ownerUserId } }, orderBy: { startedAt: 'desc' }, take: 100,
    select: { id: true, runId: true, stageName: true, taskType: true, provider: true, model: true, status: true, attempt: true, durationMs: true, errorMessage: true, startedAt: true, run: { select: { workflowName: true, lead: { select: { email: true, firstName: true, lastName: true } } } } },
  });
  const paused = await db().aiWorkflowRun.findMany({ where: { ownerUserId, workspaceId, status: { in: ['PAUSED', 'PAUSED_LIMIT'] } }, orderBy: { updatedAt: 'desc' }, take: 50, select: { id: true, status: true, pausedReason: true, pausedProvider: true, autoResume: true, leadId: true, workflowName: true, lead: { select: { email: true, firstName: true, lastName: true } } } });
  return { counts, queues, executions, paused };
}

export async function setQueuesPaused(ownerUserId: string, paused: boolean) {
  for (const name of AI_QUEUES) { const q = queue(name); if (paused) await q.pause(); else await q.resume(); }
  await platformAudit({ actorUserId: ownerUserId, action: paused ? 'ai_workflow.queues_paused' : 'ai_workflow.queues_resumed', targetType: 'ai_queue' });
  return { ok: true, paused };
}
