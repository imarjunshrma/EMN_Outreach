import { guardBrowserE2eQueue } from '../../backend/src/core/browser-e2e-safety.js';
import { DelayedError, type Job } from 'bullmq';
import { redis } from '../../backend/src/core/redis.js';
import { orgIdOf } from '../../backend/src/core/tenant.js';
import { tenantState } from '../../backend/src/services/entitlements.js';
import * as tenancy from '../../backend/src/services/tenancy.js';
import { db } from '../../backend/src/core/db.js';
import { QUEUES, enqueue, type QueueName } from '../../backend/src/core/queues.js';
import { logError } from '../../backend/src/core/audit.js';
import { logger } from '../../backend/src/core/logger.js';
import { importStages } from '../../backend/src/services/knowledge-import.js';
import * as engine from '../../backend/src/services/engine.js';
import * as accounts from '../../backend/src/services/accounts.js';
import * as inbox from '../../backend/src/services/inbox.js';
import * as leads from '../../backend/src/services/leads.js';
import * as intel from '../../backend/src/services/intelligence.js';
import * as ops from '../../backend/src/services/ops.js';
import * as automation from '../../backend/src/services/automation.js';
import * as webhooks from '../../backend/src/services/webhooks.js';
import * as crm from '../../backend/src/services/crm.js';
import * as personalization from '../../backend/src/services/personalization.js';
import * as workflows from '../../backend/src/services/workflows.js';
import * as domains from '../../backend/src/services/domains.js';
import * as enrichment from '../../backend/src/services/enrichment.js';
import * as replyAssist from '../../backend/src/services/reply-assist.js';
import * as insights from '../../backend/src/services/insights.js';

type Data = Record<string, unknown> & { workspaceId?: string };
type Handler = (job: Job<Data>) => Promise<unknown>;

const s = (v: unknown) => String(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wsOf = (d: Data) => (typeof d.workspaceId === 'string' && UUID.test(d.workspaceId) ? d.workspaceId : null);

/** Owner-only AI workflow stages. A busy provider slot re-queues the stage with a delay instead of failing it. */
function AI_WORKFLOW_HANDLERS(): Record<string, Handler> {
  return {
    'aiwf.stage': async (j) => {
      const runs = await import('../../backend/src/services/ai-workflow-runs.js');
      const data = j.data as unknown as import('../../backend/src/services/ai-workflow-runs.js').StageJobData;
      const r = await runs.processStageJob(data);
      if (r.delayMs) await enqueue(j.queueName as QueueName, 'aiwf.stage', j.data, { delay: r.delayMs, attempts: 1, jobId: `aiwf-delay_${data.runId}_${data.stageIndex}_${data.attempt}_${Date.now()}` });
      return r;
    },
    'aiwf.regenerate': async (j) => (await import('../../backend/src/services/ai-workflow-runs.js')).processRegenerateJob(j.data as never),
  };
}

/** Job handlers by queue and job name. Every handler is idempotent. */
function knowledgeImportHandlers() {
  return Object.fromEntries(importStages.map(stage => [stage, async (j: Job<Data>) => (
    await import('../../backend/src/services/knowledge-import-worker.js')
  ).processImportJob(j)]));
}

export const HANDLERS: Record<QueueName, Record<string, Handler>> = {
  [QUEUES.warmup]: {
    'warmup.tick': async () => (await import('../../backend/src/services/warmup.js')).tickWarmup(),
  },
  [QUEUES.scheduler]: {
    'campaign.tick': async (j) => engine.tick(new Date(), j.data.campaignId ? s(j.data.campaignId) : undefined),
  },
  [QUEUES.prepare]: {
    'outbound.prepare': async (j) => engine.prepareOutbound(s(j.data.workspaceId), s(j.data.outboundId)),
  },
  [QUEUES.send]: {
    'outbound.send': async (j) => engine.sendOutbound(s(j.data.workspaceId), s(j.data.outboundId)),
  },
  [QUEUES.replySend]: {
    'reply.forward': async (j) => inbox.sendForward(s(j.data.workspaceId), s(j.data.conversationId), s(j.data.to), String(j.data.note ?? ''), (j.data.userId as string) ?? null),
    'reply.send': async (j) => inbox.sendReply(s(j.data.workspaceId), s(j.data.conversationId), s(j.data.bodyText), (j.data.userId as string) ?? null),
  },
  [QUEUES.sync]: {
    'sync.account': async (j) => accounts.syncAccount(s(j.data.accountId)),
    'sync.pollAll': async () => {
      const list = await db().emailAccount.findMany({ where: { status: { in: ['CONNECTED', 'PAUSED'] } }, select: { id: true, workspaceId: true } });
      const bucket = Math.floor(Date.now() / 60_000);
      for (const a of list) await enqueue(QUEUES.sync, 'sync.account', { workspaceId: a.workspaceId, accountId: a.id }, { jobId: `sync-${a.id}-${bucket}`, attempts: 2 });
      return { queued: list.length };
    },
    'graph.renewAccount': async (j) => {
      const account = await db().emailAccount.findFirst({
        where: { id: s(j.data.accountId), workspaceId: s(j.data.workspaceId), provider: 'MICROSOFT', status: { in: ['CONNECTED', 'PAUSED'] } },
        select: { id: true },
      });
      if (account) await accounts.ensureGraphSubscription(account.id, j.data.recreate === true);
    },
    'graph.renew': async () => {
      const list = await db().emailAccount.findMany({ where: { provider: 'MICROSOFT', status: 'CONNECTED' }, select: { id: true } });
      if (process.env.GRAPH_WEBHOOKS_ENABLED !== 'true') return { skipped: 'GRAPH_WEBHOOKS_ENABLED is false (polling only)' };
      for (const a of list) await accounts.ensureGraphSubscription(a.id).catch((e) => logger.warn({ err: e, accountId: a.id }, 'graph renew failed'));
      return { renewed: list.length };
    },
  },
  [QUEUES.ai]: {
    'ai.classifyReply': async (j) => inbox.classifyMessage(s(j.data.workspaceId), s(j.data.messageId)),
    'ai.replyAssist': async (j) => replyAssist.processInbound(s(j.data.workspaceId), s(j.data.messageId)),
    'ai.qualify': async (j) => {
      const workspaceId = s(j.data.workspaceId);
      const leadId = s(j.data.leadId);
      const result = await intel.scoreLead(workspaceId, leadId, (j.data.icpId as string | null) ?? null);
      if (!result?.identityVerified || !result.qualified) return result;
      const latest = await db().researchReport.findFirst({ where: { workspaceId, leadId, status: 'COMPLETED' }, orderBy: { completedAt: 'desc' }, select: { id: true, researchDepth: true } });
      if (latest?.researchDepth !== 'INITIAL') return result;
      const { getConfig } = await import('../../backend/src/services/ai-studio.js');
      const research = (await getConfig(workspaceId, 'RESEARCH')).data;
      if (result.score < research.deepResearchScoreThreshold) return result;
      await enqueue(QUEUES.research, 'research.lead', {
        workspaceId, leadId, campaignId: typeof j.data.campaignId === 'string' ? j.data.campaignId : undefined,
        depth: 'DEEP', thenScore: true, icpId: j.data.icpId ?? null,
      }, { jobId: `deep-research-${latest.id}-${leadId}` });
      return { ...result, deepResearchQueued: true };
    },
  },
  [QUEUES.research]: {
    'research.lead': async (j) => {
      const r = await intel.runResearch(s(j.data.workspaceId), { leadId: s(j.data.leadId), campaignId: typeof j.data.campaignId === 'string' ? j.data.campaignId : undefined, depth: j.data.depth === 'DEEP' ? 'DEEP' : 'INITIAL', refresh: j.data.refresh === true, retryMissing: j.data.retryMissing === true, retryReportId: typeof j.data.retryReportId === 'string' ? j.data.retryReportId : undefined, sourceUrl: typeof j.data.sourceUrl === 'string' ? j.data.sourceUrl : undefined });
      if (j.data.thenScore && r?.reused && (await intel.supportedClaims(s(j.data.workspaceId), s(j.data.leadId))).length) await enqueue(QUEUES.ai, 'ai.qualify', { workspaceId: j.data.workspaceId, leadId: j.data.leadId, icpId: j.data.icpId ?? null, campaignId: j.data.campaignId ?? null });
      return r;
    },
    'research.company': async (j) => intel.runResearch(s(j.data.workspaceId), { companyId: s(j.data.companyId) }),
  },
  [QUEUES.imports]: {
    // Drains Knowledge Importer stages published here by releases before the dedicated queue existed.
    ...knowledgeImportHandlers(),
    'import.csv': async (j) => leads.processImport(s(j.data.workspaceId), s(j.data.importId)),
  },
  [QUEUES.knowledgeImport]: knowledgeImportHandlers(),
  [QUEUES.verify]: {
    'verify.lead': async (j) => enrichment.verifyQueued(s(j.data.workspaceId), s(j.data.leadId), { force: !!j.data.force, ...(typeof j.data.freshDays === 'number' ? { freshDays: j.data.freshDays } : {}) }),
    'verify.address': async (j) => {
      const verifier = await import('../../backend/src/services/first-party-verification.js');
      const attempt = Math.max(j.attemptsMade, j.stalledCounter) + 1;
      try { return await verifier.processFirstPartyVerification(s(j.data.workspaceId), s(j.data.verificationId), attempt); }
      catch (e) {
        if (attempt >= (j.opts.attempts ?? 1)) await verifier.failFirstPartyVerification(s(j.data.workspaceId), s(j.data.verificationId), (e as Error).message);
        else await verifier.releaseFirstPartyVerification(s(j.data.workspaceId), s(j.data.verificationId));
        throw e;
      }
    },
    'verify.csv-import': async (j) => {
      const csv = await import('../../backend/src/services/verification-csv.js');
      try { return await csv.processVerificationCsvBatch(s(j.data.workspaceId), s(j.data.batchId)); }
      catch (e) {
        if (j.attemptsMade + 1 >= (j.opts.attempts ?? 1)) await csv.markCsvImportFailed(s(j.data.workspaceId), s(j.data.batchId), (e as Error).message);
        throw e;
      }
    },
    'verify.batch-resume': async (j) => (await import('../../backend/src/services/verification-csv.js')).enqueueBatchPending(s(j.data.workspaceId), s(j.data.batchId), s(j.data.actionId)),
  },
  [QUEUES.domain]: {
    'domain.check': async (j) => ops.runDomainCheck(s(j.data.workspaceId), s(j.data.domainId)),
    'domain.renewals': async () => domains.renewalReminders(),
    'domain.checkAll': async () => {
      const ds = await db().domain.findMany({ select: { id: true, workspaceId: true } });
      for (const d of ds) await enqueue(QUEUES.domain, 'domain.check', { workspaceId: d.workspaceId, domainId: d.id });
      return { queued: ds.length };
    },
  },
  [QUEUES.aiClaude]: AI_WORKFLOW_HANDLERS(),
  [QUEUES.aiCodex]: AI_WORKFLOW_HANDLERS(),
  [QUEUES.aiApi]: AI_WORKFLOW_HANDLERS(),
  [QUEUES.maintenance]: {
    'aiSubscriptions.refreshLimits': async () => (await import('../../backend/src/services/ai-subscriptions.js')).refreshLimits(),
    'reports.daily': async () => insights.runScheduledReports(),
    'maintenance.retention': async () => ops.runRetention(),
    'maintenance.taskReminders': async () => crm.sendTaskReminders(),
    'maintenance.mailboxReadiness': async () => accounts.advanceMailboxReadiness(),
    'tenant.sync': async () => tenancy.syncTenantStatuses(),
    'tenant.purge': async () => tenancy.purgeDueTenants(),
    'storage.reconcile': async () => (await import('../../backend/src/services/storage-accounting.js')).reconcileStorage(),
    'emailVerification.datasets.refresh': async () => (await import('../../backend/src/services/email-verification-datasets.js')).refreshDisposableDataset(),
    'knowledge.import.recover': async () => (await import('../../backend/src/services/knowledge-import.js')).recoverImportJobs(),
    'leads.import.recover': async () => leads.recoverInterruptedLeadImports(),
    'knowledge.website.refresh': async (j) => (await import('../../backend/src/services/business-onboarding.js')).refreshBusinessWebsiteSources(typeof j.data.workspaceId === 'string' ? j.data.workspaceId : undefined),
    'billing.reconcile': async () => (await import('../../backend/src/services/billing.js')).reconcileSubscriptions(),
  },
  [QUEUES.automation]: {
    'workflow.run': async (j) => workflows.runWorkflow(s(j.data.workspaceId), s(j.data.workflowId), s(j.data.eventKey), (j.data.payload as Record<string, unknown>) ?? {}, !!j.data.testMode),
    'workflow.daily': async () => workflows.dailyScheduled(),
    'automation.dispatch': async (j) => automation.dispatch(s(j.data.workspaceId), s(j.data.type), s(j.data.eventKey), (j.data.payload ?? {}) as Record<string, unknown>),
  },
  [QUEUES.webhooks]: {
    'channel.notify': async (j) => insights.deliverToChannels(s(j.data.workspaceId), { type: s(j.data.type), title: s(j.data.title), link: (j.data.link as string) ?? undefined }),
    'webhook.deliver': async (j) => webhooks.deliver(s(j.data.workspaceId), s(j.data.deliveryId)),
  },
  [QUEUES.personalize]: {
    'personalize.lead': async (j) => {
      const d = { campaignId: s(j.data.campaignId), leadId: s(j.data.leadId), stepIds: (j.data.stepIds as string[]) ?? [], batchId: s(j.data.batchId), force: !!j.data.force };
      try {
        return await personalization.processBatchLead(s(j.data.workspaceId), d);
      } catch (e) {
        if (j.attemptsMade + 1 >= (j.opts.attempts ?? 1)) await personalization.markBatchLeadFailed(s(j.data.workspaceId), d, (e as Error).message);
        throw e;
      }
    },
    'personalize.single': async (j) => personalization.generateForLead(s(j.data.workspaceId), s(j.data.campaignId), s(j.data.leadId), s(j.data.stepId), {}),
  },
  [QUEUES.privacy]: {
    'privacy.export': async (j) => ops.processPrivacyRequest(s(j.data.workspaceId), s(j.data.requestId)),
    'privacy.erasure': async (j) => ops.processPrivacyRequest(s(j.data.workspaceId), s(j.data.requestId)),
  },
};

const NOISY = new Set(['campaign.tick', 'sync.pollAll', 'sync.account', 'maintenance.taskReminders']);

/**
 * Tenant gate for workers. The API is not the only way in: queued work must re-check the tenant
 * when it runs. Jobs that create cost or contact third parties are skipped for suspended,
 * cancelled or deleted tenants. Compliance work (privacy export/erasure, unsubscribes via mailbox
 * sync, domain checks) keeps running. Sending is gated inside the engine itself, which defers.
 */
export const TENANT_GATED = new Set([
  'reply.send', 'reply.forward', 'ai.classifyReply', 'ai.replyAssist', 'ai.qualify', 'research.lead', 'research.company',
  'import.csv', 'verify.lead', 'workflow.run', 'automation.dispatch', 'webhook.deliver', 'channel.notify', 'personalize.lead', 'personalize.single',
]);
/** Per-tenant fair share: at most N concurrent jobs of these queues per organization. */
const FAIR_QUEUES = new Set<QueueName>([QUEUES.ai, QUEUES.research, QUEUES.personalize, QUEUES.verify, QUEUES.imports, QUEUES.knowledgeImport]);
const SLOTS = () => Math.max(1, Number(process.env.TENANT_JOB_SLOTS ?? 2));

export async function tenantGate(job: Job<Data>): Promise<{ skip?: string; organizationId?: string }> {
  const ws = wsOf(job.data);
  if (!ws) return {};
  const organizationId = await orgIdOf(ws).catch(() => undefined);
  if (!organizationId) return { skip: 'workspace no longer exists' };
  if (!TENANT_GATED.has(job.name)) return { organizationId };
  const st = await tenantState(organizationId);
  return st.operational ? { organizationId } : { skip: `tenant inactive: ${st.reason ?? 'unknown'}`, organizationId };
}

async function acquireSlot(queueName: QueueName, org: string, jobId: string): Promise<(() => Promise<void>) | null> {
  const key = `tenant:slots:${org}:${queueName}`;
  const r = redis();
  const now = Date.now();
  await r.zremrangebyscore(key, 0, now - 10 * 60_000); // crashed holders expire after 10 min
  await r.zadd(key, now, jobId);
  const rank = await r.zrank(key, jobId);
  await r.pexpire(key, 15 * 60_000);
  if (rank !== null && rank < SLOTS()) return async () => { await r.zrem(key, jobId); };
  await r.zrem(key, jobId);
  return null;
}

/** Hard ceiling per job so a hung provider call cannot hold a worker slot forever (the job is retried with back-off). */
const TIMEOUT_MS: Partial<Record<QueueName, number>> = {
  [QUEUES.send]: 120_000, [QUEUES.replySend]: 120_000, [QUEUES.prepare]: 120_000, [QUEUES.ai]: 180_000, [QUEUES.personalize]: 240_000,
  [QUEUES.research]: 300_000, [QUEUES.aiClaude]: 35 * 60_000, [QUEUES.aiCodex]: 35 * 60_000, [QUEUES.aiApi]: 35 * 60_000, [QUEUES.verify]: 120_000, [QUEUES.sync]: 300_000, [QUEUES.webhooks]: 30_000, [QUEUES.imports]: 30 * 60_000, [QUEUES.knowledgeImport]: 3 * 60 * 60_000, [QUEUES.maintenance]: 30 * 60_000,
};
export const jobTimeoutMs = (q: QueueName) => Number(process.env.JOB_TIMEOUT_MS ?? 0) || TIMEOUT_MS[q] || 10 * 60_000;
export class JobTimeoutError extends Error {}
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new JobTimeoutError(`${label} exceeded ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(t));
}

/** Wraps a handler with JobRun bookkeeping and error logging. */
export function processorFor(queueName: QueueName) {
  return async (job: Job<Data>, token?: string) => {
    guardBrowserE2eQueue(queueName, 'process');
    const handler = HANDLERS[queueName]?.[job.name];
    if (!handler) throw new Error(`No handler for ${queueName}/${job.name}`);
    const gate = await tenantGate(job);
    if (gate.skip) {
      await db().jobRun.create({ data: { workspaceId: wsOf(job.data), queue: queueName, jobName: job.name, jobId: String(job.id), status: 'COMPLETED', attempt: job.attemptsMade + 1, error: `skipped: ${gate.skip}`.slice(0, 1000), durationMs: 0 } }).catch(() => undefined);
      return { skipped: gate.skip };
    }
    let release: (() => Promise<void>) | null = null;
    if (gate.organizationId && FAIR_QUEUES.has(queueName) && token) {
      release = await acquireSlot(queueName, gate.organizationId, String(job.id));
      if (!release) { await job.moveToDelayed(Date.now() + 3_000 + Math.floor(Math.random() * 2_000), token); throw new DelayedError(); }
    }
    const started = Date.now();
    try {
      const result = await withTimeout(handler(job), jobTimeoutMs(queueName), `${queueName}/${job.name}`);
      if (!NOISY.has(job.name)) {
        await db().jobRun.create({ data: { workspaceId: wsOf(job.data), queue: queueName, jobName: job.name, jobId: String(job.id), status: 'COMPLETED', attempt: job.attemptsMade + 1, durationMs: Date.now() - started } }).catch(() => undefined);
      }
      return result ?? null;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      await db().jobRun.create({ data: { workspaceId: wsOf(job.data), queue: queueName, jobName: job.name, jobId: String(job.id), status: 'FAILED', attempt: job.attemptsMade + 1, error: msg.slice(0, 1000), durationMs: Date.now() - started } }).catch(() => undefined);
      await logError('worker', `${queueName}/${job.name}`, msg, { workspaceId: wsOf(job.data), context: { jobId: job.id, attempt: job.attemptsMade + 1 } });
      throw e;
    } finally {
      if (release) await release().catch(() => undefined);
    }
  };
}
