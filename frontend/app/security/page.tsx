'use client';
import Link from 'next/link';
import { SiteShell, Section } from '@/components/site/site-shell';

const GROUPS = [
  { title: 'Your data stays yours', items: [
    ['Separate by design', 'Each customer is an organization. Every record belongs to one workspace of one organization, and the database itself refuses links between workspaces.'],
    ['Access is checked on every request', 'An id in a URL is never proof of access. Membership is checked on the server for every call, and records from another organization answer “not found”.'],
    ['Export and deletion', 'Owners can download all of their data at any time, and can delete the organization. Deletion waits 14 days so it can be undone, then erases the data and files.'],
  ] },
  { title: 'Accounts and access', items: [
    ['Strong sign-in', 'Passwords are hashed with Argon2id. Two-factor authentication with recovery codes, and workspaces can require it.'],
    ['Roles', 'Organization owner, admin and billing roles; workspace roles from admin to read-only. API keys are scoped and can expire.'],
    ['Staff access is rare and recorded', 'Our support staff can open a workspace only with a time-limited, read-only grant that states a reason. Each grant shows in your audit log, and every page they open is recorded.'],
  ] },
  { title: 'Secrets and integrations', items: [
    ['Encrypted credentials', 'Mailbox tokens, AI keys and integration secrets are encrypted with AES-256-GCM and never sent back to the browser.'],
    ['Signed webhooks', 'Payment and integration webhooks are verified by signature and processed once, even if a provider sends them twice.'],
    ['Payments', 'Card details go to Stripe or Razorpay, never to our servers. Plans change only after the provider confirms payment.'],
  ] },
  { title: 'Operations', items: [
    ['Limits and fair use', 'Per-organization rate limits and job slots keep one busy customer from slowing others down.'],
    ['Audit trail', 'Sign-ins, setting changes, sends, exports and staff actions are logged. The platform audit log is append-only.'],
    ['Responsible disclosure', 'Found a problem? Write to info@elitemedianetworks.com.'],
  ] },
];

export default function Security() {
  return (
    <SiteShell>
      <Section className="pb-12 pt-16 lg:pt-20">
        <h1 className="font-display max-w-3xl text-[44px] font-bold leading-[1.05] tracking-[-0.04em] sm:text-[54px]">How we protect your data and your sender reputation</h1>
        <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-slate-600">A plain description of what the product does today. For the technical detail, see the <Link className="font-semibold text-ink underline" href="/docs/security">security documentation</Link>.</p>
      </Section>
      {GROUPS.map((g) => (
        <section key={g.title} className="border-t border-slate-200">
          <div className="mx-auto grid max-w-6xl gap-8 px-5 py-14 lg:grid-cols-[1fr_2.2fr]">
            <h2 className="font-display text-[26px] font-bold tracking-[-0.03em]">{g.title}</h2>
            <dl className="grid gap-8 md:grid-cols-3">
              {g.items.map(([t, d]) => <div key={t}><dt className="font-bold">{t}</dt><dd className="mt-2 text-[15px] leading-relaxed text-slate-600">{d}</dd></div>)}
            </dl>
          </div>
        </section>
      ))}
    </SiteShell>
  );
}
