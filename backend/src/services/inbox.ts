import { z } from 'zod';
import sanitizeHtml from 'sanitize-html';
import { randomUUID } from 'node:crypto';
import { db, Prisma } from '../core/db.js';
import { adapters } from '../core/container.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit, notifyWorkspace, publish, WORKER_ACTOR, type Actor } from '../core/audit.js';
import { enqueue, QUEUES } from '../core/queues.js';
import { assertKeyBelongsTo, store } from '../core/storage.js';
import { logger } from '../core/logger.js';
import type { NormalizedMessage } from '../../../integrations/src/email/types.js';
import { OUTBOUND_HEADER } from '../../../integrations/src/email/types.js';
import { neutralizeTags, wrapUntrusted } from '../../../integrations/src/ai/guard.js';
import { runAi } from './ai.js';
import { addSuppression } from './compliance.js';
import { stopEnrollmentsForLead } from './engine.js';
import { emitEvent } from './automation.js';
import { getAuth } from './accounts.js';
import { factCheck, supportedClaims } from './intelligence.js';
import { readSettings } from './workspace.js';
import type { ReplyClassification } from '../../../shared/src/ai-schemas.js';

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'blockquote', 'a', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'pre', 'code', 'hr'],
  allowedAttributes: { a: ['href', 'title'], td: ['colspan', 'rowspan'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }) },
};

export const sanitizeEmailHtml = (html: string) => sanitizeHtml(html, SANITIZE);

/** Ingest messages from a mailbox sync. Idempotent per (account, providerMessageId). */
export async function ingestMessages(workspaceId: string, accountId: string, messages: NormalizedMessage[]) {
  const account = await db().emailAccount.findUniqueOrThrow({ where: { id: accountId } });
  const stats = { inbound: 0, outbound: 0, bounces: 0, replies: 0, skipped: 0 };
  const sorted = [...messages].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const m of sorted) {
    try {
      const exists = await db().emailMessage.findUnique({ where: { emailAccountId_providerMessageId: { emailAccountId: accountId, providerMessageId: m.providerMessageId } } });
      if (exists) { stats.skipped++; continue; }
      const outbound = m.from.address === account.emailAddress;

      // Our own campaign email seen in the Sent folder: link provider ids, don't duplicate.
      if (outbound && m.outboundId) {
        const ob = await db().outboundEmail.findFirst({ where: { id: m.outboundId, workspaceId } });
        if (ob?.emailMessageId) {
          await db().emailMessage.update({ where: { id: ob.emailMessageId }, data: { providerMessageId: m.providerMessageId, internetMessageId: m.internetMessageId ?? undefined } }).catch(() => undefined);
          if (!ob.providerMessageId) await db().outboundEmail.update({ where: { id: ob.id }, data: { providerMessageId: m.providerMessageId, providerThreadId: m.providerThreadId } });
          stats.skipped++;
          continue;
        }
      }

      // Conversation matching: In-Reply-To/References → provider thread → new.
      const refIds = [m.inReplyTo, ...m.references].filter(Boolean) as string[];
      const parent = refIds.length ? await db().emailMessage.findFirst({ where: { workspaceId, emailAccountId: accountId, internetMessageId: { in: refIds } }, orderBy: { sentAt: 'desc' } }) : null;
      let conversation = parent ? await db().conversation.findUnique({ where: { id: parent.conversationId } }) : null;
      conversation ??= await db().conversation.findUnique({ where: { emailAccountId_providerThreadId: { emailAccountId: accountId, providerThreadId: m.providerThreadId } } });
      const counterpart = outbound ? m.to[0] : m.from.address;
      const lead = counterpart ? await db().lead.findUnique({ where: { workspaceId_emailNormalized: { workspaceId, emailNormalized: counterpart } } }) : null;
      if (!conversation) {
        conversation = await db().conversation.create({ data: { workspaceId, emailAccountId: accountId, leadId: lead?.id, providerThreadId: m.providerThreadId, subject: m.subject, lastMessageAt: m.date, isUnread: !outbound } });
      }

      const message = await db().emailMessage.create({
        data: {
          workspaceId, conversationId: conversation.id, emailAccountId: accountId, direction: outbound ? 'OUTBOUND' : 'INBOUND',
          providerMessageId: m.providerMessageId, internetMessageId: m.internetMessageId, inReplyTo: m.inReplyTo, references: m.references.slice(0, 50),
          fromAddress: m.from.address, fromName: m.from.name, toAddresses: m.to, ccAddresses: m.cc, subject: m.subject,
          snippet: (m.text ?? '').replace(/\s+/g, ' ').slice(0, 200), bodyText: m.text?.slice(0, 100_000), bodyHtmlSanitized: m.html ? sanitizeEmailHtml(m.html).slice(0, 200_000) : null,
          isAutoReply: m.isAutoReply, isBounce: !!m.bounce, sentAt: m.date,
        },
      });
      for (const att of m.attachments.slice(0, 20)) {
        let storageKey: string | null = null;
        if (att.content && att.size <= 10 * 1024 * 1024) storageKey = await store().put(workspaceId, 'attachments', att.content, (att.filename.split('.').pop() ?? 'bin').slice(0, 8));
        await db().emailAttachment.create({ data: { workspaceId, messageId: message.id, filename: att.filename.slice(0, 200), contentType: att.contentType, sizeBytes: att.size, storageKey } });
      }
      await db().conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: m.date > conversation.lastMessageAt ? m.date : conversation.lastMessageAt, ...(outbound ? {} : { isUnread: true, status: 'OPEN' }), ...(lead && !conversation.leadId ? { leadId: lead.id } : {}) } });

      if (outbound) { stats.outbound++; continue; }
      stats.inbound++;
      if (m.bounce) { stats.bounces++; await handleBounce(workspaceId, accountId, message.id, m); continue; }
      if (lead) { stats.replies++; await handleReply(workspaceId, accountId, conversation.id, message.id, lead.id, m); }
    } catch (e) {
      logger.error({ err: e, providerMessageId: m.providerMessageId }, 'ingest failed for message');
    }
  }
  return stats;
}

async function handleBounce(workspaceId: string, accountId: string, messageId: string, m: NormalizedMessage) {
  const b = m.bounce!;
  let ob = b.outboundId ? await db().outboundEmail.findFirst({ where: { id: b.outboundId, workspaceId } }) : null;
  ob ??= b.originalMessageId ? await db().outboundEmail.findFirst({ where: { workspaceId, internetMessageId: b.originalMessageId } }) : null;
  const recipient = b.recipient ?? ob?.toAddress ?? null;
  const lead = recipient ? await db().lead.findUnique({ where: { workspaceId_emailNormalized: { workspaceId, emailNormalized: recipient } } }) : null;
  if (!lead && !ob) return;
  const type = b.hard ? 'BOUNCED_HARD' : 'BOUNCED_SOFT';
  const key = `${type}:${ob?.id ?? lead?.id}:${b.hard ? '' : messageId}`;
  await db().emailEvent.upsert({ where: { dedupeKey: key }, update: {}, create: { workspaceId, type, leadId: lead?.id ?? null, campaignId: ob?.campaignId, enrollmentId: ob?.enrollmentId, outboundEmailId: ob?.id, emailMessageId: messageId, emailAccountId: accountId, dedupeKey: key, metadata: { status: b.status, recipient } } });
  if (!lead) return;
  const soft = b.hard ? 0 : await db().emailEvent.count({ where: { leadId: lead.id, type: 'BOUNCED_SOFT' } });
  if (b.hard || soft >= 3) {
    await addSuppression(workspaceId, { type: 'EMAIL', value: lead.emailNormalized, reason: 'HARD_BOUNCE', source: 'bounce', note: b.status ?? undefined }, WORKER_ACTOR);
    if (lead.status !== 'BOUNCED') await db().lead.update({ where: { id: lead.id }, data: { status: 'BOUNCED', emailVerificationStatus: 'INVALID', statusChanges: { create: { workspaceId, fromStatus: lead.status, toStatus: 'BOUNCED', reason: `bounce ${b.status ?? ''}` } } } });
    await emitEvent(workspaceId, 'email.bounced', `bounce:${lead.id}`, { leadId: lead.id, status: b.status, campaignId: ob?.campaignId });
  }
}

async function handleReply(workspaceId: string, accountId: string, conversationId: string, messageId: string, leadId: string, m: NormalizedMessage) {
  const enrollments = await db().sequenceEnrollment.findMany({ where: { workspaceId, leadId, emailAccountId: accountId }, include: { campaign: true } });
  const conv = await db().conversation.findUniqueOrThrow({ where: { id: conversationId } });
  if (!conv.campaignId && enrollments[0]) await db().conversation.update({ where: { id: conversationId }, data: { campaignId: enrollments[0].campaignId } });
  for (const e of enrollments) {
    if (m.isAutoReply) {
      await db().emailEvent.upsert({ where: { dedupeKey: `AUTO:${messageId}:${e.id}` }, update: {}, create: { workspaceId, type: 'AUTO_REPLIED', leadId, campaignId: e.campaignId, enrollmentId: e.id, emailMessageId: messageId, emailAccountId: accountId, dedupeKey: `AUTO:${messageId}:${e.id}` } });
      if (e.campaign.stopOnAutoReply) await stopEnrollmentsForLead(workspaceId, leadId, 'STOPPED_REPLIED', 'auto-reply received', e.campaignId);
    } else {
      await db().emailEvent.upsert({ where: { dedupeKey: `REPLIED:${messageId}:${e.id}` }, update: {}, create: { workspaceId, type: 'REPLIED', leadId, campaignId: e.campaignId, enrollmentId: e.id, emailMessageId: messageId, emailAccountId: accountId, dedupeKey: `REPLIED:${messageId}:${e.id}` } });
      if (e.campaign.stopOnReply) await stopEnrollmentsForLead(workspaceId, leadId, 'STOPPED_REPLIED', 'prospect replied', e.campaignId);
    }
  }
  if (!m.isAutoReply) {
    const lead = await db().lead.findUniqueOrThrow({ where: { id: leadId } });
    await db().lead.update({ where: { id: leadId }, data: { lastRepliedAt: m.date, ...(['NEW', 'RESEARCHED', 'QUALIFIED', 'CONTACTED'].includes(lead.status) ? { status: 'REPLIED' } : {}) } });
    if (['NEW', 'RESEARCHED', 'QUALIFIED', 'CONTACTED'].includes(lead.status)) await db().leadStatusChange.create({ data: { workspaceId, leadId, fromStatus: lead.status, toStatus: 'REPLIED', reason: 'reply received' } });
  }
  await enqueue(QUEUES.ai, 'ai.classifyReply', { workspaceId, messageId }, { jobId: `classify-${messageId}` });
}

const UNSUB_RE = /\b(unsubscribe|remove me|take me off|stop (emailing|contacting|sending)|do not (email|contact)|don'?t (email|contact) me|opt[ -]?out)\b/i;
const COMPLAINT_RE = /\b(this is spam|reported (you|this) as spam|report(ing)? you|harass)/i;

/** Keyword fallback used when no AI provider is configured or AI fails — opt-outs must never be missed. */
export function heuristicClassify(text: string): Pick<ReplyClassification, 'category' | 'unsubscribeIntent'> & { confidence: number } {
  if (COMPLAINT_RE.test(text)) return { category: 'COMPLAINT', unsubscribeIntent: true, confidence: 0.6 };
  if (UNSUB_RE.test(text)) return { category: 'UNSUBSCRIBE', unsubscribeIntent: true, confidence: 0.6 };
  return { category: 'OTHER', unsubscribeIntent: false, confidence: 0.2 };
}

/** Worker: classify one inbound reply and apply deterministic effects. */
export async function classifyMessage(workspaceId: string, messageId: string) {
  const msg = await db().emailMessage.findFirst({ where: { id: messageId, workspaceId }, include: { conversation: true } });
  if (!msg || msg.direction !== 'INBOUND' || msg.isBounce) return null;
  const text = (msg.bodyText ?? '').split(/\n(?:On .+wrote:|-{2,}\s*Original Message)/)[0].slice(0, 6000);
  let result: { category: ReplyClassification['category']; confidence: number; sentiment?: string; meetingInterest?: boolean; objection?: string | null; unsubscribeIntent: boolean };
  try {
    const r = await runAi<ReplyClassification>(workspaceId, 'REPLY_CLASSIFICATION', { subject: neutralizeTags(msg.subject ?? ''), reply: neutralizeTags(text) }, { entity: { type: 'email_message', id: messageId }, critical: true });
    result = r.data.confidence < 0.6 && !r.data.unsubscribeIntent ? { ...r.data, category: 'OTHER' } : r.data;
    const h = heuristicClassify(text);
    if (h.unsubscribeIntent && !result.unsubscribeIntent) result = { ...result, unsubscribeIntent: true, category: h.category }; // belt and braces
  } catch (e) {
    logger.warn({ err: e }, 'AI classification unavailable; using keyword fallback');
    result = heuristicClassify(text);
  }
  await db().emailMessage.update({ where: { id: messageId }, data: { category: result.category, categoryConfidence: result.confidence, sentiment: result.sentiment ?? null, meetingInterest: result.meetingInterest ?? null, objection: result.objection ?? null } });
  await db().conversation.update({ where: { id: msg.conversationId }, data: { category: result.category } });
  await db().emailAccount.update({ where: { id: msg.emailAccountId }, data: { lastReceivedAt: msg.sentAt } }).catch(() => undefined);
  const leadId = msg.conversation.leadId;
  if (leadId) await applyCategoryEffects(workspaceId, leadId, msg.fromAddress, result, messageId);
  await emitEvent(workspaceId, 'reply.categorized', `reply:${messageId}`, { leadId, conversationId: msg.conversationId, messageId, category: result.category, confidence: result.confidence });
  await publish(workspaceId, 'inbox.classified', { conversationId: msg.conversationId, category: result.category });
  await enqueue(QUEUES.ai, 'ai.replyAssist', { workspaceId, messageId }, { jobId: `reply-assist-${messageId}`, attempts: 2 });
  return result;
}

async function applyCategoryEffects(workspaceId: string, leadId: string, fromAddress: string, r: { category: string; unsubscribeIntent: boolean }, messageId: string) {
  const { setLeadStatus } = await import('./leads.js');
  const lead = await db().lead.findUniqueOrThrow({ where: { id: leadId } });
  if (r.unsubscribeIntent || r.category === 'UNSUBSCRIBE') {
    await addSuppression(workspaceId, { type: 'EMAIL', value: lead.emailNormalized, reason: 'UNSUBSCRIBED', source: 'reply_classifier' }, WORKER_ACTOR);
    await db().emailEvent.upsert({ where: { dedupeKey: `UNSUBSCRIBED:${leadId}` }, update: {}, create: { workspaceId, type: 'UNSUBSCRIBED', leadId, emailMessageId: messageId, dedupeKey: `UNSUBSCRIBED:${leadId}`, metadata: { source: 'reply' } } });
    await setLeadStatus(workspaceId, leadId, 'UNSUBSCRIBED', 'asked to stop in reply', WORKER_ACTOR);
  }
  if (r.category === 'COMPLAINT') {
    await addSuppression(workspaceId, { type: 'EMAIL', value: lead.emailNormalized, reason: 'COMPLAINT', source: 'reply_classifier' }, WORKER_ACTOR);
    const enr = await db().sequenceEnrollment.findFirst({ where: { leadId }, orderBy: { enrolledAt: 'desc' } });
    await db().emailEvent.upsert({ where: { dedupeKey: `COMPLAINED:${messageId}` }, update: {}, create: { workspaceId, type: 'COMPLAINED', leadId, campaignId: enr?.campaignId, enrollmentId: enr?.id, emailMessageId: messageId, dedupeKey: `COMPLAINED:${messageId}`, metadata: { source: 'reply_classifier', note: 'Detected from reply content; provider complaint feedback is not available for mailbox sending.' } } });
    await notifyWorkspace(workspaceId, 'MANAGER', { type: 'complaint', title: `Complaint from ${fromAddress}`, link: `/leads/${leadId}` });
  }
  if (['INTERESTED', 'WANTS_PRICING', 'WANTS_MEETING', 'NEEDS_INFO'].includes(r.category) && !['MEETING_BOOKED', 'CUSTOMER'].includes(lead.status)) {
    await setLeadStatus(workspaceId, leadId, 'INTERESTED', `reply: ${r.category}`, WORKER_ACTOR);
    await notifyWorkspace(workspaceId, 'MEMBER', { type: 'reply.positive', title: `${r.category.replace('_', ' ').toLowerCase()}: ${fromAddress}`, link: `/inbox` });
  }
  if (['NOT_INTERESTED', 'HAS_PROVIDER'].includes(r.category) && !['CUSTOMER'].includes(lead.status)) await setLeadStatus(workspaceId, leadId, 'NOT_INTERESTED', `reply: ${r.category}`, WORKER_ACTOR);
  if (r.category === 'OUT_OF_OFFICE') {
    // An OOO that stopped a sequence (headers missed it) re-activates it with a short delay.
    const stopped = await db().sequenceEnrollment.findMany({ where: { leadId, status: 'STOPPED_REPLIED', stopReason: 'prospect replied', completedAt: { gte: new Date(Date.now() - 2 * 86400_000) } }, include: { campaign: true } });
    for (const e of stopped) {
      if (e.campaign.status !== 'RUNNING' || e.campaign.stopOnAutoReply) continue;
      await db().sequenceEnrollment.update({ where: { id: e.id }, data: { status: 'ACTIVE', stopReason: null, completedAt: null, nextActionAt: new Date(Date.now() + 3 * 86400_000) } });
      await db().emailEvent.deleteMany({ where: { enrollmentId: e.id, type: 'REPLIED', emailMessageId: messageId } });
    }
    if (lead.status === 'REPLIED') await setLeadStatus(workspaceId, leadId, 'CONTACTED', 'reply was out-of-office', WORKER_ACTOR);
  }
}

// ---------------------------------------------------------------- conversations API

export const ConversationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
  q: z.string().optional(),
  accountId: z.string().uuid().optional(),
  category: z.string().optional(),
  status: z.enum(['OPEN', 'WAITING', 'CLOSED']).optional(),
  unread: z.enum(['true', 'false']).optional(),
  campaignId: z.string().uuid().optional(),
  label: z.string().optional(),
  assigneeId: z.string().uuid().optional(),
  hasReply: z.enum(['true', 'false']).optional(),
  starred: z.enum(['true', 'false']).optional(),
  archived: z.enum(['true', 'false', 'all']).optional(),
});

export async function listConversations(workspaceId: string, q: z.infer<typeof ConversationQuerySchema>) {
  const where: Prisma.ConversationWhereInput = {
    workspaceId,
    ...(q.accountId ? { emailAccountId: q.accountId } : {}),
    ...(q.category ? { category: q.category as never } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.unread ? { isUnread: q.unread === 'true' } : {}),
    ...(q.campaignId ? { campaignId: q.campaignId } : {}),
    ...(q.label ? { labels: { has: q.label } } : {}),
    ...(q.assigneeId ? { assigneeId: q.assigneeId } : {}),
    ...(q.starred ? { isStarred: q.starred === 'true' } : {}),
    ...(q.archived === 'all' ? {} : { isArchived: q.archived === 'true' }),
    ...(q.hasReply === 'true' ? { messages: { some: { direction: 'INBOUND' } } } : {}),
    ...(q.q ? { OR: [{ subject: { contains: q.q, mode: 'insensitive' } }, { messages: { some: { OR: [{ fromAddress: { contains: q.q.toLowerCase() } }, { bodyText: { contains: q.q, mode: 'insensitive' } }] } } }] } : {}),
  };
  const [items, total] = await Promise.all([
    db().conversation.findMany({ where, orderBy: { lastMessageAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { lead: { select: { id: true, email: true, firstName: true, lastName: true, status: true } }, emailAccount: { select: { emailAddress: true } }, messages: { orderBy: { sentAt: 'desc' }, take: 1, select: { snippet: true, direction: true, fromAddress: true } } } }),
    db().conversation.count({ where }),
  ]);
  return { items, total };
}

export async function getConversation(workspaceId: string, id: string) {
  const c = await db().conversation.findFirst({
    where: { id, workspaceId },
    include: {
      lead: { include: { company: { select: { id: true, name: true } } } }, emailAccount: { select: { id: true, emailAddress: true, provider: true, status: true } }, campaign: { select: { id: true, name: true } },
      messages: { orderBy: { sentAt: 'asc' }, include: { attachments: { select: { id: true, filename: true, sizeBytes: true, contentType: true, storageKey: true } } } },
      notes: { orderBy: { createdAt: 'asc' }, include: { author: { select: { name: true } } } },
      tasks: { where: { status: 'OPEN' } },
    },
  });
  if (!c) throw NotFound('Conversation');
  return c;
}

export const ConversationUpdateSchema = z.object({
  status: z.enum(['OPEN', 'WAITING', 'CLOSED']).optional(),
  isUnread: z.boolean().optional(),
  labels: z.array(z.string().max(40)).max(20).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  isStarred: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  category: z.enum(['INTERESTED', 'WANTS_PRICING', 'WANTS_MEETING', 'NEEDS_INFO', 'NOT_INTERESTED', 'HAS_PROVIDER', 'WRONG_PERSON', 'OUT_OF_OFFICE', 'UNSUBSCRIBE', 'COMPLAINT', 'OTHER']).optional(),
});

export async function updateConversation(workspaceId: string, id: string, input: z.infer<typeof ConversationUpdateSchema>, actor: Actor) {
  const c = await db().conversation.findFirst({ where: { id, workspaceId } });
  if (!c) throw NotFound('Conversation');
  if (input.assigneeId && !(await db().workspaceMember.findFirst({ where: { workspaceId, userId: input.assigneeId } }))) throw NotFound('Member');
  const updated = await db().conversation.update({ where: { id }, data: input });
  // Manual category override applies the same deterministic effects (e.g. opt-out).
  if (input.category && input.category !== c.category && c.leadId) {
    const lastIn = await db().emailMessage.findFirst({ where: { conversationId: id, direction: 'INBOUND' }, orderBy: { sentAt: 'desc' } });
    await applyCategoryEffects(workspaceId, c.leadId, lastIn?.fromAddress ?? '', { category: input.category, unsubscribeIntent: input.category === 'UNSUBSCRIBE' }, lastIn?.id ?? id);
    await audit(workspaceId, actor, 'conversation.recategorized', { type: 'conversation', id }, { from: c.category, to: input.category });
  }
  return updated;
}

export const ReplySchema = z.object({ bodyText: z.string().min(1).max(20000), idempotencyKey: z.string().min(8).max(100).optional() });

/** Queue a reply. It is always sent from the conversation's original mailbox. */
export async function queueReply(workspaceId: string, conversationId: string, input: z.infer<typeof ReplySchema>, actor: Actor) {
  const c = await db().conversation.findFirst({ where: { id: conversationId, workspaceId }, include: { emailAccount: true } });
  if (!c) throw NotFound('Conversation');
  if (c.emailAccount.status !== 'CONNECTED') throw new AppError('ACCOUNT_NOT_CONNECTED', `The original mailbox ${c.emailAccount.emailAddress} is ${c.emailAccount.status}; reconnect it to reply.`, 409);
  const key = input.idempotencyKey ?? randomUUID();
  await enqueue(QUEUES.replySend, 'reply.send', { workspaceId, conversationId, bodyText: input.bodyText, userId: actor.userId, key }, { jobId: `reply-${key}`, attempts: 1 });
  await audit(workspaceId, actor, 'conversation.reply_queued', { type: 'conversation', id: conversationId });
  return { queued: true, idempotencyKey: key };
}

/** Worker: send a manual reply in-thread. Attempts=1 + jobId dedupe prevent double sending. */
export async function sendReply(workspaceId: string, conversationId: string, bodyText: string, userId: string | null) {
  const c = await db().conversation.findFirstOrThrow({ where: { id: conversationId, workspaceId }, include: { emailAccount: true, messages: { orderBy: { sentAt: 'asc' } } } });
  const lastInbound = [...c.messages].reverse().find((m) => m.direction === 'INBOUND') ?? c.messages[c.messages.length - 1];
  if (!lastInbound) throw new AppError('CONFLICT', 'Conversation has no messages', 409);
  const to = lastInbound.direction === 'INBOUND' ? lastInbound.fromAddress : lastInbound.toAddresses[0];
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const id = randomUUID();
  const messageId = `<${id}@${c.emailAccount.emailAddress.split('@')[1]}>`;
  const subject = c.subject?.toLowerCase().startsWith('re:') ? c.subject : `Re: ${c.subject ?? ''}`;
  const refs = [...lastInbound.references, lastInbound.internetMessageId].filter(Boolean) as string[];
  const text = c.emailAccount.signatureText ? `${bodyText}\n\n${c.emailAccount.signatureText}` : bodyText;
  const res = await adapters().email[c.emailAccount.provider].send(await getAuth(c.emailAccountId), {
    from: { address: c.emailAccount.emailAddress, name: c.emailAccount.displayName ?? ws.senderLegalName ?? undefined }, to, subject, text,
    messageId, inReplyTo: lastInbound.internetMessageId ?? undefined, references: refs, threadId: c.providerThreadId.startsWith('<') ? undefined : c.providerThreadId,
    headers: { [OUTBOUND_HEADER]: `reply-${id}` },
  });
  await db().emailMessage.create({ data: { workspaceId, conversationId, emailAccountId: c.emailAccountId, direction: 'OUTBOUND', providerMessageId: res.providerMessageId ?? `pending:reply-${id}`, internetMessageId: res.internetMessageId, inReplyTo: lastInbound.internetMessageId, references: refs, fromAddress: c.emailAccount.emailAddress, toAddresses: [to], ccAddresses: [], subject, bodyText: text, snippet: text.slice(0, 200), sentAt: new Date() } });
  await db().conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date(), status: 'WAITING', isUnread: false } });
  await audit(workspaceId, { type: 'USER', userId }, 'conversation.reply_sent', { type: 'conversation', id: conversationId });
  await publish(workspaceId, 'inbox.updated', { conversationId });
}

export const ForwardSchema = z.object({ to: z.string().email(), note: z.string().max(5000).default(''), idempotencyKey: z.string().min(8).max(100).optional() });

/** Forward a conversation (human action) from its original mailbox. Suppressed addresses are refused. */
export async function queueForward(workspaceId: string, conversationId: string, input: z.infer<typeof ForwardSchema>, actor: Actor) {
  const c = await db().conversation.findFirst({ where: { id: conversationId, workspaceId }, include: { emailAccount: true } });
  if (!c) throw NotFound('Conversation');
  if (c.emailAccount.status !== 'CONNECTED') throw new AppError('ACCOUNT_NOT_CONNECTED', `The mailbox ${c.emailAccount.emailAddress} is ${c.emailAccount.status}`, 409);
  const to = input.to.toLowerCase();
  if ((await (await import('./compliance.js')).isSuppressed(workspaceId, to)).suppressed) throw new AppError('SUPPRESSED', 'That address is on the suppression list', 409);
  const key = input.idempotencyKey ?? randomUUID();
  await enqueue(QUEUES.replySend, 'reply.forward', { workspaceId, conversationId, to, note: input.note, userId: actor.userId, key }, { jobId: `fwd-${key}`, attempts: 1 });
  await audit(workspaceId, actor, 'conversation.forward_queued', { type: 'conversation', id: conversationId }, { to });
  return { queued: true, idempotencyKey: key };
}

export async function sendForward(workspaceId: string, conversationId: string, to: string, note: string, userId: string | null) {
  const c = await db().conversation.findFirstOrThrow({ where: { id: conversationId, workspaceId }, include: { emailAccount: true, messages: { orderBy: { sentAt: 'asc' } } } });
  const quoted = c.messages.map((m) => `---------- ${m.direction === 'INBOUND' ? 'From' : 'Sent by'} ${m.fromAddress} on ${m.sentAt.toUTCString()}\nSubject: ${m.subject ?? ''}\n\n${(m.bodyText ?? '').slice(0, 20000)}`).join('\n\n');
  const text = `${note ? `${note}\n\n` : ''}${quoted}`;
  const id = randomUUID();
  await adapters().email[c.emailAccount.provider].send(await getAuth(c.emailAccountId), {
    from: { address: c.emailAccount.emailAddress, name: c.emailAccount.displayName ?? undefined }, to, subject: `Fwd: ${c.subject ?? ''}`, text,
    messageId: `<${id}@${c.emailAccount.emailAddress.split('@')[1]}>`, headers: { [OUTBOUND_HEADER]: `fwd-${id}` },
  });
  await db().note.create({ data: { workspaceId, conversationId, leadId: c.leadId, authorId: userId, body: `Forwarded to ${to}` } });
  await audit(workspaceId, { type: 'USER', userId }, 'conversation.forwarded', { type: 'conversation', id: conversationId }, { to });
}

function threadText(messages: Array<{ direction: string; fromAddress: string; sentAt: Date; bodyText: string | null }>) {
  return neutralizeTags(messages.map((m) => `[${m.direction} ${m.fromAddress} ${m.sentAt.toISOString()}]\n${(m.bodyText ?? '').split(/\nOn .+wrote:/)[0].slice(0, 3000)}`).join('\n\n'));
}

export async function summarize(workspaceId: string, conversationId: string) {
  const c = await getConversation(workspaceId, conversationId);
  const r = await runAi<{ summary: string; openQuestions: string[]; suggestedNextAction: string }>(workspaceId, 'CONVERSATION_SUMMARY', { thread: threadText(c.messages) }, { entity: { type: 'conversation', id: conversationId } });
  await db().conversation.update({ where: { id: conversationId }, data: { summary: r.data.summary } });
  return r.data;
}

/** AI reply draft for human review — never sent automatically. */
export async function draftReply(workspaceId: string, conversationId: string) {
  const c = await getConversation(workspaceId, conversationId);
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const settings = readSettings(ws.settings);
  const claims = c.leadId ? await supportedClaims(workspaceId, c.leadId) : [];
  const r = await runAi<{ body: string; usedClaimIds: string[] }>(workspaceId, 'REPLY_DRAFT', {
    offer: settings.offerFacts || '(none provided)', bookingLink: settings.bookingLink ?? '(none)',
    claims: claims.map((x) => `- [${x.id}] ${x.text}`).join('\n') || '(none)', thread: threadText(c.messages),
  }, { entity: { type: 'conversation', id: conversationId } });
  const check = c.leadId ? await factCheck(workspaceId, c.leadId, r.data.body, settings.offerFacts) : null;
  return { body: r.data.body, factCheck: check, note: 'Draft only. Review and edit before sending.' };
}

export async function downloadAttachment(workspaceId: string, attachmentId: string) {
  const a = await db().emailAttachment.findFirst({ where: { id: attachmentId, workspaceId } });
  if (!a?.storageKey) throw NotFound('Attachment');
  assertKeyBelongsTo(a.storageKey, workspaceId); // defence in depth: the object key itself must be in this workspace's prefix
  return { stream: store().stream(a.storageKey), filename: a.filename, contentType: a.contentType };
}

export function threadForAi(text: string) { return wrapUntrusted('email-thread', text); }
