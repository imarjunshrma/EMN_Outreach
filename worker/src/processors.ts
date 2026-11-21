import { DelayedError, type Job } from 'bullmq';
import { redis } from '../../backend/src/core/redis.js';
import { orgIdOf } from '../../backend/src/core/tenant.js';
import { tenantState } from '../../backend/src/services/entitlements.js';
import * as tenancy from '../../backend/src/services/tenancy.js';
import { db } from '../../backend/src/core/db.js';
import { QUEUES, enqueue, type QueueName } from '../../backend/src/core/queues.js';
import { logError } from '../../backend/src/core/audit.js';
import { logger } from '../../backend/src/core/logger.js';
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

/** Job handlers by queue and job name. Every handler is idempotent. */
export const HANDLERS: Record<QueueName, Record<string, Handler>> = {
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
    'ai.qualify': async (j) => intel.scoreLead(s(j.data.workspaceId), s(j.data.leadId), (j.data.icpId as string | null) ?? null),
  },
  [QUEUES.research]: {
    'research.lead': async (j) => {
      const r = await intel.runResearch(s(j.data.workspaceId), { leadId: s(j.data.leadId), campaignId: typeof j.data.campaignId === 'string' ? j.data.campaignId : undefined });
      if (j.data.thenScore) await enqueue(QUEUES.ai, 'ai.qualify', { workspaceId: j.data.workspaceId, leadId: j.data.leadId, icpId: j.data.icpId ?? null });
      return r;
    },
    'research.company': async (j) => intel.runResearch(s(j.data.workspaceId), { companyId: s(j.data.companyId) }),
  },
  [QUEUES.imports]: {
    'import.csv': async (j) => leads.processImport(s(j.data.workspaceId), s(j.data.importId)),
  },
  [QUEUES.verify]: {
    'verify.lead': async (j) => enrichment.verifyWaterfall(s(j.data.workspaceId), s(j.data.leadId), { force: !!j.data.force }),
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
  [QUEUES.maintenance]: {
    'reports.daily': async () => insights.runScheduledReports(),
    'maintenance.retention': async () => ops.runRetention(),
    'maintenance.taskReminders': async () => crm.sendTaskReminders(),
    'tenant.sync': async () => tenancy.syncTenantStatuses(),
    'tenant.purge': async () => tenancy.purgeDueTenants(),
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
const FAIR_QUEUES = new Set<QueueName>([QUEUES.ai, QUEUES.research, QUEUES.personalize, QUEUES.verify, QUEUES.imports]);
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

/** Wraps a handler with JobRun bookkeeping and error logging. */
export function processorFor(queueName: QueueName) {
  return async (job: Job<Data>, token?: string) => {
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
      const result = await handler(job);
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
