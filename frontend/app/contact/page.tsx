'use client';
import Link from 'next/link';
import { SiteShell, Section } from '@/components/site/site-shell';

export default function Contact() {
  return (
    <SiteShell>
      <Section className="pb-24 pt-16 lg:pt-20">
        <h1 className="font-display max-w-2xl text-[44px] font-bold leading-[1.05] tracking-[-0.04em]">Talk to us</h1>
        <p className="mt-4 max-w-xl text-[17px] leading-relaxed text-slate-600">Questions about plans, a demo for your team or agency, or help with your account. A person at Elite Media Networks reads every message.</p>
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 p-6">
            <p className="font-bold">Sales and demos</p>
            <p className="mt-2 text-[15px] text-slate-600">Tell us how many people and clients you send for, and we’ll suggest a plan.</p>
            <a className="mt-4 inline-block font-semibold text-brand-700 underline" href="mailto:info@elitemedianetworks.com?subject=Outreach%20OS%20demo">info@elitemedianetworks.com</a>
            <p className="mt-1 text-sm text-slate-600"><a className="hover:text-ink" href="tel:+919664329203">+91 96643 29203</a></p>
          </div>
          <div className="rounded-2xl border border-slate-200 p-6">
            <p className="font-bold">Account and billing help</p>
            <p className="mt-2 text-[15px] text-slate-600">Write from the email address on your account and include your organization name. Never send passwords or card numbers.</p>
            <a className="mt-4 inline-block font-semibold text-brand-700 underline" href="mailto:info@elitemedianetworks.com?subject=Outreach%20OS%20support">Email support</a>
          </div>
          <div className="rounded-2xl border border-slate-200 p-6">
            <p className="font-bold">Security and privacy</p>
            <p className="mt-2 text-[15px] text-slate-600">Report a vulnerability or make a data-protection request. For data about you held by one of our customers, contact that customer first.</p>
            <a className="mt-4 inline-block font-semibold text-brand-700 underline" href="mailto:info@elitemedianetworks.com?subject=Security%20report">Report an issue</a>
          </div>
        </div>
        <p className="mt-10 text-sm text-slate-600">Looking for how-to answers? The <Link className="font-semibold text-ink underline" href="/docs">documentation</Link> covers setup, sending, billing and the API.</p>
      </Section>
    </SiteShell>
  );
}
