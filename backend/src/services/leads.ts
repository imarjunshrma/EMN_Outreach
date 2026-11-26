import { emptyTracking, trackingTotals } from './tracking-analytics.js';
import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { sha256 } from '../core/crypto.js';
import { db, Prisma } from '../core/db.js';
import { AppError, BadRequest, NotFound } from '../core/errors.js';
import { audit, publish, type Actor } from '../core/audit.js';
import { acquireLock } from '../core/redis.js';
import { store } from '../core/storage.js';
import { enqueue, QUEUES } from '../core/queues.js';
import { emitEvent } from './automation.js';

export const LEAD_STATUSES = ['NEW', 'RESEARCHED', 'QUALIFIED', 'DISQUALIFIED', 'CONTACTED', 'REPLIED', 'INTERESTED', 'MEETING_BOOKED', 'NOT_INTERESTED', 'CUSTOMER', 'UNSUBSCRIBED', 'BOUNCED'] as const;
export const LAWFUL_BASES = ['UNKNOWN', 'CONSENT', 'LEGITIMATE_INTEREST', 'EXISTING_RELATIONSHIP', 'NOT_REQUIRED'] as const;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();
/** Canonical key used for exact profile deduplication, never fuzzy name matching. */
export function canonicalLinkedInProfile(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const value = raw.trim();
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/in\/([^/]+)\/?$/i);
    if (!match?.[1]) return null;
    const slug = decodeURIComponent(match[1]).normalize('NFKC').trim().toLowerCase();
    return slug ? `linkedin.com/in/${slug}` : null;
  } catch { return null; }
}
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
export const isValidEmail = (e: string) => EMAIL_RE.test(e.trim());

export function domainFromUrlOrEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (s.includes('@') && !s.includes('/')) return s.split('@')[1] ?? null;
  try { return new URL(s.startsWith('http') ? s : `https://${s}`).hostname.replace(/^www\./, ''); } catch { return null; }
}

const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'yandex.com', 'mail.com', 'zoho.com']);

export const LeadInputSchema = z.object({
  email: z.string().refine(isValidEmail, 'Invalid email address'),
  firstName: z.string().max(100).nullable().optional(),
  lastName: z.string().max(100).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  linkedinUrl: z.string().url().nullable().optional().or(z.literal('').transform(() => null)),
  website: z.string().max(300).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  country: z.string().length(2).toUpperCase().nullable().optional().or(z.literal('').transform(() => null)),
  city: z.string().max(100).nullable().optional(),
  timezone: z.string().max(60).nullable().optional(),
  companyName: z.string().max(200).nullable().optional(),
  companyDomain: z.string().max(200).nullable().optional(),
  lawfulBasis: z.enum(LAWFUL_BASES).optional(),
  lawfulBasisNote: z.string().max(500).nullable().optional(),
  tags: z.array(z.string().max(50)).max(30).optional(),
  customFields: z.record(z.string(), z.string()).optional(),
  ownerId: z.string().uuid().nullable().optional(),
});
export type LeadInput = z.infer<typeof LeadInputSchema>;

export async function upsertCompany(workspaceId: string, name: string | null | undefined, domainHint: string | null | undefined, extra: Partial<Prisma.CompanyUncheckedCreateInput> = {}) {
  const domain = domainFromUrlOrEmail(domainHint);
  if (!name && !domain) return null;
  if (domain && FREE_MAIL.has(domain)) {
    if (!name) return null;
    const existing = await db().company.findFirst({ where: { workspaceId, name, domain: null } });
    return existing ?? db().company.create({ data: { workspaceId, name, ...extra } });
  }
  if (domain) {
    const args = {
      where: { workspaceId_domain: { workspaceId, domain } },
      update: { ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== null && v !== undefined)) },
      create: { workspaceId, name: name || domain, domain, website: `https://${domain}`, ...extra },
    };
    try {
      return await db().company.upsert(args);
    } catch (e) {
      // Two leads from the same company created at the same moment: the loser of the insert race
      // retries once and finds the row the winner created (found by the v1.4 load test).
      if ((e as { code?: string }).code !== 'P2002') throw e;
      return db().company.upsert(args);
    }
  }
  const existing = await db().company.findFirst({ where: { workspaceId, name: name!, domain: null } });
  return existing ?? db().company.create({ data: { workspaceId, name: name!, ...extra } });
}

export async function createLead(workspaceId: string, input: LeadInput, actor: Actor, sourceId?: string) {
  await (await import('./entitlements.js')).ws.quota(workspaceId, 'leads');
  const emailNormalized = normalizeEmail(input.email);
  const company = await upsertCompany(workspaceId, input.companyName, input.companyDomain ?? input.website ?? emailNormalized);
  try {
    const lead = await db().lead.create({
      data: {
        workspaceId, email: input.email.trim(), emailNormalized, firstName: input.firstName, lastName: input.lastName, title: input.title,
        linkedinUrl: input.linkedinUrl, website: input.website, phone: input.phone, country: input.country, city: input.city, timezone: input.timezone,
        lawfulBasis: input.lawfulBasis ?? 'UNKNOWN', lawfulBasisNote: input.lawfulBasisNote, tags: input.tags ?? [],
        customFields: (input.customFields ?? {}) as Prisma.InputJsonValue, companyId: company?.id, sourceId, ownerId: input.ownerId ?? null,
        statusChanges: { create: { workspaceId, toStatus: 'NEW', reason: 'created', actorUserId: actor.userId ?? null } },
      },
    });
    await audit(workspaceId, actor, 'lead.created', { type: 'lead', id: lead.id });
    await emitEvent(workspaceId, 'lead.created', `${lead.id}:created`, { leadId: lead.id });
    return lead;
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new AppError('CONFLICT', 'A lead with this email already exists in this workspace', 409);
    throw e;
  }
}

export const QualificationReviewSchema = z.enum(['QUALIFIED', 'NEEDS_REVIEW', 'DISQUALIFIED']);

export const LeadQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  listId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  qualificationReview: QualificationReviewSchema.optional(),
  research: z.enum(['NOT_RESEARCHED', 'FAILED']).optional(),
  selectedIds: z.string().max(7400).transform(value => value.split(',')).pipe(z.array(z.uuid()).min(1).max(200)).optional(),
  verification: z.enum(['UNVERIFIED', 'VALID', 'INVALID', 'RISKY', 'CATCH_ALL', 'UNKNOWN']).optional(),
  minScore: z.coerce.number().int().optional(),
  country: z.string().optional(),
  tag: z.string().optional(),
  sort: z.enum(['createdAt', 'score', 'lastRepliedAt', 'email']).default('createdAt'),
});

export function leadWhere(workspaceId: string, q: Partial<z.infer<typeof LeadQuerySchema>>): Prisma.LeadWhereInput {
  return {
    workspaceId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.companyId ? { companyId: q.companyId } : {}),
    ...(q.selectedIds ? { id: { in: q.selectedIds } } : {}),
    ...(q.qualificationReview === 'NEEDS_REVIEW'
      ? { AND: [{ OR: [{ qualificationReview: null }, { qualificationReview: 'NEEDS_REVIEW' }] }] }
      : q.qualificationReview ? { qualificationReview: q.qualificationReview } : {}),
    ...(q.research === 'NOT_RESEARCHED' ? { researchReports: { none: { status: 'COMPLETED' } } }
      : q.research === 'FAILED' ? { researchReports: { some: { status: 'FAILED' }, none: { status: 'COMPLETED' } } } : {}),
    ...(q.verification ? { emailVerificationStatus: q.verification } : {}),
    ...(q.minScore !== undefined ? { currentScore: { gte: q.minScore } } : {}),
    ...(q.country ? { country: q.country.toUpperCase() } : {}),
    ...(q.tag ? { tags: { has: q.tag } } : {}),
    ...(q.listId ? { listMembers: { some: { listId: q.listId } } } : {}),
    ...(q.q ? { OR: [
      { emailNormalized: { contains: q.q.toLowerCase() } },
      { firstName: { contains: q.q, mode: 'insensitive' } },
      { lastName: { contains: q.q, mode: 'insensitive' } },
      { company: { name: { contains: q.q, mode: 'insensitive' } } },
    ] } : {}),
  };
}

export async function listLeads(workspaceId: string, q: z.infer<typeof LeadQuerySchema>) {
  const where = leadWhere(workspaceId, q);
  const orderBy: Prisma.LeadOrderByWithRelationInput =
    q.sort === 'score' ? { currentScore: { sort: 'desc', nulls: 'last' } } : q.sort === 'lastRepliedAt' ? { lastRepliedAt: { sort: 'desc', nulls: 'last' } } : q.sort === 'email' ? { emailNormalized: 'asc' } : { createdAt: 'desc' };
  const [items, total] = await Promise.all([
    db().lead.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { company: { select: { id: true, name: true, domain: true } }, source: { select: { name: true } }, verifications: { where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 1, select: { result: true, provider: true, createdAt: true } } } }),
    db().lead.count({ where }),
  ]);
  return { items, total };
}

export async function getLead(workspaceId: string, id: string) {
  const lead = await db().lead.findFirst({
    where: { id, workspaceId },
    include: {
      company: true, source: true, owner: { select: { id: true, name: true, email: true } },
      statusChanges: { orderBy: { createdAt: 'desc' }, take: 50 },
      verifications: { orderBy: { createdAt: 'desc' }, take: 5 },
      scores: { orderBy: { createdAt: 'desc' }, take: 5, include: { icp: { select: { name: true } } } },
      researchReports: { orderBy: { createdAt: 'desc' }, take: 3, include: { claims: { include: { evidence: { select: { url: true, title: true } } } } } },
      listMembers: { include: { list: { select: { id: true, name: true } } } },
      enrollments: { include: { campaign: { select: { id: true, name: true, status: true } }, emailAccount: { select: { emailAddress: true } } } },
      conversations: { orderBy: { lastMessageAt: 'desc' }, take: 20, select: { id: true, subject: true, category: true, lastMessageAt: true, status: true } },
      opportunities: true,
      notes: { orderBy: { createdAt: 'desc' }, include: { author: { select: { name: true } } } },
      tasks: { orderBy: { dueAt: 'asc' } },
      events: { orderBy: { occurredAt: 'desc' }, take: 50 },
    },
  });
  if (!lead) throw NotFound('Lead');
  const tracking = await trackingTotals(workspaceId, 'prospect', lead.id);
  return { ...lead, lifetimeTracking: tracking.get(lead.id) ?? emptyTracking };
}

export async function setLeadStatus(workspaceId: string, leadId: string, status: (typeof LEAD_STATUSES)[number], reason: string, actor: Actor) {
  const lead = await db().lead.findFirst({ where: { id: leadId, workspaceId } });
  if (!lead) throw NotFound('Lead');
  if (lead.status === status) return lead;
  const updated = await db().$transaction(async (tx) => {
    const l = await tx.lead.update({ where: { id: leadId }, data: { status } });
    await tx.leadStatusChange.create({ data: { workspaceId, leadId, fromStatus: lead.status, toStatus: status, reason, actorUserId: actor.userId ?? null } });
    return l;
  });
  // Converted or otherwise ineligible contacts stop all sequences.
  if (['CUSTOMER', 'DISQUALIFIED', 'NOT_INTERESTED', 'UNSUBSCRIBED', 'BOUNCED'].includes(status)) {
    const { stopEnrollmentsForLead } = await import('./engine.js');
    await stopEnrollmentsForLead(workspaceId, leadId, 'STOPPED_INELIGIBLE', `lead status ${status}`);
  }
  await emitEvent(workspaceId, 'lead.status_changed', `${leadId}:${status}:${Date.now()}`, { leadId, from: lead.status, to: status });
  await publish(workspaceId, 'lead.updated', { leadId });
  return updated;
}

export async function updateLead(workspaceId: string, id: string, input: Partial<LeadInput> & { status?: (typeof LEAD_STATUSES)[number] }, actor: Actor) {
  const lead = await db().lead.findFirst({ where: { id, workspaceId } });
  if (!lead) throw NotFound('Lead');
  const company = input.companyName !== undefined || input.companyDomain !== undefined
    ? await upsertCompany(workspaceId, input.companyName, input.companyDomain ?? lead.emailNormalized) : undefined;
  if (input.ownerId) {
    const m = await db().workspaceMember.findFirst({ where: { workspaceId, userId: input.ownerId } });
    if (!m) throw BadRequest('VALIDATION_FAILED', 'Owner must be a workspace member');
  }
  const { status, companyName: _c, companyDomain: _d, customFields, email, ...rest } = input;
  const updated = await db().lead.update({
    where: { id },
    data: {
      ...rest,
      ...(email && normalizeEmail(email) !== lead.emailNormalized ? { email: email.trim(), emailNormalized: normalizeEmail(email), emailVerificationStatus: 'UNVERIFIED', emailVerifiedAt: null } : {}),
      ...(customFields ? { customFields: customFields as Prisma.InputJsonValue } : {}),
      ...(company !== undefined ? { companyId: company?.id ?? null } : {}),
    },
  });
  if (status) await setLeadStatus(workspaceId, id, status, 'manual update', actor);
  await audit(workspaceId, actor, 'lead.updated', { type: 'lead', id }, { fields: Object.keys(input) });
  return updated;
}

export async function deleteLeads(workspaceId: string, ids: string[], actor: Actor) {
  const r = await db().lead.deleteMany({ where: { workspaceId, id: { in: ids } } });
  await audit(workspaceId, actor, 'lead.deleted', undefined, { count: r.count });
  return r.count;
}

export const BulkActionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(5000),
  action: z.enum(['add_to_list', 'remove_from_list', 'add_tag', 'set_status', 'set_lawful_basis', 'research', 'retry_research', 'score', 'verify', 'review_qualification', 'delete']),
  listId: z.string().uuid().optional(),
  tag: z.string().max(50).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  lawfulBasis: z.enum(LAWFUL_BASES).optional(),
  review: QualificationReviewSchema.optional(),
  reviewReason: z.string().trim().min(3).max(500).optional(),
  icpId: z.string().uuid().optional(),
});

export async function bulkAction(workspaceId: string, input: z.infer<typeof BulkActionSchema>, actor: Actor) {
  const leads = await db().lead.findMany({ where: { workspaceId, id: { in: input.ids } }, select: { id: true } });
  const ids = leads.map((l) => l.id);
  switch (input.action) {
    case 'add_to_list': {
      if (!input.listId) throw BadRequest('VALIDATION_FAILED', 'listId required');
      const list = await db().leadList.findFirst({ where: { id: input.listId, workspaceId } });
      if (!list) throw NotFound('List');
      const r = await db().leadListMember.createMany({ data: ids.map((leadId) => ({ workspaceId, listId: list.id, leadId })), skipDuplicates: true });
      return { affected: r.count };
    }
    case 'remove_from_list': {
      if (!input.listId) throw BadRequest('VALIDATION_FAILED', 'listId required');
      const r = await db().leadListMember.deleteMany({ where: { workspaceId, listId: input.listId, leadId: { in: ids } } });
      return { affected: r.count };
    }
    case 'add_tag': {
      if (!input.tag) throw BadRequest('VALIDATION_FAILED', 'tag required');
      const r = await db().$executeRaw`UPDATE "Lead" SET tags = array_append(tags, ${input.tag}) WHERE "workspaceId" = ${workspaceId}::uuid AND id = ANY(${ids}::uuid[]) AND NOT (${input.tag} = ANY(tags))`;
      return { affected: r };
    }
    case 'set_status': {
      if (!input.status) throw BadRequest('VALIDATION_FAILED', 'status required');
      for (const id of ids) await setLeadStatus(workspaceId, id, input.status, 'bulk update', actor);
      return { affected: ids.length };
    }
    case 'set_lawful_basis': {
      if (!input.lawfulBasis) throw BadRequest('VALIDATION_FAILED', 'lawfulBasis required');
      const r = await db().lead.updateMany({ where: { workspaceId, id: { in: ids } }, data: { lawfulBasis: input.lawfulBasis } });
      await audit(workspaceId, actor, 'lead.lawful_basis_set', undefined, { count: r.count, basis: input.lawfulBasis });
      return { affected: r.count };
    }
    case 'research':
      for (const id of ids) await enqueue(QUEUES.research, 'research.lead', { workspaceId, leadId: id }, { jobId: `research-${id}-${Math.floor(Date.now() / 60000)}` });
      return { queued: ids.length };
    case 'retry_research': {
      const intel = await import('./intelligence.js');
      for (const id of ids) {
        const report = await db().researchReport.findFirst({
          where: { workspaceId, leadId: id, status: { in: ['FAILED', 'COMPLETED'] } },
          orderBy: { createdAt: 'desc' }, select: { id: true },
        });
        await intel.queueResearch(workspaceId, { leadId: id }, { retryMissing: !!report, retryReportId: report?.id });
      }
      return { queued: ids.length };
    }
    case 'score':
      for (const id of ids) await enqueue(QUEUES.ai, 'ai.qualify', { workspaceId, leadId: id, icpId: input.icpId ?? null });
      return { queued: ids.length };
    case 'verify':
      for (const id of ids) await enqueue(QUEUES.verify, 'verify.lead', { workspaceId, leadId: id });
      return { queued: ids.length };
    case 'review_qualification': {
      if (!input.review || !input.reviewReason) throw BadRequest('VALIDATION_FAILED', 'Select a review decision and provide a reason.');
      const decision = input.review;
      const reason = input.reviewReason;
      if (ids.length !== new Set(input.ids).size) throw NotFound('Lead');
      const reviewed = await db().$transaction(async tx => {
        const rows = await tx.lead.findMany({
          where: { workspaceId, id: { in: ids } },
          select: { id: true, qualificationReview: true, scores: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } },
        });
        for (const row of rows) {
          const score = row.scores[0];
          const verifiedIdentity = Array.isArray(score?.reasons) && score.reasons.some(entry =>
            entry && typeof entry === 'object' && !Array.isArray(entry) && entry.criterion === 'professional_identity'
              && entry.identityStatus === 'VERIFIED' && Array.isArray(entry.claimIds) && entry.claimIds.length > 0);
          if (decision === 'QUALIFIED' && (!score?.qualified || !verifiedIdentity)) {
            throw BadRequest('QUALIFICATION_REQUIRED', 'Each selected prospect needs a qualifying ICP score backed by verified identity evidence.');
          }
          await tx.lead.updateMany({
            where: { id: row.id, workspaceId },
            data: { qualificationReview: decision, qualificationReviewReason: reason, qualificationReviewScoreId: decision === 'QUALIFIED' ? score.id : null },
          });
        }
        return rows;
      });
      for (const row of reviewed) {
        await audit(workspaceId, actor, 'lead.qualification_reviewed', { type: 'lead', id: row.id }, { previous: row.qualificationReview, decision, reason });
        await publish(workspaceId, 'lead.updated', { leadId: row.id });
      }
      return { affected: reviewed.length };
    }
    case 'delete':
      return { affected: await deleteLeads(workspaceId, ids, actor) };
  }
}

// ---------------------------------------------------------------- lists

export async function listLists(workspaceId: string) {
  const lists = await db().leadList.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { members: true } } } });
  return lists.map((l) => ({ id: l.id, name: l.name, description: l.description, createdAt: l.createdAt, memberCount: l._count.members }));
}

export async function createList(workspaceId: string, input: { name: string; description?: string | null }, actor: Actor) {
  const l = await db().leadList.create({ data: { workspaceId, name: input.name, description: input.description ?? null } });
  await audit(workspaceId, actor, 'list.created', { type: 'list', id: l.id });
  return l;
}

export async function updateList(workspaceId: string, id: string, input: { name?: string; description?: string | null }) {
  const r = await db().leadList.updateMany({ where: { id, workspaceId }, data: input });
  if (!r.count) throw NotFound('List');
  return db().leadList.findUnique({ where: { id } });
}

export async function deleteList(workspaceId: string, id: string, actor: Actor) {
  const inUse = await db().campaignList.count({ where: { listId: id, workspaceId, campaign: { status: { in: ['RUNNING', 'APPROVED', 'PAUSED'] } } } });
  if (inUse) throw new AppError('CONFLICT', 'List is used by an active campaign', 409);
  const r = await db().leadList.deleteMany({ where: { id, workspaceId } });
  if (!r.count) throw NotFound('List');
  await audit(workspaceId, actor, 'list.deleted', { type: 'list', id });
}

// ---------------------------------------------------------------- companies

export async function listCompanies(workspaceId: string, q: { page: number; pageSize: number; q?: string }) {
  const where: Prisma.CompanyWhereInput = { workspaceId, ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { domain: { contains: q.q.toLowerCase() } }] } : {}) };
  const [items, total] = await Promise.all([
    db().company.findMany({ where, orderBy: { name: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { _count: { select: { leads: true } } } }),
    db().company.count({ where }),
  ]);
  return { items, total };
}

export async function getCompany(workspaceId: string, id: string) {
  const c = await db().company.findFirst({
    where: { id, workspaceId },
    include: {
      leads: { select: { id: true, email: true, firstName: true, lastName: true, title: true, status: true, currentScore: true } },
      researchReports: { orderBy: { createdAt: 'desc' }, take: 3, include: { claims: { include: { evidence: { select: { url: true, title: true } } } } } },
      opportunities: true,
      notes: { orderBy: { createdAt: 'desc' }, include: { author: { select: { name: true } } } },
    },
  });
  if (!c) throw NotFound('Company');
  return c;
}

export async function updateCompany(workspaceId: string, id: string, input: Partial<{ name: string; website: string | null; industry: string | null; employeeCount: number | null; country: string | null; city: string | null; description: string | null }>, actor: Actor) {
  const r = await db().company.updateMany({ where: { id, workspaceId }, data: input });
  if (!r.count) throw NotFound('Company');
  await audit(workspaceId, actor, 'company.updated', { type: 'company', id });
  return db().company.findUnique({ where: { id } });
}

// ---------------------------------------------------------------- notes

export async function addNote(workspaceId: string, target: { leadId?: string; companyId?: string; conversationId?: string }, body: string, actor: Actor) {
  if (target.leadId && !(await db().lead.findFirst({ where: { id: target.leadId, workspaceId } }))) throw NotFound('Lead');
  if (target.companyId && !(await db().company.findFirst({ where: { id: target.companyId, workspaceId } }))) throw NotFound('Company');
  if (target.conversationId && !(await db().conversation.findFirst({ where: { id: target.conversationId, workspaceId } }))) throw NotFound('Conversation');
  return db().note.create({ data: { workspaceId, ...target, body, authorId: actor.userId ?? null } });
}

export async function deleteNote(workspaceId: string, id: string) {
  const r = await db().note.deleteMany({ where: { id, workspaceId } });
  if (!r.count) throw NotFound('Note');
}

// ---------------------------------------------------------------- CSV import / export

const IMPORT_FIELDS = ['email', 'firstName', 'lastName', 'fullName', 'title', 'companyName', 'companyDomain', 'website', 'linkedinUrl', 'phone', 'country', 'city', 'timezone', 'tags'] as const;
export const ImportMappingSchema = z.record(z.string(), z.enum([...IMPORT_FIELDS, 'ignore'] as [string, ...string[]]).or(z.string().regex(/^custom\.[a-zA-Z0-9_]+$/)));

export async function uploadImport(workspaceId: string, file: { originalname: string; buffer: Buffer }, actor: Actor) {
  if (file.buffer.length > 20 * 1024 * 1024) throw BadRequest('VALIDATION_FAILED', 'CSV must be 20 MB or smaller');
  let rows: string[][];
  try {
    rows = parse(file.buffer, { bom: true, skip_empty_lines: true, to_line: 6, relax_column_count: true }) as string[][];
  } catch (e) {
    throw BadRequest('VALIDATION_FAILED', `Could not parse CSV: ${(e as Error).message}`);
  }
  if (rows.length === 0) throw BadRequest('VALIDATION_FAILED', 'CSV is empty');
  const headers = rows[0].map((h) => h.trim());
  const key = await (await import('./storage-accounting.js')).putTracked(workspaceId, 'imports', file.buffer, 'csv', { enforce: true });
  const guess: Record<string, string> = {};
  for (const h of headers) {
    const n = h.toLowerCase().replace(/[^a-z]/g, '');
    const map: Record<string, string> = { email: 'email', emailaddress: 'email', workemail: 'email', firstname: 'firstName', first: 'firstName', lastname: 'lastName', last: 'lastName', fullname: 'fullName', name: 'fullName', title: 'title', jobtitle: 'title', company: 'companyName', companyname: 'companyName', organization: 'companyName', domain: 'companyDomain', companydomain: 'companyDomain', website: 'website', companywebsite: 'website', youtube: 'custom.youtubeUrl', youtubeurl: 'custom.youtubeUrl', instagramurl: 'custom.instagramUrl', facebookurl: 'custom.facebookUrl', socialurl: 'custom.socialUrl', transcripturl: 'custom.transcriptUrl', profileurl: 'custom.publicProfileUrl', publicprofileurl: 'custom.publicProfileUrl', notes: 'custom.notes', additionalnotes: 'custom.notes', linkedin: 'linkedinUrl', linkedinurl: 'linkedinUrl', phone: 'phone', country: 'country', city: 'city', timezone: 'timezone', tags: 'tags' };
    guess[h] = map[n] ?? 'ignore';
  }
  const job = await db().importJob.create({ data: { workspaceId, fileName: file.originalname.slice(0, 200), storageKey: key, headers, mapping: guess, createdById: actor.userId ?? null } });
  await audit(workspaceId, actor, 'import.uploaded', { type: 'import', id: job.id }, { file: file.originalname });
  return { importId: job.id, headers, sampleRows: rows.slice(1, 6), suggestedMapping: guess };
}

export const StartImportSchema = z.object({
  mapping: ImportMappingSchema,
  dedupeMode: z.enum(['skip', 'update']).default('skip'),
  targetListId: z.string().uuid().nullable().optional(),
  newListName: z.string().max(100).optional(),
  sourceName: z.string().min(1).max(100).default('CSV import'),
  lawfulBasis: z.enum(LAWFUL_BASES).default('UNKNOWN'),
  lawfulBasisNote: z.string().max(500).optional(),
  defaultCountry: z.string().length(2).toUpperCase().optional(),
});

export async function startImport(workspaceId: string, importId: string, input: z.infer<typeof StartImportSchema>, actor: Actor) {
  const job = await db().importJob.findFirst({ where: { id: importId, workspaceId } });
  if (!job) throw NotFound('Import');
  if (job.status !== 'PENDING') throw new AppError('CONFLICT', 'Import already started', 409);
  const fields = new Set(Object.values(input.mapping));
  const mapsName = fields.has('fullName') || (fields.has('firstName') && fields.has('lastName'));
  const mapsSource = ['companyDomain', 'website', 'custom.publicProfileUrl'].some((field) => fields.has(field));
  if (!fields.has('email') && !(mapsName && mapsSource)) throw BadRequest('VALIDATION_FAILED', 'Map an email, or map a full name and a company website or public profile URL for research.');
  let targetListId = input.targetListId ?? null;
  if (targetListId && !(await db().leadList.findFirst({ where: { id: targetListId, workspaceId } }))) throw NotFound('List');
  if (!targetListId && input.newListName) targetListId = (await createList(workspaceId, { name: input.newListName }, actor)).id;
  await db().importJob.update({ where: { id: job.id }, data: { mapping: input.mapping, targetListId, options: { dedupeMode: input.dedupeMode, sourceName: input.sourceName, lawfulBasis: input.lawfulBasis, lawfulBasisNote: input.lawfulBasisNote ?? null, defaultCountry: input.defaultCountry ?? null } } });
  await enqueue(QUEUES.imports, 'import.csv', { workspaceId, importId: job.id }, { jobId: `import-${job.id}`, attempts: 1 });
  return { importId: job.id, status: 'queued' };
}

const ImportErrorSchema = z.object({ row: z.number().int().min(2), error: z.string(), retryable: z.boolean().optional() });

export async function retryImport(workspaceId: string, importId: string, actor: Actor) {
  const job = await db().importJob.findFirst({ where: { workspaceId, id: importId } });
  if (!job) throw NotFound('Import');
  if (job.status !== 'COMPLETED' && job.status !== 'FAILED') throw new AppError('CONFLICT', 'This import is still pending or running.', 409);
  const previousOptions = job.options as Record<string, Prisma.InputJsonValue>;
  if (!previousOptions.sourceName) throw new AppError('CONFLICT', 'The import does not have saved mapping options.', 409);
  const errors = z.array(ImportErrorSchema).safeParse(job.errors);
  const rows = errors.success ? errors.data.filter(error => error.retryable).map(error => error.row) : [];
  if (job.status === 'COMPLETED' && !rows.length) throw new AppError('CONFLICT', 'No retryable rows. Correct invalid data in the source file and import it again.', 409);
  const retryRows = job.status === 'COMPLETED' ? rows : previousOptions.retryRows;
  const options = { ...previousOptions, dedupeMode: 'skip', ...(retryRows ? { retryRows } : {}) };
  const claimed = await db().importJob.updateMany({
    where: { workspaceId, id: importId, status: job.status, finishedAt: job.finishedAt },
    data: { status: 'PENDING', options },
  });
  if (!claimed.count) throw new AppError('CONFLICT', 'This import already changed. Refresh its status.', 409);
  try {
    await enqueue(QUEUES.imports, 'import.csv', { workspaceId, importId }, { jobId: `import-retry-${importId}-${Date.now()}`, attempts: 1 });
  } catch (error) {
    await db().importJob.updateMany({ where: { workspaceId, id: importId, status: 'PENDING' }, data: { status: job.status, options: previousOptions } });
    throw error;
  }
  await audit(workspaceId, actor, 'import.retried', { type: 'import', id: importId }, { targetedRows: Array.isArray(retryRows) ? retryRows.length : null });
  return { importId, status: 'queued' };
}

/** Worker: process an import job in batches. */
export async function processImport(workspaceId: string, importId: string) {
  const release = await acquireLock(`import-csv:${workspaceId}:${importId}`, 15 * 60_000);
  if (!release) return;
  try {
    return await processImportRows(workspaceId, importId);
  } catch (error) {
    await db().importJob.updateMany({
      where: { workspaceId, id: importId, status: 'RUNNING' },
      data: { status: 'FAILED', finishedAt: new Date() },
    });
    throw error;
  } finally {
    await release();
  }
}

async function processImportRows(workspaceId: string, importId: string) {
  const job = await db().importJob.findFirst({ where: { id: importId, workspaceId } });
  if (!job || job.status === 'COMPLETED') return;
  await db().importJob.update({ where: { id: job.id }, data: { status: 'RUNNING' } });
  const opts = job.options as { dedupeMode: 'skip' | 'update'; sourceName: string; lawfulBasis: (typeof LAWFUL_BASES)[number]; lawfulBasisNote: string | null; defaultCountry: string | null; retryRows?: number[] };
  const mapping = job.mapping as Record<string, string>;
  const source = await db().leadSource.upsert({ where: { workspaceId_name: { workspaceId, name: opts.sourceName } }, update: {}, create: { workspaceId, name: opts.sourceName, type: 'CSV_IMPORT', provider: 'csv' } });
  const records = parse(await store().get(job.storageKey), { bom: true, columns: true, skip_empty_lines: true, relax_column_count: true, trim: true }) as Record<string, string>[];
  const targeted = opts.retryRows ? new Set(opts.retryRows) : null;
  const prior = z.array(ImportErrorSchema).safeParse(job.errors);
  const errors = targeted && prior.success ? prior.data.filter(error => !targeted.has(error.row)) : [];
  const counters = targeted ? {
    imported: job.importedRows, updated: job.updatedRows, skipped: job.skippedRows, errors: Math.max(0, job.errorRows - targeted.size),
  } : { imported: 0, updated: 0, skipped: 0, errors: 0 };
  // Plan lead limit: computed once, then counted down locally (no per-row count queries).
  const { ws: ent } = await import('./entitlements.js');
  const tstate = await ent.state(workspaceId);
  let leadRoom = tstate.entitlements.maxLeads >= 1e9 ? Number.POSITIVE_INFINITY : Math.max(0, tstate.entitlements.maxLeads - (await db().lead.count({ where: { workspace: { organizationId: tstate.organizationId } } })));
  const seen = new Set<string>();
  const suppressed = new Set((await db().suppressionEntry.findMany({ where: { workspaceId, type: 'EMAIL' }, select: { value: true } })).map((s) => s.value));

  for (let i = 0; i < records.length; i++) {
    if (targeted && !targeted.has(i + 2)) continue;
    const rec = records[i];
    const row: Record<string, string> = {};
    const custom: Record<string, string> = {};
    for (const [col, field] of Object.entries(mapping)) {
      const v = (rec[col] ?? '').trim();
      if (!v || field === 'ignore') continue;
      if (field.startsWith('custom.')) custom[field.slice(7)] = v; else row[field] = v;
    }
    if (row.fullName) {
      const [firstName, ...rest] = row.fullName.split(/\s+/);
      row.firstName ??= firstName;
      if (rest.length) row.lastName ??= rest.join(' ');
    }
    const email = normalizeEmail(row.email ?? '');
    const companySource = row.companyDomain ?? row.website;
    const researchSource = companySource ?? custom.publicProfileUrl;
    const researchOnly = !email && !!(row.firstName && row.lastName && researchSource);
    if (!researchOnly && !isValidEmail(email)) {
      counters.errors++;
      if (errors.length < 200) errors.push({ row: i + 2, error: email ? 'invalid email' : 'missing email or name and public source for research' });
      continue;
    }
    const key = researchOnly
      ? `research-only:${sha256(JSON.stringify([row.firstName, row.lastName, researchSource, custom.publicProfileUrl, row.linkedinUrl].map((value) => value?.trim().toLowerCase() ?? null)))}`
      : email;
    if (seen.has(key)) { counters.skipped++; continue; }
    seen.add(key);
    if (email && suppressed.has(email)) { counters.skipped++; if (errors.length < 200) errors.push({ row: i + 2, error: 'email is on the suppression list' }); continue; }
    try {
      const existing = await db().lead.findUnique({ where: { workspaceId_emailNormalized: { workspaceId, emailNormalized: key } } });
      const country = (row.country ?? opts.defaultCountry ?? '').toUpperCase().slice(0, 2) || null;
      let leadId: string;
      let outcome: 'imported' | 'updated' | 'skipped';
      if (existing) {
        if (opts.dedupeMode === 'skip') { outcome = 'skipped'; leadId = existing.id; }
        else {
          const previousCustom = existing.customFields && typeof existing.customFields === 'object' && !Array.isArray(existing.customFields)
            ? existing.customFields : {};
          await db().lead.update({ where: { id: existing.id }, data: {
            firstName: row.firstName, lastName: row.lastName, title: row.title, country: country ?? undefined,
            city: row.city, phone: row.phone, linkedinUrl: row.linkedinUrl, website: row.website,
            ...(Object.keys(custom).length ? { customFields: { ...previousCustom, ...custom } } : {}),
          } });
          outcome = 'updated'; leadId = existing.id;
        }
      } else {
        if (leadRoom <= 0) { counters.skipped++; if (errors.length < 500) errors.push({ row: i + 2, error: 'Plan lead limit reached — upgrade to import more' }); continue; }
        leadRoom--;
        const company = await upsertCompany(workspaceId, row.companyName, companySource ?? email);
        const lead = await db().lead.create({
          data: {
            workspaceId, email, emailNormalized: key, ...(researchOnly ? { emailVerificationStatus: 'INVALID' as const } : {}), firstName: row.firstName, lastName: row.lastName, title: row.title, website: row.website,
            linkedinUrl: row.linkedinUrl, phone: row.phone, country, city: row.city, timezone: row.timezone,
            tags: row.tags ? row.tags.split(/[;,]/).map((t) => t.trim()).filter(Boolean) : [], customFields: custom,
            lawfulBasis: researchOnly ? 'UNKNOWN' : opts.lawfulBasis, lawfulBasisNote: researchOnly ? null : opts.lawfulBasisNote, sourceId: source.id, companyId: company?.id,
            statusChanges: { create: { workspaceId, toStatus: 'NEW', reason: `import ${job.fileName}` } },
          },
        });
        outcome = 'imported'; leadId = lead.id;
      }
      if (job.targetListId) await db().leadListMember.createMany({ data: [{ workspaceId, listId: job.targetListId, leadId }], skipDuplicates: true });
      counters[outcome]++;
    } catch {
      counters.errors++;
      if (errors.length < 200) errors.push({ row: i + 2, error: 'The row could not be saved. Retry the import row.', retryable: true });
    }
    if (!targeted && i % 200 === 0) {
      await db().importJob.update({ where: { id: job.id }, data: { totalRows: records.length, importedRows: counters.imported, updatedRows: counters.updated, skippedRows: counters.skipped, errorRows: counters.errors } });
      await publish(workspaceId, 'import.progress', { importId, processed: i + 1, total: records.length });
    }
  }
  await db().importJob.update({
    where: { id: job.id },
    data: { status: 'COMPLETED', finishedAt: new Date(), totalRows: records.length, importedRows: counters.imported, updatedRows: counters.updated, skippedRows: counters.skipped, errorRows: counters.errors, errors, options: { ...opts, retryRows: null } as Prisma.InputJsonValue },
  });
  await publish(workspaceId, 'import.completed', { importId, ...counters });
  return counters;
}

export async function exportLeadsCsv(workspaceId: string, q: Partial<z.infer<typeof LeadQuerySchema>>, actor: Actor) {
  const leads = await db().lead.findMany({ where: leadWhere(workspaceId, q), include: { company: true, source: true }, orderBy: { createdAt: 'asc' }, take: 100_000 });
  const safe = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // CSV formula-injection guard
  };
  const rows = leads.map((l) => [l.email, l.firstName, l.lastName, l.title, l.company?.name, l.company?.domain, l.country, l.city, l.status, l.emailVerificationStatus, l.currentScore, l.qualificationReview, l.qualificationReviewReason, l.lawfulBasis, l.source?.name, l.tags.join(';'), l.createdAt.toISOString()].map(safe));
  await audit(workspaceId, actor, 'lead.exported', undefined, { count: leads.length });
  return stringify([['email', 'firstName', 'lastName', 'title', 'company', 'companyDomain', 'country', 'city', 'status', 'verification', 'score', 'qualificationReview', 'qualificationReviewReason', 'lawfulBasis', 'source', 'tags', 'createdAt'], ...rows]);
}

export async function getImport(workspaceId: string, id: string) {
  const j = await db().importJob.findFirst({ where: { id, workspaceId } });
  if (!j) throw NotFound('Import');
  return j;
}

export async function listImports(workspaceId: string) {
  return db().importJob.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 50 });
}
