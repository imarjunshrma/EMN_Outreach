/**
 * Workspace and organization exports are streamed in batches. The streamed document must match the in-memory export
 * exactly (apart from its timestamp) across batch boundaries, and must contain only the requested tenant's data.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import { workspaceExport } from '../../backend/src/services/ops.js';
import { addMailbox, createUserSession, resetDb } from '../helpers/harness.js';

beforeEach(async () => { await resetDb(); });

/** The in-memory export had no defined row order; compare each list in id order. */
const normalized = (document: Record<string, unknown>) => Object.fromEntries(Object.entries(document).map(([key, value]) => [key,
  key === 'exportedAt' ? undefined : Array.isArray(value) ? [...value].sort((a, b) => String(a.id).localeCompare(String(b.id))) : value]));
const parse = (body: Buffer | string) => JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body);
const binary = (res: { on: (event: string, listener: (chunk?: Buffer) => void) => void }, done: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk) => chunks.push(chunk!));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

async function seed(workspaceId: string, prefix: string, leads: number) {
  for (let i = 0; i < leads; i += 1_000) {
    await db().lead.createMany({ data: Array.from({ length: Math.min(1_000, leads - i) }, (_, k) => ({
      workspaceId, email: `${prefix}${i + k}@export.example`, emailNormalized: `${prefix}${i + k}@export.example`, firstName: `Lead ${i + k}`,
    })) });
  }
  const account = await addMailbox(workspaceId, `${prefix}sender@export.example`);
  const conversation = await db().conversation.create({ data: { workspaceId, emailAccountId: account.id, providerThreadId: `${prefix}thread`, subject: 'Export thread', lastMessageAt: new Date() } });
  await db().emailMessage.create({ data: { workspaceId, conversationId: conversation.id, emailAccountId: account.id, direction: 'INBOUND', providerMessageId: `${prefix}message`, fromAddress: `${prefix}0@export.example`, toAddresses: [account.emailAddress], references: [], ccAddresses: [], subject: 'Hello', bodyText: 'Body', sentAt: new Date() } });
  await db().suppressionEntry.create({ data: { workspaceId, type: 'EMAIL', value: `${prefix}1@export.example`, reason: 'MANUAL' } as never });
}

describe('streamed exports', () => {
  it('streams the same workspace document as the in-memory export, across batches', async () => {
    const owner = await createUserSession('export-owner@x.com');
    const other = await createUserSession('export-other@x.com');
    await seed(owner.workspaceId, 'a', 2_345);
    await seed(other.workspaceId, 'b', 10);

    const res = await owner.agent.get(`/api/v1/w/${owner.workspaceId}/export`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('workspace-export.json');
    const streamed = parse(res.body);
    const expected = JSON.parse(JSON.stringify(await workspaceExport(owner.workspaceId, { type: 'SYSTEM' })));
    expect(streamed.leads).toHaveLength(2_345);
    expect(normalized(streamed)).toEqual(normalized(expected));
    expect(Object.keys(streamed)).toEqual(Object.keys(expected));
    expect(JSON.stringify(streamed)).not.toContain('b0@export.example');
  });

  it('streams every workspace of the organization and nothing else', async () => {
    const owner = await createUserSession('org-export@x.com');
    const second = await db().workspace.create({ data: { organizationId: owner.organizationId, name: 'Second', slug: 'second-export' } });
    const stranger = await createUserSession('org-stranger@x.com');
    await seed(owner.workspaceId, 'c', 1_200);
    await seed(second.id, 'd', 5);
    await seed(stranger.workspaceId, 'e', 5);

    const res = await owner.agent.post(`/api/v1/orgs/${owner.organizationId}/export`).set('x-csrf-token', owner.csrf).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const document = parse(res.body);
    expect(document.organization.id).toBe(owner.organizationId);
    expect(document.workspaces).toHaveLength(2);
    const leadCounts = document.workspaces.map((workspace: { leads: unknown[] }) => workspace.leads.length).sort((a: number, b: number) => a - b);
    expect(leadCounts).toEqual([5, 1_200]);
    expect(JSON.stringify(document)).not.toContain('e0@export.example');
  });
});
