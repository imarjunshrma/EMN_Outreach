import { describe, expect, it } from 'vitest';
import { buildMime, parseRawMessage, fromBase64Url } from '../../integrations/src/email/mime.js';
import { GmailProvider, GoogleOAuthClient } from '../../integrations/src/email/gmail.js';
import { MicrosoftGraphProvider } from '../../integrations/src/email/microsoft.js';
import { AnthropicAdapter } from '../../integrations/src/ai/anthropic.js';
import { OpenAiAdapter, toStrictSchema } from '../../integrations/src/ai/openai.js';
import { GoogleAiAdapter, toGeminiSchema } from '../../integrations/src/ai/google.js';
import { OpenAiCompatibleAdapter, groqSupportsStrictJsonSchema } from '../../integrations/src/ai/openai-compatible.js';
import { resetPromptCompatibilityForTests } from '../../integrations/src/ai/prompt-compat.js';
import { AI_OUTPUT_SCHEMAS, AI_TASKS } from '../../shared/src/ai-schemas.js';
import { DEFAULT_PROMPTS } from '../../shared/src/prompts.js';
import { DEFAULT_OUTPUT_FORMAT, OUTPUT_JSON_SCHEMAS, SAFETY_RULES, TASK_INSTRUCTIONS, TASK_TYPES } from '../../shared/src/ai-workflows.js';
import { z } from 'zod';
import { ApolloProvider, MillionVerifierProvider } from '../../integrations/src/providers/index.js';
import { checkDomain } from '../../integrations/src/research/dns.js';
import { httpRequest, ProviderError } from '../../integrations/src/http.js';
import { smtpError } from '../../integrations/src/email/smtp-imap.js';
import { aiProviderFailure } from '../../backend/src/services/ai.js';

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

describe('SMTP/IMAP safe errors', () => {
  it('maps SMTP auth and transient failures without exposing provider text', () => {
    const authErr = smtpError(Object.assign(new Error('password=secret-token'), { code: 'EAUTH' }));
    expect(authErr).toMatchObject({ status: 401, retryable: false });
    expect(authErr.message).toContain('SMTP authentication failed');
    expect(authErr.message).not.toContain('secret-token');
    const transient = smtpError(Object.assign(new Error('secret diagnostic'), { responseCode: 451 }));
    expect(transient).toMatchObject({ status: 503, retryable: true });
    expect(transient.message).not.toContain('secret diagnostic');
    const recipient = smtpError(Object.assign(new Error(), { responseCode: 550, command: 'RCPT TO', response: '550 5.1.1 No such user' }));
    expect(recipient).toMatchObject({ code: 'RECIPIENT_NOT_FOUND', submissionOutcome: 'PROVIDER_REJECTED' });
    expect(smtpError(Object.assign(new Error(), { responseCode: 550, command: 'RCPT TO', response: '550 5.7.1 Sender policy' })).code).toBeUndefined();
    expect(smtpError(Object.assign(new Error(), { code: 'ETIMEDOUT', command: 'DATA' })).submissionOutcome).toBeUndefined();
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
  it('OpenAI assembles all text blocks when the aggregate text is empty', async () => {
    const { f } = mockFetch(() => json({ status: 'completed', output_text: '', output: [
      { type: 'reasoning' },
      { type: 'message', content: [{ type: 'output_text', text: '{"a":' }, { type: 'output_text', text: '"joined"}' }] },
    ] }));
    await expect(new OpenAiAdapter(f).generateStructured('key', req)).resolves.toMatchObject({ data: { a: 'joined' } });
  });
  it.each([
    [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"a":' }, 'OPENAI_OUTPUT_LIMIT', 'AI_OUTPUT_LIMIT'],
    [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'OPENAI_OUTPUT_LIMIT', 'AI_OUTPUT_LIMIT'],
    [{ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, 'OPENAI_CONTENT_FILTER', 'AI_RESPONSE_FILTERED'],
    [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }, 'OPENAI_REFUSAL', 'AI_RESPONSE_FILTERED'],
    [{ status: 'completed', output_text: '{"a":' }, 'OPENAI_INVALID_JSON', 'AI_INVALID_RESPONSE'],
  ])('OpenAI classifies unsuccessful structured responses without extra calls (%#)', async (payload, providerCode, appCode) => {
    const { f, calls } = mockFetch(() => json(payload));
    const execution = new OpenAiAdapter(f).generateStructured('key', req);
    await expect(execution).rejects.toMatchObject({ code: providerCode });
    const error = await execution.catch((failure: ProviderError) => failure);
    expect(aiProviderFailure(error as ProviderError)).toMatchObject({ code: appCode });
    expect(calls).toHaveLength(1);
  });
  it('Gemini retries once without systemInstruction when the selected model rejects that capability, then remembers it', async () => {
    resetPromptCompatibilityForTests();
    let attempts = 0;
    const { f, calls } = mockFetch((_url) => {
      attempts++;
      if (attempts === 1) return json({ error: { message: 'Developer instruction is not enabled for this model' } }, 400);
      return json({ candidates: [{ content: { parts: [{ text: '{"a":"ok"}' }] } }] });
    });
    const adapter = new GoogleAiAdapter(f);
    await adapter.generateStructured('key', { ...req, model: 'unsupported-system-model' });
    const result = await adapter.generateStructured('key', { ...req, model: 'unsupported-system-model' });
    expect(result.generationMode).toBe('instruction_fallback');
    expect(calls).toHaveLength(3);
    // First request uses native instructions; fallback and later request place them in the user message.
    const firstBody = JSON.parse(String(calls[0].init?.body));
    const fallbackBody = JSON.parse(String(calls[1].init?.body));
    const rememberedBody = JSON.parse(String(calls[2].init?.body));
    expect(firstBody.systemInstruction.parts[0].text).toBe('sys');
    expect(fallbackBody.systemInstruction).toBeUndefined();
    expect(fallbackBody.contents[0].parts[0].text).toContain('Instructions for this task');
    expect(fallbackBody.contents[0].parts[0].text).toContain('Return JSON matching this schema');
    expect(rememberedBody.systemInstruction).toBeUndefined();
  });
  it('Gemini falls back from both unsupported instructions and JSON schema without changing models', async () => {
    resetPromptCompatibilityForTests();
    const { f, calls } = mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.systemInstruction) return json({ error: { message: 'Developer instruction is not enabled for this model' } }, 400);
      if (body.generationConfig.responseJsonSchema) return json({ error: { message: 'responseJsonSchema is not supported for this model' } }, 400);
      return json({ candidates: [{ content: { parts: [{ text: '{"a":"ok"}' }] } }] });
    });
    const result = await new GoogleAiAdapter(f).generateStructured('key', { ...req, model: 'fallback-both-capabilities' });
    expect(result.data).toEqual({ a: 'ok' });
    expect(result.generationMode).toBe('prompt_fallback');
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.url).toContain('fallback-both-capabilities');
    const finalBody = JSON.parse(String(calls[2].init?.body));
    expect(finalBody.systemInstruction).toBeUndefined();
    expect(finalBody.generationConfig.responseJsonSchema).toBeUndefined();
    expect(finalBody.contents[0].parts[0].text).toContain('Instructions for this task');
    expect(finalBody.contents[0].parts[0].text).toContain('Return JSON matching this schema');
  });
  it('drops unsupported JSON mode for a model but retains schema instructions and JSON parsing', async () => {
    resetPromptCompatibilityForTests();
    const { f, calls } = mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.generationConfig.responseMimeType) return json({ error: { message: 'responseMimeType is not supported for this model' } }, 400);
      return json({ candidates: [{ content: { parts: [{ text: '{"a":"ok"}' }] } }] });
    });
    const result = await new GoogleAiAdapter(f).generateStructured('key', { ...req, model: 'unsupported-json-mode' });
    expect(result.data).toEqual({ a: 'ok' });
    expect(result.generationMode).toBe('schema_fallback');
    expect(calls).toHaveLength(2);
    const fallback = JSON.parse(String(calls[1].init?.body));
    expect(fallback.generationConfig.responseMimeType).toBeUndefined();
    expect(fallback.generationConfig.responseJsonSchema).toBeUndefined();
    expect(fallback.contents[0].parts[0].text).toContain(JSON.stringify(req.jsonSchema));
  });
  it('Groq, OpenRouter, and xAI-compatible requests preserve system instructions and JSON output requirements', async () => {
    const cases = [
      { name: 'GROQ' as const, base: 'https://api.groq.com/openai/v1', expectedTokenField: 'max_completion_tokens' },
      { name: 'OPENROUTER' as const, base: 'https://openrouter.ai/api/v1', expectedTokenField: 'max_tokens' },
      { name: 'CUSTOM_OPENAI' as const, base: 'https://api.x.ai/v1', expectedTokenField: 'max_tokens' },
    ];
    for (const c of cases) {
      const { f, calls } = mockFetch(() => json({ choices: [{ message: { content: '{"a":"ok"}' } }] }));
      const adapter = new OpenAiCompatibleAdapter(c.name, c.base, f);
      const result = await adapter.generateStructured('key', req);
      expect(result.generationMode).toBe('json_object');
      const body = JSON.parse(String(calls[0].init?.body));
      expect(body.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('sys') });
      expect(body.messages[0].content).toContain('Return only JSON matching this schema');
      expect(body[c.expectedTokenField]).toBe(100);
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(calls[0].url).toBe(`${c.base}/chat/completions`);
    }
  });
  it('retries OpenAI-compatible models without response_format when explicitly unsupported', async () => {
    resetPromptCompatibilityForTests();
    const { f, calls } = mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.response_format) return json({ error: { message: 'response_format is not supported for this model' } }, 400);
      return json({ choices: [{ message: { content: '{"a":"ok"}' } }] });
    });
    const result = await new OpenAiCompatibleAdapter('OPENROUTER', 'https://openrouter.ai/api/v1', f).generateStructured('key', { ...req, model: 'unsupported-json-mode' });
    expect(result.data).toEqual({ a: 'ok' });
    expect(result.generationMode).toBe('schema_fallback');
    expect(calls).toHaveLength(2);
    const fallback = JSON.parse(String(calls[1].init?.body));
    expect(fallback.response_format).toBeUndefined();
    expect(fallback.messages[0].content).toContain(JSON.stringify(req.jsonSchema));
  });
  it('sends Groq JSON Object Mode and falls back only when that parameter is rejected', async () => {
    resetPromptCompatibilityForTests();
    const { f, calls } = mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.response_format) return json({ error: { message: 'response_format json_object is not supported for this model' } }, 400);
      return json({ choices: [{ message: { content: '{"a":"ok"}' } }] });
    });
    const adapter = new OpenAiCompatibleAdapter('GROQ', 'https://api.groq.com/openai/v1', f);
    const result = await adapter.generateStructured('key', { ...req, model: 'groq-json-fallback-test' });
    expect(result.data).toEqual({ a: 'ok' });
    expect(result.generationMode).toBe('schema_fallback');
    expect(calls).toHaveLength(2);
    const initial = JSON.parse(String(calls[0].init?.body));
    const fallback = JSON.parse(String(calls[1].init?.body));
    expect(initial.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(initial.max_completion_tokens).toBe(req.maxOutputTokens);
    expect(initial.response_format).toEqual({ type: 'json_object' });
    expect(fallback.response_format).toBeUndefined();
    expect(fallback.messages[0].content).toContain(JSON.stringify(req.jsonSchema));
  });
  it('sends Groq strict JSON Schema only for documented compatible model IDs', async () => {
    resetPromptCompatibilityForTests();
    const { f, calls } = mockFetch(() => json({ choices: [{ message: { content: '{"a":"ok"}' } }] }));
    await new OpenAiCompatibleAdapter('GROQ', 'https://api.groq.com/openai/v1', f).generateStructured('key', { ...req, model: 'allam-2-7b' });
    expect(groqSupportsStrictJsonSchema('allam-2-7b')).toBe(false);
    expect(JSON.parse(String(calls[0].init?.body)).response_format).toEqual({ type: 'json_object' });
  });
  it('sends Groq native strict JSON Schema for compatible models, preserving nested arrays and nullable required fields', async () => {
    resetPromptCompatibilityForTests();
    const emailSchema = z.toJSONSchema(AI_OUTPUT_SCHEMAS.EMAIL_WRITING, { target: 'draft-7', io: 'output' }) as Record<string, unknown>;
    delete emailSchema.$schema;
    const expected = { subject: null, firstLine: 'Hi Alex,', body: 'A brief synthetic test email.', usedClaimIds: [] };
    const { f, calls } = mockFetch(() => json({ choices: [{ message: { content: JSON.stringify(expected) } }] }));
    const result = await new OpenAiCompatibleAdapter('GROQ', 'https://api.groq.com/openai/v1', f).generateStructured('key', {
      model: 'openai/gpt-oss-120b', system: 'Write a concise email.', user: 'Synthetic prospect only.', jsonSchema: emailSchema,
      schemaName: 'email_writing', maxOutputTokens: 300,
    });
    expect(groqSupportsStrictJsonSchema('openai/gpt-oss-120b')).toBe(true);
    expect(groqSupportsStrictJsonSchema('allam-2-7b')).toBe(false);
    expect(AI_OUTPUT_SCHEMAS.EMAIL_WRITING.safeParse(result.data).success).toBe(true);
    expect(result.generationMode).toBe('structured');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'email_writing', strict: true } });
    const sentSchema = body.response_format.json_schema.schema;
    expect(sentSchema.required).toEqual(['subject', 'firstLine', 'body', 'usedClaimIds']);
    expect(sentSchema.additionalProperties).toBe(false);
    expect(sentSchema.properties.subject.type).toEqual(['string', 'null']);
    expect(sentSchema.properties.usedClaimIds).toMatchObject({ type: 'array', items: { type: 'string' } });
  });
  it('falls back from rejected Groq JSON Schema to JSON Object Mode on the same model', async () => {
    resetPromptCompatibilityForTests();
    const { f, calls } = mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.response_format?.type === 'json_schema') return json({ error: { message: 'json_schema response_format is not supported for this model' } }, 400);
      return json({ choices: [{ message: { content: '{"sentences":[]}' } }] });
    });
    const schema = z.toJSONSchema(AI_OUTPUT_SCHEMAS.FACT_CHECK, { target: 'draft-7', io: 'output' }) as Record<string, unknown>;
    delete schema.$schema;
    const result = await new OpenAiCompatibleAdapter('GROQ', 'https://api.groq.com/openai/v1', f).generateStructured('key', {
      model: 'openai/gpt-oss-120b', system: 'Fact check.', user: 'Synthetic email.', jsonSchema: schema, schemaName: 'fact_check', maxOutputTokens: 300,
    });
    expect(result.data).toEqual({ sentences: [] });
    expect(result.generationMode).toBe('schema_fallback');
    expect(calls).toHaveLength(2);
    const strictSchema = JSON.parse(String(calls[0].init?.body)).response_format.json_schema.schema;
    expect(strictSchema.required).toEqual(['sentences']);
    expect(strictSchema.additionalProperties).toBe(false);
    expect(strictSchema.properties.sentences.items.required).toEqual(['text', 'verdict', 'claimId', 'reason']);
    expect(strictSchema.properties.sentences.items.properties.claimId.type).toEqual(['string', 'null']);
    expect(JSON.parse(String(calls[1].init?.body)).response_format).toEqual({ type: 'json_object' });
    expect(AI_OUTPUT_SCHEMAS.FACT_CHECK.safeParse(result.data).success).toBe(true);
  });
  it('rejects malformed JSON from Groq rather than returning it', async () => {
    const { f } = mockFetch(() => json({ choices: [{ message: { content: '{not json' } }] }));
    await expect(new OpenAiCompatibleAdapter('GROQ', 'https://api.groq.com/openai/v1', f).generateStructured('key', req))
      .rejects.toMatchObject({ name: 'ProviderError', message: expect.stringContaining('output was not valid JSON') });
  });
  it('leaves array and missing-field responses for the task Zod schema to reject', async () => {
    for (const raw of ['[]', '{"subject":"Only a subject"}']) {
      const { f } = mockFetch(() => json({ choices: [{ message: { content: raw } }] }));
      const result = await new OpenAiCompatibleAdapter('GROQ', 'https://api.groq.com/openai/v1', f).generateStructured('key', {
        ...req, model: 'allam-2-7b', jsonSchema: z.toJSONSchema(AI_OUTPUT_SCHEMAS.EMAIL_WRITING, { target: 'draft-7', io: 'output' }) as Record<string, unknown>,
      });
      expect(AI_OUTPUT_SCHEMAS.EMAIL_WRITING.safeParse(result.data).success).toBe(false);
    }
  });
  it('normalizes every registered AI task schema for Groq strict mode', async () => {
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      if (node.type === 'object' && node.properties && typeof node.properties === 'object') {
        const keys = Object.keys(node.properties as Record<string, unknown>);
        expect(node.required).toEqual(keys);
        expect(node.additionalProperties).toBe(false);
      }
      for (const child of Object.values(node)) visit(child);
    };
    for (const task of AI_TASKS) {
      resetPromptCompatibilityForTests();
      const schema = z.toJSONSchema(AI_OUTPUT_SCHEMAS[task], { target: 'draft-7', io: 'output' }) as Record<string, unknown>;
      delete schema.$schema;
      const { f, calls } = mockFetch(() => json({ choices: [{ message: { content: '{}' } }] }));
      await new OpenAiCompatibleAdapter('GROQ', 'https://api.groq.com/openai/v1', f).generateStructured('key', {
        model: 'openai/gpt-oss-120b', system: 'Task instructions.', user: 'Synthetic input.', jsonSchema: schema,
        schemaName: task.toLowerCase(), maxOutputTokens: 300,
      });
      const body = JSON.parse(String(calls[0].init?.body));
      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema.name).toBe(task.toLowerCase());
      visit(body.response_format.json_schema.schema);
    }
  });
  it('runs every registered AI task through the shared Gemini prompt path with instructions and JSON schema', async () => {
    for (const task of AI_TASKS) {
      resetPromptCompatibilityForTests();
      const { f, calls } = mockFetch(() => json({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }));
      const schema = z.toJSONSchema(AI_OUTPUT_SCHEMAS[task], { target: 'draft-7', io: 'output' }) as Record<string, unknown>;
      delete schema.$schema;
      await new GoogleAiAdapter(f).generateStructured('key', {
        model: `test-${task.toLowerCase()}`, system: DEFAULT_PROMPTS[task].system, user: DEFAULT_PROMPTS[task].user,
        jsonSchema: schema, schemaName: task.toLowerCase(), maxOutputTokens: 200,
      });
      const body = JSON.parse(String(calls[0].init?.body));
      expect(body.systemInstruction.parts[0].text).toBe(DEFAULT_PROMPTS[task].system);
      expect(body.generationConfig.responseJsonSchema).toEqual(toGeminiSchema(schema));
      expect(body.contents[0].parts[0].text).toContain(DEFAULT_PROMPTS[task].user);
      expect(body.contents[0].parts[0].text).toContain('Return JSON matching this schema');
    }
  });
  it('sends the required EMAIL_WRITING keys to Gemini and parses its structured response', async () => {
    resetPromptCompatibilityForTests();
    const { f, calls } = mockFetch(() => json({ candidates: [{ content: { parts: [{ text: '{"subject":null,"firstLine":"Hi there,","body":"A short honest note.","usedClaimIds":[]}' }] } }] }));
    const schema = z.toJSONSchema(AI_OUTPUT_SCHEMAS.EMAIL_WRITING, { target: 'draft-7', io: 'output' }) as Record<string, unknown>;
    delete schema.$schema;
    const result = await new GoogleAiAdapter(f).generateStructured('key', {
      model: 'email-writing-model', system: DEFAULT_PROMPTS.EMAIL_WRITING.system, user: 'Write an email.', jsonSchema: schema,
      schemaName: 'email_writing', maxOutputTokens: 300,
    });
    expect(AI_OUTPUT_SCHEMAS.EMAIL_WRITING.safeParse(result.data).success).toBe(true);
    expect(result.generationMode).toBe('structured');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.generationConfig.responseJsonSchema.required).toEqual(['subject', 'firstLine', 'body', 'usedClaimIds']);
    expect(body.generationConfig.responseJsonSchema.properties).toMatchObject({
      subject: { type: 'string', nullable: true }, firstLine: { type: 'string', nullable: true }, body: { type: 'string', nullable: true }, usedClaimIds: { type: 'array' },
    });
  });
  it('runs every workflow-builder task through the same Gemini prompt path', async () => {
    for (const task of TASK_TYPES) {
      resetPromptCompatibilityForTests();
      const { f, calls } = mockFetch(() => json({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }));
      const schema = OUTPUT_JSON_SCHEMAS[DEFAULT_OUTPUT_FORMAT[task]];
      const system = `${SAFETY_RULES}\n\n${TASK_INSTRUCTIONS[task]}`;
      await new GoogleAiAdapter(f).generateStructured('key', {
        model: `workflow-${task.toLowerCase()}`, system, user: 'workflow input', jsonSchema: schema,
        schemaName: task.toLowerCase(), maxOutputTokens: 300,
      });
      const body = JSON.parse(String(calls[0].init?.body));
      expect(body.systemInstruction.parts[0].text).toBe(system);
      expect(body.generationConfig.responseJsonSchema).toEqual(toGeminiSchema(schema));
      expect(body.contents[0].parts[0].text).toContain('workflow input');
      expect(body.contents[0].parts[0].text).toContain(JSON.stringify(schema));
    }
  });
  it('converts nullable JSON Schema fields to Gemini nullable fields', () => {
    expect(toGeminiSchema({
      type: 'object', additionalProperties: false,
      properties: { subject: { type: ['string', 'null'], default: null }, body: { type: 'string' } },
      required: ['subject', 'body'],
    })).toEqual({
      type: 'object',
      properties: { subject: { type: 'string', nullable: true }, body: { type: 'string' } },
      required: ['subject', 'body'],
    });
  });
  it('surfaces non-retryable errors without retrying', async () => {
    const { f, calls } = mockFetch(() => json({ error: 'bad key' }, 401));
    await expect(new AnthropicAdapter(f).generateStructured('bad', req)).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(1);
  });
  it('extracts provider error code without persisting echoed failed-generation text', async () => {
    const { f } = mockFetch(() => json({ error: { message: 'Failed to generate JSON. Adjust the prompt.', code: 'json_validate_failed', failed_generation: 'Bearer hidden-test-key' } }, 400));
    let error: ProviderError | undefined;
    try { await httpRequest('https://x', { headers: { authorization: 'Bearer hidden-test-key' } }, { provider: 'groq', fetchImpl: f, retries: 0 }); }
    catch (e) { error = e as ProviderError; }
    expect(error).toBeInstanceOf(ProviderError);
    if (!error) throw new Error('expected provider failure');
    expect(error).toMatchObject({ status: 400, code: 'json_validate_failed' });
    expect(error.message).toContain('Failed to generate JSON');
    expect(error.message).not.toContain('failed_generation');
    expect(error.message).not.toContain('hidden-test-key');
    expect(aiProviderFailure(error)).toMatchObject({ code: 'AI_INVALID_RESPONSE', status: 502 });
    expect(aiProviderFailure(new ProviderError('groq', 'model not found', 404, false, undefined, 'model_not_found')))
      .toMatchObject({ code: 'AI_MODEL_NOT_FOUND' });
    expect(aiProviderFailure(new ProviderError('groq', 'invalid key', 401))).toMatchObject({ code: 'AI_PROVIDER_AUTH' });
    expect(aiProviderFailure(new ProviderError('groq', 'rate limited', 429, true))).toMatchObject({ code: 'AI_RATE_LIMITED' });
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
