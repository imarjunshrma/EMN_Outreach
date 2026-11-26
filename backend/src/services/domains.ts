import { emptyTracking, trackingTotals } from './tracking-analytics.js';
import { Resolver } from 'node:dns/promises';
import { z } from 'zod';
import { db } from '../core/db.js';
import { adapters } from '../core/container.js';
import { randomToken } from '../core/crypto.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit, notifyWorkspace, type Actor } from '../core/audit.js';
import { PROVIDER_REGISTRY } from '../../../shared/src/provider-registry.js';
import { classifyMailboxHealth } from '../../../shared/src/mailbox-health.js';
import { getSecret, requireSecret } from './integrations.js';
import { readSettings } from './workspace.js';
import { listAccounts } from './accounts.js';

// Domain manager: ownership verification (TXT), DNS propagation across public resolvers, recommended
// records per mailbox provider, optional one-click record creation via a DNS provider adapter
// (Cloudflare), renewal reminders and mailbox health.

export interface TxtResolver { resolveTxt(name: string): Promise<string[][]> }
const PUBLIC_RESOLVERS: Array<[string, string]> = [['Cloudflare', '1.1.1.1'], ['Google', '8.8.8.8'], ['Quad9', '9.9.9.9']];
let resolverFactory: (ip: string) => TxtResolver = (ip) => { const r = new Resolver({ timeout: 4000, tries: 1 }); r.setServers([ip]); return r; };
export function setResolverFactoryForTests(f: (ip: string) => TxtResolver) { resolverFactory = f; }

async function txt(r: TxtResolver, name: string) { try { return (await r.resolveTxt(name)).map((p) => p.join('')); } catch { return []; } }

async function getDomain(workspaceId: string, id: string) {
  const d = await db().domain.findFirst({ where: { id, workspaceId } });
  if (!d) throw NotFound('Domain');
  return d;
}

export async function startVerification(workspaceId: string, id: string, actor: Actor) {
  const d = await getDomain(workspaceId, id);
  const token = d.verificationToken ?? randomToken(16).replace(/[^a-zA-Z0-9]/g, 'x');
  await db().domain.update({ where: { id }, data: { verificationToken: token } });
  await audit(workspaceId, actor, 'domain.verification_started', { type: 'domain', id });
  return { record: { type: 'TXT', name: `_emn-verify.${d.name}`, value: `emn-verify=${token}` }, note: 'Add this TXT record at your DNS provider, then click Verify. It proves this workspace controls the domain.' };
}

export async function checkOwnership(workspaceId: string, id: string, actor: Actor) {
  const d = await getDomain(workspaceId, id);
  if (!d.verificationToken) throw new AppError('VALIDATION_FAILED', 'Start verification first', 400);
  const values = await txt(adapters().dns as TxtResolver, `_emn-verify.${d.name}`);
  const ok = values.includes(`emn-verify=${d.verificationToken}`);
  if (ok && !d.verifiedAt) {
    await db().domain.update({ where: { id }, data: { verifiedAt: new Date() } });
    await audit(workspaceId, actor, 'domain.verified', { type: 'domain', id });
  }
  return { verified: ok || !!d.verifiedAt, found: values };
}

/** Compare SPF / DMARC / verification TXT across independent public resolvers. */
export async function checkPropagation(workspaceId: string, id: string) {
  const d = await getDomain(workspaceId, id);
  const names = { spf: d.name, dmarc: `_dmarc.${d.name}`, verification: `_emn-verify.${d.name}` };
  const results = await Promise.all(PUBLIC_RESOLVERS.map(async ([label, ip]) => {
    const r = resolverFactory(ip);
    const [spf, dmarc, ver] = await Promise.all([txt(r, names.spf), txt(r, names.dmarc), txt(r, names.verification)]);
    return { resolver: label, ip, spf: spf.find((v) => v.startsWith('v=spf1')) ?? null, dmarc: dmarc.find((v) => v.startsWith('v=DMARC1')) ?? null, verification: ver.find((v) => v.startsWith('emn-verify=')) ?? null };
  }));
  const consistent = (k: 'spf' | 'dmarc' | 'verification') => new Set(results.map((x) => x[k])).size === 1;
  const summary = { spfConsistent: consistent('spf'), dmarcConsistent: consistent('dmarc'), verificationConsistent: consistent('verification'), checkedAt: new Date().toISOString() };
  await db().domain.update({ where: { id }, data: { propagation: { results, ...summary } } });
  return { results, ...summary };
}

/** Recommended DNS records for the mailbox providers used on this domain (guidance, not guesses about values we can't know). */
export async function recommendedRecords(workspaceId: string, id: string) {
  const d = await getDomain(workspaceId, id);
  const accounts = await db().emailAccount.findMany({ where: { workspaceId, emailAddress: { endsWith: `@${d.name}` } }, select: { provider: true } });
  const providers = new Set(accounts.map((a) => a.provider));
  const includes = [providers.has('GMAIL') ? 'include:_spf.google.com' : null, providers.has('MICROSOFT') ? 'include:spf.protection.outlook.com' : null].filter(Boolean);
  const records = [
    { type: 'TXT', name: d.name, value: `v=spf1 ${includes.join(' ') || '<include your mail provider>'} ~all`, purpose: 'SPF — authorises your mail provider. Merge with any existing SPF record; a domain must have only one.' },
    { type: 'TXT', name: `_dmarc.${d.name}`, value: `v=DMARC1; p=none; rua=mailto:dmarc@${d.name}; fo=1`, purpose: 'DMARC — start with p=none to monitor, then tighten to quarantine/reject.' },
    ...(providers.has('GMAIL') ? [{ type: 'TXT', name: `google._domainkey.${d.name}`, value: '(generate in Google Admin → Apps → Gmail → Authenticate email)', purpose: 'DKIM for Google Workspace — the key is generated by Google; copy it exactly.' }] : []),
    ...(providers.has('MICROSOFT') ? [{ type: 'CNAME', name: `selector1._domainkey.${d.name}`, value: '(shown in Microsoft Defender → Email authentication → DKIM)', purpose: 'DKIM for Microsoft 365 — two CNAMEs (selector1/selector2) provided by Microsoft.' }] : []),
  ];
  if (d.verificationToken) records.push({ type: 'TXT', name: `_emn-verify.${d.name}`, value: `emn-verify=${d.verificationToken}`, purpose: 'Ownership verification for this workspace.' });
  return { domain: d.name, records, providersDetected: [...providers] };
}

export const ApplyRecordSchema = z.object({ type: z.enum(['TXT', 'CNAME']), name: z.string().min(3).max(253), content: z.string().min(1).max(2000) });

/** Create one DNS record through a connected DNS provider, only on explicit request. Refuses to create a 2nd SPF record. */
export async function applyRecord(workspaceId: string, id: string, input: z.infer<typeof ApplyRecordSchema>, actor: Actor) {
  const d = await getDomain(workspaceId, id);
  if (input.name !== d.name && !input.name.endsWith(`.${d.name}`)) throw new AppError('VALIDATION_FAILED', 'Record name must be inside this domain', 400);
  if (input.content.includes('<') || input.content.startsWith('(')) throw new AppError('VALIDATION_FAILED', 'Replace the placeholder with the real value first', 400);
  const { secret } = await requireSecret(workspaceId, 'cloudflare');
  const cf = adapters().dnsProviders.cloudflare;
  const zone = await cf.findZone(secret, d.name);
  if (!zone) throw new AppError('NOT_FOUND', `Zone ${d.name} not found in this Cloudflare account`, 404);
  if (input.type === 'TXT' && input.content.startsWith('v=spf1')) {
    const existing = (await cf.listRecords(secret, zone.id, { type: 'TXT', name: d.name })).filter((r) => r.content.replace(/"/g, '').startsWith('v=spf1'));
    if (existing.length) throw new AppError('CONFLICT', 'An SPF record already exists; edit it in Cloudflare and merge the include instead of adding a second SPF record', 409, existing);
  }
  const rec = await cf.createRecord(secret, zone.id, { type: input.type, name: input.name, content: input.content });
  await db().domain.update({ where: { id }, data: { dnsProvider: 'cloudflare', dnsZoneId: zone.id } });
  await audit(workspaceId, actor, 'domain.dns_record_created', { type: 'domain', id }, { type: input.type, name: input.name });
  return rec;
}

export const RenewalSchema = z.object({ registrar: z.string().max(100).nullable().optional(), expiresAt: z.coerce.date().nullable().optional(), autoRenew: z.boolean().nullable().optional() });
export async function updateRenewal(workspaceId: string, id: string, input: z.infer<typeof RenewalSchema>, actor: Actor) {
  await getDomain(workspaceId, id);
  const r = await db().domain.update({ where: { id }, data: { ...input, renewalNotifiedAt: null } });
  await audit(workspaceId, actor, 'domain.renewal_updated', { type: 'domain', id });
  return r;
}

/** Daily job: notify about domains expiring within 30 days (once a week per domain, unless auto-renew is on). */
export async function renewalReminders(now = new Date()) {
  const soon = new Date(now.getTime() + 30 * 86400_000);
  const due = await db().domain.findMany({ where: { expiresAt: { lte: soon, gte: new Date(now.getTime() - 30 * 86400_000) }, AND: [{ OR: [{ autoRenew: null }, { autoRenew: false }] }, { OR: [{ renewalNotifiedAt: null }, { renewalNotifiedAt: { lte: new Date(now.getTime() - 7 * 86400_000) } }] }] } }); // NULL-safe (NOT autoRenew=true would drop NULLs)
  for (const d of due) {
    const days = Math.ceil((d.expiresAt!.getTime() - now.getTime()) / 86400_000);
    await notifyWorkspace(d.workspaceId, 'ADMIN', { type: 'domain.renewal', title: days >= 0 ? `Domain ${d.name} expires in ${days} day(s)` : `Domain ${d.name} expired ${-days} day(s) ago`, link: `/domains/${d.id}` });
    await db().domain.update({ where: { id: d.id }, data: { renewalNotifiedAt: now } });
  }
  return { notified: due.length };
}

export function providerRegistry() { return PROVIDER_REGISTRY; }

/** Mailbox health in one view (only data we actually have — no inferred inbox placement). */
export async function mailboxHealth(workspaceId: string) {
  const workspace = await db().workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
  const readinessManagementEnabled = readSettings(workspace?.settings).mailboxReadinessManagement;
  const since = new Date(Date.now() - 30 * 86400_000);
  const accounts = await db().emailAccount.findMany({ where: { workspaceId }, select: { id: true, emailAddress: true, provider: true, status: true, statusReason: true, autoPauseUntil: true, lastSyncedAt: true, lastSentAt: true, lastReceivedAt: true, lastError: true, lastErrorAt: true, dailySendLimit: true, connectionConfig: true } });
  const [events, usage, domains, history, tracking] = await Promise.all([
    db().emailEvent.groupBy({
      by: ['emailAccountId', 'type'], where: { workspaceId, occurredAt: { gte: since }, type: { in: ['SENT', 'BOUNCED_HARD', 'BOUNCED_SOFT', 'FAILED', 'COMPLAINED'] } },
      _count: { _all: true }, _max: { occurredAt: true },
    }),
    listAccounts(workspaceId),
    db().domain.findMany({ where: { workspaceId }, select: { name: true, healthStatus: true, verifiedAt: true } }),
    db().auditLog.findMany({
      where: { workspaceId, entityType: 'email_account', action: { in: ['email_account.paused', 'email_account.resumed', 'email_account.auto_paused_provider_errors', 'email_account.auto_paused_bounce_rate', 'email_account.needs_reauth', 'email_account.disconnected'] } },
      orderBy: { createdAt: 'desc' }, take: 150, select: { entityId: true, action: true, createdAt: true },
    }),
    trackingTotals(workspaceId, 'mailbox'),
  ]);
  return accounts.map((a) => {
    const n = (t: string) => events.find((e) => e.emailAccountId === a.id && e.type === t)?._count._all ?? 0;
    const sent = n('SENT');
    const dom = domains.find((d) => a.emailAddress.endsWith(`@${d.name}`));
    const hardBounces = n('BOUNCED_HARD');
    const complaints = n('COMPLAINED');
    const mailboxUsage = usage.find(row => row.id === a.id);
    const hourlyLimit = (mailboxUsage?.sendingWindow as { hourlySendLimit?: number | null } | null | undefined)?.hourlySendLimit ?? null;
    const lastAcceptedAt = events.find(event => event.emailAccountId === a.id && event.type === 'SENT')?._max.occurredAt ?? null;
    const health = classifyMailboxHealth({ connectionStatus: a.status, sent30d: sent, hardBounces30d: hardBounces, complaints30d: complaints, domainHealth: dom?.healthStatus ?? null, domainVerified: !!dom?.verifiedAt, lastSyncedAt: a.lastSyncedAt, lastErrorAt: a.lastErrorAt });
    const { connectionConfig, ...publicAccount } = a;
    const privateConfig = connectionConfig as { connectionHealth?: { smtp?: { ok?: boolean; error?: string | null }; imap?: { ok?: boolean; error?: string | null }; checkedAt?: string }; readiness?: Record<string, unknown> } | null;
    const connectionHealth = privateConfig?.connectionHealth;
    const rawReadiness = privateConfig?.readiness;
    const readiness = rawReadiness ? { ...rawReadiness, globallyEnabled: readinessManagementEnabled, effectiveDailyCap: readinessManagementEnabled && rawReadiness.enabled === true ? Math.min(a.dailySendLimit, Number(rawReadiness.currentDailyCap ?? 5)) : a.dailySendLimit } : null;
    return { ...publicAccount, lifetimeTracking: tracking.get(a.id) ?? emptyTracking, readiness, smtpConnection: connectionHealth?.smtp ?? null, imapConnection: connectionHealth?.imap ?? null, connectionCheckedAt: connectionHealth?.checkedAt ?? null, sent30d: sent, hardBounces30d: hardBounces, bounceRatePct: sent ? +(100 * hardBounces / sent).toFixed(2) : null, complaints30d: complaints, sentToday: mailboxUsage?.sentToday ?? 0, sentLastHour: mailboxUsage?.sentLastHour ?? 0, hourlyLimit, lastAcceptedAt,
      softBounces30d: n('BOUNCED_SOFT'), failed30d: n('FAILED'), healthHistory: history.filter(event => event.entityId === a.id).slice(0, 5), quota: { dailyLimit: readiness?.effectiveDailyCap ?? a.dailySendLimit, source: 'mailbox configuration and readiness cap (provider quotas are not exposed)' }, domain: dom ?? null, health, authStatus: a.status === 'NEEDS_REAUTH' ? 'needs re-authentication' : a.status === 'CONNECTED' ? 'ok' : a.status };
  });
}

export async function dnsProviderConnected(workspaceId: string) { return !!(await getSecret(workspaceId, 'cloudflare')); }

// ------------------------------------------------------------------ zone records: list, edit, delete (explicit approval)

const PROTECTED_TYPES = new Set(['NS', 'SOA']);
async function zoneFor(workspaceId: string, domainId: string) {
  const d = await getDomain(workspaceId, domainId);
  const { secret } = await requireSecret(workspaceId, 'cloudflare');
  const provider = adapters().dnsProviders[d.dnsProvider ?? 'cloudflare'] ?? adapters().dnsProviders.cloudflare;
  const zone = await provider.findZone(secret, d.name);
  if (!zone) throw new AppError('NOT_FOUND', `Zone ${d.name} not found in the connected DNS account`, 404);
  return { d, secret, provider, zone };
}
const inDomain = (name: string, domain: string) => name === domain || name.endsWith(`.${domain}`);

/** Records of the domain's zone, read from the provider (nothing is cached). */
export async function listZoneRecords(workspaceId: string, domainId: string) {
  const { d, secret, provider, zone } = await zoneFor(workspaceId, domainId);
  const records = await provider.listRecords(secret, zone.id, {});
  return { zone: { id: zone.id, name: zone.name, provider: provider.name }, records: records.filter((r) => inDomain(r.name, d.name)).map((r) => ({ ...r, editable: !PROTECTED_TYPES.has(r.type) })) };
}

export const EditRecordSchema = z.object({
  content: z.string().min(1).max(2000), ttl: z.number().int().min(1).max(86400).optional(),
  /** The record's current content, as shown to the user. The edit is refused if the record changed since (no blind overwrite). */
  expectedContent: z.string().max(2000),
});

/** Changes one record's value, only if it still has the value the user saw. Type and name never change. */
export async function editZoneRecord(workspaceId: string, domainId: string, recordId: string, input: z.infer<typeof EditRecordSchema>, actor: Actor) {
  const { d, secret, provider, zone } = await zoneFor(workspaceId, domainId);
  const current = (await provider.listRecords(secret, zone.id, {})).find((r) => r.id === recordId);
  if (!current || !inDomain(current.name, d.name)) throw NotFound('DNS record');
  if (PROTECTED_TYPES.has(current.type)) throw new AppError('FORBIDDEN', `${current.type} records are managed by the DNS provider and cannot be edited here`, 403);
  if (current.content !== input.expectedContent) throw new AppError('CONFLICT', 'This record changed since you loaded it. Reload and review the current value first.', 409, { current: current.content });
  if (input.content.includes('<') || input.content.startsWith('(')) throw new AppError('VALIDATION_FAILED', 'Replace the placeholder with the real value first', 400);
  if (current.type === 'TXT' && /^"?v=spf1/.test(input.content) && !/^"?v=spf1/.test(current.content)) {
    const spf = (await provider.listRecords(secret, zone.id, { type: 'TXT', name: current.name })).filter((r) => r.id !== recordId && r.content.replace(/"/g, '').startsWith('v=spf1'));
    if (spf.length) throw new AppError('CONFLICT', 'Another SPF record already exists for this name; edit that one instead of creating a second SPF record', 409);
  }
  const before = { type: current.type, name: current.name, content: current.content, ttl: current.ttl }; // snapshot before the provider call
  const updated = await provider.updateRecord(secret, zone.id, recordId, { type: before.type, name: before.name, content: input.content, ttl: input.ttl ?? before.ttl });
  await audit(workspaceId, actor, 'domain.dns_record_updated', { type: 'domain', id: domainId }, { recordId, type: before.type, name: before.name, before: before.content, after: input.content });
  return updated;
}

export const DeleteRecordSchema = z.object({ confirmName: z.string().min(1).max(253), expectedContent: z.string().max(2000) });

/** Deletes one record after the user typed its name; refuses NS/SOA and records outside the domain. */
export async function deleteZoneRecord(workspaceId: string, domainId: string, recordId: string, input: z.infer<typeof DeleteRecordSchema>, actor: Actor) {
  const { d, secret, provider, zone } = await zoneFor(workspaceId, domainId);
  const current = (await provider.listRecords(secret, zone.id, {})).find((r) => r.id === recordId);
  if (!current || !inDomain(current.name, d.name)) throw NotFound('DNS record');
  if (PROTECTED_TYPES.has(current.type)) throw new AppError('FORBIDDEN', `${current.type} records cannot be deleted here`, 403);
  if (input.confirmName !== current.name) throw new AppError('VALIDATION_FAILED', 'Type the record name exactly to confirm deletion', 400);
  if (current.content !== input.expectedContent) throw new AppError('CONFLICT', 'This record changed since you loaded it. Reload and review it first.', 409);
  await provider.deleteRecord(secret, zone.id, recordId);
  await audit(workspaceId, actor, 'domain.dns_record_deleted', { type: 'domain', id: domainId }, { recordId, type: current.type, name: current.name, content: current.content });
  return { deleted: true };
}
