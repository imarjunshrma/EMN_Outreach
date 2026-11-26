import { Queue } from 'bullmq';
import { db, Prisma } from '../core/db.js';
import { adapters } from '../core/container.js';
import { createHmac } from 'node:crypto';
import { safeEqual } from '../core/crypto.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit, publish, notifyWorkspace, WORKER_ACTOR, type Actor } from '../core/audit.js';
import { ALL_QUEUE_NAMES, enqueue, queue, QUEUES, type QueueName } from '../core/queues.js';
import { assertKeyBelongsTo, store } from '../core/storage.js';
import { startOfDayIn } from '../../../shared/src/schedule.js';
import { checkDomain } from '../../../integrations/src/research/dns.js';
import { readSettings } from './workspace.js';
import { getSecret } from './integrations.js';
import { emitEvent } from './automation.js';
import { addSuppression } from './compliance.js';

// ---------------------------------------------------------------- dashboard

export async function dashboard(workspaceId: string) {
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const today = startOfDayIn(ws.timezone);
  const [sentToday, repliesToday, positiveOpen, reviewQueue, accountsAttention, tasksDue, running, failedJobs, unread] = await Promise.all([
    db().emailEvent.count({ where: { workspaceId, type: 'SENT', occurredAt: { gte: today } } }),
    db().emailEvent.count({ where: { workspaceId, type: 'REPLIED', occurredAt: { gte: today } } }),
    db().conversation.count({ where: { workspaceId, status: 'OPEN', category: { in: ['INTERESTED', 'WANTS_PRICING', 'WANTS_MEETING', 'NEEDS_INFO'] } } }),
    db().outboundEmail.count({ where: { workspaceId, status: 'AWAITING_APPROVAL' } }),
    db().emailAccount.findMany({ where: { workspaceId, status: { in: ['NEEDS_REAUTH', 'ERROR'] } }, select: { id: true, emailAddress: true, status: true, statusReason: true } }),
    db().task.count({ where: { workspaceId, status: 'OPEN', dueAt: { lte: new Date() } } }),
    db().campaign.findMany({ where: { workspaceId, status: { in: ['RUNNING', 'PAUSED', 'PENDING_APPROVAL'] } }, select: { id: true, name: true, status: true, pauseReason: true } }),
    db().jobRun.count({ where: { workspaceId, status: 'FAILED', createdAt: { gte: new Date(Date.now() - 86400_000) } } }),
    db().conversation.count({ where: { workspaceId, isUnread: true } }),
  ]);
  const setup = {
    postalAddress: !!ws.postalAddress, aiProvider: (await (await import('./ai-source.js')).aiAvailability(workspaceId)).ok,
    mailbox: (await db().emailAccount.count({ where: { workspaceId, status: 'CONNECTED' } })) > 0,
    icp: (await db().idealCustomerProfile.count({ where: { workspaceId } })) > 0,
    leads: (await db().lead.count({ where: { workspaceId } })) > 0,
  };
  return { sentToday, repliesToday, positiveOpen, reviewQueue, accountsAttention, tasksDue, campaigns: running, failedJobs24h: failedJobs, unreadConversations: unread, setup };
}

// ---------------------------------------------------------------- domains

export async function listDomains(workspaceId: string) {
  return db().domain.findMany({ where: { workspaceId }, orderBy: { name: 'asc' }, include: { _count: { select: { emailAccounts: true } }, checks: { orderBy: { checkedAt: 'desc' }, take: 1 } } });
}

export async function addDomain(workspaceId: string, name: string, selectors: string[] | undefined, actor: Actor) {
  const clean = name.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) throw new AppError('VALIDATION_FAILED', 'Invalid domain name', 400);
  const d = await db().domain.upsert({ where: { workspaceId_name: { workspaceId, name: clean } }, update: selectors ? { dkimSelectors: selectors } : {}, create: { workspaceId, name: clean, ...(selectors ? { dkimSelectors: selectors } : {}) } });
  await enqueue(QUEUES.domain, 'domain.check', { workspaceId, domainId: d.id });
  await audit(workspaceId, actor, 'domain.added', { type: 'domain', id: d.id });
  return d;
}

export async function deleteDomain(workspaceId: string, id: string, actor: Actor) {
  const r = await db().domain.deleteMany({ where: { id, workspaceId } });
  if (!r.count) throw NotFound('Domain');
  await audit(workspaceId, actor, 'domain.deleted', { type: 'domain', id });
}

export async function runDomainCheck(workspaceId: string, domainId: string) {
  const d = await db().domain.findFirst({ where: { id: domainId, workspaceId } });
  if (!d) return null;
  const r = await checkDomain(d.name, d.dkimSelectors, adapters().dns);
  const critical = r.issues.some((i) => i.severity === 'critical');
  const health = critical ? 'CRITICAL' : r.issues.length ? 'WARNING' : 'HEALTHY';
  const authentication = { SPF: r.spf.status, DKIM: r.dkim.status, DMARC: r.dmarc.status };
  const failures = Object.keys(authentication).filter(key => authentication[key as keyof typeof authentication] === 'FAIL');
  const healthy = Object.values(authentication).every(status => status === 'PASS');
  const sendingHoldReason = failures.length ? `Domain authentication failed: ${failures.join(', ')}` : healthy ? null : d.sendingHoldReason;
  const changed = await db().$transaction(async tx => {
    const updated = await tx.domain.updateMany({ where: { id: domainId, workspaceId, lastCheckedAt: d.lastCheckedAt }, data: {
      spfStatus: r.spf.status, dkimStatus: r.dkim.status, dmarcStatus: r.dmarc.status,
      mxStatus: r.mx.status, healthStatus: health, lastCheckedAt: new Date(), sendingHoldReason,
    } });
    if (!updated.count) return false;
    await tx.domainHealthCheck.create({ data: { workspaceId, domainId, spfStatus: r.spf.status, spfRecord: r.spf.record, dkimStatus: r.dkim.status, dkimResults: r.dkim.results as Prisma.InputJsonValue, dmarcStatus: r.dmarc.status, dmarcRecord: r.dmarc.record, mxStatus: r.mx.status, mxRecords: r.mx.records as Prisma.InputJsonValue, issues: r.issues as Prisma.InputJsonValue } });
    return true;
  });
  if (changed && sendingHoldReason !== d.sendingHoldReason) {
    await audit(workspaceId, WORKER_ACTOR, sendingHoldReason ? 'domain.sending_held' : 'domain.sending_recovered',
      { type: 'domain', id: domainId }, { authentication, reason: sendingHoldReason });
    await notifyWorkspace(workspaceId, 'ADMIN', {
      type: sendingHoldReason ? 'domain.sending_held' : 'domain.sending_recovered',
      title: sendingHoldReason ? `Sending held for ${d.name}` : `Authentication recovered for ${d.name}`,
      body: sendingHoldReason ?? 'A fresh DNS check passed SPF, DKIM and DMARC.', link: `/domains/${domainId}`,
    });
  }
  await publish(workspaceId, 'domain.checked', { domainId, health });
  return r;
}

export async function getDomain(workspaceId: string, id: string) {
  const d = await db().domain.findFirst({ where: { id, workspaceId }, include: { checks: { orderBy: { checkedAt: 'desc' }, take: 20 }, emailAccounts: { select: { id: true, emailAddress: true, provider: true } } } });
  if (!d) throw NotFound('Domain');
  return d;
}

// ---------------------------------------------------------------- job monitoring

export async function queueOverview() {
  const out = [];
  for (const name of ALL_QUEUE_NAMES) {
    const q = queue(name as QueueName);
    const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    out.push({ name, counts, isPaused: await q.isPaused() });
  }
  return out;
}

export async function failedJobs(workspaceId: string, queueName: QueueName, limit = 50) {
  const q: Queue = queue(queueName);
  const jobs = await q.getFailed(0, 200);
  return jobs
    .filter((j) => !j.data?.workspaceId || j.data.workspaceId === workspaceId)
    .slice(0, limit)
    .map((j) => ({ id: j.id, name: j.name, attemptsMade: j.attemptsMade, failedReason: j.failedReason?.slice(0, 500), timestamp: j.timestamp, finishedOn: j.finishedOn }));
}

export async function retryJob(workspaceId: string, queueName: QueueName, jobId: string, actor: Actor) {
  const job = await queue(queueName).getJob(jobId);
  if (!job || (job.data?.workspaceId && job.data.workspaceId !== workspaceId)) throw NotFound('Job');
  await job.retry();
  await audit(workspaceId, actor, 'job.retried', { type: 'job', id: jobId }, { queue: queueName });
}

export async function jobHistory(workspaceId: string, q: { page: number; pageSize: number; status?: string; queue?: string }) {
  const where: Prisma.JobRunWhereInput = { workspaceId, ...(q.status ? { status: q.status as never } : {}), ...(q.queue ? { queue: q.queue } : {}) };
  const [items, total] = await Promise.all([db().jobRun.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }), db().jobRun.count({ where })]);
  return { items, total };
}

// ---------------------------------------------------------------- logs & notifications

export async function auditLogs(workspaceId: string, q: { page: number; pageSize: number; action?: string; actorUserId?: string; entityType?: string }) {
  const where: Prisma.AuditLogWhereInput = { workspaceId, ...(q.action ? { action: { contains: q.action } } : {}), ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}), ...(q.entityType ? { entityType: q.entityType } : {}) };
  const [items, total] = await Promise.all([db().auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { actor: { select: { name: true, email: true } } } }), db().auditLog.count({ where })]);
  return { items, total };
}

export async function errorLogs(workspaceId: string, q: { page: number; pageSize: number; source?: string }) {
  const where: Prisma.ErrorLogWhereInput = { workspaceId, ...(q.source ? { source: q.source } : {}) };
  const [items, total] = await Promise.all([db().errorLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }), db().errorLog.count({ where })]);
  return { items, total };
}

export async function listNotifications(workspaceId: string, userId: string) {
  const [items, unread] = await Promise.all([
    db().notification.findMany({ where: { workspaceId, userId }, orderBy: { createdAt: 'desc' }, take: 100 }),
    db().notification.count({ where: { workspaceId, userId, readAt: null } }),
  ]);
  return { items, unread };
}

export async function markNotificationsRead(workspaceId: string, userId: string, ids?: string[]) {
  await db().notification.updateMany({ where: { workspaceId, userId, readAt: null, ...(ids?.length ? { id: { in: ids } } : {}) }, data: { readAt: new Date() } });
}

// ---------------------------------------------------------------- privacy (export / erasure)

export async function createPrivacyRequest(workspaceId: string, type: 'EXPORT' | 'ERASURE', subjectEmail: string, actor: Actor) {
  const r = await db().privacyRequest.create({ data: { workspaceId, type, subjectEmail: subjectEmail.trim().toLowerCase() } });
  await enqueue(QUEUES.privacy, `privacy.${type.toLowerCase()}`, { workspaceId, requestId: r.id }, { attempts: 3 });
  await audit(workspaceId, actor, `privacy.${type.toLowerCase()}_requested`, { type: 'privacy_request', id: r.id });
  return r;
}

export async function listPrivacyRequests(workspaceId: string) {
  return db().privacyRequest.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 100 });
}

export async function processPrivacyRequest(workspaceId: string, requestId: string) {
  const r = await db().privacyRequest.findFirst({ where: { id: requestId, workspaceId } });
  if (!r || r.status === 'COMPLETED') return;
  const email = r.subjectEmail;
  const lead = await db().lead.findUnique({ where: { workspaceId_emailNormalized: { workspaceId, emailNormalized: email } }, include: { company: true, statusChanges: true, verifications: true, scores: true, notes: true, events: true, opportunities: true, researchReports: { include: { claims: true, evidence: { select: { url: true, fetchedAt: true } } } } } });
  const messages = await db().emailMessage.findMany({ where: { workspaceId, OR: [{ fromAddress: email }, { toAddresses: { has: email } }] }, select: { id: true, direction: true, subject: true, bodyText: true, sentAt: true, fromAddress: true, toAddresses: true } });
  const suppressions = await db().suppressionEntry.findMany({ where: { workspaceId, value: email } });
  if (r.type === 'EXPORT') {
    const data = Buffer.from(JSON.stringify({ subject: email, exportedAt: new Date().toISOString(), lead, messages, suppressions }, null, 2));
    const key = await (await import('./storage-accounting.js')).putTracked(workspaceId, 'privacy', data, 'json', { enforce: false }); // legal requests are never refused
    await db().privacyRequest.update({ where: { id: r.id }, data: { status: 'COMPLETED', completedAt: new Date(), resultStorageKey: key } });
  } else {
    await db().$transaction(async (tx) => {
      await tx.emailMessage.deleteMany({ where: { id: { in: messages.map((m) => m.id) } } });
      if (lead) {
        await tx.researchReport.deleteMany({ where: { leadId: lead.id } });
        await tx.lead.delete({ where: { id: lead.id } }); // cascades enrollments, events, notes, scores, verifications
      }
      await tx.conversation.deleteMany({ where: { workspaceId, messages: { none: {} } } });
    });
    // Keep only the minimum needed to honor "do not contact" and block re-imports.
    await addSuppression(workspaceId, { type: 'EMAIL', value: email, reason: 'DO_NOT_CONTACT_REQUEST', source: 'erasure_request' }, { type: 'SYSTEM' });
    await db().privacyRequest.update({ where: { id: r.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
  }
}

export async function downloadPrivacyExport(workspaceId: string, id: string) {
  const r = await db().privacyRequest.findFirst({ where: { id, workspaceId, type: 'EXPORT', status: 'COMPLETED' } });
  if (!r?.resultStorageKey) throw NotFound('Export');
  assertKeyBelongsTo(r.resultStorageKey, workspaceId);
  return store().stream(r.resultStorageKey);
}

/** Full workspace data export (JSON) for backups / portability. */
export async function workspaceExport(workspaceId: string, actor: Actor) {
  const [leads, companies, campaigns, conversations, suppressions, opportunities, tasks] = await Promise.all([
    db().lead.findMany({ where: { workspaceId } }), db().company.findMany({ where: { workspaceId } }),
    db().campaign.findMany({ where: { workspaceId }, include: { sequence: { include: { steps: { include: { variants: true } } } } } }),
    db().conversation.findMany({ where: { workspaceId }, include: { messages: { select: { direction: true, fromAddress: true, toAddresses: true, subject: true, bodyText: true, sentAt: true, category: true } } } }),
    db().suppressionEntry.findMany({ where: { workspaceId } }), db().opportunity.findMany({ where: { workspaceId } }), db().task.findMany({ where: { workspaceId } }),
  ]);
  await audit(workspaceId, actor, 'workspace.exported');
  return { exportedAt: new Date().toISOString(), leads, companies, campaigns, conversations, suppressions, opportunities, tasks };
}

// ---------------------------------------------------------------- maintenance & retention

export async function runRetention(now = new Date()) {
  const workspaces = await db().workspace.findMany();
  const result: Record<string, number> = { aiOutputs: 0, importFiles: 0, domainChecks: 0, sessions: 0, jobRuns: 0, auditLogs: 0 };
  for (const ws of workspaces) {
    const r = readSettings(ws.settings).retentionDays;
    result.aiOutputs += (await db().aiExecution.updateMany({ where: { workspaceId: ws.id, createdAt: { lt: new Date(now.getTime() - r.aiOutputs * 86400_000) }, NOT: { output: { equals: Prisma.DbNull } } }, data: { output: Prisma.DbNull, inputPreview: null } })).count;
    const oldImports = await db().importJob.findMany({ where: { workspaceId: ws.id, createdAt: { lt: new Date(now.getTime() - r.importFiles * 86400_000) }, storageKey: { not: '' } } });
    for (const j of oldImports) { await (await import('./storage-accounting.js')).deleteTracked(j.storageKey); await db().importJob.update({ where: { id: j.id }, data: { storageKey: '' } }); result.importFiles++; }
    result.domainChecks += (await db().domainHealthCheck.deleteMany({ where: { workspaceId: ws.id, checkedAt: { lt: new Date(now.getTime() - r.domainChecks * 86400_000) } } })).count;
    const auditCutoff = new Date(now.getTime() - r.auditLogs * 86400_000);
    result.auditLogs += await db().$transaction(async (tx) => {
      // The append-only trigger only lets this transaction delete audit rows (transaction-local flag).
      await tx.$executeRaw`SELECT set_config('emn.allow_audit_delete', 'on', true)`;
      return (await tx.auditLog.deleteMany({ where: { workspaceId: ws.id, createdAt: { lt: auditCutoff } } })).count;
    });
  }
  result.sessions = (await db().session.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date(now.getTime() - 30 * 86400_000) } }, { revokedAt: { lt: new Date(now.getTime() - 30 * 86400_000) } }] } })).count;
  result.jobRuns = (await db().jobRun.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 30 * 86400_000) } } })).count;
  await db().errorLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 90 * 86400_000) } } });
  return result;
}

// ---------------------------------------------------------------- tracking (optional, privacy-aware)

export const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export function isAutomatedTrackingRequest(headers: Record<string, string | string[] | undefined>) {
  const purpose = [headers['sec-purpose'], headers['purpose'], headers['x-purpose']].join(' ');
  const agent = String(headers['user-agent'] ?? '');
  return /\b(prefetch|prerender|preview)\b/i.test(purpose)
    || /bot\b|crawler|spider|scanner|proofpoint|mimecast|barracuda|safelinks|googleimageproxy/i.test(agent);
}

export async function recordOpen(outboundId: string, automated = false) {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(outboundId)) return;
  const o = await db().outboundEmail.findUnique({ where: { id: outboundId }, include: { campaign: true, enrollment: { select: { leadId: true } }, workspace: { select: { settings: true } } } });
  if (!o || o.status !== 'SENT' || !o.campaign.trackOpens || !readSettings(o.workspace.settings).trackingEnabled) return;
  const attribution = { leadId: o.enrollment.leadId, emailAccountId: o.emailAccountId };
  await db().$transaction(async tx => {
    await tx.outboundEmail.update({ where: { id: o.id }, data: {
      pixelRequestCount: { increment: 1 },
      automatedPixelRequestCount: { increment: automated ? 1 : 0 },
    } });
    if (automated) return;
    await tx.emailEvent.upsert({ where: { dedupeKey: `OPENED:${o.id}` }, update: attribution, create: {
      workspaceId: o.workspaceId, type: 'OPENED', campaignId: o.campaignId, enrollmentId: o.enrollmentId,
      outboundEmailId: o.id, ...attribution, dedupeKey: `OPENED:${o.id}`, metadata: { estimate: true },
    } });
  });
}

export function isTrackingDestination(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export async function recordClick(token: string, automated = false): Promise<string | null> {
  const l = await db().trackedLink.findUnique({
    where: { token },
    include: { outboundEmail: { include: { campaign: { select: { trackClicks: true } }, enrollment: { select: { leadId: true } }, workspace: { select: { settings: true } } } } },
  });
  if (!l || !isTrackingDestination(l.url)) return null;
  const o = l.outboundEmail;
  if (o.status !== 'SENT' || !o.campaign.trackClicks || !readSettings(o.workspace.settings).trackingEnabled) return l.url;
  const attribution = { leadId: o.enrollment.leadId, emailAccountId: o.emailAccountId };
  await db().$transaction(async tx => {
    await tx.trackedLink.update({ where: { id: l.id }, data: { clickCount: { increment: 1 }, automatedClickCount: { increment: automated ? 1 : 0 } } });
    if (automated) return;
    await tx.emailEvent.upsert({ where: { dedupeKey: `CLICKED:${o.id}:${l.id}` }, update: attribution, create: {
      workspaceId: o.workspaceId, type: 'CLICKED', campaignId: o.campaignId, enrollmentId: o.enrollmentId,
      outboundEmailId: o.id, ...attribution, dedupeKey: `CLICKED:${o.id}:${l.id}`, metadata: { url: l.url, estimate: true },
    } });
  });
  return l.url;
}

// ---------------------------------------------------------------- booking webhook (Cal.com / Calendly style)

/**
 * Accepts the signature formats of common schedulers:
 *  - EMN / generic: HMAC-SHA256(body) as base64url or hex, optionally prefixed "sha256="
 *  - Cal.com (x-cal-signature-256): hex HMAC-SHA256(body)
 *  - Calendly (calendly-webhook-signature): "t=<unix>,v1=<hex HMAC-SHA256(`${t}.${body}`)>", max age 5 minutes
 */
export function verifyBookingSignature(secret: string, rawBody: string, signature: string | undefined, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!signature) return false;
  const mac = (data: string, enc: 'hex' | 'base64url') => createHmac('sha256', secret).update(data).digest(enc);
  const parts = Object.fromEntries(signature.split(',').map((p) => p.trim().split('=', 2)).filter((kv) => kv.length === 2));
  if (parts.t && parts.v1) {
    const t = Number(parts.t);
    if (!Number.isFinite(t) || Math.abs(nowSec - t) > 300) return false;
    return safeEqual(parts.v1, mac(`${parts.t}.${rawBody}`, 'hex'));
  }
  const given = signature.replace(/^sha256=/, '');
  return safeEqual(given, mac(rawBody, 'base64url')) || safeEqual(given, mac(rawBody, 'hex'));
}

export async function handleBookingWebhook(workspaceId: string, rawBody: string, signature: string | undefined) {
  const s = await getSecret(workspaceId, 'booking');
  if (!s) throw new AppError('PROVIDER_NOT_CONFIGURED', 'Booking integration not configured', 404);
  if (!verifyBookingSignature(s.secret, rawBody, signature)) throw new AppError('UNAUTHENTICATED', 'Invalid signature', 401);
  const body = JSON.parse(rawBody) as Record<string, unknown>;
  const emails = new Set<string>();
  JSON.stringify(body).replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, (m) => { emails.add(m.toLowerCase()); return m; });
  let matched = 0;
  for (const e of emails) {
    const lead = await db().lead.findUnique({ where: { workspaceId_emailNormalized: { workspaceId, emailNormalized: e } } });
    if (!lead) continue;
    matched++;
    if (!['MEETING_BOOKED', 'CUSTOMER'].includes(lead.status)) {
      await db().lead.update({ where: { id: lead.id }, data: { status: 'MEETING_BOOKED', statusChanges: { create: { workspaceId, fromStatus: lead.status, toStatus: 'MEETING_BOOKED', reason: 'booking webhook' } } } });
    }
    await emitEvent(workspaceId, 'meeting.booked', `meeting:${lead.id}:${Date.now()}`, { leadId: lead.id });
    await publish(workspaceId, 'lead.updated', { leadId: lead.id });
  }
  return { matched };
}

export async function exportSuppressionCsv(workspaceId: string) {
  const rows = await db().suppressionEntry.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
  return ['type,value,reason,source,createdAt', ...rows.map((r) => [r.type, r.value, r.reason, r.source ?? '', r.createdAt.toISOString()].join(','))].join('\n');
}
