import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import { encryptSecret } from '../../backend/src/services/workspace.js';
import * as domains from '../../backend/src/services/domains.js';
import * as enrichment from '../../backend/src/services/enrichment.js';
import { resetDb, installFakes, createUserSession, addLead, addMailbox } from '../helpers/harness.js';
import { fakeDns } from '../helpers/fakes.js';

let fakes: ReturnType<typeof installFakes>;
beforeEach(async () => { await resetDb(); fakes = installFakes(); fakeDns.records.clear(); });
const ACTOR = { type: 'SYSTEM' as const };
const integ = (workspaceId: string, type: string) => db().integration.create({ data: { workspaceId, type, encryptedConfig: encryptSecret('k') } });
async function setSettings(workspaceId: string, patch: Record<string, unknown>) {
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  await db().workspace.update({ where: { id: workspaceId }, data: { settings: { ...(ws.settings as object), ...patch } as never } });
}

describe('domain manager', () => {
  it('verifies ownership via TXT, checks propagation across resolvers, and applies records only through the DNS adapter', async () => {
    const s = await createUserSession('o@x.com');
    const d = await db().domain.create({ data: { workspaceId: s.workspaceId, name: 'ourco.com' } });
    const v = await domains.startVerification(s.workspaceId, d.id, ACTOR);
    expect(v.record.name).toBe('_emn-verify.ourco.com');
    expect((await domains.checkOwnership(s.workspaceId, d.id, ACTOR)).verified).toBe(false);
    fakeDns.records.set('_emn-verify.ourco.com', [[v.record.value]]);
    expect((await domains.checkOwnership(s.workspaceId, d.id, ACTOR)).verified).toBe(true);
    // Propagation: two resolvers see the new SPF, one does not yet
    domains.setResolverFactoryForTests((ip) => ({ resolveTxt: async (n: string) => (n === 'ourco.com' ? (ip === '9.9.9.9' ? [['v=spf1 ~all']] : [['v=spf1 include:_spf.google.com ~all']]) : []) }));
    const p = await domains.checkPropagation(s.workspaceId, d.id);
    expect(p.spfConsistent).toBe(false);
    expect(p.results.map((r) => r.resolver)).toEqual(['Cloudflare', 'Google', 'Quad9']);
    // Recommended records reflect the providers actually used on the domain
    await addMailbox(s.workspaceId, 'arjun@ourco.com');
    const rec = await domains.recommendedRecords(s.workspaceId, d.id);
    expect(rec.records[0].value).toMatch(/include:_spf.google.com/);
    // Apply via Cloudflare adapter: needs integration, refuses placeholders and a second SPF
    await expect(domains.applyRecord(s.workspaceId, d.id, { type: 'TXT', name: '_dmarc.ourco.com', content: 'v=DMARC1; p=none' }, ACTOR)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    await integ(s.workspaceId, 'cloudflare');
    fakes.cloudflare.zones.set('ourco.com', 'z1');
    await expect(domains.applyRecord(s.workspaceId, d.id, { type: 'TXT', name: 'evil.com', content: 'x' }, ACTOR)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await domains.applyRecord(s.workspaceId, d.id, { type: 'TXT', name: '_dmarc.ourco.com', content: 'v=DMARC1; p=none' }, ACTOR);
    fakes.cloudflare.records.push({ id: 'old', zoneId: 'z1', type: 'TXT', name: 'ourco.com', content: 'v=spf1 ~all', ttl: 1 });
    await expect(domains.applyRecord(s.workspaceId, d.id, { type: 'TXT', name: 'ourco.com', content: 'v=spf1 include:_spf.google.com ~all' }, ACTOR)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fakes.cloudflare.records.filter((r) => r.name === '_dmarc.ourco.com')).toHaveLength(1);
  });

  it('sends renewal reminders once a week for domains expiring within 30 days', async () => {
    const s = await createUserSession('o@x.com');
    const now = new Date('2026-12-01T00:00:00Z');
    await db().domain.create({ data: { workspaceId: s.workspaceId, name: 'soon.com', expiresAt: new Date('2026-12-10T00:00:00Z') } });
    await db().domain.create({ data: { workspaceId: s.workspaceId, name: 'auto.com', expiresAt: new Date('2026-12-10T00:00:00Z'), autoRenew: true } });
    await db().domain.create({ data: { workspaceId: s.workspaceId, name: 'later.com', expiresAt: new Date('2027-06-01T00:00:00Z') } });
    expect((await domains.renewalReminders(now)).notified).toBe(1);
    expect((await domains.renewalReminders(new Date(now.getTime() + 86400_000))).notified).toBe(0);
    expect((await domains.renewalReminders(new Date(now.getTime() + 8 * 86400_000))).notified).toBe(1);
    expect(await db().notification.count({ where: { title: { contains: 'soon.com' } } })).toBeGreaterThanOrEqual(2);
  });
});

describe('mailbox health', () => {
  it('summarises measured sending signals per mailbox (regression: wrong event timestamp column)', async () => {
    const s = await createUserSession('o@x.com');
    const mb = await addMailbox(s.workspaceId, 'arjun@ourco.com');
    for (const type of ['SENT', 'SENT', 'SENT', 'SENT', 'BOUNCED_HARD']) await db().emailEvent.create({ data: { workspaceId: s.workspaceId, emailAccountId: mb.id, type: type as never } });
    const [h] = await domains.mailboxHealth(s.workspaceId);
    expect(h).toMatchObject({ emailAddress: 'arjun@ourco.com', sent30d: 4, hardBounces30d: 1, bounceRatePct: 25, authStatus: 'ok' });
    expect((await s.agent.get(`/api/v1/w/${s.workspaceId}/mailbox-health`)).status).toBe(200);
  });
});

describe('verification waterfall', () => {
  it('falls through providers until a definitive result, records history and cost, skips fresh results and disposables', async () => {
    const s = await createUserSession('o@x.com');
    await integ(s.workspaceId, 'millionverifier'); await integ(s.workspaceId, 'zerobounce');
    await setSettings(s.workspaceId, { verifierOrder: ['millionverifier', 'zerobounce'], verifierProvider: 'none' });
    const lead = await addLead(s.workspaceId, 'jo@client.com', { emailVerificationStatus: 'UNVERIFIED' });
    fakes.verifier.results.set('jo@client.com', 'UNKNOWN');
    fakes.verifier2.results.set('jo@client.com', 'VALID');
    const r = await enrichment.verifyWaterfall(s.workspaceId, lead.id);
    expect(r.result).toBe('VALID');
    expect(r.steps.map((x) => `${x.provider}:${x.result}`)).toEqual(['millionverifier:UNKNOWN', 'zerobounce:VALID']);
    const hist = await enrichment.verificationHistory(s.workspaceId, lead.id);
    expect(hist).toHaveLength(2);
    expect((await enrichment.verifyWaterfall(s.workspaceId, lead.id)).skipped).toBe('recently verified'); // no wasted credits
    const stats = await enrichment.enrichmentStats(s.workspaceId);
    expect(stats.find((x) => x.provider === 'zerobounce')?.definitiveRatePct).toBe(100);
    // A disposable domain says nothing about the mailbox itself: it is recorded as UNKNOWN with the disposable
    // attribute, and sending is refused by the disposable-domain policy — even where UNKNOWN is otherwise allowed.
    const throwaway = await addLead(s.workspaceId, 'x@mailinator.com', { emailVerificationStatus: 'UNVERIFIED', emailVerifiedAt: null });
    expect((await enrichment.verifyWaterfall(s.workspaceId, throwaway.id)).result).toBe('UNKNOWN');
    await setSettings(s.workspaceId, { verificationUnknownPolicy: 'allow', verificationDisposablePolicy: 'block' });
    const { canContact } = await import('../../backend/src/services/compliance.js');
    const fresh = await db().lead.findUniqueOrThrow({ where: { id: throwaway.id } });
    const decision = await canContact(s.workspaceId, fresh, { requireVerified: true });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('email uses a known disposable domain');
    expect((await db().usageRecord.count({ where: { workspaceId: s.workspaceId, kind: 'verify' } }))).toBe(2); // disposable cost nothing
  });

  it('discovers emails through the finder waterfall and never treats them as verified', async () => {
    const s = await createUserSession('o@x.com');
    await expect(enrichment.findEmail(s.workspaceId, { firstName: 'Ana', lastName: 'Lee', domain: 'acme.io' }, ACTOR)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    await integ(s.workspaceId, 'hunter');
    await setSettings(s.workspaceId, { finderOrder: ['hunter'] });
    fakes.finder.emails.set('Ana Lee@acme.io', 'ana@acme.io');
    const r = await enrichment.findEmail(s.workspaceId, { firstName: 'Ana', lastName: 'Lee', domain: 'https://www.acme.io/' }, ACTOR);
    expect(r.email).toBe('ana@acme.io');
    expect(r.note).toMatch(/verify it/);
  });
});
