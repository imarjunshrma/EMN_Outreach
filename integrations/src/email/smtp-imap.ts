import { assertRealEmailProviderAllowed } from './real-provider-safety.js';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { ProviderError } from '../http.js';
import { buildMime, parseRawMessage } from './mime.js';
import {
  OUTBOUND_HEADER,
  type AuthHandle, type EmailProvider, type MailboxProfile, type NormalizedMessage, type OutgoingMessage,
  type ConnectionCheck, type SentResult, type SmtpImapConfig, type SyncResult,
} from './types.js';

// SMTP (send) + IMAP (sync) adapter for providers that permit app-password / password access.
// Use only where the mailbox provider's terms and security policy allow it.

function creds(auth: AuthHandle): { config: SmtpImapConfig; password: string; smtpPassword: string; imapPassword: string; email: string } {
  if (auth.kind !== 'password') throw new ProviderError('smtp', 'password credentials required');
  return { ...auth, smtpPassword: auth.smtpPassword ?? auth.password, imapPassword: auth.imapPassword ?? auth.password };
}

/**
 * Map SMTP reply codes onto the HTTP-style statuses the send engine understands:
 *   530/534/535 (auth)          → 401  mailbox needs re-authentication
 *   5xx (permanent rejection)   → 400  fail this email, never retry
 *   4xx (temporary, e.g. 421/450/451/452) → 503  retryable
 *   no code (network/TLS/timeout)        → undefined  ambiguous: reconcile before any retry
 */
type SmtpSubmissionError = Error & { responseCode?: number; code?: string; command?: string; response?: string };

export function smtpError(err: SmtpSubmissionError): ProviderError {
  const c = err.responseCode;
  if (err.code === 'EAUTH' || c === 530 || c === 534 || c === 535) return new ProviderError('smtp', 'SMTP authentication failed', 401, false, undefined, undefined, 'PROVIDER_REJECTED');
  if (c && c >= 500 && err.command === 'RCPT TO' && /\b5\.1\.1\b/.test(err.response ?? '')) {
    return new ProviderError('smtp', 'SMTP rejected the recipient as nonexistent', 400, false, undefined, 'RECIPIENT_NOT_FOUND', 'PROVIDER_REJECTED');
  }
  if (c && c >= 500) return new ProviderError('smtp', `SMTP provider rejected the message (${c})`, 400, false, undefined, undefined, 'PROVIDER_REJECTED');
  if (c && c >= 400) return new ProviderError('smtp', `SMTP provider temporarily unavailable (${c})`, 503, true, undefined, undefined, 'PROVIDER_REJECTED');
  return new ProviderError('smtp', 'SMTP connection failed or timed out', undefined, true);
}

function imapError(err: unknown): ProviderError {
  const e = err as { code?: string; responseText?: string; message?: string };
  const hint = `${e?.code ?? ''} ${e?.responseText ?? ''} ${e?.message ?? ''}`;
  if (/auth|login|credential|password|invalid.*user|not authenticated/i.test(hint)) return new ProviderError('imap', 'IMAP authentication failed', 401, false);
  return new ProviderError('imap', 'IMAP connection or synchronization failed', undefined, true);
}

export interface ImapCursor { [folder: string]: { uidValidity: string; lastUid: number } }

export class SmtpImapProvider implements EmailProvider {
  readonly name = 'SMTP_IMAP' as const;
  constructor() { assertRealEmailProviderAllowed(); }

  private imap(auth: AuthHandle) {
    const { config, imapPassword } = creds(auth);
    return new ImapFlow({ host: config.imapHost, port: config.imapPort, secure: config.imapSecure, auth: { user: config.imapUsername ?? config.username, pass: imapPassword }, logger: false });
  }

  async testConnection(auth: AuthHandle): Promise<MailboxProfile> {
    const { config, email } = creds(auth);
    const check = await this.testConnectionDetailed(auth);
    if (!check.smtp.ok || !check.imap.ok) {
      const failures = [!check.smtp.ok && `SMTP: ${check.smtp.error}`, !check.imap.ok && `IMAP: ${check.imap.error}`].filter(Boolean).join('; ');
      throw new ProviderError('smtp-imap', failures, 400, false);
    }
    return { email: email.toLowerCase(), providerAccountId: `${config.imapUsername ?? config.username}@${config.imapHost}` };
  }

  async testConnectionDetailed(auth: AuthHandle): Promise<ConnectionCheck> {
    const { config, smtpPassword } = creds(auth);
    let smtp: ConnectionCheck['smtp'];
    const transport = nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure, auth: { user: config.smtpUsername ?? config.username, pass: smtpPassword } });
    try { await transport.verify(); smtp = { ok: true, error: null }; }
    catch (e) { smtp = { ok: false, error: smtpError(e as SmtpSubmissionError).message }; }

    let imap: ConnectionCheck['imap'];
    const client = this.imap(auth);
    try { await client.connect(); imap = { ok: true, error: null }; }
    catch (e) { imap = { ok: false, error: imapError(e).message }; }
    finally { await client.logout().catch(() => undefined); }
    return { smtp, imap };
  }

  async send(auth: AuthHandle, msg: OutgoingMessage): Promise<SentResult> {
    const { config, smtpPassword } = creds(auth);
    const raw = await buildMime(msg);
    const transport = nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure, auth: { user: config.smtpUsername ?? config.username, pass: smtpPassword } });
    try {
      await transport.sendMail({ envelope: { from: msg.from.address, to: [msg.to] }, raw });
    } catch (e) {
      throw smtpError(e as SmtpSubmissionError);
    }
    if (config.appendToSent) {
      const client = this.imap(auth);
      try {
        await client.connect();
        await client.append(config.sentFolder ?? 'Sent', raw, ['\\Seen']);
      } catch {
        // SMTP has already accepted the message. A failed Sent copy cannot undo submission.
      } finally { await client.logout().catch(() => undefined); }
    }
    return { providerMessageId: msg.messageId, providerThreadId: msg.references?.[0] ?? msg.inReplyTo ?? msg.messageId, internetMessageId: msg.messageId };
  }

  async findSentByOutboundId(auth: AuthHandle, q: { outboundId: string; to: string; since: Date }): Promise<SentResult | null> {
    const { config } = creds(auth);
    const client = this.imap(auth);
    try { await client.connect(); } catch (e) { throw imapError(e); }
    try {
      const lock = await client.getMailboxLock(config.sentFolder ?? 'Sent');
      try {
        const uids = await client.search({ header: { [OUTBOUND_HEADER]: q.outboundId }, since: q.since }, { uid: true });
        if (!uids || uids.length === 0) return null;
        const msg = await client.fetchOne(String(uids[0]), { envelope: true }, { uid: true });
        const mid = msg && msg.envelope?.messageId ? msg.envelope.messageId : '';
        return { providerMessageId: mid, providerThreadId: mid, internetMessageId: mid };
      } finally { lock.release(); }
    } catch (e) { throw imapError(e); }
    finally { await client.logout().catch(() => undefined); }
  }

  async sync(auth: AuthHandle, cursor: string | null, since: Date): Promise<SyncResult> {
    const { config } = creds(auth);
    const cur: ImapCursor = cursor ? JSON.parse(cursor) : {};
    const folders = ['INBOX', config.sentFolder ?? 'Sent'];
    const client = this.imap(auth);
    try { await client.connect(); } catch (e) { throw imapError(e); }
    const messages: NormalizedMessage[] = [];
    try {
      for (const configuredFolder of folders) {
        let folder = configuredFolder;
        let lock;
        try { lock = await client.getMailboxLock(folder); } catch (e) {
          // INBOX is required for reply tracking. The sent folder is optional;
          // discover providers' special-use Sent folder if the configured name is absent.
          if (folder === 'INBOX') throw e;
          try {
            const sent = (await client.list()).find((f) => f.specialUse?.toLowerCase() === '\\sent');
            if (!sent || sent.path === folder) continue;
            folder = sent.path;
            lock = await client.getMailboxLock(folder);
          } catch { continue; }
        }
        try {
          const mailbox = client.mailbox;
          const uidValidity = mailbox && typeof mailbox === 'object' ? String(mailbox.uidValidity) : '0';
          const prev = cur[folder];
          const range = prev && prev.uidValidity === uidValidity ? { uid: `${prev.lastUid + 1}:*` } : { since };
          let lastUid = prev && prev.uidValidity === uidValidity ? prev.lastUid : 0;
          for await (const m of client.fetch(range as never, { source: true, uid: true }, { uid: true })) {
            if (!m.source || (prev && m.uid <= prev.lastUid)) continue;
            messages.push(await parseRawMessage(m.source, { providerMessageId: `${folder}:${uidValidity}:${m.uid}` }));
            lastUid = Math.max(lastUid, m.uid);
          }
          cur[folder] = { uidValidity, lastUid };
        } finally { lock.release(); }
      }
    } catch (e) { throw imapError(e); }
    finally { await client.logout().catch(() => undefined); }
    return { messages, nextCursor: JSON.stringify(cur) };
  }
}
