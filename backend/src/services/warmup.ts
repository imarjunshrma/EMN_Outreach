import { WARMUP_DEV_WORKSPACE } from '../core/warmup-test-safety.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit, WORKER_ACTOR, type Actor } from '../core/audit.js';
import { acquireLock } from '../core/redis.js';
import { adapters } from '../core/container.js';
import { getAuth, mailboxBounceRisk, markNeedsReauth, testAccount } from './accounts.js';
import { isSuppressed } from './compliance.js';
import { readSettings } from './workspace.js';
import { SendingWindowSchema, isInWindow, isValidZone, startOfDayIn, nextWindowStart } from '../../../shared/src/schedule.js';
import { OUTBOUND_HEADER, type NormalizedMessage } from '../../../integrations/src/email/types.js';
import { ProviderError } from '../../../integrations/src/http.js';

export const WarmupConfig = z.object({
  startAt: z.iso.datetime(),
  durationDays: z.number().int().min(3).max(90),
  window: SendingWindowSchema.extend({ timezone: z.string().refine(isValidZone) }).refine(w =>
    [w.start, w.end].every(t => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)) && w.start < w.end, 'Enter a valid same-day sending window.'),
  pauseDates: z.array(z.iso.date()).max(90).default([]),
  startingTarget: z.number().int().min(1).max(50),
  maximumTarget: z.number().int().min(1).max(50),
  hourlyLimit: z.number().int().min(1).max(50),
  minIntervalSeconds: z.number().int().min(60).max(3600),
  mode: z.enum(['RECOMMENDED', 'CUSTOM']),
  increment: z.number().int().min(1).max(10),
  observationDays: z.number().int().min(1).max(30),
  minimumSample: z.number().int().min(1).max(500),
  maxBouncePct: z.number().min(0).max(5),
  subject: z.string().trim().min(5).max(160).regex(/^[^\r\n]+$/),
  body: z.string().trim().min(30).max(5000),
}).refine(c => c.startingTarget <= c.maximumTarget && c.observationDays <= c.durationDays, 'Review target and observation bounds.');
export type WarmupConfig = z.infer<typeof WarmupConfig>;

export const WarmupRecipients = z.object({ recipients: z.array(z.object({
  email: z.email().transform(e => e.toLowerCase()),
  evidence: z.string().trim().min(10).max(500),
  dailyLimit: z.number().int().min(1).max(5),
  authorized: z.literal(true),
})).min(1).max(100) });

export const WarmupAction = z.object({ action: z.enum(['START', 'PAUSE', 'RESUME', 'STOP']), confirmed: z.literal(true) });
const OPEN = ['READY_TO_START', 'ACTIVE', 'PAUSED', 'HEALTH_HOLD', 'AUTH_REQUIRED'] as const;
const DAY = 86_400_000;
const quotaStatuses = ['RESERVED', 'ACCEPTED', 'UNCERTAIN', 'REJECTED'] as const;
const mailboxView = { id: true, emailAddress: true, provider: true, status: true, dailySendLimit: true } as const;
const conflict = (message: string) => new AppError('CONFLICT', message, 409);

function requireOperator(actor: Actor) {
  if (actor.type !== 'USER' || !actor.userId) throw new AppError('FORBIDDEN', 'A signed-in workspace administrator is required.', 403);
  return actor.userId;
}

export async function warmupOverview(workspaceId: string) {
  const [mailboxes, programs, metrics] = await Promise.all([
    db().emailAccount.findMany({ where: { workspaceId }, select: mailboxView }),
    db().warmupProgram.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 300, include: {
      emailAccount: { select: mailboxView },
      _count: { select: { recipients: true, messages: true } },
    } }),
    db().warmupMessage.groupBy({ where: { workspaceId }, by: ['programId', 'status', 'hardBounce'], _count: { _all: true } }),
  ]);
  return { mailboxes, programs, metrics };
}

export async function warmupDetail(workspaceId: string, id: string) {
  const program = await db().warmupProgram.findFirst({ where: { workspaceId, id }, include: {
    emailAccount: { select: { ...mailboxView, operatorPaused: true, domain: { select: {
      spfStatus: true, dkimStatus: true, dmarcStatus: true, healthStatus: true,
    } } } }, recipients: { orderBy: { authorizedAt: 'desc' } },
  } });
  if (!program) throw NotFound('Warm-up program');
  const [messages, daily, history] = await Promise.all([
    db().warmupMessage.findMany({ where: { workspaceId, programId: id }, orderBy: { reservedAt: 'desc' }, take: 100, include: { recipient: { select: { email: true } } } }),
    db().$queryRaw<{ day: string; status: string; bounced: boolean; replied: boolean; count: number }[]>`
      SELECT to_char("reservedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, status::text,
        ("bouncedAt" IS NOT NULL) AS bounced, ("repliedAt" IS NOT NULL) AS replied, count(*)::int AS count
      FROM "WarmupMessage" WHERE "workspaceId" = ${workspaceId}::uuid AND "programId" = ${id}::uuid
      GROUP BY 1, 2, 3, 4 ORDER BY 1 DESC`,
    db().auditLog.findMany({ where: { workspaceId, entityType: 'warmup_program', entityId: id }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  return { ...program, messages, daily, history };
}

function startingTarget(config: WarmupConfig, dailyLimit: number) {
  return Math.min(config.startingTarget, dailyLimit, config.mode === 'RECOMMENDED' ? 2 : dailyLimit);
}

export async function enrollWarmup(workspaceId: string, emailAccountId: string, config: WarmupConfig, actor: Actor) {
  requireOperator(actor);
  const account = await db().emailAccount.findFirst({ where: { workspaceId, id: emailAccountId } });
  if (!account) throw NotFound('Mailbox');
  if (account.status !== 'CONNECTED' || account.operatorPaused) throw conflict('Connect and resume the mailbox before enrolling.');
  const health = await testAccount(workspaceId, emailAccountId);
  if (!health.ok) throw conflict('Mailbox connectivity verification failed.');
  let program;
  try {
    program = await db().warmupProgram.create({ data: { workspaceId, emailAccountId, config, dailyTarget: startingTarget(config, account.dailySendLimit) } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('There is already an open program for this mailbox.');
    throw e;
  }
  await audit(workspaceId, actor, 'warmup.enrolled', { type: 'warmup_program', id: program.id });
  return program;
}

export async function updateWarmupConfig(workspaceId: string, id: string, config: WarmupConfig, actor: Actor) {
  requireOperator(actor);
  const program = await db().warmupProgram.findFirst({ where: { workspaceId, id }, include: { emailAccount: { select: { dailySendLimit: true } } } });
  if (!program) throw NotFound('Warm-up program');
  const updated = await db().warmupProgram.updateMany({
    where: { workspaceId, id, status: 'READY_TO_START', updatedAt: program.updatedAt },
    data: { config, dailyTarget: startingTarget(config, program.emailAccount.dailySendLimit) },
  });
  if (!updated.count) throw conflict('Configuration can be changed only before the program starts.');
  await audit(workspaceId, actor, 'warmup.configured', { type: 'warmup_program', id });
  return { ok: true };
}

export async function addWarmupRecipients(workspaceId: string, id: string, input: z.infer<typeof WarmupRecipients>, actor: Actor) {
  const program = await db().warmupProgram.findFirst({ where: { workspaceId, id } });
  if (!program) throw NotFound('Warm-up program');
  const authorizedBy = requireOperator(actor);
  for (const r of input.recipients) {
    if (await db().lead.findUnique({ where: { workspaceId_emailNormalized: { workspaceId, emailNormalized: r.email } }, select: { id: true } }) || (await isSuppressed(workspaceId, r.email)).suppressed) {
      throw conflict('Prospects and suppressed addresses cannot be warm-up recipients.');
    }
  }
  await db().$transaction(input.recipients.map(({ email, evidence, dailyLimit }) => db().warmupRecipient.upsert({
    where: { programId_email: { programId: id, email } },
    create: { workspaceId, programId: id, email, evidence, dailyLimit, authorizedBy },
    update: { evidence, dailyLimit, authorizedBy, authorizedAt: new Date(), enabled: true },
  })));
  await audit(workspaceId, actor, 'warmup.recipients_authorized', { type: 'warmup_program', id }, { count: input.recipients.length });
  return { count: input.recipients.length };
}

export async function revokeWarmupRecipient(workspaceId: string, id: string, recipientId: string, actor: Actor) {
  requireOperator(actor);
  const changed = await db().warmupRecipient.updateMany({ where: { workspaceId, programId: id, id: recipientId }, data: { enabled: false } });
  if (!changed.count) throw NotFound('Warm-up recipient');
  await audit(workspaceId, actor, 'warmup.recipient_revoked', { type: 'warmup_program', id }, { recipientId });
  return { ok: true };
}

async function healthIssue(workspaceId: string, mailboxId: string, now: Date) {
  const account = await db().emailAccount.findFirstOrThrow({ where: { id: mailboxId, workspaceId }, include: { domain: true } });
  if (account.status === 'NEEDS_REAUTH') return { status: 'AUTH_REQUIRED' as const, reason: 'Mailbox must be reauthorized.' };
  if (account.status !== 'CONNECTED' || account.operatorPaused || (account.autoPauseUntil && account.autoPauseUntil > now)) return { status: 'HEALTH_HOLD' as const, reason: 'Mailbox is held or disconnected.' };
  if (account.domain?.spfStatus !== 'PASS' || account.domain.dkimStatus !== 'PASS' || account.domain.dmarcStatus !== 'PASS' ||
      !account.domain.lastCheckedAt || now.getTime() - account.domain.lastCheckedAt.getTime() > 3 * DAY) {
    return { status: 'HEALTH_HOLD' as const, reason: 'Refresh domain checks and confirm SPF, DKIM and DMARC before sending.' };
  }
  const workspace = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
  if (readSettings(workspace.settings).emergencyPause || await mailboxBounceRisk(workspaceId, mailboxId, account.sendingWindow, workspace.settings)) {
    return { status: 'HEALTH_HOLD' as const, reason: 'Workspace emergency pause or mailbox bounce safety threshold.' };
  }
  return null;
}

export async function changeWarmup(workspaceId: string, id: string, action: z.infer<typeof WarmupAction>['action'], actor: Actor) {
  requireOperator(actor);
  const program = await db().warmupProgram.findFirst({ where: { workspaceId, id } });
  if (!program) throw NotFound('Warm-up program');
  const permitted: Record<typeof action, readonly string[]> = {
    START: ['READY_TO_START'], RESUME: ['PAUSED', 'AUTH_REQUIRED', 'HEALTH_HOLD'], PAUSE: ['ACTIVE'], STOP: OPEN,
  };
  if (!permitted[action].includes(program.status)) throw conflict('This action is unavailable in the current state.');
  const now = new Date();
  if (action === 'START' || action === 'RESUME') {
    const issue = await healthIssue(workspaceId, program.emailAccountId, now);
    if (issue) throw conflict(issue.reason);
    if (await db().warmupMessage.count({ where: { programId: id, status: 'UNCERTAIN', resolvedAt: null } })) throw conflict('Resolve ambiguous submissions before resuming.');
    if (!await db().warmupRecipient.count({ where: { workspaceId, programId: id, enabled: true } })) throw conflict('Authorize at least one recipient first.');
    if (!(await testAccount(workspaceId, program.emailAccountId)).ok) throw conflict('Mailbox connection verification failed.');
  }
  const config = WarmupConfig.parse(program.config);
  const status = action === 'STOP' ? 'STOPPED' : action === 'PAUSE' ? 'PAUSED' : 'ACTIVE';
  const changed = await db().warmupProgram.updateMany({ where: { workspaceId, id, status: program.status, updatedAt: program.updatedAt }, data: {
    status, reason: null, nextAt: status === 'ACTIVE' ? new Date(Math.max(+now, +new Date(config.startAt))) : null,
    startedAt: status === 'ACTIVE' ? program.startedAt ?? now : undefined,
    progressedAt: status === 'ACTIVE' ? program.progressedAt ?? now : undefined,
    finishedAt: status === 'STOPPED' ? now : undefined,
  } });
  if (!changed.count) throw conflict('Program state changed.');
  await audit(workspaceId, actor, 'warmup.lifecycle', { type: 'warmup_program', id }, { action, status });
  return { status };
}

export async function countWarmupReservations(workspaceId: string, since: Date, emailAccountId?: string | { in: string[] }) {
  return db().warmupMessage.count({ where: { workspaceId, emailAccountId, reservedAt: { gte: since }, status: { in: [...quotaStatuses] } } });
}

async function transition(id: string, workspaceId: string, status: 'HEALTH_HOLD' | 'AUTH_REQUIRED' | 'COMPLETED', reason: string) {
  const r = await db().warmupProgram.updateMany({ where: { id, workspaceId, status: 'ACTIVE' }, data: {
    status, reason, nextAt: null, finishedAt: status === 'COMPLETED' ? new Date() : undefined,
  } });
  if (r.count) await audit(workspaceId, WORKER_ACTOR, 'warmup.health_transition', { type: 'warmup_program', id }, { status, reason });
}

export function evaluateProgress(config: WarmupConfig, target: number, elapsedDays: number, observedDays: number, accepted: number, bounces: number, failures: number) {
  if (bounces > 0 && 100 * bounces / Math.max(accepted, 1) >= config.maxBouncePct) return 'HOLD';
  const ready = observedDays >= (config.mode === 'RECOMMENDED' ? Math.max(3, config.observationDays) : config.observationDays) && accepted >= config.minimumSample && failures === 0;
  if (elapsedDays >= config.durationDays) return ready ? 'COMPLETE' : 'HOLD';
  if (ready && target < config.maximumTarget) return 'INCREASE';
  return 'OBSERVE';
}

function warmupWorkspaceScope(): Prisma.WarmupProgramWhereInput {
  return { workspace: { slug: process.env.OUTVEXA_WARMUP_TEST === 'dev' ? WARMUP_DEV_WORKSPACE : { not: WARMUP_DEV_WORKSPACE } } };
}

export async function processWarmup(id: string, now = new Date()) {
  const p = await db().warmupProgram.findFirst({ where: { ...warmupWorkspaceScope(), id, status: 'ACTIVE', nextAt: { lte: now } }, include: { emailAccount: true, workspace: true } });
  if (!p) return;
  if (await db().warmupMessage.count({ where: { programId: id, status: 'RESERVED' } })) return;
  const c = WarmupConfig.parse(p.config);
  const issue = await healthIssue(p.workspaceId, p.emailAccountId, now);
  if (issue) return transition(id, p.workspaceId, issue.status, issue.reason);
  const entitlements = await import('./entitlements.js');
  const tenant = await entitlements.tenantStateForWorkspace(p.workspaceId);
  if (!tenant.operational) return transition(id, p.workspaceId, 'HEALTH_HOLD', 'Organization is inactive.');
  try { await entitlements.assertMetered(tenant.organizationId, 'email_sends'); }
  catch { return transition(id, p.workspaceId, 'HEALTH_HOLD', 'Workspace sending allowance is unavailable.'); }

  const zone = c.window.timezone;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const observations = await db().warmupMessage.groupBy({ by: ['status', 'hardBounce'], where: {
    programId: id, reservedAt: { gte: p.progressedAt ?? p.createdAt },
  }, _count: { _all: true } });
  const tally = (status: string) => observations.filter(r => r.status === status).reduce((n, r) => n + r._count._all, 0);
  const bounceCount = observations.filter(r => r.hardBounce).reduce((n, r) => n + r._count._all, 0);
  if (await db().warmupMessage.count({ where: { programId: id, status: 'UNCERTAIN', resolvedAt: null } })) return transition(id, p.workspaceId, 'HEALTH_HOLD', 'Resolve ambiguous submissions before continuing.');
  const elapsed = Math.max(0, Math.floor((+now - Math.max(+(p.startedAt ?? now), +new Date(c.startAt))) / DAY));
  const acceptedDays = await db().$queryRaw<{ count: number }[]>`
    SELECT count(DISTINCT date_trunc('day', "acceptedAt" AT TIME ZONE ${zone}))::int AS count
    FROM "WarmupMessage" WHERE "programId" = ${id}::uuid AND "acceptedAt" >= ${p.progressedAt ?? p.createdAt}
  `;
  const evaluation = evaluateProgress(c, p.dailyTarget, elapsed, acceptedDays[0]?.count ?? 0, tally('ACCEPTED'), bounceCount, tally('REJECTED') + tally('NOT_SUBMITTED'));
  if (evaluation === 'HOLD') return transition(id, p.workspaceId, 'HEALTH_HOLD', 'Bounce threshold or completion observation criteria require administrator review.');
  if (evaluation === 'COMPLETE') return transition(id, p.workspaceId, 'COMPLETED', 'Observation and health criteria met. Inbox placement was not measured.');

  const release = await acquireLock(`send-quota:${p.workspaceId}`, 15_000);
  if (!release) return;
  let submission: { id: string; internetMessageId: string; to: string } | undefined;
  try {
    const current = await db().warmupProgram.findFirst({ where: { id, status: 'ACTIVE', nextAt: { lte: now } } });
    if (!current || +current.updatedAt !== +p.updatedAt || current.dailyTarget !== p.dailyTarget || await db().warmupMessage.count({ where: { programId: id, status: 'RESERVED' } })) return;
    const postpone = (at: Date) => db().warmupProgram.updateMany({ where: { id, status: 'ACTIVE', nextAt: { lte: now } }, data: { nextAt: at } });
    const account = await db().emailAccount.findFirstOrThrow({ where: { id: p.emailAccountId, workspaceId: p.workspaceId } });
    const mailboxWindow = SendingWindowSchema.safeParse(account.sendingWindow);
    const limits = account.sendingWindow as { enabled?: boolean; hourlySendLimit?: number; maxSecondsBetweenSends?: number };
    const mailboxZone = mailboxWindow.success ? mailboxWindow.data.timezone ?? p.workspace.timezone : p.workspace.timezone;
    if (account.status !== 'CONNECTED' || account.operatorPaused) return;
    if (!isInWindow(now, c.window, zone)) return void await postpone(nextWindowStart(now, c.window, zone));
    if (c.pauseDates.includes(date)) return void await postpone(new Date(+now + 60 * 60_000));
    if (limits.enabled && (!mailboxWindow.success || !isInWindow(now, mailboxWindow.data, mailboxZone))) return void await postpone(new Date(+now + 60_000));
    const spacing = Math.max(c.minIntervalSeconds, account.minSecondsBetweenSends, limits.maxSecondsBetweenSends ?? 0) * 1000;
    if (account.lastSentAt && +account.lastSentAt + spacing > +now) return void await postpone(new Date(+account.lastSentAt + spacing));
    const settings = readSettings((await db().workspace.findUniqueOrThrow({ where: { id: p.workspaceId }, select: { settings: true } })).settings);
    if (settings.emergencyPause) return;
    const readiness = (account.connectionConfig as { readiness?: { enabled?: boolean; currentDailyCap?: number } } | null)?.readiness;
    const mailboxLimit = Math.min(account.dailySendLimit, settings.mailboxReadinessManagement && readiness?.enabled ? readiness.currentDailyCap ?? 5 : account.dailySendLimit);
    const count = async (since: Date, emailAccountId?: string | { in: string[] }) => {
      const other = await db().outboundEmail.count({ where: { workspaceId: p.workspaceId, emailAccountId, OR: [
        { status: 'SENT', sentAt: { gte: since } }, { status: { in: ['SENDING', 'UNCERTAIN'] }, sendStartedAt: { gte: since } },
      ] } });
      return other + await countWarmupReservations(p.workspaceId, since, emailAccountId);
    };
    const since = startOfDayIn(zone, now);
    const mailboxDay = startOfDayIn(mailboxZone, now);
    const hour = new Date(+now - 3600_000);
    const programCount = (date: Date) => db().warmupMessage.count({ where: { programId: id, reservedAt: { gte: date }, status: { in: [...quotaStatuses] } } });
    const observationElapsed = +now - +(current.progressedAt ?? current.createdAt);
    const target = evaluation === 'INCREASE' && observationElapsed >= c.observationDays * DAY ? Math.min(c.maximumTarget, current.dailyTarget + (c.mode === 'CUSTOM' ? c.increment : 1), mailboxLimit) : current.dailyTarget;
    if (await programCount(since) >= target || await programCount(hour) >= c.hourlyLimit ||
        await count(mailboxDay, account.id) >= mailboxLimit || (limits.hourlySendLimit && await count(hour, account.id) >= limits.hourlySendLimit)) return void await postpone(new Date(+now + 60_000));
    const workspaceDay = startOfDayIn(p.workspace.timezone, now);
    if (settings.dailyEmailSendLimit !== null && await count(workspaceDay) >= settings.dailyEmailSendLimit) return void await postpone(new Date(+now + 60_000));
    if (settings.dailyDomainSendLimit !== null) {
      const accounts = await db().emailAccount.findMany({ where: { workspaceId: p.workspaceId, emailAddress: { endsWith: `@${account.emailAddress.split('@').at(-1)}` } }, select: { id: true } });
      if (await count(workspaceDay, { in: accounts.map(a => a.id) }) >= settings.dailyDomainSendLimit) return void await postpone(new Date(+now + 60_000));
    }
    const recipients = await db().warmupRecipient.findMany({ where: { programId: id, workspaceId: p.workspaceId, enabled: true }, orderBy: { id: 'asc' } });
    for (const r of recipients) {
      if ((await isSuppressed(p.workspaceId, r.email)).suppressed || await db().lead.findUnique({ where: { workspaceId_emailNormalized: { workspaceId: p.workspaceId, emailNormalized: r.email } }, select: { id: true } })) continue;
      if (await db().warmupMessage.count({ where: { recipientId: r.id, reservedAt: { gte: since }, status: { in: [...quotaStatuses] } } }) >= r.dailyLimit) continue;
      const row = await db().$transaction(async tx => {
        const claimed = await tx.warmupProgram.updateMany({ where: { id, status: 'ACTIVE', nextAt: { lte: now } }, data: {
          nextAt: new Date(+now + spacing), dailyTarget: target, progressedAt: target > current.dailyTarget ? now : undefined,
        } });
        if (!claimed.count) return;
        await tx.emailAccount.update({ where: { id: account.id }, data: { lastSentAt: now } });
        return tx.warmupMessage.create({ data: {
          workspaceId: p.workspaceId, programId: id, recipientId: r.id, emailAccountId: account.id, reservedAt: now,
          internetMessageId: `<warmup-${randomUUID()}@${account.emailAddress.split('@').at(-1)}>`,
        } });
      });
      if (row) submission = { id: row.id, internetMessageId: row.internetMessageId, to: r.email };
      break;
    }
    if (!submission) {
      if (!recipients.length) await transition(id, p.workspaceId, 'HEALTH_HOLD', 'No authorized recipients remain.');
      else await postpone(new Date(+now + 60_000));
    }
  } finally { await release(); }
  if (!submission) return;
  const send = submission;
  let started = false;
  try {
    const auth = await getAuth(p.emailAccountId);
    const eligible = await db().warmupMessage.findFirst({
      where: { id: send.id, status: 'RESERVED', recipient: { enabled: true },
        program: { status: 'ACTIVE', emailAccount: { status: 'CONNECTED', operatorPaused: false } } },
    });
    if (!eligible || (await isSuppressed(p.workspaceId, send.to)).suppressed ||
        await db().lead.findUnique({ where: { workspaceId_emailNormalized: { workspaceId: p.workspaceId, emailNormalized: send.to } }, select: { id: true } })) {
      await db().warmupMessage.updateMany({ where: { id: send.id, status: 'RESERVED' }, data: { status: 'NOT_SUBMITTED', reason: 'Eligibility changed before submission.' } });
      return;
    }
    const issue = await healthIssue(p.workspaceId, p.emailAccountId, new Date());
    if (issue) {
      await db().warmupMessage.updateMany({ where: { id: send.id, status: 'RESERVED' }, data: { status: 'NOT_SUBMITTED', reason: issue.reason } });
      return transition(id, p.workspaceId, issue.status, issue.reason);
    }
    started = true;
    const result = await adapters().email[p.emailAccount.provider].send(auth, {
      from: { address: p.emailAccount.emailAddress }, to: send.to, subject: c.subject, text: c.body,
      messageId: send.internetMessageId, headers: { [OUTBOUND_HEADER]: send.id, 'X-Outvexa-Traffic': 'warmup' },
    });
    await db().warmupMessage.updateMany({ where: { id: send.id, status: 'RESERVED' }, data: { status: 'ACCEPTED', acceptedAt: now, providerMessageId: result.providerMessageId, providerThreadId: result.providerThreadId, internetMessageId: result.internetMessageId || send.internetMessageId } });
    await (await import('./usage.js')).meter({ workspaceId: p.workspaceId, metric: 'email_sends', quantity: 1, key: `warmup:${send.id}`, at: now });
  } catch (error) {
    const status = error instanceof ProviderError ? error.status : undefined;
    const authFailure = status === 401 || status === 403;
    const rejected = status != null && status >= 400 && status < 500 && status !== 408;
    const classification = !started ? 'NOT_SUBMITTED' : rejected ? 'REJECTED' : 'UNCERTAIN';
    await db().warmupMessage.updateMany({ where: { id: send.id, status: 'RESERVED' }, data: { status: classification, reason: status ? `Provider status ${status}` : 'Submission outcome unavailable' } });
    if (rejected && error instanceof ProviderError && error.code === 'RECIPIENT_NOT_FOUND') {
      await db().warmupRecipient.updateMany({ where: { workspaceId: p.workspaceId, programId: id, email: send.to }, data: { enabled: false } });
    }
    if (authFailure) await markNeedsReauth(p.workspaceId, p.emailAccountId, 'Warm-up provider authorization failed.');
    await transition(id, p.workspaceId, authFailure ? 'AUTH_REQUIRED' : 'HEALTH_HOLD', authFailure ? 'Provider authorization failed.' : 'Warm-up submission requires operator review.');
  }
}

export async function tickWarmup(now = new Date()) {
  const stale = await db().warmupMessage.findMany({ where: { program: warmupWorkspaceScope(), status: 'RESERVED', reservedAt: { lt: new Date(+now - 15 * 60_000) } }, take: 100 });
  for (const row of stale) {
    const result = await db().warmupMessage.updateMany({ where: { id: row.id, status: 'RESERVED' }, data: { status: 'UNCERTAIN', reason: 'Interrupted after reservation; confirm through the provider.' } });
    if (result.count) await transition(row.programId, row.workspaceId, 'HEALTH_HOLD', 'Interrupted submission requires reconciliation.');
  }
  const due = await db().warmupProgram.findMany({ where: { ...warmupWorkspaceScope(), status: 'ACTIVE', nextAt: { lte: now } }, orderBy: { nextAt: 'asc' }, select: { id: true }, take: 100 });
  return Promise.allSettled(due.map(row => processWarmup(row.id, now)));
}

export async function ingestWarmup(workspaceId: string, emailAccountId: string, m: NormalizedMessage, outbound: boolean) {
  const ids = outbound ? [m.internetMessageId] : [m.bounce?.originalMessageId, m.inReplyTo, ...m.references];
  const references = ids.filter((id): id is string => !!id);
  const marker = (outbound ? m.outboundId : m.bounce?.outboundId) ?? '';
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(marker) ? marker : undefined;
  if (!references.length && !uuid) return false;
  const found = await db().warmupMessage.findFirst({ where: { workspaceId, emailAccountId, OR: [
    { internetMessageId: { in: references } }, ...(uuid ? [{ id: uuid }] : []),
  ] }, include: { recipient: { select: { email: true } } } });
  if (!found) return false;
  if (outbound && m.to.some(address => address.toLowerCase() === found.recipient.email)) {
    if ((found.status !== 'RESERVED' && found.status !== 'UNCERTAIN') || found.resolvedAt) return true;
    const account = await db().emailAccount.findFirstOrThrow({ where: { id: emailAccountId, workspaceId }, select: { provider: true } });
    // A From header is not proof that the provider stored the message in Sent.
    const sent = await adapters().email[account.provider].findSentByOutboundId(await getAuth(emailAccountId), {
      outboundId: found.id, to: found.recipient.email, since: found.reservedAt,
    });
    if (!sent) return true;
    const accepted = await db().warmupMessage.updateMany({ where: { id: found.id, status: { in: ['RESERVED', 'UNCERTAIN'] }, resolvedAt: null }, data: {
      status: 'ACCEPTED', acceptedAt: m.date, providerMessageId: sent.providerMessageId, providerThreadId: sent.providerThreadId,
      internetMessageId: sent.internetMessageId || found.internetMessageId,
    } });
    if (accepted.count) await (await import('./usage.js')).meter({ workspaceId, metric: 'email_sends', quantity: 1, key: `warmup:${found.id}`, at: m.date });
  } else if (!outbound && m.bounce && (!m.bounce.recipient || m.bounce.recipient.toLowerCase() === found.recipient.email)) {
    await db().warmupMessage.updateMany({ where: { id: found.id, bouncedAt: null }, data: { bouncedAt: m.date, hardBounce: m.bounce.hard } });
    if (m.bounce.hard) {
      await db().warmupRecipient.updateMany({ where: { id: found.recipientId, workspaceId }, data: { enabled: false } });
      await transition(found.programId, workspaceId, 'HEALTH_HOLD', 'Confirmed hard bounce in controlled warm-up.');
    }
  } else if (!outbound && !m.isAutoReply && !m.bounce && m.from.address.toLowerCase() === found.recipient.email) {
    await db().warmupMessage.updateMany({ where: { id: found.id, repliedAt: null }, data: { repliedAt: m.date } });
  }
  return true;
}

export async function resolveWarmupSubmission(workspaceId: string, programId: string, messageId: string, actor: Actor, input: {
  decision: 'CONFIRMED_ACCEPTED' | 'CONFIRMED_NOT_SUBMITTED' | 'STILL_UNCERTAIN' | 'MANUALLY_CLOSED';
  reason: string;
  evidence?: string;
}) {
  if (actor.type !== 'USER' || !actor.userId) throw new AppError('FORBIDDEN', 'A workspace administrator must review the attempt.', 403);
  const at = new Date();
  const review = { ...input, evidence: input.evidence ?? null, reviewedBy: actor.userId, reviewedAt: at.toISOString() };
  await db().$transaction(async tx => {
    const row = await tx.warmupMessage.findFirst({ where: { id: messageId, workspaceId, programId, status: 'UNCERTAIN' } });
    if (!row) throw NotFound('Warm-up submission');
    const changed = await tx.warmupMessage.updateMany({
      where: { id: messageId, workspaceId, programId, status: 'UNCERTAIN', resolvedAt: null },
      data: { reconciliation: review, resolvedAt: input.decision === 'STILL_UNCERTAIN' ? null : at },
    });
    if (!changed.count) throw conflict('This submission has already been reviewed.');
    await tx.auditLog.create({ data: {
      workspaceId, actorType: 'USER', actorUserId: actor.userId, entityType: 'warmup_program', entityId: programId,
      action: 'warmup.submission_reviewed', metadata: { messageId, ...review },
    } });
  });
  return { ok: true };
}
