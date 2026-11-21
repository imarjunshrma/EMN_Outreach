'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from 'next/link';
import { useWs, useWsQuery } from '@/lib/hooks';
import { Card, Notice, PageHeader, QueryView, Stat } from '@/components/ui';

export default function AiStudio() {
  const ws = useWs();
  const q = useWsQuery<any>('/ai-studio/overview');
  const link = (href: string, label: string, text: string) => <Link href={`/w/${ws}/ai-studio${href}`} className="block rounded-lg border border-slate-200 p-4 hover:border-brand-500"><div className="font-semibold">{label}</div><p className="mt-1 text-sm text-slate-600">{text}</p></Link>;
  return (
    <>
      <PageHeader title="AI Studio" subtitle="Teach the AI about your business and how to write — once, for every campaign." />
      <QueryView q={q}>
        {(d) => (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-4">
              <Stat label="Business knowledge" value={d.knowledgeVersion ? `v${d.knowledgeVersion}` : 'not set'} hint={d.companyName || undefined} />
              <Stat label="Active outreach rules" value={d.activeRules} hint={`${d.activeExamples} active examples`} />
              <Stat label="Draft decisions" value={`${d.approvedDrafts} approved`} hint={`${d.rejectedDrafts} rejected · ${d.generatedDrafts} need review`} />
              <Stat label="AI spend this month" value={`$${d.monthSpendUsd.toFixed(2)}`} hint={d.aiMonthlyBudgetUsd ? `budget $${d.aiMonthlyBudgetUsd}` : 'no workspace budget'} />
            </div>
            {!d.knowledgeVersion && <Notice kind="warning">Business knowledge is not set. The AI can only state facts about your company that you enter here.</Notice>}
            <Card title="Configure">
              <div className="grid gap-3 md:grid-cols-3">
                {link('/knowledge', 'Business knowledge', `Company, services, offers, verified case studies and achievements, competitors, documents (${d.activeDocuments} active).`)}
                {link('/writing', 'Writing instructions', 'Tone, style, length, CTA, words to avoid, forbidden claims, examples and a large custom-instructions editor.')}
                {link('/research', 'Research instructions', 'What to research about people and companies, permitted sources, signals, evidence rules and what never to infer.')}
                {link('/training', 'AI Outreach Training', `${d.pendingSuggestions} learning suggestion(s) · manage customer rules, examples and feedback.`)}
                {link('/profiles', 'Prompt library', `Reusable prompt profiles with variables, conditionals, versions, folders, tags, import/export and tests (${d.profiles}).`)}
                {link('/models', 'Models & budgets', 'Model per task, fallback, token limits, monthly budget, maximum cost per lead and cost tracking.')}
              </div>
            </Card>
            <Notice>How instructions combine: <b>platform safety & compliance rules</b> (never overridable) → workspace (this studio) → prompt profile → campaign → ICP → sequence step → A/B variant → individual prospect. Single settings: the most specific level wins. Words to avoid, forbidden claims and “never infer” topics accumulate across levels. Prospect data from research is treated as data, never as instructions.</Notice>
          </div>
        )}
      </QueryView>
    </>
  );
}
