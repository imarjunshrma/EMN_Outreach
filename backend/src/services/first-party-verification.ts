import { calculateEmailRisk, inspectEmail, validateEmailSyntax } from '../../../integrations/src/email-verification.js';
import { db, Prisma } from '../core/db.js';
import { config } from '../core/config.js';
import { acquireLock } from '../core/redis.js';
import { rateLimit } from '../core/redis.js';
import { classifyMailboxEvidence, probeRecipientSmtp, type SmtpResult } from '../../../integrations/src/email-verification-smtp.js';
import { randomUUID } from 'node:crypto';
import { isSuppressed } from './compliance.js';
import { verificationDictionaries } from './email-verification-datasets.js';
import { readSettings } from './workspace.js';

export async function createVerification(workspaceId: string, email: string, opts: { batchId?: string; leadId?: string; force?: boolean } = {}) {
  const input = email.trim().normalize('NFC');
  const syntax = validateEmailSyntax(input);
  const normalized = (syntax.valid ? syntax.normalizedEmail : input).toLowerCase();
  const ws = await db().workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
  const workspaceSettings = readSettings(ws?.settings);
  const dictionaries = await verificationDictionaries(workspaceId, workspaceSettings.verificationSmtpProbeEnabled, workspaceSettings.verificationSmtpMailFrom);
  // Serialize identical requests so retries and concurrent clients reuse the same queued row.
  // PostgreSQL transaction-scoped advisory locks do not add schema constraints or alter history.
  const lockKey = opts.batchId
    ? `email-verification:batch:${workspaceId}:${opts.batchId}:${normalized}`
    : `email-verification:request:${workspaceId}:${opts.leadId ?? ''}:${normalized}`;
  return db().$transaction(async (tx) => {
    // Prisma raw-query APIs must return a decodable value; PostgreSQL advisory locks
    // return void, so force the lock in a materialized CTE and select an integer.
    await tx.$queryRaw`WITH verification_lock AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))) SELECT 1 FROM verification_lock`;
    if (opts.batchId) {
      const existing = await tx.emailVerification.findFirst({ where: { workspaceId, batchId: opts.batchId, email: normalized, provider: 'first-party-dns' } });
      if (existing) return { id: existing.id, status: existing.result, cached: existing.rawResult !== 'queued', details: existing.details };
    } else {
      const pending = await tx.emailVerification.findFirst({ where: { workspaceId, email: normalized, provider: 'first-party-dns', rawResult: 'queued', ...(opts.leadId ? { leadId: opts.leadId } : { leadId: null }) }, orderBy: { createdAt: 'desc' } });
      if (pending) return { id: pending.id, status: pending.result, cached: false, details: pending.details };
    }
    const cached = await tx.emailVerification.findFirst({
      where: { workspaceId, email: normalized, provider: 'first-party-dns', expiresAt: { gt: new Date() }, ...(opts.leadId ? { leadId: opts.leadId } : { leadId: null }) },
      orderBy: { createdAt: 'desc' },
    });
    const currentCached = cached && (cached.details as { datasetVersion?: string } | null)?.datasetVersion === dictionaries.datasetVersion ? cached : null;
    if (currentCached && !opts.batchId && !opts.force) return { id: currentCached.id, status: currentCached.result, cached: true, details: currentCached.details };
    if (currentCached && opts.batchId) {
      const copy = await tx.emailVerification.create({ data: { workspaceId, batchId: opts.batchId, email: normalized, provider: 'first-party-dns', result: currentCached.result, rawResult: currentCached.rawResult, details: currentCached.details as Prisma.InputJsonValue, expiresAt: currentCached.expiresAt } });
      return { id: copy.id, status: copy.result, cached: true, details: copy.details };
    }
    const row = await tx.emailVerification.create({ data: {
      workspaceId, email: normalized, provider: 'first-party-dns', result: 'UNKNOWN',
      rawResult: 'queued', details: { state: 'QUEUED' },
      ...(opts.batchId ? { batchId: opts.batchId } : {}), ...(opts.leadId ? { leadId: opts.leadId } : {}),
    } });
    return { id: row.id, status: row.result, cached: false, details: row.details };
  });
}

/** The uploaded CSV row kept with each result, so exports can return the customer's own columns. Never dropped. */
export function sourceColumns(details: unknown): Record<string, unknown> {
  const d = (details ?? {}) as Record<string, unknown>;
  return { ...(d.originalRow !== undefined ? { originalRow: d.originalRow } : {}), ...(d.sourceRow !== undefined ? { sourceRow: d.sourceRow } : {}) };
}

export async function processFirstPartyVerification(workspaceId: string, verificationId: string, attempt = 1) {
  const row = await db().emailVerification.findFirst({ where: { id: verificationId, workspaceId, provider: 'first-party-dns' } });
  if (!row) return { skipped: 'verification record not found' };
  const workspace = await db().workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
  const workspaceSettings = readSettings(workspace?.settings);
  const cacheMs = workspaceSettings.verificationFreshnessDays * 86_400_000;
  // BullMQ can redeliver a job after a worker disappears while the row is processing.
  if (row.rawResult !== 'queued' && !(row.rawResult === 'processing' && attempt > 1)) return { skipped: 'already processed' };
  if (row.batchId) {
    const batch = await db().emailVerificationBatch.findFirst({ where: { id: row.batchId, workspaceId }, select: { status: true } });
    if (batch?.status === 'PAUSED' || batch?.status === 'CANCELLED') {
      if (row.rawResult === 'processing') await releaseFirstPartyVerification(workspaceId, row.id);
      return { skipped: `batch ${batch.status.toLowerCase()}` };
    }
  }
  const claim = await db().emailVerification.updateMany({
    where: { id: row.id, workspaceId, provider: 'first-party-dns', rawResult: row.rawResult },
    data: { rawResult: 'processing', step: attempt, details: { ...(row.details as Record<string, unknown>), state: 'PROCESSING', attempt, processingAt: new Date().toISOString() } },
  });
  if (!claim.count) return { skipped: 'another worker claimed this verification' };
  const result = await inspectEmail(row.email, undefined, 2500, await verificationDictionaries(workspaceId, workspaceSettings.verificationSmtpProbeEnabled, workspaceSettings.verificationSmtpMailFrom));
  const env = config();
  const mailFrom = workspaceSettings.verificationSmtpMailFrom || env.EMAIL_VERIFY_MAIL_FROM;
  let controlResult: SmtpResult | undefined;
  if (result.syntax.valid && result.dns.mx.length && workspaceSettings.verificationSmtpProbeEnabled && env.EMAIL_VERIFY_SMTP_ENABLED && mailFrom) {
    const release = await acquireLock(`email-verify-domain:${result.domain}`, 300_000);
    if (!release) throw new Error('SMTP domain cooldown is active; retry later');
    try {
      const mx = result.dns.mx.flatMap((m) => m.addresses.slice(0, 2).map((address) => ({ exchange: m.exchange, priority: m.priority, addresses: [address] }))).slice(0, 4);
      const claimSmtpProbe = async () => {
        const [domainLimit, globalLimit] = await Promise.all([rateLimit(`email-verify-smtp-domain:${result.domain}`, env.EMAIL_VERIFY_PER_DOMAIN_PER_MINUTE, 60), rateLimit('email-verify-smtp-global', env.EMAIL_VERIFY_GLOBAL_PER_MINUTE, 60)]);
        return domainLimit.allowed && globalLimit.allowed;
      };
      if (!await claimSmtpProbe()) throw new Error('SMTP verification rate limit reached; retry scheduled');
      result.smtp = await probeRecipientSmtp({ email: result.normalizedEmail, domain: result.domain, mx }, { enabled: true, mailFrom, timeoutMs: env.EMAIL_VERIFY_SMTP_TIMEOUT_MS });
      if (env.EMAIL_VERIFY_CATCH_ALL_ENABLED && result.smtp.classification === 'ACCEPTED_BUT_UNCONFIRMED') {
        if (!await claimSmtpProbe()) {
          result.catchAll = { status: 'UNKNOWN', reason: 'Control recipient probe skipped because the SMTP rate limit was reached', controlClassification: 'NOT_PROBED' };
        } else {
          const controlAddress = `emn-control-${randomUUID()}@${result.domain}`;
          controlResult = await probeRecipientSmtp({ email: controlAddress, domain: result.domain, mx }, { enabled: true, mailFrom, timeoutMs: env.EMAIL_VERIFY_SMTP_TIMEOUT_MS });
          result.catchAll = {
            status: controlResult.classification === 'ACCEPTED_BUT_UNCONFIRMED' ? 'SUSPECTED' : controlResult.classification === 'USER_UNKNOWN' ? 'NOT_CATCH_ALL' : 'UNKNOWN',
            reason: controlResult.classification === 'ACCEPTED_BUT_UNCONFIRMED' ? 'One randomized control recipient was accepted; catch-all is suspected, not confirmed' : controlResult.classification === 'USER_UNKNOWN' ? 'Random control recipient was rejected' : `Control result was ${controlResult.classification}`,
            controlClassification: controlResult.classification,
          };
        }
      }
      result.primaryStatus = classifyMailboxEvidence(result.smtp, controlResult);
      result.limitations = [
        'SMTP acceptance alone does not prove mailbox existence; VALID requires an accepted recipient plus rejection of a randomized control address',
        ...(result.primaryStatus === 'CATCH_ALL' ? ['A randomized control address was also accepted; CATCH_ALL is suspected from one probe'] : []),
        'SMTP status does not prove deliverability or inbox placement',
        'No DATA command or email delivery was performed',
      ];
      if (['TEMPORARY_FAILURE','GREYLISTED','CONNECTION_TIMEOUT','CONNECTION_RESET'].includes(result.smtp.classification) && attempt < 4) {
        await db().emailVerification.updateMany({ where: { id: row.id, workspaceId, rawResult: 'processing' }, data: { rawResult: 'queued', step: attempt, details: { ...result, ...sourceColumns(row.details), state: 'RETRYING', attempt } } });
        throw new Error(`Temporary SMTP result ${result.smtp.classification}; scheduled retry ${attempt + 1}`);
      }
    } finally { await release(); }
  } else {
    const reason = !workspaceSettings.verificationSmtpProbeEnabled
      ? 'Enable SMTP probing in this workspace verification settings'
      : !env.EMAIL_VERIFY_SMTP_ENABLED
        ? 'SMTP probing is disabled by the server configuration'
        : !mailFrom
          ? 'Set a verification sender address in this workspace settings or EMAIL_VERIFY_MAIL_FROM on the server'
          : 'SMTP recipient probing requires a valid MX record';
    result.smtp = { classification: 'DISABLED', reason };
  }
  const [suppression, lead] = await Promise.all([
    isSuppressed(workspaceId, row.email),
    db().lead.findFirst({ where: { workspaceId, emailNormalized: row.email }, select: { status: true } }),
  ]);
  const internalSignals = [
    ...(suppression.suppressed ? [`Suppressed in this workspace (${suppression.reason ?? 'suppressed'})`] : []),
    ...(lead?.status === 'BOUNCED' ? ['This workspace has a prior bounce for the address'] : []),
  ];
  result.risk = calculateEmailRisk(result, internalSignals);
  const stored = { ...result, ...sourceColumns(row.details), state: 'COMPLETE', checkedAt: new Date().toISOString() };
  await db().$transaction(async (tx) => {
    const updated = await tx.emailVerification.updateMany({ where: { id: row.id, workspaceId, rawResult: 'processing' }, data: {
      result: result.primaryStatus, rawResult: JSON.stringify(stored), details: stored, expiresAt: new Date(Date.now() + cacheMs),
    } });
    if (!updated.count) return;
    const linkedLeadId = row.leadId ?? (await tx.lead.findUnique({ where: { workspaceId_emailNormalized: { workspaceId, emailNormalized: row.email } }, select: { id: true } }))?.id;
    if (linkedLeadId) {
      await tx.lead.updateMany({ where: { id: linkedLeadId, workspaceId }, data: { emailVerificationStatus: result.primaryStatus, emailVerifiedAt: new Date() } });
      if (!row.leadId) await tx.emailVerification.updateMany({ where: { id: row.id, workspaceId, leadId: null }, data: { leadId: linkedLeadId } });
    }
    if (row.batchId) {
      const batch = await tx.emailVerificationBatch.findFirst({ where: { id: row.batchId, workspaceId } });
      if (batch && batch.status !== 'CANCELLED') {
        await tx.emailVerificationBatch.update({ where: { id: batch.id }, data: { processed: { increment: 1 }, ...(['INGESTING','PAUSED','CANCELLED','FAILED_IMPORT'].includes(batch.status) ? {} : { status: 'PROCESSING' }) } });
        const current = await tx.emailVerificationBatch.findUnique({ where: { id: batch.id }, select: { processed: true, total: true, status: true } });
        if (current && !['INGESTING','PAUSED','CANCELLED','FAILED_IMPORT'].includes(current.status) && current.processed >= current.total) await tx.emailVerificationBatch.update({ where: { id: batch.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      }
    }
  });
  return { id: row.id, result: result.primaryStatus, details: stored };
}

export async function releaseFirstPartyVerification(workspaceId: string, verificationId: string) {
  await db().$transaction(async (tx) => {
    const row = await tx.emailVerification.findFirst({ where: { id: verificationId, workspaceId, provider: 'first-party-dns', rawResult: 'processing' }, select: { id: true, batchId: true, details: true } });
    if (!row) return;
    const batch = row.batchId ? await tx.emailVerificationBatch.findFirst({ where: { id: row.batchId, workspaceId }, select: { status: true } }) : null;
    const cancelled = batch?.status === 'CANCELLED';
    await tx.emailVerification.updateMany({ where: { id: row.id, workspaceId, rawResult: 'processing' }, data: {
      rawResult: cancelled ? 'cancelled' : 'queued',
      details: { ...(row.details as Record<string, unknown>), state: cancelled ? 'CANCELLED' : 'QUEUED', ...(cancelled ? {} : { recoveredAt: new Date().toISOString() }) },
    } });
  });
}

export async function failFirstPartyVerification(workspaceId: string, verificationId: string, error: string) {
  const safe = error.replace(/[\r\n\t]+/g, ' ').slice(0, 160) || 'Verification failed';
  await db().$transaction(async (tx) => {
    const row = await tx.emailVerification.findFirst({ where: { id: verificationId, workspaceId, provider: 'first-party-dns', rawResult: { in: ['queued', 'processing'] } }, select: { id: true, batchId: true, details: true } });
    if (!row) return;
    await tx.emailVerification.updateMany({ where: { id: row.id, workspaceId, rawResult: { in: ['queued', 'processing'] } }, data: { rawResult: 'failed', details: { ...sourceColumns(row.details), state: 'FAILED', error: safe } as Prisma.InputJsonValue } });
    if (row.batchId) {
      const batch = await tx.emailVerificationBatch.findFirst({ where: { id: row.batchId, workspaceId } });
      if (!batch || batch.status === 'CANCELLED') return;
      await tx.emailVerificationBatch.update({ where: { id: batch.id }, data: { processed: { increment: 1 } } });
      const current = await tx.emailVerificationBatch.findUnique({ where: { id: batch.id }, select: { processed: true, total: true } });
      if (current && batch.status !== 'INGESTING' && batch.status !== 'FAILED_IMPORT' && current.processed >= current.total) await tx.emailVerificationBatch.update({ where: { id: batch.id }, data: { status: 'COMPLETED_WITH_ERRORS', completedAt: new Date() } });
    }
  });
}
