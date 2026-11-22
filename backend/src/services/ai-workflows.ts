import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import { platformAudit } from '../core/tenant.js';
import { PRESET_KEYS, StageSchema, WorkflowInputSchema, presetWorkflows, stageId, type Stage, type StageProvider, type WorkflowInput } from '../../../shared/src/ai-workflows.js';

// Owner-scoped workflow definitions, reusable stage templates and the versioned writing playbook.
// Callers must have passed assertOwner() first.

// ------------------------------------------------------------------ playbook

/** Shipped default playbook: ai/playbook/cold-email.md. Saved versions live in the database (survive deploys). */
export function defaultPlaybook(): string {
  const path = resolve(process.env.AI_PLAYBOOK_PATH ?? 'ai/playbook/cold-email.md');
  try { return readFileSync(path, 'utf8'); } catch { throw new AppError('CONFIG_MISSING', `Default playbook not found at ${path}`, 500); }
}

export async function currentPlaybook(ownerUserId: string) {
  const cur = await db().aiPlaybookVersion.findFirst({ where: { ownerUserId, isCurrent: true } });
  if (cur) return cur;
  return db().aiPlaybookVersion.upsert({
    where: { ownerUserId_version: { ownerUserId, version: 1 } },
    update: { isCurrent: true },
    create: { ownerUserId, version: 1, content: defaultPlaybook(), note: 'Initial playbook (ai/playbook/cold-email.md)', isCurrent: true },
  });
}

export async function playbookOverview(ownerUserId: string) {
  const current = await currentPlaybook(ownerUserId);
  const versions = await db().aiPlaybookVersion.findMany({ where: { ownerUserId }, orderBy: { version: 'desc' }, select: { id: true, version: true, note: true, isCurrent: true, createdAt: true } });
  return { current, versions };
}

export async function playbookVersion(ownerUserId: string, id: string) {
  const v = await db().aiPlaybookVersion.findFirst({ where: { id, ownerUserId } });
  if (!v) throw NotFound('Playbook version');
  return v;
}

export const PlaybookSaveSchema = z.object({ content: z.string().trim().min(20).max(50_000), note: z.string().trim().max(200).nullable().optional() });

export async function savePlaybook(ownerUserId: string, input: z.infer<typeof PlaybookSaveSchema>) {
  const cur = await currentPlaybook(ownerUserId);
  if (cur.content.trim() === input.content.trim()) return { version: cur, unchanged: true };
  const v = await db().$transaction(async (tx) => {
    const last = await tx.aiPlaybookVersion.findFirst({ where: { ownerUserId }, orderBy: { version: 'desc' } });
    await tx.aiPlaybookVersion.updateMany({ where: { ownerUserId, isCurrent: true }, data: { isCurrent: false } });
    return tx.aiPlaybookVersion.create({ data: { ownerUserId, version: (last?.version ?? 0) + 1, content: input.content, note: input.note ?? null, isCurrent: true } });
  });
  await platformAudit({ actorUserId: ownerUserId, action: 'ai_playbook.saved', targetType: 'ai_playbook', targetId: String(v.version) });
  return { version: v, unchanged: false };
}

/** Restoring creates a new version with the old content, so history is never rewritten. */
export async function restorePlaybook(ownerUserId: string, id: string) {
  const old = await playbookVersion(ownerUserId, id);
  return savePlaybook(ownerUserId, { content: old.content, note: `Restored from version ${old.version}` });
}

// ------------------------------------------------------------------ workflows

function parseStages(json: unknown): Stage[] {
  const r = z.array(StageSchema).safeParse(json);
  return r.success ? r.data : [];
}

/** Create the preset workflows once per owner (presets are ordinary editable workflows). */
export async function ensurePresets(ownerUserId: string, apiProvider?: StageProvider) {
  const existing = await db().aiWorkflow.findMany({ where: { ownerUserId, presetKey: { not: null } }, select: { presetKey: true } });
  const have = new Set(existing.map((e) => e.presetKey));
  const anyDefault = await db().aiWorkflow.count({ where: { ownerUserId, isDefault: true } });
  for (const p of presetWorkflows(apiProvider)) {
    if (have.has(p.presetKey)) continue;
    await db().aiWorkflow.create({ data: { ownerUserId, presetKey: p.presetKey, name: p.name, description: p.description, stages: p.stages as unknown as Prisma.InputJsonValue, isDefault: !anyDefault && p.presetKey === 'custom_example' } });
  }
}

export async function listWorkflows(ownerUserId: string) {
  await ensurePresets(ownerUserId);
  const rows = await db().aiWorkflow.findMany({ where: { ownerUserId }, orderBy: [{ isDefault: 'desc' }, { presetKey: 'asc' }, { createdAt: 'asc' }] });
  return rows.map((w) => ({ ...w, stages: parseStages(w.stages) }));
}

export async function getWorkflow(ownerUserId: string, id: string) {
  const w = await db().aiWorkflow.findFirst({ where: { id, ownerUserId } });
  if (!w) throw NotFound('Workflow');
  return { ...w, stages: parseStages(w.stages) };
}

export async function workflowByPreset(ownerUserId: string, presetKey: typeof PRESET_KEYS[number]) {
  await ensurePresets(ownerUserId);
  const w = await db().aiWorkflow.findFirst({ where: { ownerUserId, presetKey } });
  if (!w) throw NotFound('Workflow');
  return { ...w, stages: parseStages(w.stages) };
}

export async function defaultWorkflow(ownerUserId: string) {
  await ensurePresets(ownerUserId);
  const w = await db().aiWorkflow.findFirst({ where: { ownerUserId, isDefault: true } }) ?? await db().aiWorkflow.findFirst({ where: { ownerUserId }, orderBy: { createdAt: 'asc' } });
  if (!w) throw NotFound('Workflow');
  return { ...w, stages: parseStages(w.stages) };
}

export async function createWorkflow(ownerUserId: string, input: WorkflowInput) {
  const w = await db().aiWorkflow.create({ data: { ownerUserId, name: input.name, description: input.description ?? null, stages: input.stages as unknown as Prisma.InputJsonValue } });
  await platformAudit({ actorUserId: ownerUserId, action: 'ai_workflow.created', targetType: 'ai_workflow', targetId: w.id });
  return { ...w, stages: input.stages };
}

export async function updateWorkflow(ownerUserId: string, id: string, input: WorkflowInput) {
  const cur = await getWorkflow(ownerUserId, id);
  const w = await db().aiWorkflow.update({ where: { id: cur.id }, data: { name: input.name, description: input.description ?? null, stages: input.stages as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
  await platformAudit({ actorUserId: ownerUserId, action: 'ai_workflow.updated', targetType: 'ai_workflow', targetId: id, metadata: { version: w.version, stages: input.stages.length } });
  return { ...w, stages: input.stages };
}

export async function duplicateWorkflow(ownerUserId: string, id: string) {
  const cur = await getWorkflow(ownerUserId, id);
  return createWorkflow(ownerUserId, { name: `${cur.name} (copy)`.slice(0, 100), description: cur.description, stages: cur.stages });
}

export async function deleteWorkflow(ownerUserId: string, id: string) {
  const cur = await getWorkflow(ownerUserId, id);
  if (cur.isDefault) throw new AppError('VALIDATION_FAILED', 'Activate another workflow before deleting the active one', 400);
  await db().aiWorkflow.delete({ where: { id: cur.id } });
  await platformAudit({ actorUserId: ownerUserId, action: 'ai_workflow.deleted', targetType: 'ai_workflow', targetId: id });
  return { ok: true };
}

/** "Activate": the workflow used by "Generate with selected workflow". */
export async function activateWorkflow(ownerUserId: string, id: string) {
  const cur = await getWorkflow(ownerUserId, id);
  await db().$transaction([
    db().aiWorkflow.updateMany({ where: { ownerUserId, isDefault: true }, data: { isDefault: false } }),
    db().aiWorkflow.update({ where: { id: cur.id }, data: { isDefault: true } }),
  ]);
  await platformAudit({ actorUserId: ownerUserId, action: 'ai_workflow.activated', targetType: 'ai_workflow', targetId: id });
  return { ok: true };
}

export { WorkflowInputSchema };

// ------------------------------------------------------------------ stage templates

export const StageTemplateSchema = z.object({ name: z.string().trim().min(1).max(80), stage: StageSchema });

export async function listStageTemplates(ownerUserId: string) {
  const rows = await db().aiStageTemplate.findMany({ where: { ownerUserId }, orderBy: { createdAt: 'desc' } });
  return rows.map((r) => ({ ...r, stage: StageSchema.parse(r.stage) }));
}
export async function saveStageTemplate(ownerUserId: string, input: z.infer<typeof StageTemplateSchema>) {
  const stage = { ...input.stage, id: stageId('tpl') };
  return db().aiStageTemplate.create({ data: { ownerUserId, name: input.name, stage: stage as unknown as Prisma.InputJsonValue } });
}
export async function deleteStageTemplate(ownerUserId: string, id: string) {
  const r = await db().aiStageTemplate.deleteMany({ where: { id, ownerUserId } });
  if (!r.count) throw NotFound('Stage template');
  return { ok: true };
}
