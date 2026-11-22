import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../backend/src/app.js';
import { db } from '../../backend/src/core/db.js';
import { redis } from '../../backend/src/core/redis.js';
import { setAdapters, resetAdapters } from '../../backend/src/core/container.js';
import { encryptSecret, initWorkspaceDefaults } from '../../backend/src/services/workspace.js';
import { hashPassword } from '../../backend/src/services/auth.js';
import { FakeFinder, FakeCloudflare, FakeAi, FakeEmailProvider, FakeFetcher, FakeLeadData, FakeOAuth, FakeSearch, FakeVerifier, fakeDns } from './fakes.js';

let app: Express | null = null;
export function getApp() { return (app ??= createApp()); }

/** Wipes every table (except migrations) and the test Redis DB. */
export async function resetDb() {
  const tables = await db().$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  // A background write left over from the previous test can deadlock with TRUNCATE; retry instead of failing the next test.
  for (let attempt = 1; ; attempt++) {
    try { await db().$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`); break; }
    catch (e) { if (attempt >= 5 || !String((e as Error).message).includes('40P01')) throw e; await new Promise((r) => setTimeout(r, 100 * attempt)); }
  }
  await redis().flushdb();
}

export function installFakes() {
  resetAdapters();
  const fakes = {
    gmail: new FakeEmailProvider('GMAIL'), graph: new FakeEmailProvider('MICROSOFT'), smtp: new FakeEmailProvider('SMTP_IMAP'),
    anthropic: new FakeAi('ANTHROPIC'), openai: new FakeAi('OPENAI'), oauthGoogle: new FakeOAuth('GMAIL'), oauthMs: new FakeOAuth('MICROSOFT'),
    fetcher: new FakeFetcher(), verifier: new FakeVerifier(), verifier2: new FakeVerifier(), finder: new FakeFinder(), cloudflare: new FakeCloudflare(), leadData: new FakeLeadData(), search: new FakeSearch(),
  };
  setAdapters({
    email: { GMAIL: fakes.gmail, MICROSOFT: fakes.graph, SMTP_IMAP: fakes.smtp },
    oauth: { GMAIL: fakes.oauthGoogle, MICROSOFT: fakes.oauthMs },
    graphSubscriptions: null,
    ai: { ANTHROPIC: fakes.anthropic, OPENAI: fakes.openai },
    fetcher: fakes.fetcher,
    verifiers: { millionverifier: fakes.verifier, zerobounce: fakes.verifier2, neverbounce: fakes.verifier },
    finders: { hunter: fakes.finder },
    dnsProviders: { cloudflare: fakes.cloudflare },
    leadData: { apollo: fakes.leadData },
    search: { brave: fakes.search, serper: fakes.search },
    dns: fakeDns,
  });
  return fakes;
}

export interface Session { agent: ReturnType<typeof request.agent>; csrf: string; userId: string; workspaceId: string; organizationId: string }

/** Creates a user + workspace directly and logs in through the API. */
export async function createUserSession(email: string, role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER' | 'VIEWER' = 'OWNER', workspaceId?: string): Promise<Session> {
  const user = await db().user.create({ data: { email, name: email.split('@')[0], passwordHash: await hashPassword('CorrectHorse123!') } });
  let wsId = workspaceId;
  let orgId: string;
  if (!wsId) {
    // A new tenant per new user (as in production sign-up): organization → owner membership → workspace.
    const org = await db().organization.create({ data: { name: `Org ${email}`, slug: `org-${user.id.slice(0, 8)}`, status: 'ACTIVE', ownerId: user.id, members: { create: { userId: user.id, role: role === 'OWNER' ? 'OWNER' : 'MEMBER' } } } });
    const ws = await db().workspace.create({ data: { organizationId: org.id, name: `WS ${email}`, slug: `ws-${user.id.slice(0, 8)}`, postalAddress: '1 Test Street, Jaipur, India', senderLegalName: 'Elite Media Networks' } });
    await initWorkspaceDefaults(ws.id);
    wsId = ws.id; orgId = org.id;
  } else {
    orgId = (await db().workspace.findUniqueOrThrow({ where: { id: wsId } })).organizationId;
    await db().organizationMember.upsert({ where: { organizationId_userId: { organizationId: orgId, userId: user.id } }, update: {}, create: { organizationId: orgId, userId: user.id, role: 'MEMBER' } });
  }
  await db().workspaceMember.create({ data: { workspaceId: wsId, userId: user.id, role } });
  const agent = request.agent(getApp());
  const res = await agent.post('/api/v1/auth/login').send({ email, password: 'CorrectHorse123!' });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, csrf: res.body.csrfToken, userId: user.id, workspaceId: wsId, organizationId: orgId };
}

export async function addMailbox(workspaceId: string, email = 'sender@ourco.com', provider: 'GMAIL' | 'MICROSOFT' = 'GMAIL', overrides: Record<string, unknown> = {}) {
  return db().emailAccount.create({
    data: {
      workspaceId, provider, emailAddress: email, displayName: 'Arjun', dailySendLimit: 50, minSecondsBetweenSends: 0,
      sendingWindow: { enabled: false, days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59', timezone: 'UTC' },
      credential: { create: { workspaceId, encryptedAccessToken: encryptSecret('at'), encryptedRefreshToken: encryptSecret('rt'), accessTokenExpiresAt: new Date(Date.now() + 3600_000), scopes: [] } },
      ...overrides,
    },
  });
}

export async function addAiProvider(workspaceId: string, provider: 'ANTHROPIC' | 'OPENAI' = 'ANTHROPIC', model = 'claude-haiku-5-5') {
  const { upsertProvider } = await import('../../backend/src/services/ai.js');
  return upsertProvider(workspaceId, { provider, apiKey: `sk-test-${provider.toLowerCase()}-1234567890`, defaultModel: model }, { type: 'SYSTEM' });
}

export async function addLead(workspaceId: string, email: string, extra: Record<string, unknown> = {}) {
  return db().lead.create({ data: { workspaceId, email, emailNormalized: email.toLowerCase(), firstName: 'Jane', country: 'US', lawfulBasis: 'LEGITIMATE_INTEREST', emailVerificationStatus: 'VALID', emailVerifiedAt: new Date(), ...extra } });
}

/** A Monday 10:00 UTC — inside default windows. */
export const MONDAY_10_UTC = new Date('2026-11-23T10:00:00Z');
