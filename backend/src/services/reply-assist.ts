import { z } from 'zod';
import { db } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit, publish, notifyWorkspace, WORKER_ACTOR, type Actor } from '../core/audit.js';
import { renderTemplate } from '../../../shared/src/template.js';
import { readSettings } from './workspace.js';
import { draftReply, queueReply } from './inbox.js';
import { isSuppressed } from './compliance.js';
import { leadVars } from './intelligence.js';

// AI reply intelligence with three permission modes (workspace setting `replyMode`):
//   suggest     – AI drafts appear on the conversation only; a person writes/sends.
//   draft       – (default) AI drafts go to an approval queue; nothing is sent until a person approves.
//   auto_narrow – ONLY for categories an admin explicitly enabled AND only with a human-approved
//                 template (never free AI text), at most once per conversation, never to suppressed
//                 contacts, never for pricing / objection / opt-out / complaint replies. Everything else
//                 falls back to the draft queue.
// AI never makes commercial commitments: drafts containing pricing, discounts, guarantees or contract
// language are flagged for careful review and can never be auto-sent.

export const REPLY_NEEDED = ['INTERESTED', 'WANTS_MEETING', 'WANTS_PRICING', 'NEEDS_INFO', 'WRONG_PERSON', 'HAS_PROVIDER', 'NOT_INTERESTED', 'OTHER'];
export const NEVER_AUTO = new Set(['WANTS_PRICING', 'NOT_INTERESTED', 'HAS_PROVIDER', 'OTHER', 'UNSUBSCRIBE', 'COMPLAINT', 'OUT_OF_OFFICE']);
export const COMMITMENT_RE = /(\$|₹|€|£)\s?\d|\b\d+\s?(usd|inr|eur|dollars|rupees|per month|\/mo|per hour)\b|\b(discount|guarantee[d]?|refund|contract|invoice|we will deliver|promise|free trial for)\b/i;

export function commitmentFlags(text: string) {
  const m = text.match(COMMITMENT_RE);
  return m ? `Contains commercial-commitment language ("${m[0]}") — AI must not commit to pricing, discounts or terms; review carefully.` : null;
}

export async function processInbound(workspaceId: string, messageId: string) {
  const msg = await db().emailMessage.findFirst({ where: { id: messageId, workspaceId }, include: { conversation: { include: { lead: { include: { company: true } } } } } });
  if (!msg || msg.direction !== 'INBOUND' || msg.isBounce || msg.isAutoReply || !msg.category) return { skipped: 'not an actionable human reply' };
  if (!REPLY_NEEDED.includes(msg.category)) return { skipped: `no reply needed for ${msg.category}` };
  const lead = msg.conversation.lead;
  if (lead && (await isSuppressed(workspaceId, lead.emailNormalized)).suppressed) return { skipped: 'contact is suppressed' };
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const settings = readSettings(ws.settings);
  const mode = settings.replyMode;

  const bill = await import('./billing.js');
  const autoAllowed = !bill.billingEnabled() || (await bill.billingState(workspaceId)).entitlements.features.autoReply;
  if (mode === 'auto_narrow' && autoAllowed && settings.autoReplyCategories.includes(msg.category) && !NEVER_AUTO.has(msg.category) && lead) {
    const already = await db().replySuggestion.count({ where: { workspaceId, conversationId: msg.conversationId, mode: 'AUTO' } });
    const tpl = await db().replyTemplate.findFirst({ where: { workspaceId, isApproved: true, categories: { has: msg.category } }, orderBy: { approvedAt: 'desc' } });
    if (!already && tpl) {
      const r = renderTemplate(tpl.body, leadVars(lead, { bookingLink: settings.bookingLink ?? '', sender: { name: ws.senderLegalName ?? ws.name, email: '' } }));
      if (!r.missing.length) {
        const s = await db().replySuggestion.create({ data: { workspaceId, conversationId: msg.conversationId, messageId, mode: 'AUTO', category: msg.category, body: r.text, templateId: tpl.id, status: 'APPROVED', reason: `Auto-reply: approved template "${tpl.name}" for ${msg.category}` } });
        try {
          await queueReply(workspaceId, msg.conversationId, { bodyText: r.text, idempotencyKey: `auto-${messageId}` }, WORKER_ACTOR);
          await db().replySuggestion.update({ where: { id: s.id }, data: { status: 'SENT', decidedAt: new Date() } });
          await audit(workspaceId, WORKER_ACTOR, 'reply.auto_sent', { type: 'conversation', id: msg.conversationId }, { templateId: tpl.id, category: msg.category });
          return { mode: 'AUTO', suggestionId: s.id };
        } catch (e) {
          await db().replySuggestion.update({ where: { id: s.id }, data: { status: 'FAILED', reason: (e as Error).message.slice(0, 300) } });
        }
      }
    }
  }

  // suggest / draft (and every auto fallback): AI draft, never sent automatically
  const kind = mode === 'suggest' ? 'SUGGEST' : 'DRAFT';
  const existing = await db().replySuggestion.findUnique({ where: { messageId_mode: { messageId, mode: kind } } });
  if (existing) return { mode: kind, suggestionId: existing.id };
  const d = await draftReply(workspaceId, msg.conversationId);
  const flags = [commitmentFlags(d.body), d.factCheck && !d.factCheck.passed ? 'Fact-check found unsupported statements.' : null].filter(Boolean).join(' ');
  const s = await db().replySuggestion.create({ data: { workspaceId, conversationId: msg.conversationId, messageId, mode: kind, category: msg.category, body: d.body, status: 'PENDING', reason: flags || null } });
  if (kind === 'DRAFT') await notifyWorkspace(workspaceId, 'MEMBER', { type: 'reply.draft_ready', title: `Reply draft ready (${msg.category.toLowerCase().replace(/_/g, ' ')}) — needs approval`, link: `/inbox/${msg.conversationId}` });
  await publish(workspaceId, 'inbox.updated', { conversationId: msg.conversationId });
  return { mode: kind, suggestionId: s.id };
}

export async function listSuggestions(workspaceId: string, q: { status?: string; conversationId?: string }) {
  return db().replySuggestion.findMany({ where: { workspaceId, ...(q.status ? { status: q.status as never } : {}), ...(q.conversationId ? { conversationId: q.conversationId } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
}

export async function approveSuggestion(workspaceId: string, id: string, body: string | undefined, actor: Actor) {
  const s = await db().replySuggestion.findFirst({ where: { id, workspaceId } });
  if (!s) throw NotFound('Suggestion');
  if (s.status !== 'PENDING') throw new AppError('CONFLICT', `Suggestion is ${s.status}`, 409);
  const text = (body ?? s.body).trim();
  const claimed = await db().replySuggestion.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'APPROVED', body: text, decidedById: actor.userId ?? null, decidedAt: new Date() } });
  if (!claimed.count) throw new AppError('CONFLICT', 'Already handled', 409);
  await queueReply(workspaceId, s.conversationId, { bodyText: text, idempotencyKey: `sugg-${id}` }, actor);
  await db().replySuggestion.update({ where: { id }, data: { status: 'SENT' } });
  await audit(workspaceId, actor, 'reply.suggestion_approved', { type: 'conversation', id: s.conversationId }, { suggestionId: id, edited: body !== undefined && body !== s.body });
  return { sent: true };
}

export async function dismissSuggestion(workspaceId: string, id: string, actor: Actor) {
  const r = await db().replySuggestion.updateMany({ where: { id, workspaceId, status: 'PENDING' }, data: { status: 'DISMISSED', decidedById: actor.userId ?? null, decidedAt: new Date() } });
  if (!r.count) throw NotFound('Pending suggestion');
}

export const TemplateSchema = z.object({ name: z.string().min(1).max(120), body: z.string().min(1).max(5000), categories: z.array(z.enum(['INTERESTED', 'WANTS_MEETING', 'NEEDS_INFO', 'WRONG_PERSON'])).max(4) });

export async function listTemplates(workspaceId: string) { return db().replyTemplate.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } }); }
export async function saveTemplate(workspaceId: string, id: string | null, input: z.infer<typeof TemplateSchema>, actor: Actor) {
  const flag = commitmentFlags(input.body);
  const data = { ...input, isApproved: false, approvedById: null, approvedAt: null }; // any edit needs re-approval
  const t = id ? await db().replyTemplate.update({ where: { id: (await db().replyTemplate.findFirst({ where: { id, workspaceId } }) ?? (() => { throw NotFound('Template'); })()).id }, data }) : await db().replyTemplate.create({ data: { workspaceId, ...data, createdById: actor.userId ?? null } });
  await audit(workspaceId, actor, 'reply.template_saved', { type: 'reply_template', id: t.id });
  return { ...t, warning: flag };
}
export async function approveTemplate(workspaceId: string, id: string, approve: boolean, actor: Actor) {
  const t = await db().replyTemplate.findFirst({ where: { id, workspaceId } });
  if (!t) throw NotFound('Template');
  await db().replyTemplate.update({ where: { id }, data: { isApproved: approve, approvedById: approve ? actor.userId ?? null : null, approvedAt: approve ? new Date() : null } });
  await audit(workspaceId, actor, approve ? 'reply.template_approved' : 'reply.template_unapproved', { type: 'reply_template', id });
}
export async function deleteTemplate(workspaceId: string, id: string, actor: Actor) {
  const r = await db().replyTemplate.deleteMany({ where: { id, workspaceId } });
  if (!r.count) throw NotFound('Template');
  await audit(workspaceId, actor, 'reply.template_deleted', { type: 'reply_template', id });
}
