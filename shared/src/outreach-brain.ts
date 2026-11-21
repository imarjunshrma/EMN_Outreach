export const OUTREACH_RULE_CATEGORIES = [
  'PROSPECT_RESEARCH', 'PROSPECT_QUALIFICATION', 'OPPORTUNITY_IDENTIFICATION', 'PERSONALIZATION',
  'EMAIL_OPENING', 'VALUE_PROPOSITION', 'PITCHING', 'CLOSING', 'FOLLOW_UPS', 'DELIVERABILITY_COMPLIANCE',
] as const;
export const OUTREACH_RULE_PRIORITIES = ['MANDATORY', 'PREFERRED', 'AVOID', 'CONDITIONAL'] as const;
export const OUTREACH_EXAMPLE_CATEGORIES = ['EMAIL', 'RESEARCH', 'CONVERSATION'] as const;
export const OUTREACH_EXAMPLE_POLARITIES = ['POSITIVE', 'NEGATIVE'] as const;

export interface OutreachRuleLike {
  id?: string;
  title: string;
  description: string;
  category: string;
  priority: string;
  condition?: string | null;
  status?: string;
  triggerTerms?: string[];
}
export interface OutreachExampleLike {
  id?: string;
  name: string;
  content: string;
  correctedContent?: string | null;
  category: string;
  polarity: string;
  explanation?: string | null;
  tags?: string[];
}

const NEGATION = /\b(never|don't|do not|doesn't|does not|avoid|mustn't|must not|shouldn't|should not|no)\b/i;
const NEGATION_WORDS = new Set(['never', 'don', 'dont', 'doesn', 'doesnt', 'avoid', 'mustn', 'mustnt', 'shouldn', 'shouldnt', 'no', 'not']);
const STOP = new Set('the and for with that this your you our are from about have has was were they their into its it a an of to in on at is by as or be should must do does not never dont avoid emails email prospect customer'.split(' '));
const tokens = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));

/** Conservative conflict warning: identical core instruction with opposite negation in the same category. */
export function findRuleConflicts(rules: OutreachRuleLike[]) {
  const active = rules.filter((r) => r.status !== 'INACTIVE');
  const conflicts: Array<{ first: string; second: string; message: string }> = [];
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
    const a = active[i], b = active[j];
    if (a.category !== b.category || NEGATION.test(`${a.title} ${a.description}`) === NEGATION.test(`${b.title} ${b.description}`)) continue;
    const signature = (r: OutreachRuleLike) => [...new Set(tokens(`${r.title} ${r.description}`).filter((w) => !NEGATION_WORDS.has(w)))].sort().join(' ');
    if (signature(a) && signature(a) === signature(b)) conflicts.push({ first: a.id ?? a.title, second: b.id ?? b.title, message: `These ${a.category.toLowerCase().replaceAll('_', ' ')} rules express the same instruction with opposite direction.` });
  }
  return conflicts;
}

export function renderOutreachRules(rules: OutreachRuleLike[]) {
  const active = rules.filter((r) => r.status !== 'INACTIVE');
  const order = ['MANDATORY', 'AVOID', 'CONDITIONAL', 'PREFERRED'];
  return order.flatMap((priority) => {
    const group = active.filter((r) => r.priority === priority);
    if (!group.length) return [];
    const title = priority === 'MANDATORY' ? 'MANDATORY CUSTOMER RULES' : priority === 'AVOID' ? 'CUSTOMER AVOID RULES' : priority === 'CONDITIONAL' ? 'CONDITIONAL CUSTOMER RULES (apply only when the stated condition is met)' : 'PREFERRED CUSTOMER GUIDANCE';
    return [`${title}:`, ...group.map((r) => `- [${r.category.toLowerCase().replaceAll('_', ' ')}] ${r.title}: ${r.description}${r.condition ? ` (Condition: ${r.condition})` : ''}${r.triggerTerms?.length ? ` [Deterministic trigger terms: ${r.triggerTerms.join(', ')}]` : ''}`)];
  }).join('\n');
}

/** Small deterministic lexical retrieval. Positive and negative examples are kept separate. */
export function retrieveRelevantExamples<T extends OutreachExampleLike>(examples: T[], context: string, limits = { positive: 3, negative: 2 }): T[] {
  const query = new Set(tokens(context));
  const score = (e: T) => {
    const candidate = new Set(tokens(`${e.name} ${e.content} ${e.correctedContent ?? ''} ${e.explanation ?? ''} ${(e.tags ?? []).join(' ')}`));
    if (!query.size || !candidate.size) return 0;
    let overlap = 0;
    for (const word of query) if (candidate.has(word)) overlap++;
    return overlap / Math.sqrt(query.size * candidate.size);
  };
  const selected: Array<{ e: T; score: number }> = [];
  for (const [polarity, limit] of [['POSITIVE', limits.positive], ['NEGATIVE', limits.negative]] as const) {
    selected.push(...examples.filter((e) => e.polarity === polarity).map((e) => ({ e, score: score(e) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit));
  }
  return selected.sort((a, b) => b.score - a.score).map((x) => x.e);
}

export function renderRelevantExamples(examples: OutreachExampleLike[]) {
  if (!examples.length) return '(no relevant customer examples found)';
  return examples.map((e) => {
    const kind = e.polarity === 'NEGATIVE' ? 'NEGATIVE EXAMPLE — do not imitate' : 'POSITIVE EXAMPLE — style/reference only; do not reuse unsupported facts';
    return `- ${kind} (${e.category}): ${e.name}\n<untrusted_content source="customer-example">${e.content.slice(0, 5000)}</untrusted_content>${e.correctedContent ? `\nCorrected version:\n<untrusted_content source="customer-example-correction">${e.correctedContent.slice(0, 5000)}</untrusted_content>` : ''}${e.explanation ? `\nCustomer explanation: ${e.explanation.slice(0, 1000)}` : ''}`;
  }).join('\n\n');
}

export function checkRuleTriggerTerms(rules: OutreachRuleLike[], content: string) {
  const lower = content.toLowerCase();
  return rules.filter((r) => r.status !== 'INACTIVE' && ['AVOID', 'MANDATORY'].includes(r.priority) && r.triggerTerms?.length)
    .flatMap((r) => {
      const found = r.triggerTerms!.filter((term) => lower.includes(term.toLowerCase()));
      return found.length ? [{ id: `customer_rule_${r.id ?? r.title}`, label: `Customer rule: ${r.title}`, status: 'fail' as const, detail: `Blocked trigger term(s): ${found.join(', ')}` }] : [];
    });
}

export interface FeedbackLike { originalContent: unknown; finalContent: unknown; changedFields: string[] }
export interface LearningCandidate { signature: string; title: string; description: string; category: string; sampleCount: number; confidence: number; evidence: string[] }

/** Suggestions require repeated human edits; these are proposals only and never update rules automatically. */
export function deriveLearningCandidates(events: FeedbackLike[], minimumSamples = 3): LearningCandidate[] {
  const patterns = [
    { signature: 'remove-generic-opening', title: 'Avoid generic email openings', category: 'EMAIL_OPENING', description: 'Consider adding a rule to remove generic openers such as “I hope this finds you well” when editing drafts.', regex: /\b(i hope this (finds you well|email finds you)|hope you're doing well|i came across your profile)\b/i },
    { signature: 'shorten-long-drafts', title: 'Prefer shorter email drafts', category: 'PITCHING', description: 'Consider setting a shorter target length. Several edits substantially shortened the generated email.', regex: null },
    { signature: 'remove-early-meeting-ask', title: 'Avoid early meeting requests', category: 'CLOSING', description: 'Consider avoiding direct meeting requests in first-touch emails; edits repeatedly removed them.', regex: /\b(schedule|book|set up|jump on)\b.{0,35}\b(call|meeting|chat)\b/i },
  ];
  return patterns.flatMap((pattern) => {
    const matched: string[] = [];
    for (const ev of events) {
      if (!ev.changedFields.some((f) => ['subject', 'openingLine', 'body', 'cta'].includes(f))) continue;
      const before = ev.originalContent as Record<string, unknown> | null;
      const after = ev.finalContent as Record<string, unknown> | null;
      const original = `${before?.openingLine ?? ''} ${before?.body ?? ''}`;
      const final = `${after?.openingLine ?? ''} ${after?.body ?? ''}`;
      const changed = pattern.regex ? pattern.regex.test(original) && !pattern.regex.test(final) : tokens(original).length >= 30 && tokens(final).length <= tokens(original).length * 0.75;
      if (changed) matched.push(ev.changedFields.join(','));
    }
    if (matched.length < minimumSamples) return [];
    return [{ signature: pattern.signature, title: pattern.title, description: pattern.description, category: pattern.category, sampleCount: matched.length, confidence: Math.min(0.95, 0.5 + matched.length / Math.max(events.length, 1) * 0.45), evidence: matched.slice(0, 10) }];
  });
}
