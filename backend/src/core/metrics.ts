import { db } from './db.js';
import { redis } from './redis.js';
import { ALL_QUEUE_NAMES, queue, type QueueName } from './queues.js';

// Prometheus exposition for the operations team. Only aggregate numbers — no tenant names or ids.
export async function prometheusText(): Promise<string> {
  const lines: string[] = [];
  const g = (name: string, help: string, rows: Array<[Record<string, string>, number]>) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, v] of rows) lines.push(`${name}${Object.keys(labels).length ? `{${Object.entries(labels).map(([k, x]) => `${k}="${x}"`).join(',')}}` : ''} ${v}`);
  };
  let dbUp = 1; let redisUp = 1;
  try { await db().$queryRaw`SELECT 1`; } catch { dbUp = 0; }
  try { await redis().ping(); } catch { redisUp = 0; }
  g('emn_database_up', 'PostgreSQL reachable', [[{}, dbUp]]);
  g('emn_redis_up', 'Redis reachable', [[{}, redisUp]]);
  const q: Array<[Record<string, string>, number]> = [];
  if (redisUp) for (const name of ALL_QUEUE_NAMES) {
    const c = await queue(name as QueueName).getJobCounts('waiting', 'active', 'delayed', 'failed');
    for (const [state, v] of Object.entries(c)) q.push([{ queue: name, state }, v]);
  }
  g('emn_queue_jobs', 'BullMQ jobs by queue and state', q);
  if (dbUp) {
    const since = new Date(Date.now() - 3600_000);
    const [failed, errors, tenants, hooks, logins] = await Promise.all([
      db().jobRun.groupBy({ by: ['queue'], where: { status: 'FAILED', createdAt: { gte: since } }, _count: { _all: true } }),
      db().errorLog.count({ where: { createdAt: { gte: since } } }),
      db().organization.groupBy({ by: ['status'], _count: { _all: true } }),
      db().platformAuditEvent.count({ where: { action: { in: ['billing.webhook_stale', 'billing.reconcile_failed', 'billing.refund_unmatched', 'billing.dispute_unmatched'] }, createdAt: { gte: since } } }),
      db().auditLog.count({ where: { action: 'auth.login_failed', createdAt: { gte: since } } }),
    ]);
    g('emn_job_failures_1h', 'Failed job attempts in the last hour', failed.map((f) => [{ queue: f.queue }, f._count._all]));
    g('emn_errors_1h', 'Errors logged in the last hour', [[{}, errors]]);
    g('emn_tenants', 'Organizations by status', tenants.map((t) => [{ status: t.status }, t._count._all]));
    g('emn_billing_anomalies_1h', 'Stale, unmatched or failed-reconcile billing events in the last hour', [[{}, hooks]]);
    g('emn_login_failures_1h', 'Failed sign-ins in the last hour', [[{}, logins]]);
  }
  return `${lines.join('\n')}\n`;
}
