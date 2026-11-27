import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { NotFound } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { IcpCriteriaSchema } from '../../../shared/src/ai-schemas.js';

export const IcpSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(4000).nullable().optional(),
  criteria: IcpCriteriaSchema,
  minScore: z.number().int().min(0).max(100).default(60),
  isActive: z.boolean().default(true),
});

export async function saveIcpVersion(
  workspaceId: string,
  id: string | null,
  input: z.input<typeof IcpSchema>,
  actor: Actor,
  transaction?: Prisma.TransactionClient,
  provenance?: Prisma.InputJsonValue,
) {
  const values = IcpSchema.parse(input);
  const write = async (tx: Prisma.TransactionClient) => {
    const current = id ? await tx.idealCustomerProfile.findFirst({ where: { id, workspaceId } }) : null;
    if (id && !current) throw NotFound('ICP');
    if (current) {
      const { name, description, criteria, minScore, isActive } = current;
      await tx.idealCustomerProfileRevision.upsert({
        where: { icpId_version: { icpId: current.id, version: current.version } },
        create: { workspaceId, icpId: current.id, version: current.version, data: { name, description, criteria, minScore, isActive }, createdAt: current.updatedAt },
        update: {},
      });
    }
    const data = { ...values, description: values.description ?? null, criteria: values.criteria as Prisma.InputJsonValue };
    const next = current
      ? await tx.idealCustomerProfile.update({ where: { workspaceId_id: { workspaceId, id: current.id } }, data: { ...data, version: { increment: 1 } } })
      : await tx.idealCustomerProfile.create({ data: { workspaceId, ...data } });
    await tx.idealCustomerProfileRevision.create({ data: {
      workspaceId, icpId: next.id, version: next.version, data: { ...data, ...(provenance ? { provenance } : {}) },
      createdById: actor.userId ?? null,
    } });
    await audit(workspaceId, actor, current ? 'icp.updated' : 'icp.created', { type: 'icp', id: next.id }, { version: next.version }, tx);
    return next;
  };
  return transaction ? write(transaction) : db().$transaction(write, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
