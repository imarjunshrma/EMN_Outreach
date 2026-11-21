import { db, Prisma } from './db.js';
import { logger } from './logger.js';
import { redis } from './redis.js';

export interface Actor {
  type: 'USER' | 'SYSTEM' | 'WORKER' | 'API';
  userId?: string | null;
  ip?: string | null;
  requestId?: string | null;
}

export const SYSTEM_ACTOR: Actor = { type: 'SYSTEM' };
export const WORKER_ACTOR: Actor = { type: 'WORKER' };

export async function audit(
  workspaceId: string | null,
  actor: Actor,
  action: string,
  entity?: { type: string; id: string },
  metadata: Record<string, unknown> = {},
) {
  try {
    await db().auditLog.create({
      data: {
        workspaceId,
        actorType: actor.type,
        actorUserId: actor.userId ?? null,
        action,
        entityType: entity?.type,
        entityId: entity?.id,
        metadata: metadata as Prisma.InputJsonValue,
        ipAddress: actor.ip ?? null,
        requestId: actor.requestId ?? null,
      },
    });
  } catch (e) {
    logger.error({ err: e, action }, 'failed to write audit log');
  }
}

export async function logError(source: 'api' | 'worker', code: string, message: string, ctx: { workspaceId?: string | null; requestId?: string | null; context?: Record<string, unknown> } = {}) {
  try {
    await db().errorLog.create({
      data: { source, code, message: message.slice(0, 2000), workspaceId: ctx.workspaceId ?? null, requestId: ctx.requestId ?? null, context: (ctx.context ?? {}) as Prisma.InputJsonValue },
    });
  } catch (e) {
    logger.error({ err: e }, 'failed to write error log');
  }
}

/** Realtime events: published to Redis and streamed to browsers over SSE. */
export async function publish(workspaceId: string, type: string, payload: Record<string, unknown> = {}) {
  try {
    await redis().publish(`events:${workspaceId}`, JSON.stringify({ type, payload, at: new Date().toISOString() }));
  } catch (e) {
    logger.warn({ err: e }, 'publish failed');
  }
}

export async function notifyWorkspace(workspaceId: string, minRole: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER', n: { type: string; title: string; body?: string; link?: string }) {
  const ranks = { OWNER: 4, ADMIN: 3, MANAGER: 2, MEMBER: 1, VIEWER: 0 } as const;
  const members = await db().workspaceMember.findMany({ where: { workspaceId } });
  const targets = members.filter((m) => ranks[m.role] >= ranks[minRole]);
  if (targets.length === 0) return;
  await db().notification.createMany({ data: targets.map((m) => ({ workspaceId, userId: m.userId, ...n })) });
  await publish(workspaceId, 'notification.created', { title: n.title });
  if (await db().notificationChannel.count({ where: { workspaceId, isActive: true } })) {
    const { enqueue, QUEUES } = await import('./queues.js');
    await enqueue(QUEUES.webhooks, 'channel.notify', { workspaceId, type: n.type, title: n.title, link: n.link ?? null }, { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } }).catch(() => undefined);
  }
}
