import { connect, isIP } from 'node:net';
import { Resolver as DefaultResolver, type Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { validateEmailSyntax } from './email-verification.js';

export type SmtpClassification = 'ACCEPTED_BUT_UNCONFIRMED' | 'USER_UNKNOWN' | 'TEMPORARY_FAILURE' | 'GREYLISTED' | 'POLICY_REJECTION' | 'SMTP_UNAVAILABLE' | 'CONNECTION_TIMEOUT' | 'CONNECTION_REFUSED' | 'CONNECTION_RESET' | 'AUTHENTICATION_REQUIRED' | 'INCONCLUSIVE';
export type SmtpResult = { classification: SmtpClassification; code?: number; enhancedCode?: string; response?: string; mx?: string; durationMs: number; reason?: string };
export type MailboxEvidenceStatus = 'VALID' | 'INVALID' | 'CATCH_ALL' | 'UNKNOWN';

/**
 * Only call an address VALID when its MX accepted RCPT TO and explicitly
 * rejected a randomized control address. A single SMTP acceptance is not
 * mailbox proof because many providers accept every recipient at the edge.
 */
export function classifyMailboxEvidence(target: SmtpResult, control?: SmtpResult): MailboxEvidenceStatus {
  if (target.classification === 'USER_UNKNOWN') return 'INVALID';
  if (target.classification !== 'ACCEPTED_BUT_UNCONFIRMED') return 'UNKNOWN';
  if (control?.classification === 'ACCEPTED_BUT_UNCONFIRMED') return 'CATCH_ALL';
  if (control?.classification === 'USER_UNKNOWN') return 'VALID';
  return 'UNKNOWN';
}

export function classifySmtpReply(reply: string): Pick<SmtpResult, 'classification' | 'code' | 'enhancedCode' | 'response'> {
  const code = Number(reply.match(/^(\d{3})/)?.[1]);
  const enhancedCode = reply.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/)?.[1];
  const response = reply.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
  if ([250, 251, 252].includes(code)) return { classification: 'ACCEPTED_BUT_UNCONFIRMED', code, enhancedCode, response };
  if (code === 535 || code === 530) return { classification: 'AUTHENTICATION_REQUIRED', code, enhancedCode, response };
  if (code >= 400 && code < 500) return { classification: enhancedCode === '4.7.1' || /grey.?list|try again later/i.test(response) ? 'GREYLISTED' : 'TEMPORARY_FAILURE', code, enhancedCode, response };
  if (code === 550 && (enhancedCode === '5.1.1' || /user unknown|no such (user|mailbox)|mailbox (was )?not found/i.test(response))) return { classification: 'USER_UNKNOWN', code, enhancedCode, response };
  if (code >= 500 && code < 600) return { classification: 'POLICY_REJECTION', code, enhancedCode, response };
  return { classification: 'INCONCLUSIVE', ...(Number.isFinite(code) ? { code } : {}), ...(enhancedCode ? { enhancedCode } : {}), response };
}

function classifyNonRecipientReply(reply: string) {
  const result = classifySmtpReply(reply);
  return result.classification === 'USER_UNKNOWN' ? { ...result, classification: 'POLICY_REJECTION' as const } : result;
}

function ipv4Public(ip: string) {
  const n = ip.split('.').map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a,b] = n;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 192 && b === 88 && n[2] === 99) || (a === 198 && (b === 18 || b === 19 || b === 51 && n[2] === 100)) || (a === 203 && b === 0 && n[2] === 113));
}

function ipv6Public(ip: string) {
  if (!ip.includes(':') || ip.startsWith('::ffff:')) return false;
  const halves = ip.toLowerCase().split('::');
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const zeros = 8 - left.length - right.length;
  if (zeros < 0) return false;
  const words = [...left, ...Array(zeros).fill('0'), ...right].map((x) => Number.parseInt(x || '0', 16));
  const [first, second] = words;
  // Only globally routed 2000::/3; exclude documentation, 6to4 and special 2001::/23 ranges.
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff && !(first === 0x2001 && (second <= 0x1ff || second === 0x0db8));
}

export function isPublicMxAddress(ip: string) {
  const family = isIP(ip);
  return family === 4 ? ipv4Public(ip) : family === 6 ? ipv6Public(ip) : false;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' })), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

type Reply = { code: number; text: string };
class SmtpConversation {
  private buffer = '';
  private replies: Array<{ reply: Reply; resolve: (r: Reply) => void; reject: (e: Error) => void }> = [];
  private socket;
  private closed = false;
  constructor(host: string, port: number, timeoutMs: number) {
    this.socket = connect({ host, port });
    this.socket.setTimeout(timeoutMs);
    this.socket.on('data', (chunk: Buffer) => { this.buffer += chunk.toString('utf8'); this.drain(); });
    this.socket.on('timeout', () => this.fail(Object.assign(new Error('SMTP connection timed out'), { code: 'ETIMEDOUT' })));
    this.socket.on('error', (e) => this.fail(e));
    this.socket.on('close', () => { if (!this.closed) this.fail(Object.assign(new Error('SMTP connection closed'), { code: 'ECONNRESET' })); });
  }
  private fail(e: Error) { const pending = this.replies.splice(0); for (const x of pending) x.reject(e); }
  private drain() {
    const lines = this.buffer.split(/\r?\n/); this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const match = line.match(/^(\d{3})([ -])(.*)$/); if (!match) continue;
      const code = Number(match[1]);
      if (match[2] === '-') continue;
      const pending = this.replies.shift(); if (pending) pending.resolve({ code, text: `${code} ${match[3]}` });
    }
  }
  async read(): Promise<Reply> { return new Promise((resolve, reject) => this.replies.push({ reply: { code: 0, text: '' }, resolve, reject })); }
  write(command: string) { this.socket.write(`${command}\r\n`); }
  end() { this.closed = true; this.socket.end(); }
}

async function exchange(mx: string, ip: string, email: string, mailFrom: string, timeoutMs: number): Promise<SmtpResult> {
  const started = Date.now();
  let smtp: SmtpConversation | undefined;
  try {
    smtp = new SmtpConversation(ip, 25, timeoutMs);
    const greeting = await smtp.read();
    if (greeting.code !== 220) return { ...classifyNonRecipientReply(greeting.text), mx, durationMs: Date.now() - started };
    smtp.write('EHLO emn-outreach-os.invalid');
    let reply = await smtp.read();
    if (reply.code !== 250) return { ...classifyNonRecipientReply(reply.text), mx, durationMs: Date.now() - started };
    smtp.write(`MAIL FROM:<${mailFrom}>`);
    reply = await smtp.read();
    if (reply.code < 200 || reply.code >= 300) return { ...classifyNonRecipientReply(reply.text), mx, durationMs: Date.now() - started };
    smtp.write(`RCPT TO:<${email}>`);
    reply = await smtp.read();
    return { ...classifySmtpReply(reply.text), mx, durationMs: Date.now() - started };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const classification: SmtpClassification = code === 'ETIMEDOUT' ? 'CONNECTION_TIMEOUT' : code === 'ECONNREFUSED' ? 'CONNECTION_REFUSED' : code === 'ECONNRESET' ? 'CONNECTION_RESET' : 'SMTP_UNAVAILABLE';
    return { classification, mx, durationMs: Date.now() - started, reason: classification };
  } finally {
    if (smtp) { try { smtp.write('QUIT'); await Promise.race([smtp.read(), new Promise((r) => setTimeout(r, 250))]); } catch { /* close below */ } smtp.end(); }
  }
}

/** Opt-in probe; only connects to publicly routable addresses returned for the recipient's MX records. Never sends DATA. */
export async function probeRecipientSmtp(input: { email: string; domain: string; mx: Array<{ exchange: string; priority: number; addresses: string[] }> }, options: { enabled: boolean; mailFrom?: string; timeoutMs?: number; resolver?: Pick<Resolver, 'resolveMx' | 'resolve4' | 'resolve6'> }): Promise<SmtpResult> {
  if (!options.enabled || !options.mailFrom) return { classification: 'SMTP_UNAVAILABLE', reason: 'SMTP verification is disabled or EMAIL_VERIFY_MAIL_FROM is not configured', durationMs: 0 };
  const recipient = validateEmailSyntax(input.email);
  const sender = validateEmailSyntax(options.mailFrom);
  const domain = domainToASCII(input.domain.trim().replace(/\.$/, '').toLowerCase());
  if (!recipient.valid || !sender.valid || recipient.domain !== domain) return { classification: 'INCONCLUSIVE', reason: 'SMTP envelope address or recipient domain failed validation', durationMs: 0 };
  if (!isAsciiLocalPart(recipient.normalizedEmail) || !isAsciiLocalPart(sender.normalizedEmail)) return { classification: 'INCONCLUSIVE', reason: 'SMTPUTF8 envelope addresses are not probed by this client', durationMs: 0 };
  const sorted = [...input.mx].sort((a,b) => a.priority-b.priority).slice(0, 10);
  let attempts = 0;
  for (const record of sorted) for (const address of record.addresses.slice(0, 2)) {
    if (!isPublicMxAddress(address)) continue;
    if (attempts++ >= 4) return { classification: 'SMTP_UNAVAILABLE', reason: 'No conclusive result after the MX probe limit', durationMs: 0 };
    const result = await exchange(record.exchange, address, recipient.normalizedEmail, sender.normalizedEmail, options.timeoutMs ?? 5000);
    if (!['SMTP_UNAVAILABLE','CONNECTION_REFUSED','CONNECTION_RESET','CONNECTION_TIMEOUT'].includes(result.classification)) return result;
  }
  return { classification: 'SMTP_UNAVAILABLE', reason: 'No publicly routable MX address could be verified', durationMs: 0 };
}

export async function diagnoseSmtpConnectivity(mailFrom: string | undefined, options: { enabled: boolean; timeoutMs?: number; resolver?: Pick<Resolver, 'resolveMx' | 'resolve4' | 'resolve6'> }) {
  if (!options.enabled || !mailFrom) return { status: 'DISABLED' as const, message: 'SMTP verification is disabled or no MAIL FROM address is configured' };
  const domain = mailFrom.split('@')[1]?.toLowerCase();
  if (!domain) return { status: 'CONFIGURATION_ERROR' as const, message: 'MAIL FROM must be an email address' };
  const resolver = options.resolver ?? new DefaultResolver();
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 5000;
  try {
    const records = (await withTimeout(resolver.resolveMx(domain), timeoutMs)).filter((x) => x.exchange !== '.').sort((a,b) => a.priority-b.priority).slice(0, 3);
    for (const record of records) {
      const addresses = await Promise.allSettled([withTimeout(resolver.resolve4(record.exchange), timeoutMs), withTimeout(resolver.resolve6(record.exchange), timeoutMs)]);
      const ips = addresses.flatMap((x) => x.status === 'fulfilled' ? x.value : []).filter(isPublicMxAddress).slice(0, 2);
      for (const ip of ips) {
        let smtp: SmtpConversation | undefined;
        try {
          smtp = new SmtpConversation(ip, 25, timeoutMs);
          const greeting = await smtp.read();
          if (greeting.code !== 220) continue;
          smtp.write('EHLO emn-outreach-os.invalid');
          const ehlo = await smtp.read();
          if (ehlo.code === 250) return { status: 'CONNECTED' as const, mx: record.exchange, responseCode: ehlo.code, durationMs: Date.now() - started, message: 'Outbound port 25 reached the configured sender domain MX; no recipient command or email was sent' };
        } catch { /* try next public MX address */ }
        finally { if (smtp) { try { smtp.write('QUIT'); } catch { /* socket may be closed */ } smtp.end(); } }
      }
    }
    return { status: 'UNAVAILABLE' as const, durationMs: Date.now() - started, message: 'No public MX host accepted an SMTP handshake; outbound port 25 may be blocked or the provider may refuse diagnostics' };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { status: 'DNS_ERROR' as const, durationMs: Date.now() - started, message: code === 'ENOTFOUND' ? 'Configured MAIL FROM domain did not resolve' : code === 'ETIMEOUT' ? 'DNS lookup timed out while resolving the configured MAIL FROM domain' : 'Could not resolve the configured MAIL FROM domain MX records' };
  }
}

/** True when the part before '@' is non-empty plain ASCII (SMTPUTF8 addresses are not probed). */
function isAsciiLocalPart(email: string) {
  const local = email.split('@')[0];
  return local.length > 0 && [...local].every((c) => c.charCodeAt(0) < 0x80);
}
