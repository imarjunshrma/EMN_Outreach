'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Field, Input, Notice, PageHeader, Select, Textarea } from '@/components/ui';
import { ConfigEditor, LinesField } from '@/components/ai-studio';

const opt = (xs: string[]) => xs.map((x) => ({ value: x, label: x.replace(/_/g, ' ') }));

export default function Writing() {
  return (
    <>
      <PageHeader title="Global AI writing instructions" subtitle="Applied to every campaign unless a campaign, step or prospect overrides them." />
      <ConfigEditor kind="writing" title="Writing rules">
        {(d, set) => {
          const s = (k: string, v: any) => set({ ...d, [k]: v });
          return (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <Field label="Default tone"><Select value={d.tone} onChange={(e) => s('tone', e.target.value)} options={opt(['friendly', 'professional', 'direct', 'consultative', 'casual'])} /></Field>
                <Field label="Formality"><Select value={d.formality} onChange={(e) => s('formality', e.target.value)} options={opt(['informal', 'neutral', 'formal'])} /></Field>
                <Field label="Sentence complexity"><Select value={d.sentenceComplexity} onChange={(e) => s('sentenceComplexity', e.target.value)} options={opt(['simple', 'moderate', 'advanced'])} /></Field>
                <Field label="Personalization intensity"><Select value={d.personalizationIntensity} onChange={(e) => s('personalizationIntensity', e.target.value)} options={opt(['light', 'medium', 'deep'])} /></Field>
                <Field label="CTA style"><Select value={d.ctaStyle} onChange={(e) => s('ctaStyle', e.target.value)} options={opt(['soft_question', 'interest_check', 'meeting_request', 'resource_offer', 'booking_link'])} /></Field>
                <Field label="Preferred language"><Input value={d.language} onChange={(e) => s('language', e.target.value)} /></Field>
                <Field label="Min words"><Input type="number" value={d.minWords} onChange={(e) => s('minWords', Number(e.target.value))} /></Field>
                <Field label="Max words"><Input type="number" value={d.maxWords} onChange={(e) => s('maxWords', Number(e.target.value))} /></Field>
              </div>
              <Field label="Writing style"><Input value={d.style} onChange={(e) => s('style', e.target.value)} /></Field>
              <div className="grid gap-3 md:grid-cols-2">
                <LinesField label="Words and phrases to avoid" value={d.avoidPhrases} onChange={(v) => s('avoidPhrases', v)} />
                <LinesField label="Claims the AI must never make" value={d.forbiddenClaims} onChange={(v) => s('forbiddenClaims', v)} />
              </div>
              <Field label="Custom instructions — tell the AI exactly how to write" hint={`${(d.customInstructions ?? '').length.toLocaleString()} / 20,000 characters`}>
                <Textarea rows={14} value={d.customInstructions} onChange={(e) => s('customInstructions', e.target.value)} placeholder={'Write emails in a natural and conversational style. Keep them short. Don’t use generic compliments. Don’t sound like an agency salesperson. Start with a relevant observation. Don’t invent facts. Focus on one business opportunity and end with one simple question.'} />
              </Field>
              <div className="grid gap-3 md:grid-cols-2">
                <ExampleList label="Writing examples to follow (style only)" value={d.goodExamples} onChange={(v) => s('goodExamples', v)} />
                <ExampleList label="Examples of unacceptable writing" value={d.badExamples} onChange={(v) => s('badExamples', v)} />
              </div>
              <Notice>Platform rules you cannot override here: no invented facts about prospects or your company, evidence-only personalization, no claims of having read/watched something that was not retrieved, compliance footer and unsubscribe on every email.</Notice>
            </div>
          );
        }}
      </ConfigEditor>
    </>
  );
}

function ExampleList({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <Field label={label} hint="Separate examples with a line containing only ---">
      <Textarea rows={8} defaultValue={value.join('\n---\n')} onChange={(e) => onChange(e.target.value.split(/\n---\n/).map((x) => x.trim()).filter(Boolean))} />
    </Field>
  );
}
