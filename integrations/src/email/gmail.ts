import { httpJson, httpRequest, ProviderError, type FetchLike } from '../http.js';
import { buildMime, fromBase64Url, parseRawMessage, toBase64Url } from './mime.js';
import {
  OUTBOUND_HEADER,
  type AuthHandle, type EmailProvider, type MailboxProfile, type OAuthClient, type OutgoingMessage,
  type SentResult, type SyncResult, type TokenSet, type NormalizedMessage,
} from './types.js';

// Gmail API adapter (REST, no SDK). Requires live verification with a real Google Workspace mailbox
// and a Google Cloud OAuth client. Scopes gmail.modify is "restricted" by Google — see docs/08.

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GOOGLE_SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

function oauthToken(auth: AuthHandle): string {
  if (auth.kind !== 'oauth') throw new ProviderError('gmail', 'OAuth credentials required');
  return auth.accessToken;
}

export class GoogleOAuthClient implements OAuthClient {
  readonly provider = 'GMAIL' as const;
  constructor(private readonly clientId: string, private readonly clientSecret: string, private readonly fetchImpl?: FetchLike) {}

  buildAuthUrl(p: { state: string; codeChallenge: string; redirectUri: string; loginHint?: string }): string {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('redirect_uri', p.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('include_granted_scopes', 'true');
    u.searchParams.set('state', p.state);
    u.searchParams.set('code_challenge', p.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (p.loginHint) u.searchParams.set('login_hint', p.loginHint);
    return u.toString();
  }

  private async token(params: Record<string, string>) {
    return httpJson<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>(
      'https://oauth2.googleapis.com/token',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params }) },
      { provider: 'google-oauth', fetchImpl: this.fetchImpl, retries: 1 },
    );
  }

  async exchangeCode(p: { code: string; codeVerifier: string; redirectUri: string }) {
    const t = await this.token({ grant_type: 'authorization_code', code: p.code, code_verifier: p.codeVerifier, redirect_uri: p.redirectUri });
    const info = await httpJson<{ sub: string; email: string; name?: string }>(
      'https://openidconnect.googleapis.com/v1/userinfo',
      { headers: { authorization: `Bearer ${t.access_token}` } },
      { provider: 'google-oauth', fetchImpl: this.fetchImpl },
    );
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: new Date(Date.now() + t.expires_in * 1000),
      scopes: (t.scope ?? '').split(' ').filter(Boolean),
      profile: { email: info.email.toLowerCase(), displayName: info.name, providerAccountId: info.sub },
    };
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const t = await this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? refreshToken, expiresAt: new Date(Date.now() + t.expires_in * 1000), scopes: (t.scope ?? '').split(' ').filter(Boolean) };
  }

  async revoke(token: string): Promise<void> {
    await httpRequest(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }, { provider: 'google-oauth', fetchImpl: this.fetchImpl, retries: 0 }).catch(() => undefined);
  }
}

interface GmailMessageRef { id: string; threadId: string }

export class GmailProvider implements EmailProvider {
  readonly name = 'GMAIL' as const;
  constructor(private readonly fetchImpl?: FetchLike, private readonly maxInitialMessages = 300) {}

  private get<T>(auth: AuthHandle, path: string) {
    return httpJson<T>(`${API}${path}`, { headers: { authorization: `Bearer ${oauthToken(auth)}` } }, { provider: 'gmail', fetchImpl: this.fetchImpl });
  }

  async testConnection(auth: AuthHandle): Promise<MailboxProfile> {
    const p = await this.get<{ emailAddress: string; historyId: string }>(auth, '/profile');
    return { email: p.emailAddress.toLowerCase(), providerAccountId: p.emailAddress.toLowerCase() };
  }

  private async metadata(auth: AuthHandle, id: string) {
    return this.get<{ id: string; threadId: string; payload?: { headers?: Array<{ name: string; value: string }> } }>(
      auth, `/messages/${id}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=${OUTBOUND_HEADER}`,
    );
  }

  async send(auth: AuthHandle, msg: OutgoingMessage): Promise<SentResult> {
    const raw = toBase64Url(await buildMime(msg));
    const sent = await httpJson<GmailMessageRef>(
      `${API}/messages/send`,
      { method: 'POST', headers: { authorization: `Bearer ${oauthToken(auth)}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw, ...(msg.threadId ? { threadId: msg.threadId } : {}) }) },
      { provider: 'gmail', fetchImpl: this.fetchImpl, retries: 0 }, // never auto-retry a send; the pipeline reconciles
    );
    // Gmail may keep or replace our Message-ID; store whatever it actually used.
    let internetMessageId = msg.messageId;
    try {
      const meta = await this.metadata(auth, sent.id);
      internetMessageId = meta.payload?.headers?.find((h) => h.name.toLowerCase() === 'message-id')?.value ?? msg.messageId;
    } catch { /* non-fatal; sync will reconcile */ }
    return { providerMessageId: sent.id, providerThreadId: sent.threadId, internetMessageId };
  }

  async findSentByOutboundId(auth: AuthHandle, q: { outboundId: string; to: string; since: Date }): Promise<SentResult | null> {
    const after = Math.floor(q.since.getTime() / 1000) - 60;
    const list = await this.get<{ messages?: GmailMessageRef[] }>(auth, `/messages?q=${encodeURIComponent(`in:sent to:${q.to} after:${after}`)}&maxResults=20`);
    for (const ref of list.messages ?? []) {
      const meta = await this.metadata(auth, ref.id);
      const headers = meta.payload?.headers ?? [];
      if (headers.some((h) => h.name.toLowerCase() === OUTBOUND_HEADER.toLowerCase() && h.value === q.outboundId)) {
        return { providerMessageId: ref.id, providerThreadId: ref.threadId, internetMessageId: headers.find((h) => h.name.toLowerCase() === 'message-id')?.value ?? '' };
      }
    }
    return null;
  }

  private async fetchRaw(auth: AuthHandle, id: string): Promise<NormalizedMessage> {
    const m = await this.get<{ id: string; threadId: string; raw: string }>(auth, `/messages/${id}?format=raw`);
    return parseRawMessage(fromBase64Url(m.raw), { providerMessageId: m.id, providerThreadId: m.threadId });
  }

  async sync(auth: AuthHandle, cursor: string | null, since: Date): Promise<SyncResult> {
    if (!cursor) {
      const profile = await this.get<{ historyId: string }>(auth, '/profile');
      const ids: string[] = [];
      let pageToken: string | undefined;
      const q = encodeURIComponent(`after:${Math.floor(since.getTime() / 1000)} -in:chats`);
      do {
        const page = await this.get<{ messages?: GmailMessageRef[]; nextPageToken?: string }>(auth, `/messages?q=${q}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`);
        ids.push(...(page.messages ?? []).map((m) => m.id));
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < this.maxInitialMessages);
      const messages: NormalizedMessage[] = [];
      for (const id of ids.slice(0, this.maxInitialMessages)) messages.push(await this.fetchRaw(auth, id));
      return { messages, nextCursor: profile.historyId };
    }
    try {
      const ids = new Set<string>();
      let pageToken: string | undefined;
      let latest = cursor;
      do {
        const h = await this.get<{ history?: Array<{ messagesAdded?: Array<{ message: GmailMessageRef }> }>; historyId: string; nextPageToken?: string }>(
          auth, `/history?startHistoryId=${cursor}&historyTypes=messageAdded${pageToken ? `&pageToken=${pageToken}` : ''}`,
        );
        for (const rec of h.history ?? []) for (const a of rec.messagesAdded ?? []) ids.add(a.message.id);
        latest = h.historyId ?? latest;
        pageToken = h.nextPageToken;
      } while (pageToken);
      const messages: NormalizedMessage[] = [];
      for (const id of ids) {
        try { messages.push(await this.fetchRaw(auth, id)); } catch (e) {
          if (e instanceof ProviderError && e.status === 404) continue; // deleted meanwhile
          throw e;
        }
      }
      return { messages, nextCursor: latest };
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return { messages: [], nextCursor: '', fullResyncRequired: true };
      throw e;
    }
  }
}
