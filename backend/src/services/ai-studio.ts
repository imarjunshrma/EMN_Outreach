import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { sha256 } from '../core/crypto.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { store } from '../core/storage.js';
import {
  KnowledgeSchema, WritingSchema, ResearchSchema, WritingOverridesSchema, CampaignAiOverridesSchema,
  resolveConfig, type Knowledge, type Writing, type Research, type ResolvedConfig, type WritingOverrides, type CampaignAiOverrides,
} from '../../../shared/src/ai-studio.js';
import { lintPromptTemplate, renderPromptTemplate, EXAMPLE_PROFILE_PROMPT, PROMPT_VARIABLES } from '../../../shared/src/prompt-builder.js';
import { htmlToText } from '../../../integrations/src/research/fetcher.js';

// AI Studio: versioned workspace AI configuration, knowledge documents and prompt profiles.

type Kind = 'KNOWLEDGE' | 'WRITING' | 'RESEARCH';
const SCHEMAS = { KNOWLEDGE: KnowledgeSchema, WRITING: WritingSchema, RESEARCH: ResearchSchema } as const;

export async function getConfig(workspaceId: string, kind: 'KNOWLEDGE'): Promise<{ data: Knowledge; version: number; versionId: string | null }>;
export async function getConfig(workspaceId: string, kind: 'WRITING'): Promise<{ data: Writing; version: number; versionId: string | null }>;
export async function getConfig(workspaceId: string, kind: 'RESEARCH'): Promise<{ data: Research; version: number; versionId: string | null }>;
export async function getConfig(workspaceId: string, kind: Kind) {
  const v = await db().aiConfigVersion.findFirst({ where: { workspaceId, kind, isActive: true }, orderBy: { version: 'desc' } });
  const parsed = SCHEMAS[kind].safeParse(v?.data ?? {});
  let data = parsed.success ? parsed.data : SCHEMAS[kind].parse({});
  if (kind === 'KNOWLEDGE' && !v) {
    // Upgrade path: seed knowledge from the legacy "offer facts" workspace setting.
    const ws = await db().workspace.findUnique({ where: { id: workspaceId }, select: { name: true, settings: true } });
    const offer = (ws?.settings as { offerFacts?: string } | null)?.offerFacts ?? '';
    data = { ...(data as Knowledge), companyName: ws?.name ?? '', description: offer };
  }
  return { data, version: v?.version ?? 0, versionId: v?.id ?? null };
}

export async function saveConfig(workspaceId: string, kind: Kind, input: unknown, changeNote: string | undefined, actor: Actor) {
  const data = SCHEMAS[kind].parse(input);
  const last = await db().aiConfigVersion.findFirst({ where: { workspaceId, kind }, orderBy: { version: 'desc' } });
  const version = (last?.version ?? 0) + 1;
  const v = await db().$transaction(async (tx) => {
    await tx.aiConfigVersion.updateMany({ where: { workspaceId, kind }, data: { isActive: false } });
    return tx.aiConfigVersion.create({ data: { workspaceId, kind, version, data: data as Prisma.InputJsonValue, isActive: true, changeNote: changeNote ?? null, createdById: actor.userId ?? null } });
  });
  await audit(workspaceId, actor, 'ai_studio.config_saved', { type: 'ai_config', id: v.id }, { kind, version });
  return { data, version, versionId: v.id };
}

export async function listConfigVersions(workspaceId: string, kind: Kind) {
  return db().aiConfigVersion.findMany({ where: { workspaceId, kind }, orderBy: { version: 'desc' }, take: 50 });
}

export async function activateConfigVersion(workspaceId: string, id: string, actor: Actor) {
  const v = await db().aiConfigVersion.findFirst({ where: { id, workspaceId } });
  if (!v) throw NotFound('Config version');
  await db().$transaction([
    db().aiConfigVersion.updateMany({ where: { workspaceId, kind: v.kind }, data: { isActive: false } }),
    db().aiConfigVersion.update({ where: { id }, data: { isActive: true } }),
  ]);
  await audit(workspaceId, actor, 'ai_studio.config_activated', { type: 'ai_config', id }, { kind: v.kind, version: v.version });
}

// ------------------------------------------------------------------ knowledge documents

const DOC_TYPES: Record<string, 'text' | 'html'> = { 'text/plain': 'text', 'text/markdown': 'text', 'text/csv': 'text', 'text/html': 'html', 'application/json': 'text' };
const DOC_EXT = /\.(txt|md|markdown|csv|json|html?)$/i;
export const MAX_DOC_CHARS = 100_000;

export async function listDocuments(workspaceId: string) {
  const docs = await db().knowledgeDocument.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, select: { id: true, title: true, fileName: true, mimeType: true, charCount: true, isActive: true, createdAt: true, updatedAt: true } });
  return docs;
}

export async function getDocument(workspaceId: string, id: string) {
  const d = await db().knowledgeDocument.findFirst({ where: { id, workspaceId } });
  if (!d) throw NotFound('Document');
  return d;
}

export async function createDocument(workspaceId: string, input: { title: string; text?: string; file?: { originalname: string; mimetype: string; buffer: Buffer } }, actor: Actor) {
  let text = input.text ?? '';
  let storageKey: string | null = null;
  if (input.file) {
    const kind = DOC_TYPES[input.file.mimetype] ?? (DOC_EXT.test(input.file.originalname) ? (/\.html?$/i.test(input.file.originalname) ? 'html' : 'text') : null);
    if (!kind) throw new AppError('VALIDATION_FAILED', 'Unsupported file type. Upload .txt, .md, .csv, .json or .html, or paste the text (for PDF/Word, copy the text in).', 400);
    const raw = input.file.buffer.toString('utf8');
    if (raw.includes('\u0000')) throw new AppError('VALIDATION_FAILED', 'File looks binary; upload a text file', 400);
    text = kind === 'html' ? htmlToText(raw).text : raw;
    storageKey = await (await import('./storage-accounting.js')).putTracked(workspaceId, 'knowledge', input.file.buffer, input.file.originalname.split('.').pop()?.toLowerCase() ?? 'txt', { enforce: true });
  }
  text = text.replace(/\r\n/g, '\n').trim();
  if (!text) throw new AppError('VALIDATION_FAILED', 'Document is empty', 400);
  if (text.length > MAX_DOC_CHARS) text = text.slice(0, MAX_DOC_CHARS);
  const d = await db().knowledgeDocument.create({ data: { workspaceId, title: input.title.slice(0, 200), fileName: input.file?.originalname ?? null, mimeType: input.file?.mimetype ?? 'text/plain', storageKey, text, charCount: text.length, createdById: actor.userId ?? null } });
  await audit(workspaceId, actor, 'ai_studio.document_added', { type: 'knowledge_document', id: d.id }, { title: d.title, chars: d.charCount });
  return { id: d.id, title: d.title, charCount: d.charCount };
}

export async function updateDocument(workspaceId: string, id: string, input: { title?: string; isActive?: boolean; text?: string }, actor: Actor) {
  const d = await getDocument(workspaceId, id);
  const text = input.text?.trim();
  await db().knowledgeDocument.update({ where: { id: d.id }, data: { title: input.title ?? undefined, isActive: input.isActive ?? undefined, ...(text ? { text: text.slice(0, MAX_DOC_CHARS), charCount: Math.min(text.length, MAX_DOC_CHARS) } : {}) } });
  await audit(workspaceId, actor, 'ai_studio.document_updated', { type: 'knowledge_document', id });
}

export async function deleteDocument(workspaceId: string, id: string, actor: Actor) {
  const d = await getDocument(workspaceId, id);
  if (d.storageKey) await (await import('./storage-accounting.js')).deleteTracked(d.storageKey);
  await db().knowledgeDocument.delete({ where: { id: d.id } });
  await audit(workspaceId, actor, 'ai_studio.document_deleted', { type: 'knowledge_document', id });
}

// ------------------------------------------------------------------ prompt profiles

export const ProfileCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  instructions: z.string().min(1).max(20000).default(EXAMPLE_PROFILE_PROMPT),
  settings: WritingOverridesSchema.default({}),
});
export const ProfileVersionSchema = z.object({
  instructions: z.string().min(1).max(20000),
  settings: WritingOverridesSchema.default({}),
  changeNote: z.string().max(500).optional(),
  activate: z.boolean().default(true),
});

function assertValidPrompt(src: string) {
  const lint = lintPromptTemplate(src);
  if (lint.errors.length) throw new AppError('VALIDATION_FAILED', `Prompt template error: ${lint.errors.join('; ')}`, 400, lint);
  if (lint.unknownVariables.length) throw new AppError('VALIDATION_FAILED', `Unknown variables: ${lint.unknownVariables.join(', ')}`, 400, { ...lint, available: PROMPT_VARIABLES.map((v) => v.name) });
}

export async function listProfiles(workspaceId: string, includeArchived = false) {
  const ps = await db().promptProfile.findMany({ where: { workspaceId, ...(includeArchived ? {} : { isArchived: false }) }, orderBy: { name: 'asc' }, include: { _count: { select: { versions: true, campaigns: true } } } });
  const active = await db().promptProfileVersion.findMany({ where: { id: { in: ps.map((p) => p.activeVersionId).filter((x): x is string => !!x) } }, select: { id: true, version: true } });
  return ps.map((p) => ({ ...p, activeVersion: active.find((a) => a.id === p.activeVersionId)?.version ?? null }));
}

export async function getProfile(workspaceId: string, id: string) {
  const p = await db().promptProfile.findFirst({ where: { id, workspaceId }, include: { versions: { orderBy: { version: 'desc' } }, campaigns: { select: { id: true, name: true, status: true } } } });
  if (!p) throw NotFound('Prompt profile');
  return p;
}

export async function createProfile(workspaceId: string, input: z.infer<typeof ProfileCreateSchema>, actor: Actor) {
  assertValidPrompt(input.instructions);
  const p = await db().$transaction(async (tx) => {
    const prof = await tx.promptProfile.create({ data: { workspaceId, name: input.name, description: input.description ?? null } });
    const v = await tx.promptProfileVersion.create({ data: { workspaceId, profileId: prof.id, version: 1, instructions: input.instructions, settings: input.settings as Prisma.InputJsonValue, changeNote: 'Created', createdById: actor.userId ?? null } });
    return tx.promptProfile.update({ where: { id: prof.id }, data: { activeVersionId: v.id } });
  });
  await audit(workspaceId, actor, 'ai_studio.profile_created', { type: 'prompt_profile', id: p.id }, { name: p.name });
  return p;
}

export async function updateProfileMeta(workspaceId: string, id: string, input: { name?: string; description?: string | null; isArchived?: boolean; folder?: string | null; tags?: string[]; isApproved?: boolean; approvedById?: string | null }, actor: Actor) {
  await getProfile(workspaceId, id);
  const p = await db().promptProfile.update({ where: { id }, data: input });
  await audit(workspaceId, actor, 'ai_studio.profile_updated', { type: 'prompt_profile', id }, input);
  return p;
}

/** Profiles are versioned: editing creates a new version; campaigns approved on an older version keep it (snapshot). */
export async function createProfileVersion(workspaceId: string, id: string, input: z.infer<typeof ProfileVersionSchema>, actor: Actor) {
  const p = await getProfile(workspaceId, id);
  assertValidPrompt(input.instructions);
  const version = (p.versions[0]?.version ?? 0) + 1;
  const v = await db().promptProfileVersion.create({ data: { workspaceId, profileId: id, version, instructions: input.instructions, settings: input.settings as Prisma.InputJsonValue, changeNote: input.changeNote ?? null, createdById: actor.userId ?? null } });
  if (input.activate) await db().promptProfile.update({ where: { id }, data: { activeVersionId: v.id } });
  await audit(workspaceId, actor, 'ai_studio.profile_version_created', { type: 'prompt_profile', id }, { version, activated: input.activate });
  return v;
}

export async function activateProfileVersion(workspaceId: string, id: string, versionId: string, actor: Actor) {
  const v = await db().promptProfileVersion.findFirst({ where: { id: versionId, profileId: id, workspaceId } });
  if (!v) throw NotFound('Profile version');
  await db().promptProfile.update({ where: { id }, data: { activeVersionId: v.id } });
  await audit(workspaceId, actor, 'ai_studio.profile_version_activated', { type: 'prompt_profile', id }, { version: v.version });
}

export async function duplicateProfile(workspaceId: string, id: string, name: string, actor: Actor) {
  const p = await getProfile(workspaceId, id);
  const active = p.versions.find((v) => v.id === p.activeVersionId) ?? p.versions[0];
  return createProfile(workspaceId, { name, description: p.description ?? undefined, instructions: active.instructions, settings: WritingOverridesSchema.parse(active.settings ?? {}) }, actor);
}

/** Export profiles as portable JSON (no ids, no secrets). */
export async function exportProfiles(workspaceId: string, ids?: string[]) {
  const ps = await db().promptProfile.findMany({ where: { workspaceId, ...(ids?.length ? { id: { in: ids } } : {}) }, include: { versions: true } });
  return {
    format: 'emn-prompt-profiles/v1',
    exportedAt: new Date().toISOString(),
    profiles: ps.map((p) => {
      const v = p.versions.find((x) => x.id === p.activeVersionId) ?? p.versions.sort((a, b) => b.version - a.version)[0];
      return { name: p.name, description: p.description, instructions: v?.instructions ?? '', settings: v?.settings ?? {} };
    }),
  };
}

export const ProfileImportSchema = z.object({
  format: z.literal('emn-prompt-profiles/v1'),
  profiles: z.array(z.object({ name: z.string().min(1).max(120), description: z.string().max(1000).nullable().optional(), instructions: z.string().min(1).max(20000), settings: WritingOverridesSchema.default({}) })).min(1).max(100),
});

export async function importProfiles(workspaceId: string, input: z.infer<typeof ProfileImportSchema>, actor: Actor) {
  const created: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const p of input.profiles) {
    let name = p.name;
    if (await db().promptProfile.findFirst({ where: { workspaceId, name } })) name = `${p.name} (imported ${new Date().toISOString().slice(0, 10)})`.slice(0, 120);
    try {
      const r = await createProfile(workspaceId, { name, description: p.description ?? undefined, instructions: p.instructions, settings: p.settings }, actor);
      created.push(r.id);
    } catch (e) { skipped.push({ name: p.name, reason: (e as Error).message }); }
  }
  return { created: created.length, skipped };
}

export function compareVersions(a: { instructions: string; settings: unknown }, b: { instructions: string; settings: unknown }) {
  const la = a.instructions.split('\n'); const lb = b.instructions.split('\n');
  const sa = new Set(la); const sb = new Set(lb);
  return {
    removedLines: la.filter((l) => !sb.has(l) && l.trim()),
    addedLines: lb.filter((l) => !sa.has(l) && l.trim()),
    settingsChanged: JSON.stringify(a.settings ?? {}) !== JSON.stringify(b.settings ?? {}),
    settingsA: a.settings, settingsB: b.settings,
  };
}

// ------------------------------------------------------------------ resolution + snapshots

export interface AiSnapshot {
  takenAt: string;
  knowledge: { versionId: string | null; version: number; data: Knowledge };
  writing: { versionId: string | null; version: number; data: Writing };
  research: { versionId: string | null; version: number; data: Research };
  documents: Array<{ id: string; title: string; text: string }>;
  outreachRules: Array<{ id: string; title: string; description: string; category: string; priority: string; condition: string | null; triggerTerms: string[] }>;
  outreachExamples: Array<{ id: string; name: string; content: string; correctedContent: string | null; category: string; polarity: string; explanation: string | null; tags: string[] }>;
  profile: { id: string; name: string; versionId: string; version: number; instructions: string; settings: WritingOverrides } | null;
  campaign: CampaignAiOverrides;
  icp: { id: string; name: string; aiInstructions: string | null } | null;
}

const DOC_BUDGET = 12_000;

async function activeDocuments(workspaceId: string) {
  const docs = await db().knowledgeDocument.findMany({ where: { workspaceId, isActive: true }, orderBy: { updatedAt: 'desc' }, select: { id: true, title: true, text: true } });
  let budget = DOC_BUDGET;
  const out: Array<{ id: string; title: string; text: string }> = [];
  for (const d of docs) {
    if (budget <= 0) break;
    const t = d.text.slice(0, budget);
    budget -= t.length;
    out.push({ id: d.id, title: d.title, text: t });
  }
  return out;
}

/** Live configuration for a campaign (what a new approval would freeze). */
export async function buildSnapshot(workspaceId: string, campaignId: string): Promise<AiSnapshot> {
  const c = await db().campaign.findFirst({ where: { id: campaignId, workspaceId }, include: { aiProfile: true, icp: true } });
  if (!c) throw NotFound('Campaign');
  const [knowledge, writing, research, documents, outreachRules, outreachExamples] = await Promise.all([
    getConfig(workspaceId, 'KNOWLEDGE'), getConfig(workspaceId, 'WRITING'), getConfig(workspaceId, 'RESEARCH'), activeDocuments(workspaceId),
    db().outreachRule.findMany({ where: { workspaceId, status: 'ACTIVE' }, orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }], take: 200, select: { id: true, title: true, description: true, category: true, priority: true, condition: true, triggerTerms: true } }),
    db().outreachExample.findMany({ where: { workspaceId, isActive: true }, orderBy: { updatedAt: 'desc' }, take: 100, select: { id: true, name: true, content: true, correctedContent: true, category: true, polarity: true, explanation: true, tags: true } }),
  ]);
  let profile: AiSnapshot['profile'] = null;
  if (c.aiProfile && !c.aiProfile.isArchived && c.aiProfile.activeVersionId) {
    const v = await db().promptProfileVersion.findUnique({ where: { id: c.aiProfile.activeVersionId } });
    if (v) profile = { id: c.aiProfile.id, name: c.aiProfile.name, versionId: v.id, version: v.version, instructions: v.instructions, settings: WritingOverridesSchema.parse(v.settings ?? {}) };
  }
  return {
    takenAt: new Date().toISOString(),
    knowledge, writing, research, documents, outreachRules, outreachExamples, profile,
    campaign: CampaignAiOverridesSchema.parse(c.aiOverrides ?? {}),
    icp: c.icp ? { id: c.icp.id, name: c.icp.name, aiInstructions: c.icp.aiInstructions } : null,
  };
}

/**
 * The configuration generation must use for this campaign: the frozen approval snapshot while the
 * campaign is approved/running/paused (so later prompt or setting edits never silently rewrite it),
 * otherwise the live configuration.
 */
export async function effectiveSnapshot(workspaceId: string, campaign: { id: string; status: string; aiConfigSnapshot: unknown }): Promise<{ snapshot: AiSnapshot; frozen: boolean }> {
  if (['APPROVED', 'RUNNING', 'PAUSED'].includes(campaign.status) && campaign.aiConfigSnapshot && typeof campaign.aiConfigSnapshot === 'object') {
    return { snapshot: campaign.aiConfigSnapshot as AiSnapshot, frozen: true };
  }
  return { snapshot: await buildSnapshot(workspaceId, campaign.id), frozen: false };
}

export function resolveFromSnapshot(s: AiSnapshot, step: { order: number; aiInstructions: string | null } | null, variant: { label: string; aiInstructions: string | null } | null, prospect?: { aiInstructions: string | null } | null): ResolvedConfig {
  const r = resolveConfig({
    workspace: { writing: WritingSchema.parse(s.writing.data), research: ResearchSchema.parse(s.research.data) },
    profile: s.profile ? { name: s.profile.name, settings: s.profile.settings, instructions: undefined } : null,
    campaign: s.campaign, icp: s.icp, step, variant,
  });
  if (prospect?.aiInstructions?.trim()) r.blocks.push({ level: 'prospect', label: 'Prospect-specific instructions (set by a user on this lead)', text: prospect.aiInstructions.trim() });
  return r;
}

export function configHash(parts: unknown): string {
  return sha256(JSON.stringify(parts)).slice(0, 32);
}

/** Render a profile prompt for one lead without calling AI (shows the resolved prompt and missing variables). */
export function renderProfilePrompt(instructions: string, vars: Record<string, unknown>) {
  return renderPromptTemplate(instructions, vars);
}
