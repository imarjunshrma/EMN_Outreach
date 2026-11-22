import { domainToASCII } from 'node:url';
import { Resolver } from 'node:dns/promises';
import { DISPOSABLE_DOMAINS } from './providers/extra.js';
import type { SmtpResult } from './email-verification-smtp.js';

export type EmailCheck = {
  normalizedEmail: string;
  primaryStatus: 'INVALID' | 'UNKNOWN';
  syntax: { valid: boolean; reason?: string };
  domain: string;
  dns: { status: 'NOT_CHECKED' | 'MX' | 'NULL_MX' | 'A_FALLBACK' | 'NO_MAIL_ROUTE' | 'NXDOMAIN' | 'DNS_ERROR'; mx: Array<{ exchange: string; priority: number; addresses: string[] }>; error?: string };
  attributes: { disposable: boolean; freeProvider: boolean; roleBased: boolean };
  smtp?: SmtpResult | { classification: 'DISABLED'; reason: string };
  catchAll?: { status: 'SUSPECTED' | 'NOT_CATCH_ALL' | 'UNKNOWN'; reason: string; controlClassification: string };
  risk?: { score: number; level: 'LOW' | 'MEDIUM' | 'HIGH'; meaning: string; signals: string[] };
  datasetVersion?: string;
  limitations: string[];
};

const FREE_PROVIDERS = new Set(['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','yahoo.com','icloud.com','me.com','proton.me','protonmail.com','aol.com','gmx.com','mail.com','yandex.com']);
const ROLE_LOCALS = new Set(['info','support','sales','contact','admin','office','hello','marketing','billing','careers','hr','jobs','webmaster','abuse','postmaster','help','team','service','enquiries']);
const asciiDomain = (s: string) => domainToASCII(s.normalize('NFC').replace(/\.$/, '').toLowerCase());
export type VerificationDictionaries = { disposableDomains?: ReadonlySet<string>; disposableExclusions?: ReadonlySet<string>; roleLocals?: ReadonlySet<string>; datasetVersion?: string };
function isDisposable(domain: string, included: ReadonlySet<string>, excluded: ReadonlySet<string>) {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const suffix = labels.slice(i).join('.');
    if (excluded.has(suffix)) return false;
    if (included.has(suffix)) return true;
  }
  return false;
}

export function validateEmailSyntax(input: string): { valid: boolean; normalizedEmail: string; domain: string; reason?: string } {
  const normalizedEmail = input.trim().normalize('NFC');
  if (!normalizedEmail || normalizedEmail.length > 254) return { valid: false, normalizedEmail, domain: '', reason: 'Email is empty or exceeds 254 characters' };
  const at = normalizedEmail.indexOf('@');
  if (at <= 0 || at !== normalizedEmail.lastIndexOf('@') || at > 64) return { valid: false, normalizedEmail, domain: '', reason: 'Expected one @ with a local part of 1–64 characters' };
  const local = normalizedEmail.slice(0, at);
  const sourceDomain = normalizedEmail.slice(at + 1);
  const domain = asciiDomain(sourceDomain);
  if (!domain || domain.length > 253 || !domain.includes('.')) return { valid: false, normalizedEmail, domain, reason: 'Domain is not a valid fully qualified domain name' };
  if (Buffer.byteLength(local, 'utf8') > 64) return { valid: false, normalizedEmail, domain, reason: 'Local part exceeds the 64-octet SMTP limit' };
  if (Buffer.byteLength(`${local}@${domain}`, 'utf8') > 254) return { valid: false, normalizedEmail, domain, reason: 'Normalized email exceeds the 254-octet SMTP limit' };
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..') || !/^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~.-]+$/u.test(local)) return { valid: false, normalizedEmail, domain, reason: 'Local part contains invalid characters or dot placement' };
  if (domain.split('.').some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return { valid: false, normalizedEmail, domain, reason: 'Domain contains an invalid label' };
  // SMTPUTF8 local-parts are syntactically possible but need SMTPUTF8 support, which is not probed here.
  return { valid: true, normalizedEmail: `${local}@${domain}`, domain };
}

/** Explainable operational risk indicator; not a probability of delivery or inbox placement. */
export function calculateEmailRisk(check: EmailCheck, extraSignals: string[] = []) {
  let score = 0;
  const signals = [...extraSignals];
  const add = (points: number, signal: string) => { score += points; signals.push(signal); };
  if (!check.syntax.valid) add(100, 'Malformed email syntax');
  if (['NXDOMAIN','NULL_MX','NO_MAIL_ROUTE'].includes(check.dns.status)) add(100, `Domain has no usable mail route (${check.dns.status})`);
  if (check.dns.status === 'DNS_ERROR') add(25, 'DNS resolution failed or timed out');
  if (check.dns.status === 'MX' && check.dns.mx.length && check.dns.mx.every((r) => r.addresses.length === 0)) add(35, 'MX hosts did not resolve to IP addresses');
  if (check.attributes.disposable) add(45, 'Domain appears in the bundled disposable-domain dataset');
  if (check.attributes.roleBased) add(12, 'Role-based local part');
  if (check.attributes.freeProvider) add(5, 'Consumer email provider');
  if (check.smtp?.classification === 'USER_UNKNOWN') add(100, 'Recipient server returned an explicit unknown-user response');
  if (check.smtp?.classification === 'POLICY_REJECTION') add(30, 'Recipient server policy rejected the probe');
  if (check.smtp?.classification === 'GREYLISTED' || check.smtp?.classification === 'TEMPORARY_FAILURE') add(20, 'Recipient server returned a temporary failure');
  if (check.smtp?.classification === 'SMTP_UNAVAILABLE' || check.smtp?.classification === 'CONNECTION_TIMEOUT') add(20, 'SMTP verification was unavailable');
  if (check.catchAll?.status === 'SUSPECTED') add(20, 'A randomized control recipient was also accepted; catch-all is suspected');
  const normalized = Math.min(100, score);
  return { score: normalized, level: normalized >= 60 ? 'HIGH' as const : normalized >= 25 ? 'MEDIUM' as const : 'LOW' as const, meaning: 'Operational warning score only; not a probability of delivery or inbox placement', signals };
}

export async function inspectEmail(input: string, resolver: Pick<Resolver, 'resolveMx' | 'resolve4' | 'resolve6'> = new Resolver(), timeoutMs = 2500, dictionaries: VerificationDictionaries = {}): Promise<EmailCheck> {
  const parsed = validateEmailSyntax(input);
  const local = parsed.normalizedEmail.split('@')[0].toLowerCase();
  const roleLocals = dictionaries.roleLocals ? new Set([...ROLE_LOCALS, ...dictionaries.roleLocals]) : ROLE_LOCALS;
  const attributes = { disposable: isDisposable(parsed.domain, dictionaries.disposableDomains ?? DISPOSABLE_DOMAINS, dictionaries.disposableExclusions ?? new Set()), freeProvider: FREE_PROVIDERS.has(parsed.domain), roleBased: roleLocals.has(local) };
  const base: EmailCheck = { normalizedEmail: parsed.normalizedEmail.toLowerCase(), primaryStatus: parsed.valid ? 'UNKNOWN' : 'INVALID', syntax: { valid: parsed.valid, ...(parsed.reason ? { reason: parsed.reason } : {}) }, domain: parsed.domain, dns: { status: parsed.valid ? 'DNS_ERROR' : 'NOT_CHECKED', mx: [] }, attributes, ...(dictionaries.datasetVersion ? { datasetVersion: dictionaries.datasetVersion } : {}), limitations: ['DNS and domain checks cannot establish that a mailbox exists', 'No SMTP recipient probe or email delivery was performed'] };
  if (!parsed.valid) return base;
  const timed = async <T>(p: Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('DNS query timed out'), { code: 'ETIMEOUT' })), timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  try {
    const mx = await timed(resolver.resolveMx(parsed.domain));
    if (mx.some((r) => r.exchange === '.')) { base.dns.status = 'NULL_MX'; base.primaryStatus = 'INVALID'; return base; }
    const ordered = mx.filter((r) => r.exchange !== '.').sort((a, b) => a.priority - b.priority).slice(0, 10);
    base.dns.mx = await Promise.all(ordered.map(async (r) => {
      const exchange = asciiDomain(r.exchange);
      const addresses = await Promise.allSettled([timed(resolver.resolve4(exchange)), timed(resolver.resolve6(exchange))]);
      return { exchange, priority: r.priority, addresses: addresses.flatMap((x) => x.status === 'fulfilled' ? x.value : []) };
    }));
    base.dns.status = ordered.length ? 'MX' : 'NO_MAIL_ROUTE';
    if (!ordered.length) {
      const [a, aaaa] = await Promise.allSettled([timed(resolver.resolve4(parsed.domain)), timed(resolver.resolve6(parsed.domain))]);
      if ((a.status === 'fulfilled' && a.value.length) || (aaaa.status === 'fulfilled' && aaaa.value.length)) base.dns.status = 'A_FALLBACK';
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENODATA') {
      const [a, aaaa] = await Promise.allSettled([timed(resolver.resolve4(parsed.domain)), timed(resolver.resolve6(parsed.domain))]);
      if ((a.status === 'fulfilled' && a.value.length) || (aaaa.status === 'fulfilled' && aaaa.value.length)) base.dns.status = 'A_FALLBACK';
      else base.dns.status = 'NO_MAIL_ROUTE';
    } else if (code === 'ENOTFOUND') {
      base.dns.status = 'NXDOMAIN';
      base.dns.error = 'Domain does not resolve';
    } else { base.dns.status = 'DNS_ERROR'; base.dns.error = code === 'ETIMEOUT' ? 'DNS query timed out' : code === 'ESERVFAIL' ? 'DNS resolver failure' : 'DNS lookup failed'; }
  }
  if (['NULL_MX', 'NO_MAIL_ROUTE', 'NXDOMAIN'].includes(base.dns.status)) base.primaryStatus = 'INVALID';
  return base;
}
