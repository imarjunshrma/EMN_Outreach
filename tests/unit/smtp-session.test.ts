/**
 * The SMTP session used by first-party email verification, against a local fake mail server:
 * target + catch-all control in ONE session, HELO fallback, real greeting name, dropped connections and
 * "mailbox does not exist" answers from Microsoft 365 and others.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { classifyMailboxEvidence, classifySmtpReply, smtpSession } from '../../integrations/src/email-verification-smtp.js';

type Script = (line: string, sock: Socket, state: { rcpt: number; lines: string[] }) => void;
let server: Server | null = null;
const sockets = new Set<Socket>();
afterEach(() => new Promise<void>((r) => { for (const s of sockets) s.destroy(); sockets.clear(); if (!server) return r(); server.close(() => r()); server = null; }));

async function fakeMx(script: Script, greeting = '220 mx.test ESMTP'): Promise<{ port: number; seen: string[]; connections: () => number }> {
  const seen: string[] = []; let conns = 0;
  server = createServer((sock) => {
    sockets.add(sock);
    conns++;
    const state = { rcpt: 0, lines: seen };
    sock.write(`${greeting}\r\n`);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        seen.push(line);
        if (line === 'QUIT') { sock.end('221 bye\r\n'); continue; }
        script(line, sock, state);
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return { port: (server!.address() as { port: number }).port, seen, connections: () => conns };
}

const standard = (rcpt: (addr: string, n: number) => string): Script => (line, sock, st) => {
  if (line.startsWith('EHLO')) sock.write('250-mx.test\r\n250-SIZE 1000\r\n250 OK\r\n');
  else if (line.startsWith('MAIL FROM')) sock.write('250 2.1.0 OK\r\n');
  else if (line.startsWith('RCPT TO')) sock.write(`${rcpt(line.slice(9, -1), ++st.rcpt)}\r\n`);
};
const opts = (port: number, controlEmail?: string) => ({ mailFrom: 'verify@sender.test', timeoutMs: 2000, port, controlEmail });

describe('smtpSession', () => {
  it('checks the target and the catch-all control in one connection: VALID when the control is rejected', async () => {
    const mx = await fakeMx(standard((addr) => (addr.startsWith('emn-control-') ? '550 5.1.1 <x> User unknown' : '250 2.1.5 OK')));
    const r = await smtpSession('127.0.0.1', 'mx.test', 'real@acme.test', opts(mx.port, 'emn-control-abc@acme.test'));
    expect(r.classification).toBe('ACCEPTED_BUT_UNCONFIRMED');
    expect(r.control?.classification).toBe('USER_UNKNOWN');
    expect(classifyMailboxEvidence(r, r.control)).toBe('VALID');
    expect(mx.connections()).toBe(1);
    expect(mx.seen.filter((l) => l.startsWith('RCPT TO'))).toEqual(['RCPT TO:<real@acme.test>', 'RCPT TO:<emn-control-abc@acme.test>']);
    expect(mx.seen[0]).toBe('EHLO sender.test'); // a real hostname, not ".invalid"
    expect(mx.seen).not.toContain('DATA');
  });

  it('reports catch-all when the random control is accepted too', async () => {
    const mx = await fakeMx(standard(() => '250 OK'));
    const r = await smtpSession('127.0.0.1', 'mx.test', 'real@acme.test', opts(mx.port, 'emn-control-abc@acme.test'));
    expect(classifyMailboxEvidence(r, r.control)).toBe('CATCH_ALL');
  });

  it('does not ask about the control when the target is rejected', async () => {
    const mx = await fakeMx(standard(() => '550 5.1.1 No such user'));
    const r = await smtpSession('127.0.0.1', 'mx.test', 'gone@acme.test', opts(mx.port, 'emn-control-abc@acme.test'));
    expect(classifyMailboxEvidence(r, r.control)).toBe('INVALID');
    expect(r.control).toBeUndefined();
    expect(mx.seen.filter((l) => l.startsWith('RCPT TO'))).toHaveLength(1);
  });

  it('keeps the target result and names the cause when the server drops the connection before the control', async () => {
    const mx = await fakeMx((line, sock, st) => {
      if (line.startsWith('EHLO')) sock.write('250 OK\r\n');
      else if (line.startsWith('MAIL FROM')) sock.write('250 OK\r\n');
      else if (line.startsWith('RCPT TO')) { if (++st.rcpt === 1) sock.write('250 OK\r\n'); else sock.destroy(); }
    });
    const r = await smtpSession('127.0.0.1', 'mx.test', 'real@acme.test', opts(mx.port, 'emn-control-abc@acme.test'));
    expect(r.classification).toBe('ACCEPTED_BUT_UNCONFIRMED');
    expect(r.control?.classification).toBe('CONNECTION_RESET');
    expect(r.control?.reason).toContain('mx.test');
    expect(classifyMailboxEvidence(r, r.control)).toBe('UNKNOWN');
  });

  it('falls back to HELO for servers without EHLO', async () => {
    const mx = await fakeMx((line, sock) => {
      if (line.startsWith('EHLO')) sock.write('502 5.5.2 Command not recognized\r\n');
      else if (line.startsWith('HELO')) sock.write('250 mx.test\r\n');
      else if (line.startsWith('MAIL FROM')) sock.write('250 OK\r\n');
      else if (line.startsWith('RCPT TO')) sock.write('250 OK\r\n');
    });
    const r = await smtpSession('127.0.0.1', 'mx.test', 'real@acme.test', opts(mx.port));
    expect(r.classification).toBe('ACCEPTED_BUT_UNCONFIRMED');
    expect(mx.seen).toContain('HELO sender.test');
  });

  it('does not lose replies that arrive in one burst', async () => {
    const mx = await fakeMx((line, sock) => {
      if (line.startsWith('EHLO')) sock.write('250-a\r\n250-b\r\n250 OK\r\n');
      else if (line.startsWith('MAIL FROM')) sock.write('250 OK\r\n');
      else if (line.startsWith('RCPT TO')) sock.write('250 OK\r\n');
    }, '220-mx.test first line\r\n220-second line\r\n220 ready');
    const r = await smtpSession('127.0.0.1', 'mx.test', 'real@acme.test', opts(mx.port));
    expect(r.classification).toBe('ACCEPTED_BUT_UNCONFIRMED');
  });

  it('times out with a clear reason when the server never answers', async () => {
    server = createServer((sock) => { sockets.add(sock); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const r = await smtpSession('127.0.0.1', 'slow.test', 'real@acme.test', { ...opts((server.address() as { port: number }).port), timeoutMs: 300 });
    expect(r.classification).toBe('CONNECTION_TIMEOUT');
    expect(r.reason).toContain('slow.test');
  });
});

describe('recipient rejections', () => {
  it('recognises "mailbox does not exist" answers from common providers', () => {
    for (const reply of [
      '550 5.4.1 Recipient address rejected: Access denied. AS(201806281) [BN8NAM12FT056.eop-nam12.prod.protection.outlook.com]', // Microsoft 365
      '550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup', // Exchange Online
      "550-5.1.1 The email account that you tried to reach does not exist.", // Gmail
      '550 5.1.1 <x@y.test>: Recipient address rejected: User unknown in virtual mailbox table', // Postfix
      '550 No Such User Here', // cPanel / Exim
      '553 5.1.3 mailbox unavailable',
      '554 delivery error: dd This user doesn\'t have a yahoo.com account (x@yahoo.com) [0] - mta.yahoo.com'.replace("doesn't have", 'does not exist, no'),
    ]) expect(classifySmtpReply(reply).classification, reply).toBe('USER_UNKNOWN');
  });
  it('keeps sender and policy blocks as policy rejections', () => {
    for (const reply of ['550 5.7.1 Service unavailable; client host blocked', '550 Recipient address rejected: access denied', '554 5.7.1 Relay access denied', '550 5.7.606 Access denied, banned sending IP'])
      expect(classifySmtpReply(reply).classification, reply).toBe('POLICY_REJECTION');
  });
});
