import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { NotFound } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { deriveLearningCandidates, findRuleConflicts, OUTREACH_EXAMPLE_CATEGORIES, OUTREACH_EXAMPLE_POLARITIES, OUTREACH_RULE_CATEGORIES, OUTREACH_RULE_PRIORITIES, retrieveRelevantExamples, type FeedbackLike, type OutreachExampleLike, type OutreachRuleLike } from '../../../shared/src/outreach-brain.js';

export const RuleInputSchema = z.object({
  title: z.string().trim().min(2).max(120), description: z.string().trim().min(3).max(3000),
  category: z.enum(OUTREACH_RULE_CATEGORIES), priority: z.enum(OUTREACH_RULE_PRIORITIES),
  condition: z.string().trim().max(1000).nullable().optional(), status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  triggerTerms: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
}).superRefine((v, ctx) => { if (v.priority === 'CONDITIONAL' && !v.condition?.trim()) ctx.addIssue({ code: 'custom', path: ['condition'], message: 'Conditional rules need an explicit condition.' }); });
export const ExampleInputSchema = z.object({
  name: z.string().trim().min(2).max(120), content: z.string().trim().min(10).max(20000), correctedContent: z.string().trim().max(20000).nullable().optional(),
  category: z.enum(OUTREACH_EXAMPLE_CATEGORIES), polarity: z.enum(OUTREACH_EXAMPLE_POLARITIES), explanation: z.string().trim().max(2000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]), isActive: z.boolean().default(true),
});

export const FeedbackReasonCodeSchema = z.enum(['WRONG_PROSPECT', 'WRONG_IDENTITY', 'INCORRECT_RESEARCH', 'UNSUPPORTED_CLAIM', 'WRONG_SERVICE', 'GENERIC_OPENING', 'IRRELEVANT_OPPORTUNITY', 'POOR_WRITING', 'WRONG_TONE', 'WEAK_CTA', 'OTHER']);
export type FeedbackReasonCode = z.infer<typeof FeedbackReasonCodeSchema>;

export function validateRuleConflictInput<T extends OutreachRuleLike>(rows: T[], next: OutreachRuleLike) {
  return findRuleConflicts([...rows, next]);
}

export async function listRules(workspaceId: string) {
  const rules = await db().outreachRule.findMany({ where: { workspaceId }, orderBy: [{ status: 'asc' }, { priority: 'asc' }, { updatedAt: 'desc' }] });
  return { rules, conflicts: findRuleConflicts(rules) };
}
export async function createRule(workspaceId: string, input: z.infer<typeof RuleInputSchema>, actor: Actor, transaction?: Prisma.TransactionClient) {
  const client = transaction ?? db();
  const existing = await client.outreachRule.findMany({ where: { workspaceId, status: 'ACTIVE' } });
  const conflicts = validateRuleConflictInput(existing, input);
  const rule = await client.outreachRule.create({ data: { workspaceId, ...input, condition: input.condition ?? null } });
  await audit(workspaceId, actor, 'outreach_brain.rule_created', { type: 'outreach_rule', id: rule.id }, { category: rule.category, priority: rule.priority }, transaction);
  return { rule, conflicts };
}
export async function updateRule(workspaceId: string, id: string, input: z.infer<typeof RuleInputSchema>, actor: Actor, transaction?: Prisma.TransactionClient) {
  const client = transaction ?? db();
  const current = await client.outreachRule.findFirst({ where: { id, workspaceId } });
  if (!current) throw NotFound('Outreach rule');
  const rows = await client.outreachRule.findMany({ where: { workspaceId, status: 'ACTIVE', id: { not: id } } });
  const conflicts = validateRuleConflictInput(rows, { ...input, id });
  const rule = await client.outreachRule.update({ where: { id }, data: { ...input, condition: input.condition ?? null } });
  await audit(workspaceId, actor, 'outreach_brain.rule_updated', { type: 'outreach_rule', id }, { category: rule.category, priority: rule.priority }, transaction);
  return { rule, conflicts };
}
export async function deleteRule(workspaceId: string, id: string, actor: Actor) {
  const r = await db().outreachRule.deleteMany({ where: { id, workspaceId } });
  if (!r.count) throw NotFound('Outreach rule');
  await audit(workspaceId, actor, 'outreach_brain.rule_deleted', { type: 'outreach_rule', id });
}

export async function listExamples(workspaceId: string) {
  return db().outreachExample.findMany({ where: { workspaceId }, orderBy: { updatedAt: 'desc' } });
}
export async function createExample(workspaceId: string, input: z.infer<typeof ExampleInputSchema>, actor: Actor) {
  const example = await db().outreachExample.create({ data: { workspaceId, ...input, isHumanApproved: true, reviewedById: actor.userId ?? null, reviewedAt: new Date(), correctedContent: input.correctedContent ?? null, explanation: input.explanation ?? null } });
  await audit(workspaceId, actor, 'outreach_brain.example_created', { type: 'outreach_example', id: example.id }, { category: example.category, polarity: example.polarity });
  return example;
}
export async function updateExample(workspaceId: string, id: string, input: z.infer<typeof ExampleInputSchema>, actor: Actor) {
  const example = await db().outreachExample.findFirst({ where: { id, workspaceId } });
  if (!example) throw NotFound('Outreach example');
  const updated = await db().outreachExample.update({ where: { id }, data: { ...input, isHumanApproved: true, reviewedById: actor.userId ?? null, reviewedAt: new Date(), correctedContent: input.correctedContent ?? null, explanation: input.explanation ?? null } });
  await audit(workspaceId, actor, 'outreach_brain.example_updated', { type: 'outreach_example', id });
  return updated;
}
export async function deleteExample(workspaceId: string, id: string, actor: Actor) {
  const r = await db().outreachExample.deleteMany({ where: { id, workspaceId } });
  if (!r.count) throw NotFound('Outreach example');
  await audit(workspaceId, actor, 'outreach_brain.example_deleted', { type: 'outreach_example', id });
}

/** Resolve at most five workspace examples against the current prospect/campaign context. */
export async function relevantExamples(workspaceId: string, context: string) {
  const rows = await db().outreachExample.findMany({ where: { workspaceId, isActive: true, isHumanApproved: true }, orderBy: { updatedAt: 'desc' }, take: 500 });
  return retrieveRelevantExamples(rows as OutreachExampleLike[], context);
}
export async function activeRules(workspaceId: string) {
  return db().outreachRule.findMany({ where: { workspaceId, status: 'ACTIVE' }, orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }] });
}

const contentFields = ['subject', 'openingLine', 'body', 'cta'] as const;
export type FeedbackContent = Record<(typeof contentFields)[number], string | null>;
export function changedContentFields(before: FeedbackContent, after: FeedbackContent) {
  return contentFields.filter((k) => (before[k] ?? '').trim() !== (after[k] ?? '').trim());
}
export async function recordFeedback(workspaceId: string, personalizationId: string, feedbackType: 'EDITED' | 'APPROVED' | 'REJECTED', originalContent: FeedbackContent, finalContent: FeedbackContent, actor: Actor, explanation?: string, scope: 'GLOBAL' | 'CAMPAIGN' | 'PROSPECT' | 'FACTUAL' = 'CAMPAIGN', reasonCode?: z.infer<typeof FeedbackReasonCodeSchema>) {
  const p = await db().leadPersonalization.findFirst({ where: { id: personalizationId, workspaceId }, select: { id: true } });
  if (!p) throw NotFound('Personalization');
  const changedFields = changedContentFields(originalContent, finalContent);
  const feedback = await db().outreachFeedback.create({ data: { workspaceId, personalizationId, feedbackType, originalContent: originalContent as unknown as Prisma.InputJsonValue, finalContent: finalContent as unknown as Prisma.InputJsonValue, changedFields, scope, reasonCode, explanation: explanation?.slice(0, 1000) ?? null, createdById: actor.userId ?? null } });
  if (feedbackType === 'EDITED' && scope === 'GLOBAL' && changedFields.length) await refreshLearningSuggestions(workspaceId);
  await audit(workspaceId, actor, `outreach_brain.feedback_${feedbackType.toLowerCase()}`, { type: 'personalization', id: personalizationId }, { changedFields });
  return feedback;
}

export async function refreshLearningSuggestions(workspaceId: string) {
  const rows = await db().outreachFeedback.findMany({ where: { workspaceId, feedbackType: 'EDITED', scope: 'GLOBAL' }, orderBy: { createdAt: 'desc' }, take: 100, select: { originalContent: true, finalContent: true, changedFields: true } });
  const candidates = deriveLearningCandidates(rows as unknown as FeedbackLike[], 3);
  for (const s of candidates) await db().aiLearningSuggestion.upsert({
    where: { workspaceId_signature: { workspaceId, signature: s.signature } },
    update: { sampleCount: s.sampleCount, confidence: s.confidence, evidence: s.evidence as unknown as Prisma.InputJsonValue },
    create: { workspaceId, ...s, evidence: s.evidence as unknown as Prisma.InputJsonValue },
  });
  return candidates;
}
export async function listSuggestions(workspaceId: string) {
  const pending = await db().aiLearningSuggestion.findMany({ where: { workspaceId, status: 'PENDING' }, orderBy: { updatedAt: 'desc' } });
  return { pending, totalPending: pending.length };
}
export async function decideSuggestion(workspaceId: string, id: string, decision: 'ACCEPT' | 'REJECT', actor: Actor) {
  const suggestion = await db().aiLearningSuggestion.findFirst({ where: { id, workspaceId, status: 'PENDING' } });
  if (!suggestion) throw NotFound('Learning suggestion');
  if (decision === 'ACCEPT') {
    const priority = suggestion.signature === 'shorten-long-drafts' ? 'PREFERRED' : 'AVOID';
    await db().outreachRule.create({ data: { workspaceId, title: suggestion.title, description: suggestion.description, category: suggestion.category, priority, status: 'ACTIVE' } });
  }
  const updated = await db().aiLearningSuggestion.update({ where: { id }, data: { status: decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED' } });
  await audit(workspaceId, actor, `outreach_brain.suggestion_${decision.toLowerCase()}`, { type: 'ai_learning_suggestion', id }, { signature: suggestion.signature });
  return updated;
}

export function conflictSchemaWarnings(rules: OutreachRuleLike[]) { return findRuleConflicts(rules); }
