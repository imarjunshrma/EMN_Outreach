import { z } from 'zod';
import { db } from '../core/db.js';
import { NotFound } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { emitEvent } from './automation.js';
import { setLeadStatus } from './leads.js';

export const STAGES = ['NEW', 'QUALIFIED', 'MEETING', 'PROPOSAL', 'WON', 'LOST'] as const;

export const OpportunitySchema = z.object({
  leadId: z.string().uuid(),
  title: z.string().min(1).max(200),
  stage: z.enum(STAGES).default('NEW'),
  valueCents: z.number().int().min(0).default(0),
  currency: z.string().length(3).toUpperCase().default('USD'),
  expectedCloseAt: z.coerce.date().nullable().optional(),
  campaignId: z.string().uuid().nullable().optional(),
});

export async function pipeline(workspaceId: string) {
  const opps = await db().opportunity.findMany({ where: { workspaceId }, orderBy: { updatedAt: 'desc' }, include: { lead: { select: { id: true, email: true, firstName: true, lastName: true } }, company: { select: { name: true } }, campaign: { select: { id: true, name: true } } } });
  const columns = STAGES.map((stage) => {
    const items = opps.filter((o) => o.stage === stage);
    return { stage, count: items.length, valueCents: items.reduce((s, o) => s + o.valueCents, 0), items };
  });
  return { columns, note: 'Values are user-entered opportunity values (not measured revenue).' };
}

export async function createOpportunity(workspaceId: string, input: z.infer<typeof OpportunitySchema>, actor: Actor) {
  const lead = await db().lead.findFirst({ where: { id: input.leadId, workspaceId } });
  if (!lead) throw NotFound('Lead');
  if (input.campaignId && !(await db().campaign.findFirst({ where: { id: input.campaignId, workspaceId } }))) throw NotFound('Campaign');
  const attributed = input.campaignId ?? (await db().sequenceEnrollment.findFirst({ where: { leadId: lead.id }, orderBy: { enrolledAt: 'desc' } }))?.campaignId ?? null;
  const o = await db().opportunity.create({ data: { workspaceId, leadId: lead.id, companyId: lead.companyId, campaignId: attributed, title: input.title, stage: input.stage, valueCents: input.valueCents, currency: input.currency, expectedCloseAt: input.expectedCloseAt ?? null } });
  await audit(workspaceId, actor, 'opportunity.created', { type: 'opportunity', id: o.id });
  return o;
}

export async function updateOpportunity(workspaceId: string, id: string, input: Partial<z.infer<typeof OpportunitySchema>>, actor: Actor) {
  const o = await db().opportunity.findFirst({ where: { id, workspaceId } });
  if (!o) throw NotFound('Opportunity');
  const { leadId: _l, ...rest } = input;
  const closing = input.stage && ['WON', 'LOST'].includes(input.stage) && !['WON', 'LOST'].includes(o.stage);
  const updated = await db().opportunity.update({ where: { id }, data: { ...rest, ...(closing ? { closedAt: new Date() } : {}) } });
  if (input.stage && input.stage !== o.stage) {
    await emitEvent(workspaceId, 'opportunity.stage_changed', `${id}:${input.stage}`, { opportunityId: id, leadId: o.leadId, from: o.stage, to: input.stage });
    if (input.stage === 'WON') await setLeadStatus(workspaceId, o.leadId, 'CUSTOMER', 'opportunity won', actor);
    if (input.stage === 'MEETING') {
      const lead = await db().lead.findUnique({ where: { id: o.leadId } });
      if (lead && !['CUSTOMER', 'MEETING_BOOKED'].includes(lead.status)) await setLeadStatus(workspaceId, o.leadId, 'MEETING_BOOKED', 'opportunity moved to meeting', actor);
    }
  }
  await audit(workspaceId, actor, 'opportunity.updated', { type: 'opportunity', id }, { fields: Object.keys(input) });
  return updated;
}

export async function deleteOpportunity(workspaceId: string, id: string, actor: Actor) {
  const r = await db().opportunity.deleteMany({ where: { id, workspaceId } });
  if (!r.count) throw NotFound('Opportunity');
  await audit(workspaceId, actor, 'opportunity.deleted', { type: 'opportunity', id });
}

// ---------------------------------------------------------------- tasks & reminders

export const TaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullable().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  dueAt: z.coerce.date().nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  leadId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
});

export async function listTasks(workspaceId: string, q: { status?: string; assigneeId?: string; due?: 'overdue' | 'today' | 'upcoming' }) {
  const now = new Date();
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
  return db().task.findMany({
    where: {
      workspaceId, ...(q.status ? { status: q.status as never } : { status: 'OPEN' }), ...(q.assigneeId ? { assigneeId: q.assigneeId } : {}),
      ...(q.due === 'overdue' ? { dueAt: { lt: now } } : q.due === 'today' ? { dueAt: { gte: now, lte: endOfDay } } : q.due === 'upcoming' ? { dueAt: { gt: endOfDay } } : {}),
    },
    orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
    include: { lead: { select: { id: true, email: true, firstName: true, lastName: true } }, assignee: { select: { id: true, name: true } } },
    take: 500,
  });
}

async function checkRefs(workspaceId: string, input: Partial<z.infer<typeof TaskSchema>>) {
  if (input.leadId && !(await db().lead.findFirst({ where: { id: input.leadId, workspaceId } }))) throw NotFound('Lead');
  if (input.conversationId && !(await db().conversation.findFirst({ where: { id: input.conversationId, workspaceId } }))) throw NotFound('Conversation');
  if (input.assigneeId && !(await db().workspaceMember.findFirst({ where: { userId: input.assigneeId, workspaceId } }))) throw NotFound('Member');
}

export async function createTask(workspaceId: string, input: z.infer<typeof TaskSchema>, actor: Actor) {
  await checkRefs(workspaceId, input);
  return db().task.create({ data: { workspaceId, ...input, assigneeId: input.assigneeId ?? actor.userId ?? null } });
}

export async function updateTask(workspaceId: string, id: string, input: Partial<z.infer<typeof TaskSchema>> & { status?: 'OPEN' | 'DONE' | 'CANCELLED' }, _actor: Actor) {
  await checkRefs(workspaceId, input);
  const t = await db().task.findFirst({ where: { id, workspaceId } });
  if (!t) throw NotFound('Task');
  return db().task.update({ where: { id }, data: { ...input, ...(input.status === 'DONE' && t.status !== 'DONE' ? { completedAt: new Date() } : {}) } });
}

export async function deleteTask(workspaceId: string, id: string) {
  const r = await db().task.deleteMany({ where: { id, workspaceId } });
  if (!r.count) throw NotFound('Task');
}

/** Worker: notify assignees of tasks that became due. */
export async function sendTaskReminders(now = new Date()) {
  const due = await db().task.findMany({ where: { status: 'OPEN', dueAt: { lte: now }, remindedAt: null, assigneeId: { not: null } }, take: 500 });
  for (const t of due) {
    await db().notification.create({ data: { workspaceId: t.workspaceId, userId: t.assigneeId!, type: 'task.due', title: `Task due: ${t.title}`, link: t.leadId ? `/leads/${t.leadId}` : '/tasks' } });
    await db().task.update({ where: { id: t.id }, data: { remindedAt: now } });
  }
  return due.length;
}
