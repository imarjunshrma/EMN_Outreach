import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { ProviderError } from '../http.js';
import { buildMime, parseRawMessage } from './mime.js';
import {
  OUTBOUND_HEADER,
  type AuthHandle, type EmailProvider, type MailboxProfile, type NormalizedMessage, type OutgoingMessage,
  type SentResult, type SmtpImapConfig, type SyncResult,
} from './types.js';

// SMTP (send) + IMAP (sync) adapter for providers that permit app-password / password access.
// Use only where the mailbox provider's terms and security policy allow it.

function creds(auth: AuthHandle): { config: SmtpImapConfig; password: string; email: string } {
  if (auth.kind !== 'password') throw new ProviderError('smtp', 'password credentials required');
  return auth;
}

/**
 * Map SMTP reply codes onto the HTTP-style statuses the send engine understands:
 *   530/534/535 (auth)          → 401  mailbox needs re-authentication
 *   5xx (permanent rejection)   → 400  fail this email, never retry
 *   4xx (temporary, e.g. 421/450/451/452) → 503  retryable
 *   no code (network/TLS/timeout)        → undefined  ambiguous: reconcile before any retry
 */
export function smtpError(err: Error & { responseCode?: number; code?: string }): ProviderError {
  const c = err.responseCode;
  if (err.code === 'EAUTH' || c === 530 || c === 534 || c === 535) return new ProviderError('smtp', `SMTP authentication failed: ${err.message}`, 401, false);
  if (c && c >= 500) return new ProviderError('smtp', `SMTP permanent rejection ${c}: ${err.message}`, 400, false);
  if (c && c >= 400) return new ProviderError('smtp', `SMTP temporary failure ${c}: ${err.message}`, 503, true);
  return new ProviderError('smtp', err.message, undefined, true);
}

export interface ImapCursor { [folder: string]: { uidValidity: string; lastUid: number } }

export class SmtpImapProvider implements EmailProvider {
  readonly name = 'SMTP_IMAP' as const;

  private imap(auth: AuthHandle) {
    const { config, password } = creds(auth);
    return new ImapFlow({ host: config.imapHost, port: config.imapPort, secure: config.imapSecure, auth: { user: config.username, pass: password }, logger: false });
  }

  async testConnection(auth: AuthHandle): Promise<MailboxProfile> {
    const { config, password, email } = creds(auth);
    const transport = nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure, auth: { user: config.username, pass: password } });
    await transport.verify().catch((e: Error) => { throw new ProviderError('smtp', `SMTP login failed: ${e.message}`); });
    const client = this.imap(auth);
    await client.connect().catch((e: Error) => { throw new ProviderError('imap', `IMAP login failed: ${e.message}`); });
    await client.logout();
    return { email: email.toLowerCase(), providerAccountId: `${config.username}@${config.imapHost}` };
  }

  async send(auth: AuthHandle, msg: OutgoingMessage): Promise<SentResult> {
    const { config, password } = creds(auth);
    const raw = await buildMime(msg);
    const transport = nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure, auth: { user: config.username, pass: password } });
    try {
      await transport.sendMail({ envelope: { from: msg.from.address, to: [msg.to] }, raw });
    } catch (e) {
      throw smtpError(e as Error & { responseCode?: number; code?: string });
    }
    if (config.appendToSent) {
      const client = this.imap(auth);
      try {
        await client.connect();
        await client.append(config.sentFolder ?? 'Sent', raw, ['\\Seen']);
      } finally { await client.logout().catch(() => undefined); }
    }
    return { providerMessageId: msg.messageId, providerThreadId: msg.references?.[0] ?? msg.inReplyTo ?? msg.messageId, internetMessageId: msg.messageId };
  }

  async findSentByOutboundId(auth: AuthHandle, q: { outboundId: string; to: string; since: Date }): Promise<SentResult | null> {
    const { config } = creds(auth);
    const client = this.imap(auth);
    await client.connect();
    try {
      const lock = await client.getMailboxLock(config.sentFolder ?? 'Sent');
      try {
        const uids = await client.search({ header: { [OUTBOUND_HEADER]: q.outboundId }, since: q.since }, { uid: true });
        if (!uids || uids.length === 0) return null;
        const msg = await client.fetchOne(String(uids[0]), { envelope: true }, { uid: true });
        const mid = msg && msg.envelope?.messageId ? msg.envelope.messageId : '';
        return { providerMessageId: mid, providerThreadId: mid, internetMessageId: mid };
      } finally { lock.release(); }
    } finally { await client.logout().catch(() => undefined); }
  }

  async sync(auth: AuthHandle, cursor: string | null, since: Date): Promise<SyncResult> {
    const { config } = creds(auth);
    const cur: ImapCursor = cursor ? JSON.parse(cursor) : {};
    const folders = ['INBOX', config.sentFolder ?? 'Sent'];
    const client = this.imap(auth);
    await client.connect();
    const messages: NormalizedMessage[] = [];
    try {
      for (const folder of folders) {
        let lock;
        try { lock = await client.getMailboxLock(folder); } catch { continue; }
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
    } finally { await client.logout().catch(() => undefined); }
    return { messages, nextCursor: JSON.stringify(cur) };
  }
}
