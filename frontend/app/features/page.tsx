'use client';
import Link from 'next/link';
import { SiteShell, Section } from '@/components/site/site-shell';

const AREAS = [
  { id: 'prospects', title: 'Prospects', lead: 'Build lists you trust.', points: ['Import CSV files with column mapping and duplicate checks', 'Search Apollo and the web for companies that match your ideal customer profile', 'Verify addresses through a waterfall of providers before anything is sent', 'Score every lead against your ICP and see why it scored that way'] },
  { id: 'research', title: 'Research', lead: 'A short, sourced brief on every lead.', points: ['Reads the company website, news and public posts you allow', 'Keeps the link for every fact it uses', 'Flags thin or stale evidence instead of guessing', 'Your research rules decide what it may and may not use'] },
  { id: 'writing', title: 'Writing', lead: 'Drafts in your voice, about their business.', points: ['Business knowledge, writing rules and banned phrases live in AI Studio', 'Every claim in a draft can be traced to a source', 'Choose hosted or local models, with budgets per workspace', 'Never invents prices, discounts or deadlines'] },
  { id: 'sending', title: 'Sequences & sending', lead: 'Careful sending from mailboxes you own.', points: ['Gmail, Microsoft 365 and any SMTP/IMAP mailbox', 'Sending windows, daily limits and gaps per mailbox', 'Follow-ups stop the moment someone replies', 'SPF, DKIM and DMARC checks with guided DNS fixes'] },
  { id: 'replies', title: 'Inbox & replies', lead: 'Every reply in one place, sorted by intent.', points: ['Interested, objection, out of office, unsubscribe — classified for you', 'Suggested replies you approve, edit or reject', 'Meetings booked through Calendly or Cal.com are tracked to the campaign', 'Deals, tasks and a simple pipeline when a reply turns into an opportunity'] },
  { id: 'teams', title: 'Teams & agencies', lead: 'One organization, as many workspaces as you need.', points: ['Roles from owner to read-only, plus two-factor sign-in', 'A separate workspace for every client, with its own data and mailboxes', 'Audit log of who changed what, and when', 'Usage, limits and invoices for the whole organization in one place'] },
];

export default function Features() {
  return (
    <SiteShell>
      <Section className="pb-14 pt-16 lg:pt-20">
        <h1 className="font-display max-w-3xl text-[44px] font-bold leading-[1.05] tracking-[-0.04em] sm:text-[54px]">Everything between “who should we email?” and “they replied.”</h1>
        <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-slate-600">Outvexa covers the whole outbound workflow. Each part can be used on its own, and each one keeps a person in charge of what gets sent.</p>
        <nav className="mt-8 flex flex-wrap gap-2" aria-label="On this page">
          {AREAS.map((a) => <a key={a.id} href={`#${a.id}`} className="rounded-full border border-slate-200 px-4 py-1.5 text-sm font-semibold text-slate-600 hover:border-ink hover:text-ink">{a.title}</a>)}
        </nav>
      </Section>
      <div className="border-t border-slate-200">
        {AREAS.map((a) => (
          <section key={a.id} id={a.id} className="scroll-mt-20 border-b border-slate-200">
            <div className="mx-auto grid max-w-6xl gap-8 px-5 py-14 md:grid-cols-[1fr_1.4fr]">
              <div>
                <h2 className="font-display text-[30px] font-bold tracking-[-0.03em]">{a.title}</h2>
                <p className="mt-2 text-[17px] text-slate-600">{a.lead}</p>
              </div>
              <ul className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                {a.points.map((p) => <li key={p} className="border-l-2 border-brand-500 pl-4 text-[15px] leading-relaxed text-slate-700">{p}</li>)}
              </ul>
            </div>
          </section>
        ))}
      </div>
      <Section className="flex flex-col items-start gap-4 py-20">
        <p className="font-display text-[28px] font-bold tracking-[-0.03em]">See it with your own prospects.</p>
        <div className="flex gap-3"><Link href="/signup" className="btn-site-primary h-12 px-6">Start free trial</Link><Link href="/docs/quickstart" className="btn-site-ghost h-12 px-6">Read the quickstart</Link></div>
      </Section>
    </SiteShell>
  );
}
