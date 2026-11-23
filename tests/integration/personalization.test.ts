import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import { sha256 } from '../../backend/src/core/crypto.js';
import * as engine from '../../backend/src/services/engine.js';
import * as studio from '../../backend/src/services/ai-studio.js';
import * as pz from '../../backend/src/services/personalization.js';
import { resetDb, installFakes, createUserSession, addMailbox, addLead, addAiProvider, MONDAY_10_UTC, type Session } from '../helpers/harness.js';
import type { FakeAi } from '../helpers/fakes.js';
import type { StructuredRequest } from '../../integrations/src/ai/types.js';

let fakes: ReturnType<typeof installFakes>;
let ai: FakeAi;
beforeEach(async () => { await resetDb(); fakes = installFakes(); ai = fakes.anthropic as FakeAi; });

const ALWAYS = { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' };
const ACTOR = { type: 'SYSTEM' as const };

/** Claims the writer received, parsed from the prompt: "- [id] (category) text". */
function claimsIn(req: StructuredRequest) {
  const block = req.user.split('EVIDENCE-BACKED CLAIMS')[1]?.split('PREVIOUS EMAILS')[0] ?? '';
  return [...block.matchAll(/- \[([0-9a-f-]{36})\] \([a-z_]+\) ([^\n]+)/g)].map((m) => ({ id: m[1], text: m[2].trim() }));
}

/** A deterministic "writer": uses the first evidence-backed claim, honest fallback when there is none. */
function honestWriter(extra: (req: StructuredRequest) => Partial<Record<string, unknown>> = () => ({})) {
  return (req: StructuredRequest) => {
    const c = claimsIn(req)[0];
    const follow = /This is step ([2-9])/.exec(req.user);
    const opening = c ? `Saw that ${c.text.replace(/\.$/, '')}.` : 'I run a small growth studio for consulting firms.';
    const body = follow
      ? `Hi there,\n\nOne different angle since my last note: many firms turn existing client questions into weekly short videos that bring in enquiries. Would a two-line outline for your team be useful?`
      : `Hi there,\n\n${opening} We help teams like yours turn that into a steady flow of qualified enquiries with short-form content and distribution. Worth a quick look at how it could work for you?`;
    return { subject: follow ? null : c ? `About ${c.text.split(' ').slice(0, 3).join(' ')}` : 'Quick question', subjectAlternatives: ['Idea for you'], openingLine: follow ? 'One different angle since my last note.' : opening, body, cta: 'Worth a quick look?', usedClaimIds: c ? [c.id] : [], personalizationBasis: c ? c.text : 'none', insufficientContext: !c, ...extra(req) };
  };
}

/** Fact-checker: a sentence is SUPPORTED if it contains a claim text, UNSUPPORTED if it contains a marker of invention. */
function factChecker(req: StructuredRequest) {
  const email = req.user.split('</untrusted_content>')[0];
  const claims = [...req.user.matchAll(/- \[([0-9a-f-]{36})\] ([^\n(]+)/g)].map((m) => ({ id: m[1], text: m[2].trim() }));
  const sentences = email.split(/(?<=[.?!])\s+/).filter((s) => s.trim().length > 3).map((text) => {
    if (/Series B|award|raised \$/.test(text)) return { text, verdict: 'UNSUPPORTED', claimId: null, reason: 'not in evidence' };
    const c = claims.find((x) => text.toLowerCase().includes(x.text.toLowerCase().replace(/\.$/, '').slice(0, 30)));
    return c ? { text, verdict: 'SUPPORTED', claimId: c.id, reason: 'matches claim' } : { text, verdict: 'GENERIC', claimId: null, reason: 'generic' };
  });
  return { sentences };
}

async function addResearch(workspaceId: string, leadId: string, facts: string[]) {
  const report = await db().researchReport.create({ data: { workspaceId, leadId, status: 'COMPLETED', completedAt: new Date(), summary: facts.join(' ') } });
  const content = facts.join(' ');
  const ev = await db().researchEvidence.create({ data: { workspaceId, reportId: report.id, sourceType: 'WEBSITE', url: `https://example.com/${leadId.slice(0, 6)}`, content, contentHash: sha256(content) } });
  for (const f of facts) await db().researchClaim.create({ data: { workspaceId, reportId: report.id, evidenceId: ev.id, category: 'signal', text: f, quote: f, confidence: 0.9 } });
  return report;
}

async function setup(s: Session, opts: { leads?: Array<{ email: string; facts: string[] }>; steps?: unknown[]; settings?: Record<string, unknown> } = {}) {
  await addAiProvider(s.workspaceId);
  await db().aiModelPrice.create({ data: { provider: 'ANTHROPIC', model: 'claude-haiku-5-5', inputPerMTokUsd: 1, outputPerMTokUsd: 5 } }).catch(() => undefined);
  const mailbox = await addMailbox(s.workspaceId);
  const list = await db().leadList.create({ data: { workspaceId: s.workspaceId, name: 'Founders' } });
  const leads = [];
  for (const l of opts.leads ?? [{ email: 'asha@studio-a.com', facts: ['Studio A launched a weekly podcast on hiring designers.'] }]) {
    const lead = await addLead(s.workspaceId, l.email, { firstName: l.email.split('@')[0], timezone: 'UTC', title: 'Founder' });
    await db().leadListMember.create({ data: { workspaceId: s.workspaceId, listId: list.id, leadId: lead.id } });
    if (l.facts.length) await addResearch(s.workspaceId, lead.id, l.facts);
    leads.push(lead);
  }
  const c = await engine.createCampaign(s.workspaceId, engine.CampaignSettingsSchema.parse({ name: 'Consulting founders', sendingWindow: ALWAYS, reviewMode: 'AI_CONTENT_ONLY', ...(opts.settings ?? {}) }), ACTOR);
  await engine.saveSequence(s.workspaceId, c.id, engine.SequenceSchema.parse({ steps: opts.steps ?? [
    { delayDays: 0, personalizationMode: 'AI_FULL', aiInstructions: 'Personal introduction.', variants: [{ label: 'A', subject: 'Idea', body: 'Hi {{firstName}}, short intro.' }] },
    { delayDays: 3, personalizationMode: 'AI_FULL', threadMode: 'REPLY_IN_THREAD', aiInstructions: 'Different business angle.', variants: [{ label: 'A', subject: '', body: 'Follow-up.' }] },
  ] }), ACTOR);
  await engine.setCampaignLists(s.workspaceId, c.id, [list.id], ACTOR);
  await engine.setCampaignAccounts(s.workspaceId, c.id, [mailbox.id], ACTOR);
  const full = await engine.getCampaign(s.workspaceId, c.id);
  return { campaignId: c.id, steps: full.sequence!.steps, leads, list, mailbox };
}

const personalizationCalls = () => ai.calls.filter((c) => c.schemaName === 'personalization');

describe('AI personalization engine', () => {
  it('1. gives two leads genuinely different emails built from their own research', async () => {
    const s = await createUserSession('owner@x.com');
    ai.on('PERSONALIZATION', honestWriter()).on('FACT_CHECK', factChecker);
    const { campaignId, steps, leads } = await setup(s, { leads: [
      { email: 'asha@studio-a.com', facts: ['Studio A launched a weekly podcast on hiring designers.'] },
      { email: 'ben@ledger-b.com', facts: ['Ledger B opened a second office in Austin for tax advisory.'] },
    ] });
    const a = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id);
    const b = await pz.generateForLead(s.workspaceId, campaignId, leads[1].id, steps[0].id);
    expect(a.status).toBe('GENERATED');
    expect(b.status).toBe('GENERATED');
    const [pa, pb] = await Promise.all([db().leadPersonalization.findUniqueOrThrow({ where: { id: a.id! } }), db().leadPersonalization.findUniqueOrThrow({ where: { id: b.id! } })]);
    expect(pa.body).toMatch(/weekly podcast/);
    expect(pb.body).toMatch(/Austin/);
    expect(pa.body).not.toEqual(pb.body);
    expect(pa.subject).not.toEqual(pb.subject);
    expect(pa.usedClaimIds).toHaveLength(1);
    // Each prompt contained only that lead's evidence
    const [ca, cb] = personalizationCalls();
    expect(ca.user).toMatch(/weekly podcast/); expect(ca.user).not.toMatch(/Austin/);
    expect(cb.user).toMatch(/Austin/); expect(cb.user).not.toMatch(/weekly podcast/);
    // Evidence is stored against the lead with source URL + retrieval timestamp
    const review = await pz.leadReview(s.workspaceId, campaignId, leads[0].id);
    expect(review.research.claims[0].url).toMatch(/^https:\/\/example.com\//);
    expect(review.research.claims[0].fetchedAt).toBeInstanceOf(Date);
    expect(pa.score).toBeGreaterThanOrEqual(60);
    expect(Number(pa.costUsd)).toBeGreaterThan(0);
  });

  it('2+3. applies workspace instructions and lets campaign settings override them (restrictions accumulate)', async () => {
    const s = await createUserSession('owner@x.com');
    ai.on('PERSONALIZATION', honestWriter()).on('FACT_CHECK', factChecker);
    await studio.saveConfig(s.workspaceId, 'WRITING', { tone: 'professional', formality: 'formal', customInstructions: 'WORKSPACE-RULE: never sound like an agency salesperson.', avoidPhrases: ['circle back'] }, 'v', ACTOR);
    const { campaignId, steps, leads } = await setup(s);
    await engine.updateCampaignAi(s.workspaceId, campaignId, { aiOverrides: { writing: { tone: 'casual', avoidPhrases: ['touch base'] }, research: {}, audienceContext: 'Consulting founders', offerContext: '', customInstructions: 'CAMPAIGN-RULE: focus on qualified consulting enquiries.', aiSource: 'workspace' } }, ACTOR);
    const prev = await pz.promptPreview(s.workspaceId, campaignId, leads[0].id, steps[0].id);
    expect(prev.resolved.writing.tone).toBe('casual');
    expect(prev.resolved.writingSources.tone).toBe('campaign');
    expect(prev.resolved.writing.formality).toBe('formal'); // not overridden → workspace value kept
    expect(prev.resolved.writing.avoidPhrases).toEqual(expect.arrayContaining(['circle back', 'touch base']));
    await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id);
    const prompt = personalizationCalls()[0].user;
    expect(prompt).toMatch(/WORKSPACE-RULE/);
    expect(prompt).toMatch(/CAMPAIGN-RULE/);
    expect(prompt.indexOf('WORKSPACE-RULE')).toBeLessThan(prompt.indexOf('CAMPAIGN-RULE')); // more specific comes later and wins
    expect(prompt.indexOf('CAMPAIGN-RULE')).toBeLessThan(prompt.indexOf('Personal introduction.')); // step instructions are most specific
    expect(prompt).toMatch(/Tone: casual/);
    expect(prompt).toMatch(/"circle back"/);
    // Workspace avoid-phrase is enforced by quality control even when the campaign overrides the tone
    ai.on('PERSONALIZATION', honestWriter(() => ({ body: 'Hi there,\n\nSaw that Studio A launched a weekly podcast on hiring designers. Let me circle back with an idea that could bring in enquiries. Open to it?' })));
    const r = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id, { force: true });
    expect(r.status).toBe('BLOCKED');
  });

  it('4. follow-ups see the earlier email, research and campaign instructions, and must not repeat the opening', async () => {
    const s = await createUserSession('owner@x.com');
    ai.on('PERSONALIZATION', honestWriter()).on('FACT_CHECK', factChecker);
    const { campaignId, steps, leads } = await setup(s);
    await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id);
    const r2 = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[1].id);
    expect(r2.status).toBe('GENERATED');
    const followPrompt = personalizationCalls()[1].user;
    expect(followPrompt).toMatch(/This is step 2 of 2/);
    expect(followPrompt).toMatch(/--- Step 1/);                       // the original email
    expect(followPrompt).toMatch(/Saw that Studio A launched a weekly podcast/);
    expect(followPrompt).toMatch(/Different business angle\./);       // step instructions
    expect(followPrompt).toMatch(/weekly podcast on hiring designers/);  // research still available
    const fu = await db().leadPersonalization.findFirstOrThrow({ where: { stepId: steps[1].id } });
    expect(fu.subject).toBeNull(); // replies in thread
    // A follow-up that repeats the first email is rejected
    ai.on('PERSONALIZATION', honestWriter(() => ({ openingLine: 'Saw that Studio A launched a weekly podcast on hiring designers.', body: 'Hi there,\n\nSaw that Studio A launched a weekly podcast on hiring designers. We help teams like yours turn that into a steady flow of qualified enquiries with short-form content and distribution. Worth a quick look at how it could work for you?' })));
    const rep = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[1].id, { force: true });
    expect(rep.status).toBe('BLOCKED');
    const q = (await db().leadPersonalization.findFirstOrThrow({ where: { stepId: steps[1].id } })).quality as { checks: Array<{ id: string; status: string }> };
    expect(q.checks.find((c) => c.id === 'repetition')?.status).toBe('fail');
  });

  it('4b. never generates follow-ups after a reply, opt-out or other stop condition', async () => {
    const s = await createUserSession('owner@x.com');
    ai.on('PERSONALIZATION', honestWriter()).on('FACT_CHECK', factChecker);
    const { campaignId, steps, leads } = await setup(s);
    await db().lead.update({ where: { id: leads[0].id }, data: { status: 'REPLIED' } });
    const r = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[1].id);
    expect(r.status).toBe('SKIPPED');
    expect(personalizationCalls()).toHaveLength(0);
  });

  it('5. rejects unsupported claims: blocked and cannot be approved until edited', async () => {
    const s = await createUserSession('owner@x.com');
    ai.on('PERSONALIZATION', honestWriter(() => ({ body: 'Hi there,\n\nCongrats on closing your Series B last month. We help funded studios turn growth into qualified enquiries. Open to a quick idea?' }))).on('FACT_CHECK', factChecker);
    const { campaignId, steps, leads } = await setup(s);
    const r = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id);
    expect(r.status).toBe('BLOCKED');
    await expect(pz.approvePersonalizations(s.workspaceId, [r.id!], ACTOR)).rejects.toMatchObject({ code: 'QUALITY_CHECK_FAILED' });
    const edited = await pz.editPersonalization(s.workspaceId, r.id!, { body: 'Hi there,\n\nSaw that Studio A launched a weekly podcast on hiring designers. We help teams turn that kind of content into qualified enquiries. Open to a quick idea?', rerunFactCheck: true, feedbackScope: 'CAMPAIGN' }, ACTOR);
    expect(edited.status).toBe('GENERATED');
    expect((await pz.approvePersonalizations(s.workspaceId, [r.id!], ACTOR)).approved).toBe(1);
  });

  it('6. missing research never produces fabricated personalization', async () => {
    const s = await createUserSession('owner@x.com');
    ai.on('PERSONALIZATION', honestWriter()).on('FACT_CHECK', factChecker);
    const { campaignId, steps, leads } = await setup(s, { leads: [{ email: 'noresearch@x-co.com', facts: [] }] });
    // Default rule: hold for research — no AI call at all
    const held = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id);
    expect(held.status).toBe('NEEDS_RESEARCH');
    expect(personalizationCalls()).toHaveLength(0);
    // Rule switched to "role and company only": the prompt says so and the email states no prospect facts
    await studio.saveConfig(s.workspaceId, 'RESEARCH', { onMissing: 'use_role_and_company_only' }, 'v', ACTOR);
    const r = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id);
    expect(personalizationCalls()[0].user).toMatch(/NO EVIDENCE-BACKED CLAIMS AVAILABLE/);
    expect(personalizationCalls()[0].user).toMatch(/No research is available|NO EVIDENCE/);
    const p = await db().leadPersonalization.findUniqueOrThrow({ where: { id: r.id! } });
    expect(p.usedClaimIds).toEqual([]);
    // If the writer invents a fact anyway, the fact-check blocks it
    ai.on('PERSONALIZATION', honestWriter(() => ({ body: 'Hi there,\n\nI saw your recent award for best consultancy. We help firms like yours win more clients. Open to an idea?' })));
    const bad = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id, { force: true });
    expect(bad.status).toBe('BLOCKED');
  });

  it('7. preserves manual edits across bulk regeneration', async () => {
    const s = await createUserSession('owner@x.com');
    ai.on('PERSONALIZATION', honestWriter()).on('FACT_CHECK', factChecker);
    const { campaignId, steps, leads } = await setup(s);
    const r = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id);
    const mine = 'Hi Asha,\n\nSaw that Studio A launched a weekly podcast on hiring designers — clever way to reach candidates. We turn shows like that into steady enquiries. Want the two-line outline?';
    await pz.editPersonalization(s.workspaceId, r.id!, { body: mine, rerunFactCheck: true, feedbackScope: 'CAMPAIGN' }, ACTOR);
    const callsBefore = personalizationCalls().length;
    // Non-forced generation and bulk planning both skip the edited row
    expect((await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id)).preserved).toMatch(/manually edited/);
    const est = await pz.estimateBatch(s.workspaceId, campaignId, { stepIds: [steps[0].id], force: false, onlyMissing: false });
    expect(est.generations).toBe(0);
    expect(est.preserved).toBe(1);
    expect(personalizationCalls().length).toBe(callsBefore);
    const p = await db().leadPersonalization.findUniqueOrThrow({ where: { id: r.id! }, include: { revisions: true } });
    expect(p.body).toBe(mine);
    expect(p.manuallyEdited).toBe(true);
    expect(p.revisions.map((x) => x.source).sort()).toEqual(['AI', 'MANUAL']);
  });

  it('8. prompt and setting changes never silently rewrite an approved campaign', async () => {
    const s = await createUserSession('owner@x.com');
    ai.on('PERSONALIZATION', honestWriter()).on('FACT_CHECK', factChecker);
    const profile = await studio.createProfile(s.workspaceId, { name: 'Founder intro', instructions: 'PROFILE-V1: write about one observation. End with one question.', settings: {} }, ACTOR);
    const { campaignId, steps, leads } = await setup(s, { leads: [
      { email: 'asha@studio-a.com', facts: ['Studio A launched a weekly podcast on hiring designers.'] },
      { email: 'ben@ledger-b.com', facts: ['Ledger B opened a second office in Austin for tax advisory.'] },
    ] });
    await engine.updateCampaignAi(s.workspaceId, campaignId, { aiProfileId: profile.id }, ACTOR);
    const r = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id);
    await pz.approvePersonalizations(s.workspaceId, [r.id!], ACTOR);
    const approvedBody = (await db().leadPersonalization.findUniqueOrThrow({ where: { id: r.id! } })).body;
    await engine.submitCampaign(s.workspaceId, campaignId, ACTOR);
    await engine.approveCampaign(s.workspaceId, campaignId, ACTOR);
    // Change the profile and the workspace writing rules after approval
    await studio.createProfileVersion(s.workspaceId, profile.id, { instructions: 'PROFILE-V2: completely different.', settings: {}, activate: true }, ACTOR);
    await studio.saveConfig(s.workspaceId, 'WRITING', { customInstructions: 'NEW-WORKSPACE-RULE' }, 'later', ACTOR);
    // The campaign is still approved (its hash did not change) and the approved email is untouched
    const camp = await db().campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(camp.status).toBe('APPROVED');
    expect(engine.contentHash(await engine.getCampaign(s.workspaceId, campaignId))).toBe(camp.approvedContentHash);
    expect((await db().leadPersonalization.findUniqueOrThrow({ where: { id: r.id! } })).body).toBe(approvedBody);
    expect((await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id)).preserved).toMatch(/approved/);
    // New generations for this approved campaign use the frozen snapshot, not the edited prompt
    await pz.generateForLead(s.workspaceId, campaignId, leads[1].id, steps[0].id);
    const last = personalizationCalls().at(-1)!.user;
    expect(last).toMatch(/PROFILE-V1/);
    expect(last).not.toMatch(/PROFILE-V2|NEW-WORKSPACE-RULE/);
    expect((await engine.listVersions(s.workspaceId, campaignId))).toHaveLength(1);
  });

  it('9. AI failures never send and never duplicate; recovery sends exactly once', async () => {
    const s = await createUserSession('owner@x.com');
    ai.on('FACT_CHECK', factChecker);
    ai.on('PERSONALIZATION', () => { throw new Error('model overloaded'); });
    const { campaignId, steps, leads } = await setup(s, { settings: { reviewMode: 'NONE' }, steps: [{ delayDays: 0, personalizationMode: 'AI_FULL', variants: [{ label: 'A', subject: 'Idea', body: 'Hi' }] }] });
    await engine.submitCampaign(s.workspaceId, campaignId, ACTOR);
    await engine.approveCampaign(s.workspaceId, campaignId, ACTOR);
    await engine.startCampaign(s.workspaceId, campaignId, ACTOR);
    await engine.tick(MONDAY_10_UTC);
    const o = await db().outboundEmail.findFirstOrThrow({ where: { campaignId } });
    expect((await engine.prepareOutbound(s.workspaceId, o.id)) as { status?: string }).toMatchObject({ status: 'AWAITING_PERSONALIZATION' });
    // The generation job runs and fails: nothing is sent
    const failed = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id);
    expect(failed.status).toBe('FAILED');
    expect(await engine.sendOutbound(s.workspaceId, o.id, MONDAY_10_UTC)).toMatchObject({ outcome: 'skipped' });
    expect(fakes.gmail.sent).toHaveLength(0);
    // Re-running prepare and the scheduler does not create a second email
    await engine.prepareOutbound(s.workspaceId, o.id);
    await engine.tick(new Date(MONDAY_10_UTC.getTime() + 60_000));
    expect(await db().outboundEmail.count({ where: { campaignId } })).toBe(1);
    // Retry succeeds; reviewMode NONE + passing checks → auto-approved → released → sent once
    ai.on('PERSONALIZATION', honestWriter());
    const ok = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id);
    expect(ok.status).toBe('APPROVED');
    expect((await db().outboundEmail.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('PENDING');
    await engine.prepareOutbound(s.workspaceId, o.id);
    expect((await engine.sendOutbound(s.workspaceId, o.id, MONDAY_10_UTC)).outcome).toBe('sent');
    expect((await engine.sendOutbound(s.workspaceId, o.id, MONDAY_10_UTC)).outcome).not.toBe('sent');
    expect(fakes.gmail.sent).toHaveLength(1);
    expect(fakes.gmail.sent[0].text).toMatch(/weekly podcast/);
    expect(fakes.gmail.sent[0].text).toMatch(/unsubscribe/i);
  });

  it('10. enforces per-lead cost limits, workspace monthly budget and batch cost caps', async () => {
    const s = await createUserSession('owner@x.com');
    ai.on('PERSONALIZATION', honestWriter()).on('FACT_CHECK', factChecker);
    const { campaignId, steps, leads } = await setup(s, { leads: [
      { email: 'asha@studio-a.com', facts: ['Studio A launched a weekly podcast on hiring designers.'] },
      { email: 'ben@ledger-b.com', facts: ['Ledger B opened a second office in Austin for tax advisory.'] },
      { email: 'cara@firm-c.com', facts: ['Firm C publishes a monthly newsletter on pricing strategy.'] },
    ] });
    // Each fake call really costs 1000 in × $1/M + 200 out × $5/M = $0.002, but the guard checks
    // spent + an UPPER-BOUND estimate (full output budget) before every call. Set the limit just above
    // one generation's estimate so the first email fits and the second does not.
    const { estimateCallCost } = await import('../../backend/src/services/ai.js');
    const pv = await pz.promptPreview(s.workspaceId, campaignId, leads[0].id, steps[0].id);
    const est1 = await estimateCallCost(s.workspaceId, 'PERSONALIZATION', JSON.stringify(pv.prompt).length + 4000, 1500);
    await engine.updateCampaignAi(s.workspaceId, campaignId, { maxAiCostPerLeadUsd: Number((est1.usd + 0.002).toFixed(4)) }, ACTOR);
    const first = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id);
    expect(first.status).toBe('GENERATED');
    const second = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[1].id);
    expect(second.status).toBe('SKIPPED');
    expect((await db().leadPersonalization.findFirstOrThrow({ where: { stepId: steps[1].id } })).error).toMatch(/AI_COST_LIMIT/);
    // Workspace monthly budget
    await engine.updateCampaignAi(s.workspaceId, campaignId, { maxAiCostPerLeadUsd: null }, ACTOR);
    const ws = await db().workspace.findUniqueOrThrow({ where: { id: s.workspaceId } });
    await db().workspace.update({ where: { id: s.workspaceId }, data: { settings: { ...(ws.settings as object), aiMonthlyBudgetUsd: 0.001 } } });
    const over = await pz.generateForLead(s.workspaceId, campaignId, leads[1].id, steps[0].id);
    expect(over.status).toBe('SKIPPED');
    expect((over as { code?: string }).code).toBe('AI_BUDGET_EXCEEDED');
    await db().workspace.update({ where: { id: s.workspaceId }, data: { settings: { ...(ws.settings as object), aiMonthlyBudgetUsd: null } } });
    // Batch cost cap stops the batch and skips the rest
    const est = await pz.estimateBatch(s.workspaceId, campaignId, { stepIds: [steps[0].id], force: false, onlyMissing: true });
    expect(est.generations, JSON.stringify(await db().leadPersonalization.findMany({ select: { leadId: true, stepId: true, status: true, error: true } }))).toBe(2);
    expect(est.estimatedUsd).toBeGreaterThan(0);
    const batch = await pz.createBatch(s.workspaceId, campaignId, { stepIds: [steps[0].id], force: false, onlyMissing: true, maxCostUsd: 0.001 }, ACTOR);
    const queued = await db().leadPersonalization.findMany({ where: { batchId: batch.batchId } });
    for (const q of queued) await pz.processBatchLead(s.workspaceId, { campaignId, leadId: q.leadId, stepIds: [q.stepId], batchId: batch.batchId });
    const b = await db().personalizationBatch.findUniqueOrThrow({ where: { id: batch.batchId } });
    expect(b.status).toBe('CANCELLED');
    expect(b.error).toMatch(/cost cap/);
    expect(b.done + b.skipped).toBe(2);
    expect(b.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe('prompt builder, preview, versions and test email', () => {
  it('renders conditionals, previews a lead, clones, versions and restricts test emails to members', async () => {
    const s = await createUserSession('owner@x.com');
    ai.on('PERSONALIZATION', honestWriter()).on('FACT_CHECK', factChecker);
    await expect(studio.createProfile(s.workspaceId, { name: 'Bad', instructions: '{{#if lead.title}}unclosed', settings: {} }, ACTOR)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(studio.createProfile(s.workspaceId, { name: 'Typo', instructions: 'Hi {{lead.frstName}}', settings: {} }, ACTOR)).rejects.toThrow(/Unknown variables/);
    const profile = await studio.createProfile(s.workspaceId, { name: 'Cond', instructions: '{{#if research.hasClaims}}USE-EVIDENCE for {{company.name|their company}}{{else}}NO-EVIDENCE{{/if}} {{#unless step.isFollowUp}}FIRST{{/unless}}', settings: { ctaStyle: 'meeting_request' } }, ACTOR);
    const { campaignId, steps, leads } = await setup(s);
    await engine.updateCampaignAi(s.workspaceId, campaignId, { aiProfileId: profile.id }, ACTOR);
    const pv = await pz.promptPreview(s.workspaceId, campaignId, leads[0].id, steps[0].id);
    expect(pv.profilePrompt.text).toMatch(/USE-EVIDENCE/);
    expect(pv.profilePrompt.text).toMatch(/FIRST/);
    expect(pv.resolved.writing.ctaStyle).toBe('meeting_request');
    expect(pv.resolved.writingSources.ctaStyle).toBe('profile');
    // Preview test on a lead: real pipeline, nothing stored
    const t = await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id, { preview: true });
    expect((t as { preview?: boolean }).preview).toBe(true);
    expect(await db().leadPersonalization.count()).toBe(0);
    // Versions + compare + export/import
    await studio.createProfileVersion(s.workspaceId, profile.id, { instructions: 'v2 text', settings: {}, activate: true }, ACTOR);
    const p = await studio.getProfile(s.workspaceId, profile.id);
    expect(studio.compareVersions(p.versions[1], p.versions[0]).addedLines).toEqual(['v2 text']);
    const exp = await studio.exportProfiles(s.workspaceId);
    const imp = await studio.importProfiles(s.workspaceId, exp as never, ACTOR);
    expect(imp.created).toBe(1);
    // Per-lead preview renders footer; test email only to members
    await pz.generateForLead(s.workspaceId, campaignId, leads[0].id, steps[0].id);
    const view = await engine.previewForLead(s.workspaceId, campaignId, leads[0].id, 1);
    expect(view.body).toMatch(/weekly podcast/);
    expect(view.body).toMatch(/unsubscribe/);
    await expect(engine.sendTestEmail(s.workspaceId, campaignId, { leadId: leads[0].id, stepOrder: 1, to: 'stranger@else.com' }, ACTOR)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const sent = await engine.sendTestEmail(s.workspaceId, campaignId, { leadId: leads[0].id, stepOrder: 1, to: 'owner@x.com' }, ACTOR);
    expect(sent.subject).toMatch(/^\[TEST\]/);
    expect(fakes.gmail.sent[0].to).toBe('owner@x.com');
    expect(await db().outboundEmail.count()).toBe(0);
    // Clone keeps AI configuration, not recipients
    const copy = await engine.duplicateCampaign(s.workspaceId, campaignId, undefined, ACTOR);
    expect(copy.aiProfileId).toBe(profile.id);
    expect(copy.sequence!.steps[0].aiInstructions).toBe('Personal introduction.');
    expect(copy.status).toBe('DRAFT');
  });

  it('isolates personalization data between workspaces', async () => {
    const a = await createUserSession('a@x.com');
    ai.on('PERSONALIZATION', honestWriter()).on('FACT_CHECK', factChecker);
    const { campaignId, steps, leads } = await setup(a);
    const r = await pz.generateForLead(a.workspaceId, campaignId, leads[0].id, steps[0].id);
    const b = await createUserSession('b@y.com');
    const h = { 'x-csrf-token': b.csrf };
    expect((await b.agent.get(`/api/v1/w/${b.workspaceId}/personalizations/${r.id}`)).status).toBe(404);
    expect((await b.agent.get(`/api/v1/w/${a.workspaceId}/campaigns/${campaignId}/personalizations`)).status).toBe(404);
    expect((await b.agent.post(`/api/v1/w/${b.workspaceId}/personalizations/approve`).set(h).send({ ids: [r.id] })).status).toBe(404);
    const ok = await a.agent.get(`/api/v1/w/${a.workspaceId}/campaigns/${campaignId}/personalizations`);
    expect(ok.status).toBe(200);
    expect(ok.body.data[0].warnings).toBeInstanceOf(Array);
  });
});
