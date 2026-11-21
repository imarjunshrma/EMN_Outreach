import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import { OUTBOUND_HEADER, type BounceInfo, type NormalizedMessage, type OutgoingMessage } from './types.js';

export async function buildMime(msg: OutgoingMessage): Promise<Buffer> {
  const composer = new MailComposer({
    from: msg.from.name ? { name: msg.from.name, address: msg.from.address } : msg.from.address,
    to: msg.to,
    replyTo: msg.replyTo,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    messageId: msg.messageId,
    inReplyTo: msg.inReplyTo,
    references: msg.references,
    headers: msg.headers,
  });
  return composer.compile().build();
}

export function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function addresses(a: AddressObject | AddressObject[] | undefined): string[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  return arr.flatMap((x) => x.value.map((v) => (v.address ?? '').toLowerCase())).filter(Boolean);
}

function headerValue(mail: ParsedMail, name: string): string | null {
  const v = mail.headers.get(name.toLowerCase());
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in (v as object)) return String((v as { value: unknown }).value);
  return String(v);
}

const AUTO_SUBJECT = /^(auto(matic)?[ -]?reply|out of (the )?office|ooo\b|abwesenheit|absence|on leave|vacation)/i;

export function detectAutoReply(mail: ParsedMail): boolean {
  const autoSubmitted = headerValue(mail, 'auto-submitted');
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') return true;
  if (headerValue(mail, 'x-autoreply') || headerValue(mail, 'x-autorespond')) return true;
  const prec = (headerValue(mail, 'precedence') ?? '').toLowerCase();
  if (prec === 'auto_reply') return true;
  return AUTO_SUBJECT.test(mail.subject ?? '');
}

const BOUNCE_FROM = /(mailer-daemon|postmaster|mail delivery (subsystem|system))/i;
const BOUNCE_SUBJECT = /(undeliver|delivery status notification|delivery (has )?failed|returned mail|failure notice|mail delivery failed|could not be delivered)/i;

function findIn(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

export function detectBounce(mail: ParsedMail, rawText: string): BounceInfo | null {
  const ct = (headerValue(mail, 'content-type') ?? '').toLowerCase();
  const fromAddr = addresses(mail.from).join(' ') + ' ' + (mail.from?.text ?? '');
  const isReport = ct.includes('multipart/report') && ct.includes('delivery-status');
  const looksLikeBounce = isReport || (BOUNCE_FROM.test(fromAddr) && BOUNCE_SUBJECT.test(mail.subject ?? ''));
  if (!looksLikeBounce) return null;

  // Gather text from delivery-status / rfc822 attachments and the raw message for header searches.
  const parts = [rawText];
  for (const att of mail.attachments ?? []) {
    if (/delivery-status|rfc822|rfc822-headers/i.test(att.contentType)) parts.push(att.content.toString('utf8'));
  }
  const all = parts.join('\n');
  const status = findIn(all, /^\s*Status:\s*([245]\.\d{1,3}\.\d{1,3})/im) ?? findIn(all, /\b([45]\.\d\.\d{1,3})\b/);
  const recipient = findIn(all, /Final-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/i) ?? findIn(all, /Original-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/i);
  const outboundId = findIn(all, new RegExp(`${OUTBOUND_HEADER}:\\s*([0-9a-f-]{36})`, 'i'));
  const originalMessageId = findIn(all, /^Message-ID:\s*(<[^>]+>)/im);
  const hard = status ? status.startsWith('5') : true;
  return { hard, status, recipient: recipient?.toLowerCase() ?? null, originalMessageId, outboundId };
}

export function threadRootFromHeaders(messageId: string | null, inReplyTo: string | null, references: string[]): string {
  return references[0] ?? inReplyTo ?? messageId ?? `no-id-${Date.now()}`;
}

/** Parse raw RFC 5322 bytes into the provider-independent shape. */
export async function parseRawMessage(
  raw: Buffer,
  ids: { providerMessageId: string; providerThreadId?: string | null },
): Promise<NormalizedMessage> {
  const mail = await simpleParser(raw, { skipImageLinks: true });
  const rawText = raw.toString('utf8').slice(0, 200_000);
  const refsHeader = mail.references;
  const references = Array.isArray(refsHeader) ? refsHeader : refsHeader ? refsHeader.split(/\s+/).filter(Boolean) : [];
  const inReplyTo = mail.inReplyTo ?? null;
  const internetMessageId = mail.messageId ?? null;
  const fromFirst = (Array.isArray(mail.from) ? mail.from[0] : mail.from)?.value?.[0];
  return {
    providerMessageId: ids.providerMessageId,
    providerThreadId: ids.providerThreadId ?? threadRootFromHeaders(internetMessageId, inReplyTo, references),
    internetMessageId,
    inReplyTo,
    references,
    from: { address: (fromFirst?.address ?? '').toLowerCase(), name: fromFirst?.name || undefined },
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    subject: mail.subject ?? null,
    text: mail.text ?? null,
    html: typeof mail.html === 'string' ? mail.html : null,
    date: mail.date ?? new Date(),
    isAutoReply: detectAutoReply(mail),
    bounce: detectBounce(mail, rawText),
    outboundId: headerValue(mail, OUTBOUND_HEADER),
    attachments: (mail.attachments ?? [])
      .filter((a) => a.contentDisposition === 'attachment' || !!a.filename)
      .map((a) => ({ filename: a.filename ?? 'attachment', contentType: a.contentType, size: a.size, content: a.content })),
  };
}
