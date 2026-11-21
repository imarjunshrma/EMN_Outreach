import { describe, expect, it } from 'vitest';
import { buildMime, parseRawMessage, fromBase64Url } from '../../integrations/src/email/mime.js';
import { GmailProvider, GoogleOAuthClient } from '../../integrations/src/email/gmail.js';
import { MicrosoftGraphProvider } from '../../integrations/src/email/microsoft.js';
import { AnthropicAdapter } from '../../integrations/src/ai/anthropic.js';
import { OpenAiAdapter, toStrictSchema } from '../../integrations/src/ai/openai.js';
import { ApolloProvider, MillionVerifierProvider } from '../../integrations/src/providers/index.js';
import { checkDomain } from '../../integrations/src/research/dns.js';
import { httpRequest, ProviderError } from '../../integrations/src/http.js';

type Call = { url: string; init?: RequestInit };
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = async (url: string | URL, init?: RequestInit) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  return { f: f as typeof fetch, calls };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const auth = { kind: 'oauth' as const, accessToken: 'tok', email: 'me@ourco.com' };

const msg = {
  from: { address: 'me@ourco.com', name: 'Arjun' }, to: 'jane@acme.io', subject: 'Hello', text: 'Body text',
  messageId: '<abc-123@ourco.com>', headers: { 'X-EMN-Outbound-Id': '11111111-1111-1111-1111-111111111111', 'List-Unsubscribe': '<https://app/u/t>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
};

describe('MIME building & parsing', () => {
  it('includes compliance and tracking headers and our Message-ID', async () => {
    const raw = (await buildMime(msg)).toString();
    expect(raw).toMatch(/Message-ID: <abc-123@ourco.com>/i);
    expect(raw).toMatch(/List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
    expect(raw).toMatch(/X-EMN-Outbound-Id: 11111111/i);
  });

  it('parses a reply with threading headers', async () => {
    const raw = Buffer.from('From: Jane <jane@acme.io>\r\nTo: me@ourco.com\r\nSubject: Re: Hello\r\nMessage-ID: <r1@acme.io>\r\nIn-Reply-To: <abc-123@ourco.com>\r\nReferences: <abc-123@ourco.com>\r\nDate: Mon, 23 Nov 2026 10:00:00 +0000\r\n\r\nSounds interesting, send pricing.\r\n');
    const m = await parseRawMessage(raw, { providerMessageId: 'x' });
    expect(m.inReplyTo).toBe('<abc-123@ourco.com>');
    expect(m.providerThreadId).toBe('<abc-123@ourco.com>');
    expect(m.from.address).toBe('jane@acme.io');
    expect(m.isAutoReply).toBe(false);
    expect(m.bounce).toBeNull();
  });

  it('detects auto-replies by header', async () => {
    const raw = Buffer.from('From: jane@acme.io\r\nTo: me@ourco.com\r\nSubject: Out of Office\r\nAuto-Submitted: auto-replied\r\nMessage-ID: <oo@acme.io>\r\n\r\nI am away.\r\n');
    expect((await parseRawMessage(raw, { providerMessageId: 'o' })).isAutoReply).toBe(true);
  });

  it('parses a DSN hard bounce and recovers our outbound id', async () => {
    const raw = Buffer.from([
      'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'To: me@ourco.com', 'Subject: Delivery Status Notification (Failure)', 'Message-ID: <dsn1@google.com>',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="B"', '', '--B', 'Content-Type: text/plain', '', 'Address not found', '--B',
      'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; googlemail.com', '', 'Final-Recipient: rfc822; jane@acme.io', 'Action: failed', 'Status: 5.1.1', '--B',
      'Content-Type: text/rfc822-headers', '', 'Message-ID: <abc-123@ourco.com>', 'X-EMN-Outbound-Id: 11111111-1111-1111-1111-111111111111', '--B--', '',
    ].join('\r\n'));
    const m = await parseRawMessage(raw, { providerMessageId: 'b' });
    expect(m.bounce).toMatchObject({ hard: true, status: '5.1.1', recipient: 'jane@acme.io', outboundId: '11111111-1111-1111-1111-111111111111' });
  });
});

describe('Gmail adapter (mocked HTTP — requires live verification)', () => {
  it('sends raw MIME and reads back the final Message-ID', async () => {
    const { f, calls } = mockFetch((url) => url.endsWith('/messages/send') ? json({ id: 'g1', threadId: 't1' }) : json({ id: 'g1', threadId: 't1', payload: { headers: [{ name: 'Message-ID', value: '<abc-123@ourco.com>' }] } }));
    const r = await new GmailProvider(f).send(auth, { ...msg, threadId: 't0' });
    expect(r).toEqual({ providerMessageId: 'g1', providerThreadId: 't1', internetMessageId: '<abc-123@ourco.com>' });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.threadId).toBe('t0');
    expect(fromBase64Url(body.raw).toString()).toContain('List-Unsubscribe');
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });
  it('signals full resync when history is too old', async () => {
    const { f } = mockFetch(() => json({ error: 'notFound' }, 404));
    const r = await new GmailProvider(f).sync(auth, '123', new Date());
    expect(r.fullResyncRequired).toBe(true);
  });
  it('builds a PKCE consent URL with offline access', () => {
    const url = new URL(new GoogleOAuthClient('cid', 'sec').buildAuthUrl({ state: 's', codeChallenge: 'c', redirectUri: 'https://app/cb' }));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('gmail.send');
  });
});

describe('Microsoft Graph adapter (mocked HTTP — requires live verification)', () => {
  it('sends MIME via sendMail and locates the sent copy', async () => {
    const { f, calls } = mockFetch((url) => url.endsWith('/me/sendMail') ? new Response(null, { status: 202 }) : json({ value: [{ id: 'm1', conversationId: 'c1', internetMessageId: '<abc-123@ourco.com>' }] }));
    const r = await new MicrosoftGraphProvider(f).send(auth, msg);
    expect(r.providerMessageId).toBe('m1');
    expect((calls[0].init?.headers as Record<string, string>)['content-type']).toBe('text/plain');
    expect(Buffer.from(String(calls[0].init?.body), 'base64').toString()).toMatch(/X-EMN-Outbound-Id/i);
  });
  it('follows delta paging and stores delta links', async () => {
    const mime = 'From: jane@acme.io\r\nTo: me@ourco.com\r\nSubject: Hi\r\nMessage-ID: <x@acme.io>\r\n\r\nhello';
    const { f } = mockFetch((url) => {
      if (url.includes('/inbox/messages/delta') && !url.includes('page2')) return json({ value: [{ id: 'a' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?page2' });
      if (url.includes('page2')) return json({ value: [{ id: 'b', '@removed': {} }], '@odata.deltaLink': 'https://graph/delta-inbox' });
      if (url.includes('sentitems/messages/delta')) return json({ value: [], '@odata.deltaLink': 'https://graph/delta-sent' });
      if (url.includes('$value')) return new Response(mime);
      return json({ id: 'a', conversationId: 'conv-a' });
    });
    const r = await new MicrosoftGraphProvider(f).sync(auth, null, new Date());
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].providerThreadId).toBe('conv-a');
    expect(JSON.parse(r.nextCursor)).toEqual({ inbox: 'https://graph/delta-inbox', sent: 'https://graph/delta-sent' });
  });
  it('signals full resync on 410 Gone', async () => {
    const { f } = mockFetch(() => json({}, 410));
    expect((await new MicrosoftGraphProvider(f).sync(auth, JSON.stringify({ inbox: 'x', sent: 'y' }), new Date())).fullResyncRequired).toBe(true);
  });
});

describe('AI adapters (mocked HTTP — requires live verification)', () => {
  const req = { model: 'm', system: 'sys', user: 'u', jsonSchema: { type: 'object', properties: { a: { type: 'string' } } }, schemaName: 'task', maxOutputTokens: 100 };
  it('Anthropic: forces the tool and returns its input + usage', async () => {
    const { f, calls } = mockFetch(() => json({ content: [{ type: 'tool_use', name: 'task', input: { a: 'x' } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } }));
    const r = await new AnthropicAdapter(f).generateStructured('key', req);
    expect(r.data).toEqual({ a: 'x' });
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedTokens: 2 });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'task' });
    expect((calls[0].init?.headers as Record<string, string>)['x-api-key']).toBe('key');
  });
  it('OpenAI: strict json_schema and parsed output', async () => {
    const { f, calls } = mockFetch(() => json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"a":"y"}' }] }], usage: { input_tokens: 3, output_tokens: 4 } }));
    const r = await new OpenAiAdapter(f).generateStructured('key', req);
    expect(r.data).toEqual({ a: 'y' });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema.required).toEqual(['a']);
    expect(toStrictSchema({ type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'number' } } } } })).toMatchObject({ additionalProperties: false, properties: { b: { required: ['c'] } } });
  });
  it('surfaces non-retryable errors without retrying', async () => {
    const { f, calls } = mockFetch(() => json({ error: 'bad key' }, 401));
    await expect(new AnthropicAdapter(f).generateStructured('bad', req)).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(1);
  });
  it('retries transient errors honoring Retry-After', async () => {
    let n = 0;
    const { f } = mockFetch(() => (++n < 2 ? new Response('busy', { status: 429, headers: { 'retry-after': '0' } }) : json({ ok: true })));
    const res = await httpRequest('https://x', {}, { provider: 't', fetchImpl: f, retries: 2 });
    expect(res.status).toBe(200);
    expect(n).toBe(2);
  });
});

describe('data providers (mocked HTTP — requires live verification)', () => {
  it('maps Apollo people and hides locked emails', async () => {
    const { f, calls } = mockFetch(() => json({ people: [{ id: 'p1', first_name: 'Ann', title: 'Founder', email: 'email_not_unlocked@domain.com', country: 'United Kingdom', organization: { name: 'Advisory Co', primary_domain: 'advisory.co', estimated_num_employees: 8 } }], pagination: { total_entries: 1 } }));
    const r = await new ApolloProvider(f).search('k', { titles: ['Founder'], keywords: ['consulting'], countries: ['GB'], industries: [], employeeMin: 1, employeeMax: 50, page: 1, perPage: 10 });
    expect(r.results[0]).toMatchObject({ externalId: 'p1', email: null, country: 'GB', company: { domain: 'advisory.co' } });
    expect(JSON.parse(String(calls[0].init?.body)).person_locations).toEqual(['United Kingdom']);
  });
  it('maps MillionVerifier results', async () => {
    const { f } = mockFetch(() => json({ result: 'catch_all' }));
    expect((await new MillionVerifierProvider(f).verify('k', 'a@b.com')).result).toBe('CATCH_ALL');
  });
});

describe('domain authentication checks', () => {
  it('reports missing DMARC and weak SPF', async () => {
    const r = await checkDomain('ourco.com', ['google'], {
      resolveTxt: async (n) => { if (n === 'ourco.com') return [['v=spf1 include:_spf.google.com ?all']]; if (n === 'google._domainkey.ourco.com') return [['v=DKIM1; k=rsa; p=MIIB']]; throw new Error('ENOTFOUND'); },
      resolveMx: async () => [{ exchange: 'aspmx.l.google.com', priority: 1 }],
    });
    expect(r.spf.status).toBe('WARN');
    expect(r.dkim.status).toBe('PASS');
    expect(r.dmarc.status).toBe('FAIL');
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['SPF_WEAK', 'DMARC_MISSING']));
  });
});
