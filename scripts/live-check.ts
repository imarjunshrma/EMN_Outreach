/**
 * Live provider integration check: OPT-IN, run by an operator against REAL accounts.
 *
 *   LIVE_CHECK=1 npm run live-check                  # read-only checks for every provider with credentials set
 *   LIVE_CHECK=1 LIVE_SEND_TO=you@yourdomain.com npm run live-check   # additionally sends ONE test email per mailbox to that address
 *
 * - Uses the production adapters from integrations/src (no mocks).
 * - Credentials come only from environment variables (see the table at the bottom / docs/18). Nothing is
 *   printed except pass/fail, the provider, and a short non-secret detail. Secrets are never logged.
 * - Never emails anyone except LIVE_SEND_TO. Never creates DNS records (Cloudflare check is read-only).
 * - Billing checks are read-only (list prices/plans); no charges, no subscriptions are created.
 * - Writes a JSON report to live-check-report.json so results can be attached to the implementation ledger.
 * A provider counts as "live-verified" only after this script passes against a real account.
 */
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { GmailProvider, GoogleOAuthClient } from '../integrations/src/email/gmail.js';
import { MicrosoftGraphProvider, MicrosoftOAuthClient } from '../integrations/src/email/microsoft.js';
import { SmtpImapProvider } from '../integrations/src/email/smtp-imap.js';
import type { AuthHandle, EmailProvider } from '../integrations/src/email/types.js';
import { AnthropicAdapter } from '../integrations/src/ai/anthropic.js';
import { OpenAiAdapter } from '../integrations/src/ai/openai.js';
import { MillionVerifierProvider } from '../integrations/src/providers/index.js';
import { ZeroBounceProvider, NeverBounceProvider, HunterFinder, CloudflareDns } from '../integrations/src/providers/extra.js';
import { S3Storage } from '../backend/src/core/storage.js';

type Result = { provider: string; status: 'pass' | 'fail' | 'skipped'; detail: string; ms?: number };
const results: Result[] = [];
const env = (k: string) => process.env[k]?.trim() || '';
const has = (...ks: string[]) => ks.every((k) => env(k));
const redact = (s: string) => s.replace(/(key|token|secret|password|authorization)[^\s,]*/gi, '$1=[redacted]').slice(0, 300);

async function check(provider: string, needs: string[], fn: () => Promise<string>) {
  if (!has(...needs)) { results.push({ provider, status: 'skipped', detail: `set ${needs.join(', ')}` }); return; }
  const t = Date.now();
  try { results.push({ provider, status: 'pass', detail: await fn(), ms: Date.now() - t }); }
  catch (e) { results.push({ provider, status: 'fail', detail: redact((e as Error).message), ms: Date.now() - t }); }
}

async function mailboxRoundTrip(name: string, p: EmailProvider, auth: AuthHandle) {
  const profile = await p.testConnection(auth);
  const sync = await p.sync(auth, null, new Date(Date.now() - 2 * 86400_000));
  let detail = `connected as ${profile.email}; sync returned ${sync.messages.length} message(s)`;
  const to = env('LIVE_SEND_TO');
  if (to) {
    const outboundId = randomUUID();
    const sent = await p.send(auth, { from: { address: profile.email }, to, subject: `[EMN live-check] ${name} ${new Date().toISOString()}`, text: 'Automated live integration check from Outvexa. No action needed.', messageId: `<${outboundId}@${profile.email.split('@')[1]}>`, headers: { 'X-EMN-Outbound-Id': outboundId } });
    const found = await p.findSentByOutboundId(auth, { outboundId, to, since: new Date(Date.now() - 600_000) }).catch(() => null);
    detail += `; sent test to ${to} (provider id ${sent.providerMessageId ? 'returned' : 'missing'}; found in Sent: ${found ? 'yes' : 'not yet'})`;
  }
  return detail;
}

async function main() {
  if (process.env.LIVE_CHECK !== '1') { console.error('Refusing to run: set LIVE_CHECK=1 to contact real providers.'); process.exit(2); }

  await check('gmail', ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'LIVE_GMAIL_REFRESH_TOKEN'], async () => {
    const tok = await new GoogleOAuthClient(env('GOOGLE_CLIENT_ID'), env('GOOGLE_CLIENT_SECRET')).refresh(env('LIVE_GMAIL_REFRESH_TOKEN'));
    return mailboxRoundTrip('gmail', new GmailProvider(), { kind: 'oauth', accessToken: tok.accessToken, email: env('LIVE_GMAIL_ADDRESS') || 'me' });
  });
  await check('microsoft-graph', ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'LIVE_MS_REFRESH_TOKEN'], async () => {
    const tok = await new MicrosoftOAuthClient(env('MICROSOFT_CLIENT_ID'), env('MICROSOFT_CLIENT_SECRET'), env('MICROSOFT_TENANT') || 'common').refresh(env('LIVE_MS_REFRESH_TOKEN'));
    return mailboxRoundTrip('graph', new MicrosoftGraphProvider(), { kind: 'oauth', accessToken: tok.accessToken, email: env('LIVE_MS_ADDRESS') || 'me' });
  });
  await check('smtp-imap', ['LIVE_SMTP_HOST', 'LIVE_IMAP_HOST', 'LIVE_MAIL_USER', 'LIVE_MAIL_PASSWORD', 'LIVE_MAIL_ADDRESS'], async () =>
    mailboxRoundTrip('smtp-imap', new SmtpImapProvider(), { kind: 'password', email: env('LIVE_MAIL_ADDRESS'), password: env('LIVE_MAIL_PASSWORD'), config: {
      smtpHost: env('LIVE_SMTP_HOST'), smtpPort: Number(env('LIVE_SMTP_PORT') || 587), smtpSecure: env('LIVE_SMTP_SECURE') === 'true',
      imapHost: env('LIVE_IMAP_HOST'), imapPort: Number(env('LIVE_IMAP_PORT') || 993), imapSecure: env('LIVE_IMAP_SECURE') !== 'false', username: env('LIVE_MAIL_USER'),
    } as never }));
  await check('system-mailer', ['SYSTEM_SMTP_URL'], async () => { await nodemailer.createTransport(env('SYSTEM_SMTP_URL')).verify(); return 'SMTP login ok (password reset / reports transport)'; });

  await check('anthropic', ['LIVE_ANTHROPIC_KEY'], async () => JSON.stringify(await new AnthropicAdapter().testConnection(env('LIVE_ANTHROPIC_KEY'), env('LIVE_ANTHROPIC_MODEL') || 'claude-haiku-5-5')));
  await check('openai', ['LIVE_OPENAI_KEY'], async () => JSON.stringify(await new OpenAiAdapter().testConnection(env('LIVE_OPENAI_KEY'), env('LIVE_OPENAI_MODEL') || 'gpt-4o-mini')));

  const probe = env('LIVE_VERIFY_EMAIL') || 'postmaster@gmail.com';
  await check('millionverifier', ['LIVE_MILLIONVERIFIER_KEY'], async () => `result ${(await new MillionVerifierProvider().verify(env('LIVE_MILLIONVERIFIER_KEY'), probe)).result}`);
  await check('zerobounce', ['LIVE_ZEROBOUNCE_KEY'], async () => `result ${(await new ZeroBounceProvider().verify(env('LIVE_ZEROBOUNCE_KEY'), probe)).result}`);
  await check('neverbounce', ['LIVE_NEVERBOUNCE_KEY'], async () => `result ${(await new NeverBounceProvider().verify(env('LIVE_NEVERBOUNCE_KEY'), probe)).result}`);
  await check('hunter', ['LIVE_HUNTER_KEY'], async () => JSON.stringify(await new HunterFinder().test(env('LIVE_HUNTER_KEY'))));
  await check('cloudflare (read-only)', ['LIVE_CLOUDFLARE_TOKEN'], async () => {
    const cf = new CloudflareDns();
    const v = await cf.verifyToken(env('LIVE_CLOUDFLARE_TOKEN'));
    if (!v.ok) throw new Error('token rejected');
    if (!env('LIVE_CLOUDFLARE_DOMAIN')) return 'token valid';
    const zone = await cf.findZone(env('LIVE_CLOUDFLARE_DOMAIN'), env('LIVE_CLOUDFLARE_DOMAIN'));
    return `token valid; zone ${zone ? 'found' : 'not found'}`;
  });

  await check('stripe (read-only)', ['STRIPE_SECRET_KEY'], async () => {
    const r = await fetch('https://api.stripe.com/v1/prices?limit=3', { headers: { authorization: `Bearer ${env('STRIPE_SECRET_KEY')}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return `prices readable (${((await r.json()) as { data: unknown[] }).data.length} listed); webhook secret ${env('STRIPE_WEBHOOK_SECRET') ? 'set' : 'NOT set'}`;
  });
  await check('razorpay (read-only)', ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'], async () => {
    const r = await fetch('https://api.razorpay.com/v1/plans?count=3', { headers: { authorization: `Basic ${Buffer.from(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`).toString('base64')}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return `plans readable; webhook secret ${env('RAZORPAY_WEBHOOK_SECRET') ? 'set' : 'NOT set'}`;
  });
  await check('s3 storage', ['S3_BUCKET', 'S3_REGION'], async () => {
    const s3 = new S3Storage({ bucket: env('S3_BUCKET'), region: env('S3_REGION'), endpoint: env('S3_ENDPOINT') || undefined, forcePathStyle: env('S3_FORCE_PATH_STYLE') === 'true', accessKeyId: env('S3_ACCESS_KEY_ID') || undefined, secretAccessKey: env('S3_SECRET_ACCESS_KEY') || undefined, prefix: env('S3_PREFIX') || undefined } as never);
    const ws = '00000000-0000-4000-8000-000000000000';
    const key = await s3.put(ws, 'live-check', Buffer.from('emn live check'), 'txt');
    const back = (await s3.get(key)).toString();
    await s3.delete(key);
    if (back !== 'emn live check') throw new Error('read-back mismatch');
    return 'put / get / delete ok';
  });

  const width = Math.max(...results.map((r) => r.provider.length));
  for (const r of results) console.log(`${r.status === 'pass' ? '✔' : r.status === 'fail' ? '✘' : '·'} ${r.provider.padEnd(width)}  ${r.status.padEnd(7)} ${r.detail}${r.ms ? ` (${r.ms} ms)` : ''}`);
  writeFileSync('live-check-report.json', JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  console.log('\nReport written to live-check-report.json (contains no secrets).');
  process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
}

void main();
