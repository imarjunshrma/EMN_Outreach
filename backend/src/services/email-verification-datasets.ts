import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { DISPOSABLE_DOMAINS } from '../../../integrations/src/providers/extra.js';
import type { VerificationDictionaries } from '../../../integrations/src/email-verification.js';
import { db } from '../core/db.js';
import { acquireLock } from '../core/redis.js';
import { audit, type Actor } from '../core/audit.js';
import { AppError } from '../core/errors.js';

const SOURCE = 'disposable-email-domains';
const SOURCE_URL = 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf';
const cache = new Map<string, { expiresAt: number; dictionaries: VerificationDictionaries }>();
const loading = new Map<string, Promise<VerificationDictionaries>>();

export function verificationCacheVersion(datasetVersion: string, options: { workspaceSmtpEnabled: boolean; smtpEnabled: boolean; catchAllEnabled: boolean; mailFrom?: string }) {
  return createHash('sha256').update(JSON.stringify({
    datasetVersion,
    workspaceSmtpEnabled: options.workspaceSmtpEnabled,
    smtpEnabled: options.smtpEnabled,
    catchAllEnabled: options.catchAllEnabled,
    mailFrom: options.mailFrom?.trim().toLowerCase() ?? null,
  })).digest('hex');
}

function normalizeDomain(input: string) {
  const domain = domainToASCII(input.trim().replace(/^@/, '').replace(/\.$/, '').toLowerCase());
  if (!domain || domain.length > 253 || domain.includes('/') || domain.includes(':') || domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new AppError('VALIDATION_FAILED', 'Provide a valid domain name', 400);
  return domain;
}

export async function verificationDictionaries(workspaceId: string, workspaceSmtpEnabled = false, workspaceMailFrom?: string | null): Promise<VerificationDictionaries> {
  const cached = cache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) return withVerificationConfig(cached.dictionaries, workspaceSmtpEnabled, workspaceMailFrom);
  const inFlight = loading.get(workspaceId);
  if (inFlight) return withVerificationConfig(await inFlight, workspaceSmtpEnabled, workspaceMailFrom);
  const pending = (async () => {
    const [domains, overrides, patterns] = await Promise.all([
      db().disposableEmailDomain.findMany({ where: { source: SOURCE }, select: { domain: true } }),
      db().emailVerificationDomainOverride.findMany({ where: { workspaceId } }),
      db().emailVerificationRolePattern.findMany({ where: { workspaceId, enabled: true }, select: { localPart: true } }),
    ]);
    const dataset = await db().emailVerificationDataset.findUnique({ where: { key: SOURCE }, select: { checksum: true, lastUpdated: true } });
    const disposableDomains = new Set([...DISPOSABLE_DOMAINS, ...domains.map((d) => d.domain)]);
    const disposableExclusions = new Set<string>();
    for (const o of overrides) (o.disposable ? disposableDomains : disposableExclusions).add(o.domain);
    const roleLocals = new Set(patterns.map((p) => p.localPart));
    const datasetVersion = createHash('sha256').update(JSON.stringify({
      checksum: dataset?.checksum ?? 'bundled-fallback',
      updated: dataset?.lastUpdated?.toISOString() ?? null,
      overrides: overrides.map((o) => [o.domain, o.disposable]).sort(),
      roles: patterns.map((p) => p.localPart).sort(),
      smtp: /^(true|1)$/i.test(process.env.EMAIL_VERIFY_SMTP_ENABLED ?? ''),
      catchAll: /^(true|1)$/i.test(process.env.EMAIL_VERIFY_CATCH_ALL_ENABLED ?? ''),
    })).digest('hex');
    const dictionaries = { disposableDomains, disposableExclusions, roleLocals, datasetVersion };
    cache.set(workspaceId, { expiresAt: Date.now() + 300_000, dictionaries });
    return dictionaries;
  })();
  loading.set(workspaceId, pending);
  try { return withVerificationConfig(await pending, workspaceSmtpEnabled, workspaceMailFrom); }
  finally { if (loading.get(workspaceId) === pending) loading.delete(workspaceId); }
}

function withVerificationConfig(dictionaries: VerificationDictionaries, workspaceSmtpEnabled: boolean, workspaceMailFrom?: string | null): VerificationDictionaries {
  const env = {
    workspaceSmtpEnabled,
    smtpEnabled: /^(true|1)$/i.test(process.env.EMAIL_VERIFY_SMTP_ENABLED ?? ''),
    catchAllEnabled: /^(true|1)$/i.test(process.env.EMAIL_VERIFY_CATCH_ALL_ENABLED ?? ''),
    mailFrom: workspaceMailFrom?.trim() || process.env.EMAIL_VERIFY_MAIL_FROM,
  };
  return { ...dictionaries, datasetVersion: verificationCacheVersion(dictionaries.datasetVersion ?? 'unknown', env) };
}

export async function listVerificationDatasets(workspaceId: string) {
  const [dataset, overrides, rolePatterns] = await Promise.all([
    db().emailVerificationDataset.findUnique({ where: { key: SOURCE } }),
    db().emailVerificationDomainOverride.findMany({ where: { workspaceId }, orderBy: { domain: 'asc' } }),
    db().emailVerificationRolePattern.findMany({ where: { workspaceId }, orderBy: { localPart: 'asc' } }),
  ]);
  return { dataset, overrides, rolePatterns, bundledFallbackCount: DISPOSABLE_DOMAINS.size };
}

export async function setDomainOverride(workspaceId: string, input: { domain: string; disposable: boolean }, actor: Actor) {
  const domain = normalizeDomain(input.domain);
  const row = await db().emailVerificationDomainOverride.upsert({ where: { workspaceId_domain: { workspaceId, domain } }, create: { workspaceId, domain, disposable: input.disposable, createdBy: actor.userId }, update: { disposable: input.disposable } });
  cache.delete(workspaceId);
  await audit(workspaceId, actor, 'email_verification.domain_override', { type: 'verification_domain', id: row.id }, { domain, disposable: input.disposable });
  return row;
}

export async function removeDomainOverride(workspaceId: string, id: string, actor: Actor) {
  const row = await db().emailVerificationDomainOverride.findFirst({ where: { id, workspaceId } });
  if (!row) throw new AppError('NOT_FOUND', 'Domain override not found', 404);
  await db().emailVerificationDomainOverride.delete({ where: { id } });
  cache.delete(workspaceId);
  await audit(workspaceId, actor, 'email_verification.domain_override_removed', { type: 'verification_domain', id }, { domain: row.domain });
  return { ok: true };
}

export async function setRolePattern(workspaceId: string, input: { localPart: string; enabled: boolean }, actor: Actor) {
  const localPart = input.localPart.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(localPart)) throw new AppError('VALIDATION_FAILED', 'Role patterns must be a local-part token, not a regular expression', 400);
  const row = await db().emailVerificationRolePattern.upsert({ where: { workspaceId_localPart: { workspaceId, localPart } }, create: { workspaceId, localPart, enabled: input.enabled, createdBy: actor.userId }, update: { enabled: input.enabled } });
  cache.delete(workspaceId);
  await audit(workspaceId, actor, 'email_verification.role_pattern', { type: 'verification_role_pattern', id: row.id }, { localPart, enabled: input.enabled });
  return row;
}

export async function refreshDisposableDataset() {
  const release = await acquireLock('email-verification-dataset-refresh', 120_000);
  if (!release) return { skipped: 'another worker is refreshing the dataset' };
  try {
    const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(20_000), headers: { accept: 'text/plain' } });
    if (!response.ok) throw new Error(`Dataset host returned HTTP ${response.status}`);
    if (response.url && new URL(response.url).hostname !== 'raw.githubusercontent.com') throw new Error('Dataset redirect target was not trusted');
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > 5_000_000) throw new Error('Dataset exceeds the 5 MB safety limit');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Dataset response had no body');
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > 5_000_000) { await reader.cancel(); throw new Error('Dataset exceeds the 5 MB safety limit'); }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks.map((x) => Buffer.from(x))).toString('utf8');
    const domains = [...new Set(text.split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter((line) => line && !line.startsWith('#') && !line.startsWith('//')).map((line) => normalizeDomain(line)))];
    if (domains.length < 1_000 || domains.length > 250_000) throw new Error(`Unexpected dataset size (${domains.length} domains); existing data was preserved`);
    const checksum = createHash('sha256').update(text).digest('hex');
    const fetchedAt = new Date();
    await db().$transaction(async (tx) => {
      await tx.disposableEmailDomain.deleteMany({ where: { source: SOURCE } });
      for (let i = 0; i < domains.length; i += 2000) await tx.disposableEmailDomain.createMany({ data: domains.slice(i, i + 2000).map((domain) => ({ domain, source: SOURCE, sourceUrl: SOURCE_URL, fetchedAt })), skipDuplicates: true });
      await tx.emailVerificationDataset.upsert({ where: { key: SOURCE }, create: { key: SOURCE, sourceUrl: SOURCE_URL, lastUpdated: fetchedAt, domainCount: domains.length, checksum, lastStatus: 'OK', lastError: null }, update: { sourceUrl: SOURCE_URL, lastUpdated: fetchedAt, domainCount: domains.length, checksum, lastStatus: 'OK', lastError: null } });
    }, { maxWait: 10_000, timeout: 120_000 });
    cache.clear();
    return { status: 'OK', source: SOURCE, domainCount: domains.length, checksum, updatedAt: fetchedAt.toISOString() };
  } catch (e) {
    const message = (e as Error).message.replace(/[\r\n\t]/g, ' ').slice(0, 200);
    await db().emailVerificationDataset.upsert({ where: { key: SOURCE }, create: { key: SOURCE, sourceUrl: SOURCE_URL, lastStatus: 'ERROR', lastError: message }, update: { lastStatus: 'ERROR', lastError: message } }).catch(() => undefined);
    throw e;
  } finally { await release(); }
}
