import { z } from 'zod';
import { db } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { StructuredExclusionRuleSchema } from '../../../shared/src/service-eligibility.js';

const lines = z.array(z.string().trim().min(1).max(500)).max(100).default([]);
export const ServiceVersionInputSchema = z.object({
  description: z.string().trim().min(1).max(5000),
  targetIndustries: lines,
  excludedIndustries: lines,
  targetGeographies: lines,
  excludedGeographies: lines,
  minEmployeeCount: z.number().int().min(0).nullable().default(null),
  maxEmployeeCount: z.number().int().min(0).nullable().default(null),
  targetCustomerProfiles: lines,
  customerProblems: lines,
  desiredOutcomes: lines,
  deliverables: lines,
  eligibilityCriteria: lines,
  exclusions: lines,
  exclusionRules: z.array(StructuredExclusionRuleSchema).max(50).default([]),
  commercialBoundaries: lines,
  changeNote: z.string().trim().max(500).optional(),
});
export const ServiceCreateSchema = z.object({ name: z.string().trim().min(2).max(160), ...ServiceVersionInputSchema.shape });
export const ProofCreateSchema = z.object({
  serviceVersionId: z.string().uuid(), claim: z.string().trim().min(5).max(1000),
  description: z.string().trim().max(3000).nullable().optional(),
  sourceUrl: z.string().url().max(2000).nullable().optional(), sourceTitle: z.string().trim().max(300).nullable().optional(),
  knowledgeDocumentId: z.string().uuid().nullable().optional(),
});

function slugFor(name: string) {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
}
function assertEmployeeRange(data: { minEmployeeCount: number | null; maxEmployeeCount: number | null }) {
  if (data.minEmployeeCount !== null && data.maxEmployeeCount !== null && data.minEmployeeCount > data.maxEmployeeCount) throw new AppError('VALIDATION_FAILED', 'Maximum employee count must be greater than or equal to the minimum', 400);
}

export async function listServices(workspaceId: string) {
  return db().businessService.findMany({
    where: { workspaceId }, orderBy: [{ isArchived: 'asc' }, { name: 'asc' }],
    include: { versions: { orderBy: { version: 'desc' }, take: 10, include: { proof: { orderBy: { createdAt: 'desc' } } } } },
  });
}

export async function createService(workspaceId: string, input: z.infer<typeof ServiceCreateSchema>, actor: Actor) {
  const { name, changeNote, ...data } = ServiceCreateSchema.parse(input);
  assertEmployeeRange(data);
  const slug = slugFor(name);
  if (!slug) throw new AppError('VALIDATION_FAILED', 'Service name must contain letters or numbers', 400);
  const duplicate = await db().businessService.findFirst({ where: { workspaceId, slug } });
  if (duplicate) throw new AppError('CONFLICT', 'A service with this name already exists in the workspace', 409);
  const service = await db().businessService.create({ data: {
    workspaceId, name, slug, createdById: actor.userId ?? null,
    // The nested relation supplies both serviceId and workspaceId from its parent.
    // Passing workspaceId here is rejected by Prisma's nested create input.
    versions: { create: { version: 1, status: 'DRAFT', ...data, changeNote: changeNote ?? null, createdById: actor.userId ?? null } },
  }, include: { versions: true } });
  await audit(workspaceId, actor, 'business_service.created', { type: 'business_service', id: service.id }, { version: 1 });
  return service;
}

export async function createServiceVersion(workspaceId: string, serviceId: string, input: z.infer<typeof ServiceVersionInputSchema>, actor: Actor) {
  const service = await db().businessService.findFirst({ where: { id: serviceId, workspaceId, isArchived: false } });
  if (!service) throw NotFound('Business service');
  const data = ServiceVersionInputSchema.parse(input);
  assertEmployeeRange(data);
  const last = await db().businessServiceVersion.findFirst({ where: { serviceId, workspaceId }, orderBy: { version: 'desc' }, select: { version: true } });
  const version = await db().businessServiceVersion.create({ data: { workspaceId, serviceId, version: (last?.version ?? 0) + 1, status: 'DRAFT', ...data, createdById: actor.userId ?? null } });
  await audit(workspaceId, actor, 'business_service.version_created', { type: 'business_service_version', id: version.id }, { serviceId, version: version.version });
  return version;
}

export async function approveServiceVersion(workspaceId: string, versionId: string, actor: Actor) {
  const version = await db().businessServiceVersion.findFirst({ where: { id: versionId, workspaceId, service: { isArchived: false } } });
  if (!version) throw NotFound('Business service version');
  if (version.status !== 'DRAFT') throw new AppError('CONFLICT', `Only draft service versions can be approved (current state: ${version.status})`, 409);
  const approved = await db().$transaction(async (tx) => {
    const now = new Date();
    const previous = await tx.businessServiceVersion.findMany({ where: { workspaceId, serviceId: version.serviceId, status: 'APPROVED' } });
    for (const old of previous) {
      await tx.businessServiceVersion.update({ where: { id: old.id }, data: { status: 'SUPERSEDED', lifecycleChangedById: actor.userId ?? null, lifecycleChangedAt: now, lifecycleReason: `Superseded by version ${version.version}` } });
      await tx.businessServiceLifecycleEvent.create({ data: { workspaceId, serviceVersionId: old.id, fromStatus: 'APPROVED', toStatus: 'SUPERSEDED', actorUserId: actor.userId ?? null, reason: `Superseded by version ${version.version}` } });
    }
    const current = await tx.businessServiceVersion.update({ where: { id: versionId }, data: { status: 'APPROVED', approvedById: actor.userId ?? null, approvedAt: now, lifecycleChangedById: actor.userId ?? null, lifecycleChangedAt: now, lifecycleReason: 'Manager approval' } });
    await tx.businessServiceLifecycleEvent.create({ data: { workspaceId, serviceVersionId: versionId, fromStatus: 'DRAFT', toStatus: 'APPROVED', actorUserId: actor.userId ?? null, reason: 'Manager approval' } });
    return current;
  });
  await audit(workspaceId, actor, 'business_service.version_approved', { type: 'business_service_version', id: versionId }, { serviceId: version.serviceId, version: version.version });
  return approved;
}

export async function revokeServiceVersion(workspaceId: string, versionId: string, reason: string, actor: Actor) {
  const note = reason.trim();
  if (note.length < 8 || note.length > 500) throw new AppError('VALIDATION_FAILED', 'Provide a revocation reason (8–500 characters)', 400);
  const version = await db().businessServiceVersion.findFirst({ where: { id: versionId, workspaceId } });
  if (!version) throw NotFound('Business service version');
  if (!['APPROVED', 'SUPERSEDED'].includes(version.status)) throw new AppError('CONFLICT', 'Only approved or superseded service versions can be revoked', 409);
  const now = new Date();
  const updated = await db().$transaction(async (tx) => {
    const row = await tx.businessServiceVersion.update({ where: { id: versionId }, data: { status: 'REVOKED', lifecycleChangedById: actor.userId ?? null, lifecycleChangedAt: now, lifecycleReason: note } });
    await tx.businessServiceLifecycleEvent.create({ data: { workspaceId, serviceVersionId: versionId, fromStatus: version.status, toStatus: 'REVOKED', actorUserId: actor.userId ?? null, reason: note } });
    return row;
  });
  await audit(workspaceId, actor, 'business_service.version_revoked', { type: 'business_service_version', id: versionId }, { reason: note });
  return updated;
}

export async function setServiceVersionExpiry(workspaceId: string, versionId: string, expiresAt: Date, reason: string, actor: Actor) {
  const note = reason.trim();
  if (note.length < 8 || note.length > 500 || Number.isNaN(expiresAt.getTime())) throw new AppError('VALIDATION_FAILED', 'Provide a valid expiry date and reason (8–500 characters)', 400);
  const version = await db().businessServiceVersion.findFirst({ where: { id: versionId, workspaceId } });
  if (!version) throw NotFound('Business service version');
  if (!['APPROVED', 'SUPERSEDED'].includes(version.status)) throw new AppError('CONFLICT', 'Only approved or superseded service versions can be expired', 409);
  const status = expiresAt <= new Date() ? 'EXPIRED' : version.status;
  const now = new Date();
  const updated = await db().$transaction(async (tx) => {
    const row = await tx.businessServiceVersion.update({ where: { id: versionId }, data: { expiresAt, status, lifecycleChangedById: actor.userId ?? null, lifecycleChangedAt: now, lifecycleReason: note } });
    await tx.businessServiceLifecycleEvent.create({ data: { workspaceId, serviceVersionId: versionId, fromStatus: version.status, toStatus: status, actorUserId: actor.userId ?? null, reason: note } });
    return row;
  });
  await audit(workspaceId, actor, 'business_service.version_expiry_set', { type: 'business_service_version', id: versionId }, { expiresAt: expiresAt.toISOString(), status, reason: note });
  return updated;
}

export async function archiveService(workspaceId: string, serviceId: string, actor: Actor) {
  const result = await db().businessService.updateMany({ where: { id: serviceId, workspaceId }, data: { isArchived: true } });
  if (!result.count) throw NotFound('Business service');
  await audit(workspaceId, actor, 'business_service.archived', { type: 'business_service', id: serviceId });
  return { ok: true };
}

export async function addProof(workspaceId: string, input: z.infer<typeof ProofCreateSchema>, actor: Actor) {
  const body = ProofCreateSchema.parse(input);
  const version = await db().businessServiceVersion.findFirst({ where: { id: body.serviceVersionId, workspaceId } });
  if (!version) throw NotFound('Business service version');
  if (version.status !== 'DRAFT') throw new AppError('CONFLICT', 'Approved service versions are immutable; create a new draft version before changing proof', 409);
  if (body.knowledgeDocumentId && !(await db().knowledgeDocument.findFirst({ where: { id: body.knowledgeDocumentId, workspaceId } }))) throw NotFound('Knowledge document');
  const proof = await db().businessProof.create({ data: { workspaceId, serviceVersionId: body.serviceVersionId, knowledgeDocumentId: body.knowledgeDocumentId ?? null, claim: body.claim, description: body.description ?? null, sourceUrl: body.sourceUrl ?? null, sourceTitle: body.sourceTitle ?? null, sourceType: body.knowledgeDocumentId ? 'KNOWLEDGE_DOCUMENT' : body.sourceUrl ? 'URL' : 'USER_PROVIDED', createdById: actor.userId ?? null } });
  await audit(workspaceId, actor, 'business_proof.created', { type: 'business_proof', id: proof.id }, { serviceVersionId: proof.serviceVersionId });
  return proof;
}

export async function reviewProof(workspaceId: string, proofId: string, input: { decision: 'REVIEWED' | 'APPROVED_FOR_USE' | 'REJECTED' | 'REVOKED'; note: string; reviewDueAt?: Date | null }, actor: Actor) {
  const proof = await db().businessProof.findFirst({ where: { id: proofId, workspaceId } });
  if (!proof) throw NotFound('Business proof');
  const version = await db().businessServiceVersion.findFirst({ where: { id: proof.serviceVersionId, workspaceId } });
  if (!version || version.status !== 'DRAFT') throw new AppError('CONFLICT', 'Proof can only be reviewed while its service version is a draft', 409);
  const note = input.note.trim();
  if (note.length < 8 || note.length > 1000) throw new AppError('VALIDATION_FAILED', 'A review note (8–1000 characters) is required', 400);
  const transitions: Record<string, string[]> = { SUBMITTED: ['REVIEWED', 'REJECTED'], REVIEWED: ['APPROVED_FOR_USE', 'REJECTED'], APPROVED_FOR_USE: ['REVIEWED', 'REVOKED'] };
  if (!transitions[proof.status]?.includes(input.decision)) throw new AppError('CONFLICT', `Proof cannot transition from ${proof.status} to ${input.decision}`, 409);
  if (input.decision === 'APPROVED_FOR_USE' && !proof.sourceUrl && !proof.knowledgeDocumentId) throw new AppError('VALIDATION_FAILED', 'Add a source URL or supporting knowledge document before permitting campaign use', 400);
  const permittedUse = input.decision === 'APPROVED_FOR_USE';
  const verificationMethod = input.decision === 'REVIEWED' || permittedUse ? (proof.sourceUrl ? 'MANAGER_SOURCE_REVIEW' : 'MANAGER_DOCUMENT_REVIEW') : proof.verificationMethod;
  const now = new Date();
  const updated = await db().$transaction(async (tx) => {
    const row = await tx.businessProof.update({ where: { id: proofId }, data: { status: input.decision, permittedUse, verificationMethod, verifiedById: actor.userId ?? null, verifiedAt: now, reviewDueAt: input.reviewDueAt ?? null, reviewNote: note, revokedById: input.decision === 'REVOKED' ? actor.userId ?? null : null, revokedAt: input.decision === 'REVOKED' ? now : null } });
    await tx.businessProofReview.create({ data: { workspaceId, proofId, fromStatus: proof.status, toStatus: input.decision, verificationMethod, reviewerId: actor.userId ?? null, permittedUse, reviewDueAt: input.reviewDueAt ?? null, note, proofSnapshot: { claim: proof.claim, description: proof.description, sourceUrl: proof.sourceUrl, sourceTitle: proof.sourceTitle, sourceType: proof.sourceType } } });
    return row;
  });
  await audit(workspaceId, actor, `business_proof.${input.decision.toLowerCase()}`, { type: 'business_proof', id: proofId }, { permittedUse, verificationMethod, note });
  return updated;
}

export async function setCampaignServices(workspaceId: string, campaignId: string, selections: Array<{ serviceVersionId: string; isPreferred?: boolean }>, actor: Actor) {
  const campaign = await db().campaign.findFirst({ where: { id: campaignId, workspaceId } });
  if (!campaign) throw NotFound('Campaign');
  if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED'].includes(campaign.status)) throw new AppError('CAMPAIGN_STATE', `Cannot configure a ${campaign.status} campaign`, 409);
  if (selections.length > 10 || new Set(selections.map((s) => s.serviceVersionId)).size !== selections.length) throw new AppError('VALIDATION_FAILED', 'Select up to 10 distinct services', 400);
  if (selections.filter((s) => s.isPreferred).length > 1) throw new AppError('VALIDATION_FAILED', 'Choose at most one preferred service', 400);
  const versions = await db().businessServiceVersion.findMany({ where: { workspaceId, status: 'APPROVED', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], id: { in: selections.map((s) => s.serviceVersionId) }, service: { isArchived: false } }, select: { id: true } });
  if (versions.length !== selections.length) throw new AppError('VALIDATION_FAILED', 'Every selected service must be an approved version in this workspace', 400);
  const selectedRows = selections.length ? await db().businessServiceVersion.findMany({ where: { id: { in: selections.map((s) => s.serviceVersionId) }, workspaceId }, select: { serviceId: true } }) : [];
  if (new Set(selectedRows.map((v) => v.serviceId)).size !== selectedRows.length) throw new AppError('VALIDATION_FAILED', 'Select only one version of each service', 400);
  await db().$transaction(async (tx) => {
    await tx.campaignServiceSelection.deleteMany({ where: { workspaceId, campaignId } });
    if (selections.length) await tx.campaignServiceSelection.createMany({ data: selections.map((s) => ({ workspaceId, campaignId, serviceVersionId: s.serviceVersionId, isPreferred: !!s.isPreferred })) });
  });
  await db().campaign.update({ where: { id: campaignId }, data: { status: ['APPROVED', 'RUNNING', 'PAUSED'].includes(campaign.status) ? 'PENDING_APPROVAL' : campaign.status, approvedContentHash: null, approvedAt: null, approvedById: null } });
  await audit(workspaceId, actor, 'campaign.services_updated', { type: 'campaign', id: campaignId }, { serviceVersionIds: selections.map((s) => s.serviceVersionId) });
  return db().campaignServiceSelection.findMany({ where: { workspaceId, campaignId }, include: { serviceVersion: { include: { proof: true, service: { select: { name: true } } } } } });
}

export async function promoteApprovedFeedback(workspaceId: string, feedbackId: string, actor: Actor) {
  const feedback = await db().outreachFeedback.findFirst({ where: { id: feedbackId, workspaceId, feedbackType: 'APPROVED' }, include: { personalization: { select: { campaignId: true, leadId: true, scoreExplanation: true, lead: { select: { firstName: true, lastName: true, email: true, company: { select: { name: true } } } }, revisions: { orderBy: { revision: 'desc' }, take: 1, select: { executionIds: true } } } } } });
  if (!feedback) throw NotFound('Approved feedback');
  const content = feedback.finalContent as Record<string, unknown>;
  let text = [content.subject, content.openingLine, content.body, content.cta].filter((x): x is string => typeof x === 'string' && !!x.trim()).join('\n\n');
  for (const privateValue of [feedback.personalization.lead.firstName, feedback.personalization.lead.lastName, feedback.personalization.lead.email, feedback.personalization.lead.company?.name].filter((x): x is string => !!x?.trim())) {
    const safe = privateValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(safe, 'gi'), '[prospect]');
  }
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]').slice(0, 20000);
  if (text.length < 10) throw new AppError('VALIDATION_FAILED', 'Approved feedback has no usable email content', 400);
  const already = await db().outreachExample.findUnique({ where: { sourceFeedbackId: feedback.id } });
  if (already) return already;
  const example = await db().outreachExample.create({ data: { workspaceId, name: 'Human-approved personalization', content: text, category: 'EMAIL', polarity: 'POSITIVE', explanation: 'Promoted from explicitly approved personalization feedback; prospect identifiers redacted', tags: ['human-approved'], isActive: true, isHumanApproved: true, reviewedById: actor.userId ?? null, reviewedAt: new Date(), sourceFeedbackId: feedback.id, createdById: actor.userId ?? null } });
  await audit(workspaceId, actor, 'outreach_brain.example_promoted', { type: 'outreach_example', id: example.id }, { feedbackId: feedback.id, campaignId: feedback.personalization.campaignId, leadId: feedback.personalization.leadId, executionIds: feedback.personalization.revisions[0]?.executionIds ?? [] });
  return example;
}

export async function promoteApprovedPersonalization(workspaceId: string, personalizationId: string, actor: Actor) {
  const feedback = await db().outreachFeedback.findFirst({ where: { workspaceId, personalizationId, feedbackType: 'APPROVED' }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  if (!feedback) throw new AppError('CONFLICT', 'Approve this personalization before promoting it as an example', 409);
  return promoteApprovedFeedback(workspaceId, feedback.id, actor);
}
