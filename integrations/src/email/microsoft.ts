import { assertRealEmailProviderAllowed } from './real-provider-safety.js';
import { httpJson, httpRequest, ProviderError, type FetchLike } from '../http.js';
import { buildMime, parseRawMessage } from './mime.js';
import {
  OUTBOUND_HEADER,
  type AuthHandle, type ChangeSubscriptionProvider, type EmailProvider, type MailboxProfile, type NormalizedMessage,
  type OAuthClient, type OutgoingMessage, type SentResult, type SyncResult, type TokenSet,
} from './types.js';

// Microsoft Graph adapter (REST, no SDK). Requires live verification with a real Microsoft 365 mailbox
// and an Entra ID app registration (multi-tenant). Tenant admin consent may be required.

const GRAPH = 'https://graph.microsoft.com/v1.0';
export const MICROSOFT_SCOPES = [
  'openid', 'profile', 'email', 'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
];

function token(auth: AuthHandle): string {
  if (auth.kind !== 'oauth') throw new ProviderError('graph', 'OAuth credentials required');
  return auth.accessToken;
}

export class MicrosoftOAuthClient implements OAuthClient {
  readonly provider = 'MICROSOFT' as const;
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly tenant = 'common',
    private readonly fetchImpl?: FetchLike,
  ) { assertRealEmailProviderAllowed(); }

  private base() { return `https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0`; }

  buildAuthUrl(p: { state: string; codeChallenge: string; redirectUri: string; loginHint?: string }): string {
    const u = new URL(`${this.base()}/authorize`);
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', p.redirectUri);
    u.searchParams.set('response_mode', 'query');
    u.searchParams.set('scope', MICROSOFT_SCOPES.join(' '));
    u.searchParams.set('state', p.state);
    u.searchParams.set('code_challenge', p.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (p.loginHint) u.searchParams.set('login_hint', p.loginHint);
    return u.toString();
  }

  private async tokenCall(params: Record<string, string>) {
    return httpJson<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>(
      `${this.base()}/token`,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, scope: MICROSOFT_SCOPES.join(' '), ...params }) },
      { provider: 'microsoft-oauth', fetchImpl: this.fetchImpl, retries: 1 },
    );
  }

  async exchangeCode(p: { code: string; codeVerifier: string; redirectUri: string }) {
    const t = await this.tokenCall({ grant_type: 'authorization_code', code: p.code, code_verifier: p.codeVerifier, redirect_uri: p.redirectUri });
    const me = await httpJson<{ id: string; mail?: string; userPrincipalName: string; displayName?: string }>(
      `${GRAPH}/me?$select=id,mail,userPrincipalName,displayName`, { headers: { authorization: `Bearer ${t.access_token}` } },
      { provider: 'graph', fetchImpl: this.fetchImpl },
    );
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: new Date(Date.now() + t.expires_in * 1000),
      scopes: (t.scope ?? '').split(' ').filter(Boolean),
      profile: { email: (me.mail ?? me.userPrincipalName).toLowerCase(), displayName: me.displayName, providerAccountId: me.id },
    };
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const t = await this.tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken });
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? refreshToken, expiresAt: new Date(Date.now() + t.expires_in * 1000), scopes: (t.scope ?? '').split(' ').filter(Boolean) };
  }

  async revoke(): Promise<void> {
    // Graph has no per-token revocation for delegated tokens; we delete stored tokens and subscriptions.
  }
}

interface DeltaPage { value: Array<{ id: string; '@removed'?: unknown }>; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }

export class MicrosoftGraphProvider implements EmailProvider, ChangeSubscriptionProvider {
  readonly name = 'MICROSOFT' as const;
  constructor(private readonly fetchImpl?: FetchLike, private readonly maxInitialMessages = 300) { assertRealEmailProviderAllowed(); }

  private json<T>(auth: AuthHandle, url: string, init: RequestInit = {}) {
    const full = url.startsWith('http') ? url : `${GRAPH}${url}`;
    return httpJson<T>(full, { ...init, headers: { authorization: `Bearer ${token(auth)}`, 'content-type': 'application/json', ...(init.headers ?? {}) } }, { provider: 'graph', fetchImpl: this.fetchImpl });
  }

  async testConnection(auth: AuthHandle): Promise<MailboxProfile> {
    const me = await this.json<{ id: string; mail?: string; userPrincipalName: string; displayName?: string }>(auth, '/me?$select=id,mail,userPrincipalName,displayName');
    return { email: (me.mail ?? me.userPrincipalName).toLowerCase(), displayName: me.displayName, providerAccountId: me.id };
  }

  async send(auth: AuthHandle, msg: OutgoingMessage): Promise<SentResult> {
    // MIME send keeps List-Unsubscribe, Message-ID and our tracking header (live-verify header retention).
    const mime = (await buildMime(msg)).toString('base64');
    await httpRequest(`${GRAPH}/me/sendMail`, { method: 'POST', headers: { authorization: `Bearer ${token(auth)}`, 'content-type': 'text/plain' }, body: mime }, { provider: 'graph', fetchImpl: this.fetchImpl, retries: 0 });
    // sendMail returns 202 without ids. Try briefly to locate the sent copy; sync reconciles later otherwise.
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 700));
      const found = await this.findByInternetId(auth, msg.messageId).catch(() => null);
      if (found) return found;
    }
    return { providerMessageId: null, providerThreadId: null, internetMessageId: msg.messageId };
  }

  private async findByInternetId(auth: AuthHandle, internetMessageId: string): Promise<SentResult | null> {
    const filter = encodeURIComponent(`internetMessageId eq '${internetMessageId.replace(/'/g, "''")}'`);
    const r = await this.json<{ value: Array<{ id: string; conversationId: string; internetMessageId: string }> }>(auth, `/me/mailFolders('sentitems')/messages?$filter=${filter}&$select=id,conversationId,internetMessageId&$top=1`);
    const m = r.value[0];
    return m ? { providerMessageId: m.id, providerThreadId: m.conversationId, internetMessageId: m.internetMessageId } : null;
  }

  async findSentByOutboundId(auth: AuthHandle, q: { outboundId: string; to: string; since: Date }): Promise<SentResult | null> {
    const since = new Date(q.since.getTime() - 60_000).toISOString();
    const r = await this.json<{ value: Array<{ id: string; conversationId: string; internetMessageId: string; internetMessageHeaders?: Array<{ name: string; value: string }> }> }>(
      auth, `/me/mailFolders('sentitems')/messages?$filter=${encodeURIComponent(`sentDateTime ge ${since}`)}&$select=id,conversationId,internetMessageId,internetMessageHeaders&$top=50`,
    );
    const m = r.value.find((x) => x.internetMessageHeaders?.some((h) => h.name.toLowerCase() === OUTBOUND_HEADER.toLowerCase() && h.value === q.outboundId));
    return m ? { providerMessageId: m.id, providerThreadId: m.conversationId, internetMessageId: m.internetMessageId } : null;
  }

  private async fetchMime(auth: AuthHandle, id: string): Promise<NormalizedMessage> {
    const meta = await this.json<{ id: string; conversationId: string }>(auth, `/me/messages/${id}?$select=id,conversationId`);
    const res = await httpRequest(`${GRAPH}/me/messages/${id}/$value`, { headers: { authorization: `Bearer ${token(auth)}` } }, { provider: 'graph', fetchImpl: this.fetchImpl });
    const raw = Buffer.from(await res.arrayBuffer());
    return parseRawMessage(raw, { providerMessageId: meta.id, providerThreadId: meta.conversationId });
  }

  private async deltaFolder(auth: AuthHandle, folder: 'inbox' | 'sentitems', link: string | null, since: Date) {
    let url = link ?? `/me/mailFolders/${folder}/messages/delta?$select=id&$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}`;
    const ids: string[] = [];
    for (let guard = 0; guard < 100; guard++) {
      const page = await this.json<DeltaPage>(auth, url, { headers: { Prefer: 'odata.maxpagesize=50' } });
      ids.push(...page.value.filter((v) => !v['@removed']).map((v) => v.id));
      if (page['@odata.nextLink']) { url = page['@odata.nextLink']; continue; }
      return { ids, deltaLink: page['@odata.deltaLink'] ?? url };
    }
    throw new ProviderError('graph', 'delta paging did not terminate');
  }

  async sync(auth: AuthHandle, cursor: string | null, since: Date): Promise<SyncResult> {
    const cur = cursor ? (JSON.parse(cursor) as { inbox: string | null; sent: string | null }) : { inbox: null, sent: null };
    try {
      const inbox = await this.deltaFolder(auth, 'inbox', cur.inbox, since);
      const sent = await this.deltaFolder(auth, 'sentitems', cur.sent, since);
      const ids = [...new Set([...inbox.ids, ...sent.ids])].slice(0, cursor ? undefined : this.maxInitialMessages);
      const messages: NormalizedMessage[] = [];
      for (const id of ids) {
        try { messages.push(await this.fetchMime(auth, id)); } catch (e) {
          if (e instanceof ProviderError && e.status === 404) continue;
          throw e;
        }
      }
      return { messages, nextCursor: JSON.stringify({ inbox: inbox.deltaLink, sent: sent.deltaLink }) };
    } catch (e) {
      if (e instanceof ProviderError && e.status === 410) return { messages: [], nextCursor: '', fullResyncRequired: true };
      throw e;
    }
  }

  async subscribe(auth: AuthHandle, notificationUrl: string, clientState: string) {
    const expiresAt = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    const r = await this.json<{ id: string; expirationDateTime: string }>(auth, '/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ changeType: 'created', notificationUrl, lifecycleNotificationUrl: notificationUrl, resource: "me/mailFolders('inbox')/messages", expirationDateTime: expiresAt.toISOString(), clientState }),
    });
    return { id: r.id, expiresAt: new Date(r.expirationDateTime) };
  }

  async renew(auth: AuthHandle, id: string) {
    const expiresAt = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    const r = await this.json<{ expirationDateTime: string }>(auth, `/subscriptions/${id}`, { method: 'PATCH', body: JSON.stringify({ expirationDateTime: expiresAt.toISOString() }) });
    return { expiresAt: new Date(r.expirationDateTime) };
  }

  async unsubscribe(auth: AuthHandle, id: string) {
    await httpRequest(`${GRAPH}/subscriptions/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token(auth)}` } }, { provider: 'graph', fetchImpl: this.fetchImpl, retries: 0 }).catch(() => undefined);
  }
}
