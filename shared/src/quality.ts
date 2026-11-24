// Deterministic personalization quality checks. These run on every generated or edited email
// before it can be approved. Accuracy is judged by the evidence rules + independent fact-check;
// the personalization score below measures SPECIFICITY, not truth.

import type { Writing } from './ai-studio.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';
/** Bump this when deterministic pass/fail quality policy changes materially. */
export const QUALITY_POLICY_VERSION = 2;
export interface QualityCheck { id: string; label: string; status: CheckStatus; detail: string }
export interface ScoreFactor { factor: string; points: number; max: number; note: string }
export interface QualityReport {
  policyVersion: number;
  checks: QualityCheck[];
  passed: boolean;
  score: number;
  scoreExplanation: ScoreFactor[];
  scoreDisclaimer: string;
  wordCount: number;
}

export interface FactCheckSentence { text: string; verdict: 'SUPPORTED' | 'GENERIC' | 'UNSUPPORTED'; claimId: string | null; reason: string }

export interface QualityInput {
  subject: string | null;
  openingLine: string | null;
  body: string;
  stepOrder: number;
  newThread: boolean;
  writing: Writing;
  usedClaims: Array<{ id: string; text: string }>;
  invalidClaimIds: string[];
  availableClaimCount: number;
  previousEmails: Array<{ stepOrder: number; subject: string | null; openingLine: string | null; body: string }>;
  otherLeadOpenings: string[];
  factCheck: FactCheckSentence[] | null;
  factCheckRequired: boolean;
  postalAddressConfigured: boolean;
  insufficientContext?: boolean;
}

export const GENERIC_OPENERS: RegExp[] = [
  /^i hope (this|you|all)/i, /^hope (you|this|all)/i, /^i came across/i, /^i was (impressed|amazed|browsing|looking)/i,
  /^my name is/i, /^i('m| am) reaching out/i, /^i wanted to reach out/i, /^i noticed you('re| are) (a|the)/i,
  /^just wanted to/i, /^quick question/i, /^i love(d)? your (company|website|work)\b/i, /^greetings/i,
  /^as a (fellow|leading)/i, /^congrat(s|ulations) on your (success|great work)/i,
];

const SPAMMY = [/\bfree!+/i, /\bguarantee(d)?\b/i, /\b100% (free|guaranteed)\b/i, /\bact now\b/i, /\brisk[- ]free\b/i, /\bno obligation\b/i, /\$\$\$/, /\bclick here\b/i, /\bwinner\b/i];

export function words(s: string) { return (s.toLowerCase().match(/[a-z0-9']+/g) ?? []); }

function trigrams(s: string): Set<string> {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}

export function similarity(a: string, b: string): number {
  const A = trigrams(a); const B = trigrams(b);
  if (!A.size || !B.size) return a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim() ? 1 : 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'your', 'you', 'our', 'are', 'from', 'about', 'have', 'has', 'was', 'were', 'they', 'their', 'into', 'its', 'it', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'is', 'by', 'as', 'or', 'be']);
function contentWords(s: string) { return words(s).filter((w) => w.length > 3 && !STOP.has(w)); }

export function firstSentence(text: string) {
  const t = text.trim().replace(/^(hi|hello|hey|dear)\b[^\n,]*[,!]?\s*/i, '').trim();
  const m = t.match(/^[^.!?\n]+[.!?]?/);
  return (m ? m[0] : t).trim();
}

export function runQualityChecks(q: QualityInput): QualityReport {
  const checks: QualityCheck[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string) => checks.push({ id, label, status, detail });
  const full = `${q.subject ?? ''}\n${q.body}`;
  const lower = full.toLowerCase();
  const wc = words(q.body).length;
  const opening = (q.openingLine?.trim() || firstSentence(q.body));

  // 1. Missing variables / placeholders
  const unresolved = [...full.matchAll(/\{\{[^}]+\}\}|\[(?:first ?name|company|name|your company|insert[^\]]*)\]/gi)].map((m) => m[0]);
  add('missing_variables', 'Missing-variable check', unresolved.length ? 'fail' : 'pass', unresolved.length ? `Unresolved placeholders: ${[...new Set(unresolved)].join(', ')}` : 'No unresolved placeholders');

  // 2. Factual accuracy / unsupported claims (independent fact-check)
  if (!q.factCheck) {
    add('fact_check', 'Factual accuracy (independent fact-check)', q.factCheckRequired ? 'fail' : 'warn', q.factCheckRequired ? 'Fact-check did not run; it is required before approval' : 'Fact-check not run');
  } else {
    const bad = q.factCheck.filter((s) => s.verdict === 'UNSUPPORTED');
    add('fact_check', 'Factual accuracy (independent fact-check)', bad.length ? 'fail' : 'pass', bad.length ? `Unsupported statements: ${bad.map((b) => `"${b.text}" (${b.reason})`).join('; ')}` : `${q.factCheck.length} sentence(s) checked; none unsupported`);
  }

  // 3. Evidence validation
  if (q.invalidClaimIds.length) add('evidence', 'Evidence validation', 'fail', `The writer cited ${q.invalidClaimIds.length} claim id(s) that are not evidence-backed for this lead; they were ignored`);
  else if (q.usedClaims.length) add('evidence', 'Evidence validation', 'pass', `${q.usedClaims.length} evidence-backed claim(s) used`);
  else if (q.availableClaimCount === 0) add('evidence', 'Evidence validation', 'fail', 'No research evidence was available; personalized campaign email is not sendable');
  else add('evidence', 'Evidence validation', 'fail', 'Research was available but the email does not use an evidence-backed claim');

  // 4. Unsupported-claim detection: forbidden claims list
  const forbidden = q.writing.forbiddenClaims.filter((c) => lower.includes(c.toLowerCase()));
  add('forbidden_claims', 'Unsupported-claim detection (forbidden claims)', forbidden.length ? 'fail' : 'pass', forbidden.length ? `Contains forbidden claim(s): ${forbidden.join(', ')}` : 'No forbidden claims');

  // 5. Generic opening
  const generic = GENERIC_OPENERS.find((r) => r.test(opening));
  const openingOverlap = q.usedClaims.some((c) => { const cw = new Set(contentWords(c.text)); return contentWords(opening).filter((w) => cw.has(w)).length >= 2; });
  if (generic) add('generic_opening', 'Generic-opening detection', 'fail', `Opening "${opening.slice(0, 80)}" is a generic opener`);
  else if (!openingOverlap && q.stepOrder === 1) add('generic_opening', 'Generic-opening detection', 'fail', 'The opening line does not reference the evidence-backed observation');
  else add('generic_opening', 'Generic-opening detection', 'pass', 'Opening is specific');

  // 6. Repetition (previous steps + other leads)
  const reps: string[] = [];
  let repFail = false;
  for (const p of q.previousEmails) {
    const pOpen = p.openingLine?.trim() || firstSentence(p.body);
    if (pOpen && similarity(pOpen, opening) >= 0.6) { reps.push(`opening repeats step ${p.stepOrder}`); repFail = true; }
    const s = similarity(p.body, q.body);
    if (s >= 0.5) { reps.push(`body is ${Math.round(s * 100)}% similar to step ${p.stepOrder}`); repFail = true; }
  }
  const twins = q.otherLeadOpenings.filter((o) => similarity(o, opening) >= 0.8).length;
  if (twins) reps.push(`opening is nearly identical to ${twins} other lead(s) in this campaign`);
  add('repetition', 'Repetition detection', repFail ? 'fail' : twins ? 'warn' : 'pass', reps.length ? reps.join('; ') : 'No repetition with earlier steps or other leads');

  // 7. Tone compliance
  const avoid = q.writing.avoidPhrases.filter((p) => lower.includes(p.toLowerCase()));
  const toneIssues: string[] = [];
  const excl = (q.body.match(/!/g) ?? []).length;
  if (excl > (q.writing.tone === 'casual' ? 2 : 1)) toneIssues.push(`${excl} exclamation marks`);
  const shouting = (q.body.match(/\b[A-Z]{5,}\b/g) ?? []).length;
  if (shouting) toneIssues.push(`${shouting} all-caps word(s)`);
  if (q.writing.formality === 'formal' && /\b(hey|gonna|wanna|yeah)\b/i.test(q.body)) toneIssues.push('informal words in a formal email');
  add('tone', 'Tone compliance', avoid.length ? 'fail' : toneIssues.length ? 'warn' : 'pass', avoid.length ? `Uses phrases to avoid: ${avoid.join(', ')}` : toneIssues.length ? toneIssues.join('; ') : `Matches ${q.writing.tone}/${q.writing.formality} settings`);

  // 8. Length
  const { minWords, maxWords } = q.writing;
  const lenStatus: CheckStatus = wc > maxWords * 1.5 || wc < Math.max(8, minWords * 0.5) ? 'fail' : wc > maxWords || wc < minWords ? 'warn' : 'pass';
  add('length', 'Length check', lenStatus, `${wc} words (target ${minWords}–${maxWords})`);

  // 9. CTA
  const questions = (q.body.match(/\?/g) ?? []).length;
  const ctaIssues: string[] = [];
  if (q.writing.ctaStyle === 'soft_question' || q.writing.ctaStyle === 'interest_check') { if (questions === 0) ctaIssues.push('no question to respond to'); }
  if (q.writing.ctaStyle === 'meeting_request' && !/\b(call|chat|meeting|meet|talk|minutes)\b/i.test(q.body)) ctaIssues.push('no meeting request');
  if (q.writing.ctaStyle === 'booking_link' && !/(https?:\/\/|\{\{bookingLink)/i.test(q.body)) ctaIssues.push('no booking link');
  if (questions > 2) ctaIssues.push(`${questions} questions — more than one ask`);
  add('cta', 'CTA check', ctaIssues.length ? 'fail' : 'pass', ctaIssues.length ? ctaIssues.join('; ') : `CTA matches "${q.writing.ctaStyle.replace(/_/g, ' ')}"`);

  // 10. Unsubscribe / compliance
  const comp: string[] = [];
  let compFail = false;
  if (q.newThread && q.stepOrder === 1 && /^\s*(re|fw|fwd)\s*:/i.test(q.subject ?? '')) { comp.push('first email subject pretends to be a reply/forward'); compFail = true; }
  if (!q.postalAddressConfigured) { comp.push('workspace postal address missing (required in the footer)'); compFail = true; }
  const spam = SPAMMY.filter((r) => r.test(full)).map((r) => r.source);
  if (spam.length) comp.push(`spam-trigger wording: ${spam.join(', ')}`);
  if ((q.subject ?? '').length > 90) comp.push('subject longer than 90 characters');
  add('compliance', 'Unsubscribe/compliance check', compFail ? 'fail' : comp.length ? 'warn' : 'pass', comp.length ? comp.join('; ') : 'Footer with sender address and one-click unsubscribe is appended automatically at send time');

  if (q.insufficientContext) add('context', 'Context availability', 'fail', 'The writer reported insufficient context; the email is not sendable');

  // Personalization score (heuristic, explained)
  const uniqueVsBatch = twins === 0;
  const factors: ScoreFactor[] = [
    { factor: 'Evidence-backed specifics', max: 35, points: q.usedClaims.length >= 2 ? 35 : q.usedClaims.length === 1 ? 25 : 0, note: `${q.usedClaims.length} verified claim(s) used` },
    { factor: 'Opening tied to evidence', max: 20, points: openingOverlap ? 20 : 0, note: openingOverlap ? 'Opening references a researched observation' : 'Opening does not reference research' },
    { factor: 'Not a generic opener', max: 15, points: generic ? 0 : 15, note: generic ? 'Generic opener detected' : 'Opening is not a stock phrase' },
    { factor: 'Unique across recipients', max: 15, points: uniqueVsBatch ? 15 : 0, note: uniqueVsBatch ? 'Different from other leads' : 'Near-duplicate of other leads' },
    { factor: 'No repetition of earlier steps', max: 10, points: repFail ? 0 : 10, note: repFail ? 'Repeats an earlier step' : 'New angle' },
    { factor: 'Clear single call to action', max: 5, points: ctaIssues.length ? 0 : 5, note: ctaIssues.length ? ctaIssues.join('; ') : 'One clear ask' },
  ];
  const score = factors.reduce((s, f) => s + f.points, 0);
  add('specificity_score', 'Personalization specificity threshold', score < 60 ? 'fail' : 'pass', `Specificity score ${score}/100 (minimum 60)`);
  return {
    policyVersion: QUALITY_POLICY_VERSION,
    checks,
    passed: !checks.some((c) => c.status === 'fail'),
    score,
    scoreExplanation: factors,
    scoreDisclaimer: 'Heuristic score of how specific and non-repetitive the email is. It is not proof of accuracy — accuracy comes from the evidence rules and the independent fact-check above.',
    wordCount: wc,
  };
}
