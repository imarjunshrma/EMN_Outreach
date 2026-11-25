'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Checkbox, Field, Input, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { ConfigEditor, LinesField } from '@/components/ai-studio';

const SOURCES: Array<[string, string]> = [['companyWebsite', 'Company website (public pages, robots.txt respected)'], ['webSearch', 'Web search API results (Brave / Serper, if configured)'], ['newsAndArticles', 'News and articles found via search'], ['podcastsAndInterviews', 'Public podcasts, interviews and talks found via search'], ['dataProvider', 'Licensed data provider fields (e.g. Apollo)'], ['userProvided', 'Information entered by your team']];

export default function Research() {
  return (
    <>
      <PageHeader title="Research instructions" subtitle="What the research agent looks for, where it may look, and what it must never infer." />
      <ConfigEditor kind="research" title="Research rules">
        {(d, set) => {
          const s = (k: string, v: any) => set({ ...d, [k]: v });
          return (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <LinesField label="What to research about each person" value={d.personTopics} onChange={(v) => s('personTopics', v)} />
                <LinesField label="What to research about each company" value={d.companyTopics} onChange={(v) => s('companyTopics', v)} />
                <LinesField label="Business signals that matter" value={d.signals} onChange={(v) => s('signals', v)} />
                <LinesField label="Never infer or mention" value={d.mustNotInfer} onChange={(v) => s('mustNotInfer', v)} />
              </div>
              <Field label="Permitted sources"><div className="grid gap-1 md:grid-cols-2">{SOURCES.map(([k, l]) => <Checkbox key={k} label={l} checked={!!d.permittedSources[k]} onChange={(v) => s('permittedSources', { ...d.permittedSources, [k]: v })} />)}</div></Field>
              <Notice>Never used, regardless of settings: LinkedIn scraping, pages behind logins, private profiles, or sources whose robots.txt disallows access. Every stored fact keeps its source URL, a verbatim quote and the retrieval time.</Notice>
              <div className="grid gap-3 md:grid-cols-3">
                <Field label="Evidence required: minimum claims before writing"><Input type="number" min={0} max={10} value={d.minClaims} onChange={(e) => s('minClaims', Number(e.target.value))} /></Field>
                <Field label="Ignore evidence older than (days)" hint="Blank = no age limit"><Input type="number" min={1} value={d.maxEvidenceAgeDays ?? ''} onChange={(e) => s('maxEvidenceAgeDays', e.target.value === '' ? null : Number(e.target.value))} /></Field>
                <Field label="When information is unavailable"><Select value={d.onMissing} onChange={(e) => s('onMissing', e.target.value)} options={[{ value: 'hold_for_research', label: 'Hold the lead until researched' }, { value: 'use_role_and_company_only', label: 'Write a simple honest email (role + company only)' }, { value: 'skip_lead', label: 'Skip the lead' }]} /></Field>
              </div>
              <div className="grid gap-3 md:grid-cols-4">
                <Field label="Recent signal window (days)"><Input type="number" min={1} max={365} value={d.recentSignalDays} onChange={(e) => s('recentSignalDays', Number(e.target.value))} /></Field>
                <Field label="Extended signal window (days)"><Input type="number" min={1} max={730} value={d.extendedSignalDays} onChange={(e) => s('extendedSignalDays', Number(e.target.value))} /></Field>
                <Field label="Search calls per research stage" hint="0 disables web search"><Input type="number" min={0} max={6} value={d.maxSearchQueriesPerRun} onChange={(e) => s('maxSearchQueriesPerRun', Number(e.target.value))} /></Field>
                <Field label="Search calls per prospect" hint="Initial + deep research combined"><Input type="number" min={0} max={20} value={d.maxSearchesPerProspect} onChange={(e) => s('maxSearchesPerProspect', Number(e.target.value))} /></Field>
                <Field label="Pages fetched per stage"><Input type="number" min={1} max={12} value={d.maxPagesPerRun} onChange={(e) => s('maxPagesPerRun', Number(e.target.value))} /></Field>
                <Field label="Deep research minimum score" hint="Deep research also requires verified identity and ICP qualification"><Input type="number" min={0} max={100} value={d.deepResearchScoreThreshold} onChange={(e) => s('deepResearchScoreThreshold', Number(e.target.value))} /></Field>
              </div>
              <Field label="Additional research instructions"><Textarea rows={5} value={d.customInstructions} onChange={(e) => s('customInstructions', e.target.value)} /></Field>
            </div>
          );
        }}
      </ConfigEditor>
    </>
  );
}
