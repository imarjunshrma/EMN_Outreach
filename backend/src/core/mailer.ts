import { blockBrowserE2eDelivery, browserE2e } from './browser-e2e-safety.js';
import nodemailer from 'nodemailer';
import { logger } from './logger.js';

// System email (password resets, MFA notices, scheduled reports, notification emails).
// Separate from prospect mailboxes: configure SYSTEM_SMTP_URL with a transactional provider
// (e.g. Postmark/SES/Mailgun SMTP or your own server). Never sent through prospecting mailboxes.

export interface SystemMail { to: string; subject: string; text: string }
export interface SystemMailer { readonly configured: boolean; send(m: SystemMail): Promise<void> }

class SmtpSystemMailer implements SystemMailer {
  readonly configured: boolean;
  private transport;
  constructor(url: string | undefined, private readonly from: string) {
    this.configured = !!url;
    this.transport = url ? nodemailer.createTransport(url) : null;
  }
  async send(m: SystemMail) {
    if (!this.transport) throw new Error('System email is not configured (set SYSTEM_SMTP_URL and SYSTEM_MAIL_FROM)');
    await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text, headers: { 'Auto-Submitted': 'auto-generated' } });
  }
}

let mailer: SystemMailer | null = null;
export function systemMailer(): SystemMailer {
  if (browserE2e()) return { configured: false, async send() { blockBrowserE2eDelivery('system-mail.send'); } };
  mailer ??= new SmtpSystemMailer(process.env.SYSTEM_SMTP_URL || undefined, process.env.SYSTEM_MAIL_FROM || 'Outvexa <no-reply@localhost>');
  return mailer;
}
export function setSystemMailerForTests(m: SystemMailer | null) { mailer = m; }

/** Send if configured; never throws into the caller (security flows must not reveal mail state). */
export async function trySendSystemMail(m: SystemMail): Promise<boolean> {
  try { await systemMailer().send(m); return true; } catch (e) { logger.error({ err: (e as Error).message, to: '[redacted]' }, 'system email not sent'); return false; }
}
