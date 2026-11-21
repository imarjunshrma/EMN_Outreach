import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import { SmtpImapProvider } from '../../integrations/src/email/smtp-imap.js';
import { ProviderError } from '../../integrations/src/http.js';
import { OUTBOUND_HEADER } from '../../integrations/src/email/types.js';

// Real SMTP protocol exchange against an in-process SMTP server (not a mock of nodemailer).
// It proves the adapter speaks SMTP correctly; it does NOT prove any specific provider accepts it.
let server: SMTPServer;
let port = 0;
const received: Array<{ from: string; to: string[]; raw: string }> = [];

beforeAll(async () => {
  server = new SMTPServer({
    secure: false, authOptional: false, disabledCommands: ['STARTTLS'], logger: false,
    onAuth(auth, _s, cb) { return auth.username === 'u' && auth.password === 'pw' ? cb(null, { user: 'u' }) : cb(Object.assign(new Error('Invalid credentials'), { responseCode: 535 })); },
    onRcptTo(addr, _s, cb) {
      if (addr.address.startsWith('nouser@')) return cb(Object.assign(new Error('No such user'), { responseCode: 550 }));
      if (addr.address.startsWith('busy@')) return cb(Object.assign(new Error('Try again later'), { responseCode: 451 }));
      return cb();
    },
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c: Buffer) => { raw += c.toString(); });
      stream.on('end', () => { received.push({ from: String(session.envelope.mailFrom && session.envelope.mailFrom.address), to: session.envelope.rcptTo.map((r) => r.address), raw }); cb(); });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.server.address() as { port: number }).port;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const auth = (password = 'pw') => ({ kind: 'password' as const, email: 'me@ourco.com', password, config: { smtpHost: '127.0.0.1', smtpPort: port, smtpSecure: false, imapHost: '127.0.0.1', imapPort: 1, imapSecure: false, username: 'u', appendToSent: false } }) as never;
const msg = (to: string) => ({ from: { address: 'me@ourco.com', name: 'Me' }, to, subject: 'Hello', text: 'Body', messageId: '<abc@ourco.com>', headers: { [OUTBOUND_HEADER]: 'ob-1', 'List-Unsubscribe': '<https://x/u/1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });

describe('SMTP adapter over a real SMTP session', () => {
  const p = new SmtpImapProvider();
  it('authenticates, sends MIME with tracking + unsubscribe headers and the right envelope', async () => {
    const r = await p.send(auth(), msg('lead@client.com'));
    expect(r.internetMessageId).toBe('<abc@ourco.com>');
    expect(received[0].to).toEqual(['lead@client.com']);
    expect(received[0].raw).toMatch(new RegExp(`${OUTBOUND_HEADER}: ob-1`, 'i'));
    expect(received[0].raw).toMatch(/List-Unsubscribe-Post: List-Unsubscribe=One-Click/i);
    expect(received[0].raw).toMatch(/Message-ID: <abc@ourco.com>/i);
  });
  it('maps permanent 550 to a non-retryable 400', async () => {
    const e = await p.send(auth(), msg('nouser@client.com')).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect([e.status, e.retryable]).toEqual([400, false]);
  });
  it('maps temporary 451 to a retryable 503', async () => {
    const e = await p.send(auth(), msg('busy@client.com')).catch((x) => x);
    expect([e.status, e.retryable]).toEqual([503, true]);
  });
  it('maps an authentication failure to 401 (mailbox needs re-auth)', async () => {
    const e = await p.send(auth('wrong'), msg('lead@client.com')).catch((x) => x);
    expect(e.status).toBe(401);
  });
});
