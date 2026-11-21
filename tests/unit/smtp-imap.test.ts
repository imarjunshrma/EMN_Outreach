import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  smtpVerify: vi.fn(),
  imapConnect: vi.fn(),
  imapLogout: vi.fn(),
  imapList: vi.fn(),
  imapMessages: [] as Array<{ uid: number; source: Buffer }>,
  imapFolders: [] as Array<{ path: string; specialUse?: string }>,
  failLockFolder: null as string | null,
  transportOptions: null as unknown,
  imapOptions: null as unknown,
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: unknown) => {
      mocks.transportOptions = options;
      return { verify: mocks.smtpVerify };
    },
  },
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor(options: unknown) { mocks.imapOptions = options; }
    mailbox: { uidValidity: number } | false = false;
    connect = mocks.imapConnect;
    logout = mocks.imapLogout;
    async getMailboxLock(path: string) {
      if (path === mocks.failLockFolder) throw new Error('folder unavailable');
      this.mailbox = { uidValidity: 42 };
      return { release: vi.fn() };
    }
    list = mocks.imapList;
    async *fetch() { yield* mocks.imapMessages; }
  },
}));

import { SmtpImapProvider } from '../../integrations/src/email/smtp-imap.js';

const auth = {
  kind: 'password' as const,
  email: 'owner@example.test',
  password: 'secret-password',
  config: { smtpHost: 'smtp.example.test', smtpPort: 587, smtpSecure: false, imapHost: 'imap.example.test', imapPort: 993, imapSecure: true, username: 'secret-user' },
};

describe('SMTP/IMAP connection verification (mocked providers)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.smtpVerify.mockResolvedValue(undefined);
    mocks.imapConnect.mockResolvedValue(undefined);
    mocks.imapLogout.mockResolvedValue(undefined);
    mocks.imapList.mockReset().mockResolvedValue([]);
    mocks.imapMessages = [];
    mocks.imapFolders = [];
    mocks.failLockFolder = null;
  });

  it('verifies SMTP then IMAP using the individual mailbox settings', async () => {
    const profile = await new SmtpImapProvider().testConnection(auth);
    expect(profile.email).toBe('owner@example.test');
    expect(mocks.transportOptions).toMatchObject({ host: 'smtp.example.test', port: 587, auth: { user: 'secret-user', pass: 'secret-password' } });
    expect(mocks.imapOptions).toMatchObject({ host: 'imap.example.test', port: 993, auth: { user: 'secret-user', pass: 'secret-password' }, logger: false });
    expect(mocks.smtpVerify).toHaveBeenCalledOnce();
    expect(mocks.imapConnect).toHaveBeenCalledOnce();
    expect(mocks.imapLogout).toHaveBeenCalledOnce();
  });

  it('uses independent SMTP and IMAP usernames and passwords when configured', async () => {
    await new SmtpImapProvider().testConnection({
      ...auth,
      smtpPassword: 'smtp-only-secret',
      imapPassword: 'imap-only-secret',
      config: { ...auth.config, smtpUsername: 'smtp-user', imapUsername: 'imap-user' },
    });
    expect(mocks.transportOptions).toMatchObject({ auth: { user: 'smtp-user', pass: 'smtp-only-secret' } });
    expect(mocks.imapOptions).toMatchObject({ auth: { user: 'imap-user', pass: 'imap-only-secret' } });
  });

  it('discovers the Sent special-use folder when the configured folder is missing', async () => {
    mocks.failLockFolder = 'Sent';
    mocks.imapList.mockResolvedValue([{ path: 'Sent Items', specialUse: '\\Sent' }]);
    mocks.imapMessages = [{ uid: 7, source: Buffer.from('From: owner@example.test\r\nTo: other@example.test\r\nSubject: test\r\nMessage-ID: <sync@example.test>\r\n\r\nhello') }];
    const result = await new SmtpImapProvider().sync(auth, null, new Date('2026-01-01T00:00:00Z'));
    expect(result.messages).toHaveLength(2);
    expect(JSON.parse(result.nextCursor)).toMatchObject({ INBOX: { uidValidity: '42', lastUid: 7 }, 'Sent Items': { uidValidity: '42', lastUid: 7 } });
  });

  it('returns a sanitized error when SMTP verification fails', async () => {
    mocks.smtpVerify.mockRejectedValue(Object.assign(new Error('secret-password leaked by server'), { code: 'EAUTH' }));
    const result = await new SmtpImapProvider().testConnectionDetailed(auth);
    expect(result.smtp).toMatchObject({ ok: false });
    expect(result.smtp.error).toContain('SMTP authentication failed');
    expect(result.smtp.error).not.toContain('secret-password');
    expect(result.imap).toMatchObject({ ok: true, error: null });
    expect(mocks.imapConnect).toHaveBeenCalledOnce();
  });

  it('returns a sanitized error when IMAP login fails', async () => {
    mocks.imapConnect.mockRejectedValue(new Error('secret-password from server text'));
    const result = await new SmtpImapProvider().testConnectionDetailed(auth);
    expect(result.imap).toMatchObject({ ok: false });
    expect(result.imap.error).toContain('IMAP authentication failed');
    expect(result.imap.error).not.toContain('secret-password');
    expect(mocks.imapLogout).toHaveBeenCalledOnce();
  });
});
