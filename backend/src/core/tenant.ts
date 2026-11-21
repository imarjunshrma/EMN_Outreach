import { db, Prisma } from './db.js';
import { AppError, NotFound } from './errors.js';
import { ORG_ACCESS, type OrgStatus } from '../../../shared/src/tenancy.js';

// Tenant context helpers. A workspace's organization can never change (DB trigger), so the mapping is cached forever.
const wsToOrg = new Map<string, string>();

export async function orgIdOf(workspaceId: string): Promise<string> {
  const hit = wsToOrg.get(workspaceId);
  if (hit) return hit;
  const ws = await db().workspace.findUnique({ where: { id: workspaceId }, select: { organizationId: true } });
  if (!ws) throw NotFound('Workspace');
  if (wsToOrg.size > 50_000) wsToOrg.clear();
  wsToOrg.set(workspaceId, ws.organizationId);
  return ws.organizationId;
}

/** Status is read fresh (it changes); callers needing it per request use this. */
export async function orgStatus(organizationId: string): Promise<OrgStatus> {
  const o = await db().organization.findUnique({ where: { id: organizationId }, select: { status: true } });
  if (!o) throw NotFound('Organization');
  return o.status as OrgStatus;
}

export const accessOf = (s: OrgStatus) => ORG_ACCESS[s];

/** Throws when the tenant may not perform state-changing work (suspended, cancelled, being deleted). */
export async function assertOperational(workspaceId: string) {
  const status = await orgStatus(await orgIdOf(workspaceId));
  if (ORG_ACCESS[status] !== 'full') throw new AppError('TENANT_INACTIVE', `This organization is ${status.toLowerCase().replace('_', ' ')} — this action is unavailable until it is reactivated`, 403, { status });
}

export async function platformAudit(e: { actorUserId?: string | null; action: string; organizationId?: string | null; targetType?: string; targetId?: string; reason?: string | null; metadata?: Record<string, unknown>; ip?: string | null }) {
  await db().platformAuditEvent.create({ data: { actorUserId: e.actorUserId ?? null, action: e.action, organizationId: e.organizationId ?? null, targetType: e.targetType ?? null, targetId: e.targetId ?? null, reason: e.reason ?? null, metadata: (e.metadata ?? {}) as Prisma.InputJsonValue, ip: e.ip ?? null } });
}
