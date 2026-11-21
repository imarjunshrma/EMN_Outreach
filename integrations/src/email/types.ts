export type EmailProviderName = 'GMAIL' | 'MICROSOFT' | 'SMTP_IMAP';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scopes: string[];
}

export interface MailboxProfile {
  email: string;
  displayName?: string;
  providerAccountId: string;
}

/** Credentials handed to an adapter for one call. Built by the backend after decryption/refresh. */
export type AuthHandle =
  | { kind: 'oauth'; accessToken: string; email: string }
  | { kind: 'password'; email: string; password: string; smtpPassword?: string; imapPassword?: string; config: SmtpImapConfig };

export interface SmtpImapConfig {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  username: string;
  smtpUsername?: string;
  imapUsername?: string;
  sentFolder?: string;
  appendToSent?: boolean;
}

export interface OutgoingMessage {
  from: { address: string; name?: string };
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  messageId: string; // "<uuid@domain>"
  inReplyTo?: string;
  references?: string[];
  threadId?: string; // provider thread id to keep follow-ups in thread
  headers: Record<string, string>;
}

export interface SentResult {
  providerMessageId: string | null;
  providerThreadId: string | null;
  internetMessageId: string;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  content?: Buffer;
}

export interface BounceInfo {
  hard: boolean;
  status: string | null;
  recipient: string | null;
  originalMessageId: string | null;
  outboundId: string | null;
}

export interface NormalizedMessage {
  providerMessageId: string;
  providerThreadId: string;
  internetMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: { address: string; name?: string };
  to: string[];
  cc: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  date: Date;
  isAutoReply: boolean;
  bounce: BounceInfo | null;
  outboundId: string | null; // X-EMN-Outbound-Id header (present on our own sent copies)
  attachments: ParsedAttachment[];
}

export interface SyncResult {
  messages: NormalizedMessage[];
  nextCursor: string;
  fullResyncRequired?: boolean;
}

export interface ConnectionCheck {
  smtp: { ok: boolean; error: string | null };
  imap: { ok: boolean; error: string | null };
}

export interface EmailProvider {
  readonly name: EmailProviderName;
  testConnection(auth: AuthHandle): Promise<MailboxProfile>;
  testConnectionDetailed?(auth: AuthHandle): Promise<ConnectionCheck>;
  send(auth: AuthHandle, msg: OutgoingMessage): Promise<SentResult>;
  /** Crash recovery: find a message we may already have sent, by our X-EMN-Outbound-Id header. */
  findSentByOutboundId(auth: AuthHandle, q: { outboundId: string; to: string; since: Date }): Promise<SentResult | null>;
  /** Incremental sync. `cursor` null = initial sync from `since`. */
  sync(auth: AuthHandle, cursor: string | null, since: Date): Promise<SyncResult>;
}

export interface OAuthClient {
  readonly provider: 'GMAIL' | 'MICROSOFT';
  buildAuthUrl(p: { state: string; codeChallenge: string; redirectUri: string; loginHint?: string }): string;
  exchangeCode(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenSet & { profile: MailboxProfile }>;
  refresh(refreshToken: string): Promise<TokenSet>;
  revoke(token: string): Promise<void>;
}

export interface ChangeSubscriptionProvider {
  subscribe(auth: AuthHandle, notificationUrl: string, clientState: string): Promise<{ id: string; expiresAt: Date }>;
  renew(auth: AuthHandle, id: string): Promise<{ expiresAt: Date }>;
  unsubscribe(auth: AuthHandle, id: string): Promise<void>;
}

export const OUTBOUND_HEADER = 'X-EMN-Outbound-Id';
