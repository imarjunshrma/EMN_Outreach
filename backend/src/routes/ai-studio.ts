import './knowledge-records.js';
import { z } from 'zod';
import multer from 'multer';
import type { Request, Response } from 'express';
import { route } from '../http/router.js';
import { db } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit } from '../core/audit.js';
import * as studio from '../services/ai-studio.js';
import * as pz from '../services/personalization.js';
import * as brain from '../services/outreach-brain.js';
import * as businessKnowledge from '../services/business-knowledge.js';
import * as businessOnboarding from '../services/business-onboarding.js';
import * as engine from '../services/engine.js';
import * as knowledgeImport from '../services/knowledge-import.js';
import { KnowledgeSchema, WritingSchema, ResearchSchema } from '../../../shared/src/ai-studio.js';
import { PROMPT_VARIABLES, lintPromptTemplate, EXAMPLE_PROFILE_PROMPT } from '../../../shared/src/prompt-builder.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
function readDoc(req: Request, res: Response): Promise<{ file?: { originalname: string; mimetype: string; buffer: Buffer }; fields: Record<string, string> }> {
  return new Promise((resolve, reject) => upload.single('file')(req, res, (err) => {
    if (err) return reject(new AppError('VALIDATION_FAILED', err.message, 400));
    const f = (req as Request & { file?: Express.Multer.File }).file;
    resolve({ file: f ? { originalname: f.originalname, mimetype: f.mimetype, buffer: f.buffer } : undefined, fields: (req.body ?? {}) as Record<string, string> });
  }));
}

const KindParam = z.enum(['knowledge', 'writing', 'research']);
const kindOf = (k: string) => KindParam.parse(k).toUpperCase() as 'KNOWLEDGE' | 'WRITING' | 'RESEARCH';
const SaveBody = z.object({ data: z.unknown(), changeNote: z.string().max(500).optional() });

route({ method: 'get', path: '/w/:workspaceId/ai-studio/imports', tag: 'AI Studio', summary: 'List knowledge imports', auth: 'workspace', role: 'VIEWER', handler: c => knowledgeImport.listImports(c.workspaceId) });
route({ method: 'get', path: '/w/:workspaceId/ai-studio/imports/template.xlsx', tag: 'AI Studio', summary: 'Download the versioned Outreach Brain workbook template', auth: 'workspace', role: 'VIEWER', raw: true, handler: async c => { c.res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); c.res.setHeader('Content-Disposition', 'attachment; filename="outvexa-outreach-brain-template-v2.xlsx"'); c.res.send(knowledgeImport.templateWorkbook()); } });
route({ method: 'get', path: '/w/:workspaceId/ai-studio/imports/:id', tag: 'AI Studio', summary: 'Inspect a knowledge import', auth: 'workspace', role: 'VIEWER', handler: c => knowledgeImport.getImport(c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/imports', tag: 'AI Studio', summary: 'Upload knowledge files for review', auth: 'workspace', role: 'ADMIN', status: 202, rateLimit: { limit: 20, windowSec: 3600, key: 'workspace', timeoutMs: 1500 }, handler: async c => {
  let totalBytes = 0;
  let tooLarge = false;
  const memory = multer.memoryStorage();
  const storage: multer.StorageEngine = {
    _handleFile(req, file, done) {
      const chunks: Buffer[] = [];
      let bytes = 0;
      file.stream.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        tooLarge ||= totalBytes > knowledgeImport.MAX_IMPORT_TOTAL_BYTES;
        if (tooLarge) {
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
        bytes += chunk.length;
      });
      file.stream.once('end', () => {
        if (tooLarge) return done(new AppError('VALIDATION_FAILED', 'The combined upload exceeds 40 MB', 413));
        done(null, { buffer: Buffer.concat(chunks, bytes), size: bytes });
      });
    },
    _removeFile: memory._removeFile,
  };
  const receive = multer({ storage, limits: { fileSize: knowledgeImport.MAX_IMPORT_BYTES, files: 20, fields: 0, parts: 21 } }).array('files', 20);
  const files = await new Promise<Express.Multer.File[]>((resolve, reject) => {
    receive(c.req, c.res, (error) => {
      if (error) return reject(error instanceof AppError ? error : new AppError('VALIDATION_FAILED', 'Invalid import upload or file exceeds 20 MB', 400));
      resolve((c.req as Request & { files?: Express.Multer.File[] }).files ?? []);
    });
  });
  return knowledgeImport.createImport(c.workspaceId, files, c.actor, String(c.req.headers['idempotency-key'] ?? '') || undefined);
} });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/import-items/:id/decision', tag: 'AI Studio', summary: 'Approve or reject an import item', auth: 'workspace', role: 'ADMIN', body: knowledgeImport.ReviewSchema, handler: c => knowledgeImport.decideItem(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/imports/:id/decisions', tag: 'AI Studio', summary: 'Reject or skip selected import items', auth: 'workspace', role: 'ADMIN', body: knowledgeImport.BulkReviewSchema, handler: c => knowledgeImport.decideItems(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/imports/:id/cancel', tag: 'AI Studio', summary: 'Cancel a queued knowledge import', auth: 'workspace', role: 'ADMIN', handler: c => knowledgeImport.cancelImport(c.workspaceId, c.params.id, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/imports/:id/retry', tag: 'AI Studio', summary: 'Retry a failed import step', auth: 'workspace', role: 'ADMIN', handler: c => knowledgeImport.retryImport(c.workspaceId, c.params.id, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/imports/:id/apply', tag: 'AI Studio', summary: 'Apply approved knowledge import items', auth: 'workspace', role: 'ADMIN', handler: c => knowledgeImport.applyApproved(c.workspaceId, c.params.id, c.actor) });

// ---------------------------------------------------------------- approved workspace service catalog and evidence-backed EMN proof
route({ method: 'get', path: '/w/:workspaceId/ai-studio/services', tag: 'AI Studio', summary: 'List workspace services and immutable versions', auth: 'workspace', role: 'VIEWER', handler: (c) => businessKnowledge.listServices(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/services', tag: 'AI Studio', summary: 'Create a draft business service', auth: 'workspace', role: 'ADMIN', body: businessKnowledge.ServiceCreateSchema, handler: (c) => businessKnowledge.createService(c.workspaceId, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/services/:id/versions', tag: 'AI Studio', summary: 'Create a new draft service version', auth: 'workspace', role: 'ADMIN', body: businessKnowledge.ServiceVersionInputSchema, handler: (c) => businessKnowledge.createServiceVersion(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/service-versions/:id/approve', tag: 'AI Studio', summary: 'Approve a service version for campaigns', auth: 'workspace', role: 'MANAGER', handler: (c) => businessKnowledge.approveServiceVersion(c.workspaceId, c.params.id, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/service-versions/:id/revoke', tag: 'AI Studio', summary: 'Revoke a service version and block future campaign use', auth: 'workspace', role: 'MANAGER', body: z.object({ reason: z.string().trim().min(8).max(500) }), handler: (c) => businessKnowledge.revokeServiceVersion(c.workspaceId, c.params.id, c.body.reason, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/service-versions/:id/expiry', tag: 'AI Studio', summary: 'Set or immediately apply a service-version expiry', auth: 'workspace', role: 'MANAGER', body: z.object({ expiresAt: z.coerce.date(), reason: z.string().trim().min(8).max(500) }), handler: (c) => businessKnowledge.setServiceVersionExpiry(c.workspaceId, c.params.id, c.body.expiresAt, c.body.reason, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/proof', tag: 'AI Studio', summary: 'Add a claim and source to an EMN service version', auth: 'workspace', role: 'ADMIN', body: businessKnowledge.ProofCreateSchema, handler: (c) => businessKnowledge.addProof(c.workspaceId, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/proof/:id/review', tag: 'AI Studio', summary: 'Record a manager review decision for business proof', auth: 'workspace', role: 'MANAGER', body: z.object({ decision: z.enum(['REVIEWED', 'APPROVED_FOR_USE', 'REJECTED', 'REVOKED']), note: z.string().trim().min(8).max(1000), reviewDueAt: z.coerce.date().nullable().optional() }), handler: (c) => businessKnowledge.reviewProof(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai-outreach-brain/feedback/:id/promote', tag: 'AI Outreach Brain', summary: 'Promote human-approved email feedback into positive retrieval examples', auth: 'workspace', role: 'MANAGER', handler: (c) => businessKnowledge.promoteApprovedFeedback(c.workspaceId, c.params.id, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/personalizations/:pid/promote-example', tag: 'AI Outreach Brain', summary: 'Promote an approved personalization into a redacted positive example', auth: 'workspace', role: 'MANAGER', handler: (c) => businessKnowledge.promoteApprovedPersonalization(c.workspaceId, c.params.pid, c.actor) });
route({ method: 'put', path: '/w/:workspaceId/campaigns/:id/services', tag: 'Campaigns', summary: 'Select approved service versions for a campaign', auth: 'workspace', role: 'MEMBER', body: z.object({ selections: z.array(z.object({ serviceVersionId: z.string().uuid(), isPreferred: z.boolean().optional() })).max(10) }), handler: (c) => businessKnowledge.setCampaignServices(c.workspaceId, c.params.id, c.body.selections, c.actor) });

// ---------------------------------------------------------------- AI Outreach Brain (workspace-specific rules, examples and explicit feedback)
route({ method: 'get', path: '/w/:workspaceId/ai-outreach-brain/overview', tag: 'AI Outreach Brain', summary: 'Training status, rules, examples, draft decisions and pending learning suggestions', auth: 'workspace', role: 'VIEWER', handler: async (c) => {
  const [rules, examples, suggestions, generated, approved, rejected, latency] = await Promise.all([
    db().outreachRule.count({ where: { workspaceId: c.workspaceId, status: 'ACTIVE' } }),
    db().outreachExample.count({ where: { workspaceId: c.workspaceId, isActive: true } }),
    db().aiLearningSuggestion.count({ where: { workspaceId: c.workspaceId, status: 'PENDING' } }),
    db().leadPersonalization.count({ where: { workspaceId: c.workspaceId, status: { in: ['GENERATED', 'BLOCKED', 'NEEDS_RESEARCH'] } } }),
    db().leadPersonalization.count({ where: { workspaceId: c.workspaceId, status: 'APPROVED' } }),
    db().leadPersonalization.count({ where: { workspaceId: c.workspaceId, status: 'REJECTED' } }),
    db().aiExecution.aggregate({ where: { workspaceId: c.workspaceId, task: 'PERSONALIZATION', status: 'SUCCEEDED' }, _avg: { latencyMs: true } }),
  ]);
  return { activeRules: rules, activeExamples: examples, pendingSuggestions: suggestions, generatedDrafts: generated, approvedDrafts: approved, rejectedDrafts: rejected, averageGenerationLatencyMs: latency._avg.latencyMs };
} });
route({ method: 'get', path: '/w/:workspaceId/ai-outreach-brain/rules', tag: 'AI Outreach Brain', summary: 'List workspace rules with conflict warnings', auth: 'workspace', role: 'VIEWER', handler: (c) => brain.listRules(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/ai-outreach-brain/rules', tag: 'AI Outreach Brain', summary: 'Create an outreach rule', auth: 'workspace', role: 'ADMIN', body: brain.RuleInputSchema, handler: (c) => brain.createRule(c.workspaceId, c.body, c.actor) });
route({ method: 'patch', path: '/w/:workspaceId/ai-outreach-brain/rules/:id', tag: 'AI Outreach Brain', summary: 'Update an outreach rule', auth: 'workspace', role: 'ADMIN', body: brain.RuleInputSchema, handler: (c) => brain.updateRule(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/ai-outreach-brain/rules/:id', tag: 'AI Outreach Brain', summary: 'Delete an outreach rule', auth: 'workspace', role: 'ADMIN', handler: async (c) => { await brain.deleteRule(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });
route({ method: 'get', path: '/w/:workspaceId/ai-outreach-brain/examples', tag: 'AI Outreach Brain', summary: 'List workspace examples', auth: 'workspace', role: 'VIEWER', handler: (c) => brain.listExamples(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/ai-outreach-brain/examples', tag: 'AI Outreach Brain', summary: 'Add a positive or negative text example', auth: 'workspace', role: 'ADMIN', body: brain.ExampleInputSchema, handler: (c) => brain.createExample(c.workspaceId, c.body, c.actor) });
route({ method: 'patch', path: '/w/:workspaceId/ai-outreach-brain/examples/:id', tag: 'AI Outreach Brain', summary: 'Update a workspace example', auth: 'workspace', role: 'ADMIN', body: brain.ExampleInputSchema, handler: (c) => brain.updateExample(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/ai-outreach-brain/examples/:id', tag: 'AI Outreach Brain', summary: 'Delete a workspace example', auth: 'workspace', role: 'ADMIN', handler: async (c) => { await brain.deleteExample(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });
route({ method: 'get', path: '/w/:workspaceId/ai-outreach-brain/suggestions', tag: 'AI Outreach Brain', summary: 'Learning suggestions from repeated customer edits', auth: 'workspace', role: 'VIEWER', handler: (c) => brain.listSuggestions(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/ai-outreach-brain/suggestions/:id/decision', tag: 'AI Outreach Brain', summary: 'Accept or reject a learning suggestion', auth: 'workspace', role: 'ADMIN', body: z.object({ decision: z.enum(['ACCEPT', 'REJECT']) }), handler: (c) => brain.decideSuggestion(c.workspaceId, c.params.id, c.body.decision, c.actor) });

// ---------------------------------------------------------------- workspace AI configuration
route({ method: 'get', path: '/w/:workspaceId/ai-studio/overview', tag: 'AI Studio', summary: 'Active configuration versions, documents, profiles and AI spend this month', auth: 'workspace', role: 'VIEWER',
  handler: async (c) => {
    const [k, w, r, docs, profiles, activeRules, activeExamples, pendingSuggestions, approvedDrafts, rejectedDrafts, generatedDrafts] = await Promise.all([
      studio.getConfig(c.workspaceId, 'KNOWLEDGE'), studio.getConfig(c.workspaceId, 'WRITING'), studio.getConfig(c.workspaceId, 'RESEARCH'), studio.listDocuments(c.workspaceId), studio.listProfiles(c.workspaceId),
      db().outreachRule.count({ where: { workspaceId: c.workspaceId, status: 'ACTIVE' } }), db().outreachExample.count({ where: { workspaceId: c.workspaceId, isActive: true } }),
      db().aiLearningSuggestion.count({ where: { workspaceId: c.workspaceId, status: 'PENDING' } }), db().leadPersonalization.count({ where: { workspaceId: c.workspaceId, status: 'APPROVED' } }),
      db().leadPersonalization.count({ where: { workspaceId: c.workspaceId, status: 'REJECTED' } }), db().leadPersonalization.count({ where: { workspaceId: c.workspaceId, status: { in: ['GENERATED', 'BLOCKED', 'NEEDS_RESEARCH'] } } }),
    ]);
    const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    const spend = await db().aiExecution.aggregate({ where: { workspaceId: c.workspaceId, createdAt: { gte: start } }, _sum: { costUsd: true } });
    const ws = await db().workspace.findUniqueOrThrow({ where: { id: c.workspaceId } });
    const settings = (ws.settings ?? {}) as Record<string, unknown>;
    return { knowledgeVersion: k.version, writingVersion: w.version, researchVersion: r.version, documents: docs.length, activeDocuments: docs.filter((d) => d.isActive).length, profiles: profiles.length, activeRules, activeExamples, pendingSuggestions, approvedDrafts, rejectedDrafts, generatedDrafts, monthSpendUsd: Number(spend._sum.costUsd ?? 0), aiMonthlyBudgetUsd: settings.aiMonthlyBudgetUsd ?? null, aiMaxCostPerLeadUsd: settings.aiMaxCostPerLeadUsd ?? null, companyName: k.data.companyName };
  } });
route({ method: 'get', path: '/w/:workspaceId/ai-studio/config/:kind', tag: 'AI Studio', summary: 'Active business knowledge / writing / research configuration', auth: 'workspace', role: 'VIEWER', handler: (c) => studio.getConfig(c.workspaceId, kindOf(c.params.kind) as 'KNOWLEDGE') });
route({ method: 'put', path: '/w/:workspaceId/ai-studio/config/:kind', tag: 'AI Studio', summary: 'Save a new version (validated; becomes active)', auth: 'workspace', role: 'ADMIN', status: 200, body: SaveBody,
  handler: (c) => studio.saveConfig(c.workspaceId, kindOf(c.params.kind), c.body.data, c.body.changeNote, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/ai-studio/config/:kind/versions', tag: 'AI Studio', summary: 'Version history', auth: 'workspace', role: 'VIEWER', handler: (c) => studio.listConfigVersions(c.workspaceId, kindOf(c.params.kind)) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/config-versions/:id/activate', tag: 'AI Studio', summary: 'Re-activate an earlier version', auth: 'workspace', role: 'ADMIN', status: 200, handler: async (c) => { await studio.activateConfigVersion(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });
route({ method: 'get', path: '/w/:workspaceId/ai-studio/schemas', tag: 'AI Studio', summary: 'Defaults and JSON schemas for the configuration forms', auth: 'workspace', role: 'VIEWER',
  handler: async () => ({ defaults: { knowledge: KnowledgeSchema.parse({}), writing: WritingSchema.parse({}), research: ResearchSchema.parse({}) }, promptVariables: PROMPT_VARIABLES, exampleProfilePrompt: EXAMPLE_PROFILE_PROMPT }) });

// ---------------------------------------------------------------- knowledge documents
route({ method: 'post', path: '/w/:workspaceId/ai-studio/onboarding/website', tag: 'AI Studio', summary: 'Safely crawl a company website and prepare inactive evidence and unapproved knowledge/service drafts', auth: 'workspace', role: 'ADMIN', status: 200, rateLimit: { limit: 5, windowSec: 3600, key: 'workspace' }, body: businessOnboarding.WebsiteIntakeSchema,
  handler: (c) => businessOnboarding.ingestBusinessWebsite(c.workspaceId, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/onboarding/revise', tag: 'AI Studio', summary: 'Propose a source-backed knowledge revision for review', auth: 'workspace', role: 'ADMIN', status: 201,
  rateLimit: { limit: 10, windowSec: 3600, key: 'workspace' }, body: businessOnboarding.WebsiteRevisionSchema,
  handler: (c) => businessOnboarding.proposeWebsiteRevision(c.workspaceId, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/ai-studio/documents', tag: 'AI Studio', summary: 'Knowledge documents', auth: 'workspace', role: 'VIEWER', handler: (c) => studio.listDocuments(c.workspaceId) });
route({ method: 'get', path: '/w/:workspaceId/ai-studio/documents/:id', tag: 'AI Studio', summary: 'One knowledge document with its extracted text', auth: 'workspace', role: 'VIEWER', handler: (c) => studio.getDocument(c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/documents', tag: 'AI Studio', summary: 'Add a document (multipart "file" .txt/.md/.csv/.json/.html ≤5 MB, or fields title+text)', auth: 'workspace', role: 'ADMIN', raw: true, rateLimit: { limit: 60, windowSec: 3600, key: 'workspace' },
  handler: async (c) => {
    const ct = String(c.req.headers['content-type'] ?? '');
    const input = ct.startsWith('multipart/') ? await readDoc(c.req, c.res) : { file: undefined, fields: (c.req.body ?? {}) as Record<string, string> };
    const title = String(input.fields.title ?? input.file?.originalname ?? '').trim();
    if (!title) throw new AppError('VALIDATION_FAILED', 'title is required', 400);
    const r = await studio.createDocument(c.workspaceId, { title, text: input.fields.text, file: input.file }, c.actor);
    c.res.status(201).json(r);
  } });
route({ method: 'patch', path: '/w/:workspaceId/ai-studio/documents/:id', tag: 'AI Studio', summary: 'Rename, (de)activate or replace document text', auth: 'workspace', role: 'ADMIN', body: z.object({ title: z.string().min(1).max(200).optional(), isActive: z.boolean().optional(), text: z.string().max(studio.MAX_DOC_CHARS).optional() }),
  handler: async (c) => { await studio.updateDocument(c.workspaceId, c.params.id, c.body, c.actor); return { ok: true }; } });
route({ method: 'delete', path: '/w/:workspaceId/ai-studio/documents/:id', tag: 'AI Studio', summary: 'Delete a document', auth: 'workspace', role: 'ADMIN', handler: async (c) => { await studio.deleteDocument(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });

// ---------------------------------------------------------------- prompt library
route({ method: 'get', path: '/w/:workspaceId/ai-studio/profiles', tag: 'Prompt library', summary: 'Prompt profiles (folders, tags, approval)', auth: 'workspace', role: 'VIEWER', query: z.object({ archived: z.coerce.boolean().default(false) }), handler: (c) => studio.listProfiles(c.workspaceId, c.query.archived) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/profiles', tag: 'Prompt library', summary: 'Create a prompt profile (version 1)', auth: 'workspace', role: 'MEMBER', body: studio.ProfileCreateSchema.extend({ folder: z.string().max(100).optional(), tags: z.array(z.string().max(40)).max(20).optional() }),
  handler: async (c) => { const p = await studio.createProfile(c.workspaceId, c.body, c.actor); if (c.body.folder || c.body.tags) await studio.updateProfileMeta(c.workspaceId, p.id, { folder: c.body.folder, tags: c.body.tags }, c.actor); return p; } });
route({ method: 'get', path: '/w/:workspaceId/ai-studio/profiles/:id', tag: 'Prompt library', summary: 'Profile with all versions and campaigns using it', auth: 'workspace', role: 'VIEWER', handler: (c) => studio.getProfile(c.workspaceId, c.params.id) });
route({ method: 'patch', path: '/w/:workspaceId/ai-studio/profiles/:id', tag: 'Prompt library', summary: 'Rename, move to folder, tag, approve for team use or archive', auth: 'workspace', role: 'MEMBER',
  body: z.object({ name: z.string().min(1).max(120).optional(), description: z.string().max(1000).nullable().optional(), folder: z.string().max(100).nullable().optional(), tags: z.array(z.string().max(40)).max(20).optional(), isArchived: z.boolean().optional(), isApproved: z.boolean().optional() }),
  handler: async (c) => {
    if (c.body.isApproved !== undefined && !['OWNER', 'ADMIN', 'MANAGER'].includes(c.role)) throw new AppError('FORBIDDEN', 'Only managers and above can approve shared templates', 403);
    const extra = c.body.isApproved !== undefined ? { approvedById: c.body.isApproved ? c.actor.userId ?? null : null } : {};
    return studio.updateProfileMeta(c.workspaceId, c.params.id, { ...c.body, ...extra }, c.actor);
  } });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/profiles/:id/versions', tag: 'Prompt library', summary: 'Save a new version (approved campaigns keep their frozen version)', auth: 'workspace', role: 'MEMBER', body: studio.ProfileVersionSchema, handler: (c) => studio.createProfileVersion(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/profiles/:id/versions/:versionId/activate', tag: 'Prompt library', summary: 'Activate an earlier version', auth: 'workspace', role: 'MEMBER', status: 200, handler: async (c) => { await studio.activateProfileVersion(c.workspaceId, c.params.id, c.params.versionId, c.actor); return { ok: true }; } });
route({ method: 'get', path: '/w/:workspaceId/ai-studio/profiles/:id/compare', tag: 'Prompt library', summary: 'Compare two versions (line diff + settings)', auth: 'workspace', role: 'VIEWER', query: z.object({ a: z.coerce.number().int(), b: z.coerce.number().int() }),
  handler: async (c) => { const p = await studio.getProfile(c.workspaceId, c.params.id); const a = p.versions.find((v) => v.version === c.query.a); const b = p.versions.find((v) => v.version === c.query.b); if (!a || !b) throw NotFound('Version'); return studio.compareVersions(a, b); } });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/profiles/:id/duplicate', tag: 'Prompt library', summary: 'Duplicate a profile', auth: 'workspace', role: 'MEMBER', body: z.object({ name: z.string().min(1).max(120) }), handler: (c) => studio.duplicateProfile(c.workspaceId, c.params.id, c.body.name, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/profiles/lint', tag: 'Prompt library', summary: 'Check prompt syntax and variables', auth: 'workspace', role: 'VIEWER', status: 200, body: z.object({ instructions: z.string().max(20000) }), handler: async (c) => lintPromptTemplate(c.body.instructions) });
route({ method: 'get', path: '/w/:workspaceId/ai-studio/profiles-export', tag: 'Prompt library', summary: 'Export profiles as JSON', auth: 'workspace', role: 'MEMBER', query: z.object({ ids: z.string().optional() }), handler: (c) => studio.exportProfiles(c.workspaceId, c.query.ids?.split(',').filter(Boolean)) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/profiles-import', tag: 'Prompt library', summary: 'Import profiles from an export file', auth: 'workspace', role: 'MEMBER', status: 200, body: studio.ProfileImportSchema, handler: (c) => studio.importProfiles(c.workspaceId, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/ai-studio/profiles/:id/test', tag: 'Prompt library', summary: 'Test the profile on a sample lead (real AI call, costs recorded; nothing is saved to campaigns)', auth: 'workspace', role: 'MEMBER', status: 200, rateLimit: { limit: 60, windowSec: 3600, key: 'workspace' },
  body: z.object({ leadId: z.string().uuid(), campaignId: z.string().uuid(), stepOrder: z.number().int().min(1).max(10).default(1) }),
  handler: async (c) => {
    const p = await studio.getProfile(c.workspaceId, c.params.id);
    const camp = await engine.getCampaign(c.workspaceId, c.body.campaignId);
    const step = camp.sequence?.steps.find((s) => s.order === c.body.stepOrder);
    if (!step) throw NotFound('Sequence step');
    if (camp.aiProfileId !== p.id) throw new AppError('VALIDATION_FAILED', 'Select this profile on the campaign (AI personalization tab) before testing it with that campaign', 400);
    return pz.generateForLead(c.workspaceId, camp.id, c.body.leadId, step.id, { preview: true, actor: c.actor });
  } });

// ---------------------------------------------------------------- prospect-specific instructions
route({ method: 'put', path: '/w/:workspaceId/leads/:id/ai-instructions', tag: 'Personalization', summary: 'Set instructions for this individual prospect (applied last in the hierarchy)', auth: 'workspace', role: 'MEMBER', status: 200, body: z.object({ aiInstructions: z.string().max(5000).nullable() }),
  handler: async (c) => {
    const r = await db().lead.updateMany({ where: { id: c.params.id, workspaceId: c.workspaceId }, data: { aiInstructions: c.body.aiInstructions?.trim() || null } });
    if (!r.count) throw NotFound('Lead');
    await audit(c.workspaceId, c.actor, 'lead.ai_instructions_set', { type: 'lead', id: c.params.id });
    return { ok: true };
  } });

// ---------------------------------------------------------------- campaign personalization
route({ method: 'put', path: '/w/:workspaceId/campaigns/:id/ai', tag: 'Personalization', summary: 'Campaign AI profile, ICP, overrides and cost limit (requires re-approval)', auth: 'workspace', role: 'MEMBER', status: 200, body: engine.CampaignAiSchema, handler: (c) => engine.updateCampaignAi(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/campaigns/:id/personalizations', tag: 'Personalization', summary: 'Per-lead generated content, status, score, warnings and cost', auth: 'workspace', role: 'VIEWER', query: pz.ListSchema,
  handler: async (c) => { const r = await pz.listForCampaign(c.workspaceId, c.params.id, c.query); return { data: r.items, page: c.query.page, pageSize: c.query.pageSize, total: r.total, totalPages: Math.max(1, Math.ceil(r.total / c.query.pageSize)), summary: r.summary }; } });
route({ method: 'get', path: '/w/:workspaceId/campaigns/:id/personalizations/lead/:leadId', tag: 'Personalization', summary: 'Review one recipient: research, evidence, every step, warnings, cost', auth: 'workspace', role: 'VIEWER', handler: (c) => pz.leadReview(c.workspaceId, c.params.id, c.params.leadId) });
route({ method: 'get', path: '/w/:workspaceId/campaigns/:id/personalizations/prompt-preview', tag: 'Personalization', summary: 'Resolved instructions and prompt for one lead/step (no AI call)', auth: 'workspace', role: 'VIEWER', query: z.object({ leadId: z.string().uuid(), stepId: z.string().uuid() }), handler: (c) => pz.promptPreview(c.workspaceId, c.params.id, c.query.leadId, c.query.stepId) });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/personalizations/generate', tag: 'Personalization', summary: 'Generate (or regenerate with force) one lead/step now', auth: 'workspace', role: 'MEMBER', status: 200, rateLimit: { limit: 300, windowSec: 3600, key: 'workspace' },
  body: z.object({ leadId: z.string().uuid(), stepId: z.string().uuid(), force: z.boolean().default(false), note: z.string().max(1000).optional() }),
  handler: (c) => pz.generateForLead(c.workspaceId, c.params.id, c.body.leadId, c.body.stepId, { force: c.body.force, note: c.body.note, actor: c.actor }) });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/personalizations/estimate', tag: 'Personalization', summary: 'Estimate cost of bulk generation', auth: 'workspace', role: 'MEMBER', status: 200, body: pz.BatchSchema, handler: (c) => pz.estimateBatch(c.workspaceId, c.params.id, c.body) });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/personalizations/batches', tag: 'Personalization', summary: 'Start bulk generation (queued; approved and manually edited content is preserved unless force)', auth: 'workspace', role: 'MANAGER', status: 202, rateLimit: { limit: 30, windowSec: 3600, key: 'workspace' }, body: pz.BatchSchema, handler: (c) => pz.createBatch(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/campaigns/:id/personalizations/batches', tag: 'Personalization', summary: 'Bulk generation runs', auth: 'workspace', role: 'VIEWER', handler: (c) => pz.listBatches(c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/personalization-batches/:batchId/cancel', tag: 'Personalization', summary: 'Cancel a running batch', auth: 'workspace', role: 'MANAGER', status: 200, handler: async (c) => { await pz.cancelBatch(c.workspaceId, c.params.batchId, c.actor); return { ok: true }; } });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/personalizations/retry-failed', tag: 'Personalization', summary: 'Re-queue failed generations', auth: 'workspace', role: 'MANAGER', status: 202, handler: (c) => pz.retryFailed(c.workspaceId, c.params.id, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/personalizations/research-missing', tag: 'Personalization', summary: 'Queue research for recipients without recent research', auth: 'workspace', role: 'MEMBER', status: 202, body: z.object({ maxAgeDays: z.number().int().min(1).max(3650).default(90) }), handler: (c) => pz.researchMissing(c.workspaceId, c.params.id, c.body.maxAgeDays, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/personalizations/:pid', tag: 'Personalization', summary: 'One generated email with revisions, evidence and quality report', auth: 'workspace', role: 'VIEWER', handler: (c) => pz.getPersonalization(c.workspaceId, c.params.pid) });
route({ method: 'patch', path: '/w/:workspaceId/personalizations/:pid', tag: 'Personalization', summary: 'Manually edit (preserved; re-checked; needs approval again)', auth: 'workspace', role: 'MEMBER', body: pz.EditSchema, handler: (c) => pz.editPersonalization(c.workspaceId, c.params.pid, c.body, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/personalizations/:pid/variants', tag: 'Personalization', summary: 'Generate three evidence-based draft alternatives for review', auth: 'workspace', role: 'MEMBER', status: 200, rateLimit: { limit: 20, windowSec: 3600, key: 'workspace' },
  handler: (c) => pz.generateDraftVariants(c.workspaceId, c.params.pid, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/personalizations/:pid/variants/select', tag: 'Personalization', summary: 'Select an evaluated draft alternative without approving it', auth: 'workspace', role: 'MEMBER', status: 200,
  body: z.object({ selectionId: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().min(0) }), handler: (c) => pz.selectDraftVariant(c.workspaceId, c.params.pid, c.body.selectionId, c.body.revision, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/personalizations/approve', tag: 'Personalization', summary: 'Approve one or many (only when quality checks pass)', auth: 'workspace', role: 'MANAGER', status: 200, body: z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) }), handler: (c) => pz.approvePersonalizations(c.workspaceId, c.body.ids, c.actor) });
route({ method: 'post', path: '/w/:workspaceId/personalizations/:pid/reject', tag: 'Personalization', summary: 'Reject with a structured quality reason', auth: 'workspace', role: 'MANAGER', status: 200, body: z.object({ reason: z.string().min(1).max(500), reasonCode: brain.FeedbackReasonCodeSchema.default('OTHER') }), handler: async (c) => { await pz.rejectPersonalization(c.workspaceId, c.params.pid, c.body.reason, c.actor, c.body.reasonCode); return { ok: true }; } });

// ---------------------------------------------------------------- campaign editor extras
route({ method: 'get', path: '/w/:workspaceId/campaigns/:id/preview', tag: 'Campaigns', summary: 'Exact rendered email for one lead and step (no AI call)', auth: 'workspace', role: 'VIEWER', query: z.object({ leadId: z.string().uuid(), stepOrder: z.coerce.number().int().min(1).max(10) }), handler: (c) => engine.previewForLead(c.workspaceId, c.params.id, c.query.leadId, c.query.stepOrder) });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/test-email', tag: 'Campaigns', summary: 'Send a rendered step to a workspace member’s own address', auth: 'workspace', role: 'MEMBER', status: 200, rateLimit: { limit: 20, windowSec: 3600, key: 'workspace' }, body: engine.TestEmailSchema, handler: (c) => engine.sendTestEmail(c.workspaceId, c.params.id, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/campaigns/:id/versions', tag: 'Campaigns', summary: 'Sequence version history (one per approval)', auth: 'workspace', role: 'VIEWER', handler: (c) => engine.listVersions(c.workspaceId, c.params.id) });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/versions/:version/restore', tag: 'Campaigns', summary: 'Restore an approved version into the editor (needs re-approval)', auth: 'workspace', role: 'MANAGER', status: 200, handler: (c) => engine.restoreVersion(c.workspaceId, c.params.id, Number(c.params.version), c.actor) });
route({ method: 'post', path: '/w/:workspaceId/campaigns/:id/duplicate', tag: 'Campaigns', summary: 'Clone a campaign (no recipients, sends or approvals)', auth: 'workspace', role: 'MEMBER', body: z.object({ name: z.string().min(1).max(150).optional() }), handler: (c) => engine.duplicateCampaign(c.workspaceId, c.params.id, c.body.name, c.actor) });
