'use client';
import Link from 'next/link';
import { Check, X } from 'lucide-react';
import { SiteShell, Section, useSignedIn } from '@/components/site/site-shell';

const FLOW = [
  { t: 'Find', d: 'Import a CSV, pull from Apollo, or search for companies that match your ideal customer profile.' },
  { t: 'Research', d: 'Each lead gets a short brief from their website, recent news and public posts — with the links.' },
  { t: 'Write', d: 'Drafts follow your offer, your tone and your rules. Every specific claim points back to a source.' },
  { t: 'Approve', d: 'You read, edit and approve. Nothing leaves a mailbox until a person says yes.' },
  { t: 'Send', d: 'From your own Gmail, Outlook or SMTP mailboxes, inside the hours and daily limits you set.' },
  { t: 'Reply', d: 'Replies land in one inbox, sorted by intent, with suggested answers you approve before they go.' },
];

export default function Home() {
  const signedIn = useSignedIn();
  return (
    <SiteShell>
      {/* Hero: the product's most characteristic moment — a researched draft waiting for a human. */}
      <Section className="grid items-center gap-14 pb-20 pt-16 lg:grid-cols-[1.05fr_1fr] lg:pt-24">
        <div>
          <h1 className="font-display text-[44px] font-bold leading-[1.02] tracking-[-0.04em] text-ink sm:text-[60px]">Cold email that shows you did the homework.</h1>
          <p className="mt-6 max-w-lg text-[17px] leading-relaxed text-slate-600">Outvexa researches every prospect, drafts an email grounded in what it found, and waits for your approval before anything is sent. One place for leads, sequences, mailboxes and replies — for your team or for every client you run.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            {signedIn ? <Link href="/app" className="btn-site-primary h-12 px-6 text-[15px]">Open the app</Link> : <Link href="/signup" className="btn-site-primary h-12 px-6 text-[15px]">Start a 14-day trial</Link>}
            <Link href="/features" className="btn-site-ghost h-12 px-6 text-[15px]">See how it works</Link>
          </div>
          <p className="mt-4 text-sm text-slate-500">No card needed for the trial. Bring your own mailboxes and AI keys.</p>
        </div>
        <DraftArtifact />
      </Section>

      <div className="border-y border-slate-200 bg-paper">
        <Section className="py-20">
          <h2 className="font-display max-w-2xl text-[34px] font-bold leading-tight tracking-[-0.03em]">From a list of names to a conversation, in six steps you can see.</h2>
          <ol className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-slate-200 bg-slate-200 sm:grid-cols-2 lg:grid-cols-3">
            {FLOW.map((s, i) => (
              <li key={s.t} className="bg-white p-7">
                <p className="font-display text-[13px] font-bold text-brand-600 tnum">Step {i + 1}</p>
                <p className="font-display mt-1 text-[22px] font-bold tracking-[-0.02em]">{s.t}</p>
                <p className="mt-2 text-[15px] leading-relaxed text-slate-600">{s.d}</p>
              </li>
            ))}
          </ol>
        </Section>
      </div>

      <Section className="grid gap-14 py-24 lg:grid-cols-2">
        <div>
          <h2 className="font-display text-[34px] font-bold leading-tight tracking-[-0.03em]">What it will not do</h2>
          <p className="mt-4 max-w-md text-[16px] leading-relaxed text-slate-600">Deliverability and reputation are yours to keep. Some shortcuts burn both, so the product leaves them out on purpose.</p>
        </div>
        <ul className="divide-y divide-slate-200 border-y border-slate-200">
          {[
            ['Rotate dozens of throwaway mailboxes', 'You send from real mailboxes you own, at volumes a person could.'],
            ['Join a warm-up network', 'No fake opens and replies traded between strangers\' inboxes.'],
            ['Send AI text you have not seen', 'Approval is the default for first emails, follow-ups and replies.'],
            ['Make promises for you', 'The AI never quotes prices, discounts or deadlines you did not write down.'],
            ['Ignore an unsubscribe', 'Opt-outs and bounces are suppressed across every campaign, immediately.'],
          ].map(([no, why]) => (
            <li key={no} className="flex gap-4 py-5">
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink text-white"><X className="h-3.5 w-3.5" aria-hidden /></span>
              <div><p className="font-bold">{no}</p><p className="mt-1 text-[15px] text-slate-600">{why}</p></div>
            </li>
          ))}
        </ul>
      </Section>

      <div className="bg-ink text-white">
        <Section className="grid gap-12 py-24 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <h2 className="font-display text-[34px] font-bold leading-tight tracking-[-0.03em]">Running outreach for clients?</h2>
            <p className="mt-4 max-w-md text-[16px] leading-relaxed text-ink-300">Give each client a workspace of its own: separate leads, mailboxes, domains, AI rules and reports. Your team moves between them from one login, and you get one bill.</p>
            <Link href="/pricing" className="mt-8 inline-flex h-12 items-center rounded-xl bg-white px-6 text-[15px] font-bold text-ink hover:bg-brand-100">Compare plans</Link>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
            <p className="text-sm font-semibold text-ink-300">Gamma Agency</p>
            <ul className="mt-4 space-y-2">
              {[['Northwind Clinics', '3 mailboxes · 1,240 leads', 'Running'], ['Harbour Realty', '2 mailboxes · 610 leads', 'Running'], ['Lumen Learning', '1 mailbox · 95 leads', 'Setting up']].map(([n, m, s]) => (
                <li key={n} className="flex items-center justify-between rounded-xl bg-white/[0.06] px-4 py-3">
                  <span><span className="block font-bold">{n}</span><span className="block text-xs text-ink-300">{m}</span></span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${s === 'Running' ? 'bg-brand-500/20 text-brand-200' : 'bg-white/10 text-ink-200'}`}>{s}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-ink-400">Illustration. Client data never crosses workspaces, and staff see only the clients they are added to.</p>
          </div>
        </Section>
      </div>

      <Section className="grid items-center gap-12 py-24 lg:grid-cols-2">
        <div>
          <h2 className="font-display text-[34px] font-bold leading-tight tracking-[-0.03em]">Plugs into the rest of your stack</h2>
          <p className="mt-4 max-w-md text-[16px] leading-relaxed text-slate-600">A REST API with scoped keys, signed webhooks for replies, meetings and status changes, Slack alerts, and booking webhooks from Calendly or Cal.com. Use the API or webhooks to keep your CRM in sync.</p>
          <ul className="mt-6 space-y-2 text-[15px]">
            {['Scoped API keys per workspace', 'Webhooks signed with HMAC-SHA256', 'OpenAPI 3.1 reference'].map((x) => <li key={x} className="flex items-center gap-2"><Check className="h-4 w-4 text-brand-600" aria-hidden />{x}</li>)}
          </ul>
          <Link href="/docs" className="btn-site-ghost mt-8">Read the documentation</Link>
        </div>
        <pre className="overflow-x-auto rounded-2xl bg-ink p-6 text-[13px] leading-relaxed text-ink-100"><code className="!bg-transparent !p-0 !text-inherit">{`curl https://app.example.com/api/v1/w/$WORKSPACE/leads \\
  -H "Authorization: Bearer $EMN_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "priya@northwind.example",
    "firstName": "Priya",
    "companyName": "Northwind Clinics"
  }'`}</code></pre>
      </Section>

      <div className="border-t border-slate-200 bg-paper">
        <Section className="flex flex-col items-start justify-between gap-6 py-16 md:flex-row md:items-center">
          <div>
            <p className="font-display text-[28px] font-bold tracking-[-0.03em]">Try it on your next 50 prospects.</p>
            <p className="mt-1 text-slate-600">Fourteen days, every feature of the plan you choose.</p>
          </div>
          <Link href={signedIn ? '/app' : '/signup'} className="btn-site-primary h-12 px-6 text-[15px]">{signedIn ? 'Open the app' : 'Start free trial'}</Link>
        </Section>
      </div>
    </SiteShell>
  );
}

function DraftArtifact() {
  return (
    <figure className="relative" aria-label="Example: a researched draft waiting for approval">
      <div className="absolute -inset-4 -z-10 rounded-[28px] bg-gradient-to-br from-brand-100 via-white to-paper" aria-hidden />
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-pop">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 text-[13px]">
          <span className="font-semibold text-slate-500">Review queue</span>
          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-800">Waiting for you</span>
        </div>
        <div className="px-5 py-4 text-[13px] text-slate-500">
          <p><span className="font-semibold text-ink">To</span> Priya Shah · Head of Growth, Northwind Clinics</p>
          <p className="mt-1"><span className="font-semibold text-ink">Subject</span> Filling the new paediatric slots</p>
        </div>
        <div className="space-y-3 px-5 pb-5 text-[14.5px] leading-relaxed text-ink">
          <p>Hi Priya,</p>
          <p>Saw that Northwind opened paediatric care at the Andheri clinic last month<Cite n={1} /> and is hiring two front-desk coordinators for it<Cite n={2} />.</p>
          <p>New services usually take a quarter to fill. We help clinics get there in weeks with search ads aimed at parents nearby. Worth a 15-minute call next week?</p>
        </div>
        <div className="border-t border-slate-200 bg-paper px-5 py-3 text-[12.5px] text-slate-600">
          <p className="font-semibold text-ink">Sources</p>
          <p className="mt-1"><b className="text-brand-700">1</b> northwind.example/news — “Paediatrics now open in Andheri”</p>
          <p><b className="text-brand-700">2</b> northwind.example/careers — 2 open roles, posted 9 days ago</p>
        </div>
        <div className="flex items-center gap-2 border-t border-slate-200 px-5 py-3">
          <span className="rounded-lg bg-ink px-3.5 py-2 text-[13px] font-bold text-white">Approve & schedule</span>
          <span className="rounded-lg border border-slate-300 px-3.5 py-2 text-[13px] font-bold">Edit</span>
          <span className="ml-auto text-xs text-slate-500">Sends Tue 10:40 from your mailbox</span>
        </div>
      </div>
      <figcaption className="mt-5 text-center text-xs text-slate-500">Example draft. Names and sources are illustrative.</figcaption>
    </figure>
  );
}

function Cite({ n }: { n: number }) {
  return <sup className="ml-0.5 rounded bg-brand-100 px-1 text-[10px] font-bold text-brand-700">{n}</sup>;
}
