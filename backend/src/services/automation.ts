import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit, notifyWorkspace, WORKER_ACTOR, type Actor } from '../core/audit.js';
import { enqueue, QUEUES } from '../core/queues.js';
import { logger } from '../core/logger.js';
import { ReplyCategoryValues } from '../../../shared/src/ai-schemas.js';

// Rule-based automation: trigger → conditions → actions. Deterministic code executes actions;
// AI output only feeds validated enum values into conditions.

export const TRIGGERS = ['reply.categorized', 'lead.scored', 'lead.status_changed'] as const;
export const WEBHOOK_EVENTS = ['reply.categorized', 'lead.scored', 'lead.status_changed', 'email.sent', 'email.bounced', 'lead.unsubscribed', 'meeting.booked', 'campaign.paused', 'opportunity.stage_changed'] as const;

const StatusEnum = z.enum(['NEW', 'RESEARCHED', 'QUALIFIED', 'DISQUALIFIED', 'CONTACTED', 'REPLIED', 'INTERESTED', 'MEETING_BOOKED', 'NOT_INTERESTED', 'CUSTOMER', 'UNSUBSCRIBED', 'BOUNCED']);

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_status'), status: StatusEnum }),
  z.object({ type: z.literal('add_to_list'), listId: z.string().uuid() }),
  z.object({ type: z.literal('create_task'), title: z.string().min(1).max(200), dueInDays: z.number().int().min(0).max(90).default(1) }),
  z.object({ type: z.literal('create_opportunity'), title: z.string().min(1).max(200), valueCents: z.number().int().min(0).default(0) }),
  z.object({ type: z.literal('notify'), title: z.string().min(1).max(200) }),
  z.object({ type: z.literal('enroll_campaign'), campaignId: z.string().uuid() }),
]);

export const RuleSchema = z.object({
  name: z.string().min(1).max(120),
  isEnabled: z.boolean().default(true),
  trigger: z.enum(TRIGGERS),
  conditions: z.object({
    categories: z.array(z.enum(ReplyCategoryValues)).optional(),
    minScore: z.number().int().min(0).max(100).optional(),
    maxScore: z.number().int().min(0).max(100).optional(),
    toStatuses: z.array(StatusEnum).optional(),
  }).default({}),
  actions: z.array(ActionSchema).min(1).max(10),
});

export async function listRules(workspaceId: string) {
  return db().automationRule.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { runs: true } } } });
}

async function validateRefs(workspaceId: string, actions: z.infer<typeof ActionSchema>[]) {
  for (const a of actions) {
    if (a.type === 'add_to_list' && !(await db().leadList.findFirst({ where: { id: a.listId, workspaceId } }))) throw NotFound('List');
    if (a.type === 'enroll_campaign' && !(await db().campaign.findFirst({ where: { id: a.campaignId, workspaceId } }))) throw NotFound('Campaign');
  }
}

export async function createRule(workspaceId: string, input: z.infer<typeof RuleSchema>, actor: Actor) {
  await validateRefs(workspaceId, input.actions);
  const r = await db().automationRule.create({ data: { workspaceId, name: input.name, isEnabled: input.isEnabled, trigger: input.trigger, conditions: input.conditions as Prisma.InputJsonValue, actions: input.actions as Prisma.InputJsonValue } });
  await audit(workspaceId, actor, 'automation.created', { type: 'automation', id: r.id });
  return r;
}

export async function updateRule(workspaceId: string, id: string, input: z.infer<typeof RuleSchema>, actor: Actor) {
  await validateRefs(workspaceId, input.actions);
  const r = await db().automationRule.updateMany({ where: { id, workspaceId }, data: { name: input.name, isEnabled: input.isEnabled, trigger: input.trigger, conditions: input.conditions as Prisma.InputJsonValue, actions: input.actions as Prisma.InputJsonValue } });
  if (!r.count) throw NotFound('Automation rule');
  await audit(workspaceId, actor, 'automation.updated', { type: 'automation', id });
  return db().automationRule.findUnique({ where: { id } });
}

export async function deleteRule(workspaceId: string, id: string, actor: Actor) {
  const r = await db().automationRule.deleteMany({ where: { id, workspaceId } });
  if (!r.count) throw NotFound('Automation rule');
  await audit(workspaceId, actor, 'automation.deleted', { type: 'automation', id });
}

export async function listRuns(workspaceId: string, ruleId?: string) {
  return db().automationRun.findMany({ where: { workspaceId, ...(ruleId ? { ruleId } : {}) }, orderBy: { createdAt: 'desc' }, take: 200, include: { rule: { select: { name: true } } } });
}

/** Publish a domain event to automations and subscribed webhooks (both async via queues). */
export async function emitEvent(workspaceId: string, type: string, eventKey: string, payload: Record<string, unknown>) {
  try {
    if ((TRIGGERS as readonly string[]).includes(type)) {
      const hasRules = await db().automationRule.count({ where: { workspaceId, trigger: type, isEnabled: true } });
      if (hasRules) await enqueue(QUEUES.automation, 'automation.dispatch', { workspaceId, type, eventKey, payload });
    }
    const { dispatch } = await import('./workflows.js');
    await dispatch(workspaceId, type, `${type}:${eventKey}`, payload);
    const hooks = await db().webhook.findMany({ where: { workspaceId, isEnabled: true, events: { has: type } } });
    for (const h of hooks) {
      const d = await db().webhookDelivery.create({ data: { workspaceId, webhookId: h.id, event: type, payload: { event: type, occurredAt: new Date().toISOString(), data: payload } as Prisma.InputJsonValue } });
      await enqueue(QUEUES.webhooks, 'webhook.deliver', { workspaceId, deliveryId: d.id }, { attempts: 8, backoff: { type: 'exponential', delay: 30_000 } });
    }
  } catch (e) {
    logger.error({ err: e, type }, 'emitEvent failed');
  }
}

function matches(conditions: z.infer<typeof RuleSchema>['conditions'], payload: Record<string, unknown>): boolean {
  if (conditions.categories?.length && !conditions.categories.includes(payload.category as never)) return false;
  if (conditions.minScore !== undefined && Number(payload.score ?? -1) < conditions.minScore) return false;
  if (conditions.maxScore !== undefined && Number(payload.score ?? 101) > conditions.maxScore) return false;
  if (conditions.toStatuses?.length && !conditions.toStatuses.includes(payload.to as never)) return false;
  return true;
}

/** Worker: evaluate rules for one event. One run per (rule, eventKey) — duplicates are ignored. */
export async function dispatch(workspaceId: string, type: string, eventKey: string, payload: Record<string, unknown>) {
  const rules = await db().automationRule.findMany({ where: { workspaceId, trigger: type, isEnabled: true } });
  const leadId = payload.leadId as string | undefined;
  for (const rule of rules) {
    const parsed = RuleSchema.safeParse({ name: rule.name, isEnabled: rule.isEnabled, trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions });
    if (!parsed.success || !matches(parsed.data.conditions, payload)) continue;
    let run;
    try {
      run = await db().automationRun.create({ data: { workspaceId, ruleId: rule.id, eventKey, status: 'RUNNING' } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') continue; // already processed
      throw e;
    }
    const results: Array<{ action: string; ok: boolean; detail?: string }> = [];
    try {
      for (const a of parsed.data.actions) {
        try {
          results.push({ action: a.type, ok: true, detail: await runAction(workspaceId, a, leadId) });
        } catch (e) {
          results.push({ action: a.type, ok: false, detail: (e as Error).message });
        }
      }
      await db().automationRun.update({ where: { id: run.id }, data: { status: results.every((r) => r.ok) ? 'COMPLETED' : 'FAILED', result: results as Prisma.InputJsonValue } });
    } catch (e) {
      await db().automationRun.update({ where: { id: run.id }, data: { status: 'FAILED', error: (e as Error).message } });
    }
  }
}

async function runAction(workspaceId: string, a: z.infer<typeof ActionSchema>, leadId?: string): Promise<string> {
  if (!leadId && a.type !== 'notify') throw new AppError('VALIDATION_FAILED', 'event has no lead', 400);
  switch (a.type) {
    case 'set_status': {
      const { setLeadStatus } = await import('./leads.js');
      await setLeadStatus(workspaceId, leadId!, a.status, 'automation', WORKER_ACTOR);
      return `status → ${a.status}`;
    }
    case 'add_to_list':
      await db().leadListMember.createMany({ data: [{ workspaceId, listId: a.listId, leadId: leadId! }], skipDuplicates: true });
      return 'added to list';
    case 'create_task': {
      const t = await db().task.create({ data: { workspaceId, title: a.title, leadId, dueAt: new Date(Date.now() + a.dueInDays * 86400_000), priority: 'HIGH' } });
      return `task ${t.id}`;
    }
    case 'create_opportunity': {
      const lead = await db().lead.findFirst({ where: { id: leadId!, workspaceId } });
      if (!lead) throw NotFound('Lead');
      const existing = await db().opportunity.findFirst({ where: { workspaceId, leadId: lead.id, stage: { notIn: ['WON', 'LOST'] } } });
      if (existing) return 'open opportunity already exists';
      const o = await db().opportunity.create({ data: { workspaceId, leadId: lead.id, companyId: lead.companyId, title: a.title, valueCents: a.valueCents } });
      return `opportunity ${o.id}`;
    }
    case 'notify':
      await notifyWorkspace(workspaceId, 'MEMBER', { type: 'automation', title: a.title, link: leadId ? `/leads/${leadId}` : undefined });
      return 'notified';
    case 'enroll_campaign': {
      const { enrollLeadManually } = await import('./engine.js');
      return enrollLeadManually(workspaceId, a.campaignId, leadId!);
    }
  }
}
