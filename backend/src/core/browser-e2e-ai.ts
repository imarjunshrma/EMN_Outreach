import { appendFileSync } from 'node:fs';
import type { AiProviderAdapter } from '../../../integrations/src/ai/types.js';
import { assertBrowserE2eSafety, E2E_STORAGE_ROOT } from './browser-e2e-safety.js';

const pages = {
  'signalwork.example': [
    'Ava Reed is the founder of Signalwork.',
    'Signalwork publishes a weekly podcast about running consulting businesses.',
  ],
  'ledgerfield.example': [
    'Noah West is the finance director at Ledgerfield.',
    'Ledgerfield supplies accounting software to regional retailers.',
  ],
} as const;

export const browserE2eFetcher = {
  async fetchPage(rawUrl: string) {
    const url = new URL(rawUrl);
    const page = pages[url.hostname as keyof typeof pages];
    if (!page || url.protocol !== 'https:' || url.pathname !== '/') throw new Error('No synthetic research fixture for this URL.');
    return { url: url.href, title: url.hostname, status: 200, text: page.join('\n'), links: [] };
  },
};

export function browserE2eAi(name: AiProviderAdapter['name']): AiProviderAdapter {
  if (!assertBrowserE2eSafety()) throw new Error('The browser AI mock requires the isolated profile.');
  return {
    name,
    async listModels() { return ['outvexa-e2e-fixture-v1']; },
    async testConnection() { return { ok: true }; },
    async generateStructured(_key, request) {
      const { schemaName, model, user } = request;
      appendFileSync(`${E2E_STORAGE_ROOT}/mock-ai.jsonl`, JSON.stringify({ at: new Date().toISOString(), schemaName, resolvedProvider: name, resolvedModel: model, actualModel: 'outvexa-e2e-fixture-v1' }) + '\n', { mode: 0o600 });
      let data: unknown;
      switch (schemaName) {
        case 'fact_extraction': {
          const claims = [...user.matchAll(/<document evidenceId="([^"]+)" url="https:\/\/([^/"]+)\/?"[^>]*>([\s\S]*?)<\/document>/g)]
            .flatMap(([, evidenceId, host, document]) => (pages[host as keyof typeof pages] ?? [])
              .flatMap((quote, index) => document.includes(quote) ? [{ text: quote, quote, evidenceId, confidence: 1, category: index === 0 ? 'professional_identity' : 'content' }] : []));
          data = { summary: claims.map(claim => claim.text).join(' '), industry: null, services: [], audience: null, businessModel: null, claims };
          break;
        }
        case 'lead_qualification': {
          const claimIds = user.split(/(?=^- \[)/m).flatMap(block => {
            const id = /^- \[([\da-f-]{36})\]/.exec(block)?.[1];
            return id && Object.values(pages).some(([identity]) => block.includes(identity)) ? [id] : [];
          });
          const fits = claimIds.length > 0 && user.includes(pages['signalwork.example'][1]);
          const reasons = [{ criterion: 'Founder', met: fits, explanation: fits ? 'The fixture homepage identifies Ava as founder.' : 'The fixture homepage does not identify a founder.', claimIds: fits ? claimIds : [] }];
          data = { score: fits ? 85 : 15, reasons, risks: [], identityAssessment: { status: claimIds.length ? 'VERIFIED' : 'UNKNOWN', evidenceClaimIds: claimIds, reason: 'Synthetic company homepage identity' } };
          break;
        }
        case 'personalization': {
          const quote = pages['signalwork.example'][1];
          const claim = [...user.matchAll(/^- \[([\da-f-]{36})\] \(content\) (.+)$/gm)].find(([, , text]) => text === quote);
          const service = /^\{"id":"([\da-f-]{36})","name":"Synthetic podcast repurposing"/m.exec(user)?.[1];
          if (!claim || !service) throw new Error('The synthetic writing fixture requires the Signalwork podcast claim and approved service.');
          const claimId = claim[1];
          const cta = 'Would a sample outline be useful?';
          data = {
            subject: 'An idea for Signalwork’s podcast', subjectAlternatives: [], openingLine: quote,
            body: `Hi Ava,\n\n${quote} One way to give an episode a second use would be to turn a practical takeaway into a short LinkedIn post. I can outline how I’d adapt one episode while keeping your voice intact.\n\n${cta}`,
            cta, usedClaimIds: [claimId], personalizationBasis: quote, insufficientContext: false,
            opportunityAnalysis: {
              qualification: 'POSSIBLE_FIT', businessModel: { statement: null, basis: 'UNKNOWN', claimIds: [] },
              facts: [{ statement: quote, claimId }], inferences: [], unknowns: [], opportunity: 'Adapt a podcast takeaway for LinkedIn.',
              serviceFit: 'Podcast repurposing applies to the published series.', serviceVersionId: service,
              serviceMatchClaimIds: [claimId], confidence: 0.9, missingInformation: [], recommendedApproach: 'Offer a sample outline.',
            },
          };
          break;
        }
        case 'fact_check': {
          const quote = pages['signalwork.example'][1];
          const evidence = user.split('Supported claims:').at(-1) ?? '';
          const claimId = evidence.split(/(?=^- \[)/m).find(block => block.includes(quote))?.match(/^- \[([\da-f-]{36})\]/)?.[1];
          const draft = /<untrusted_content source="draft">([\s\S]*?)<\/untrusted_content>/.exec(user)?.[1] ?? '';
          const sentences = draft.split(/\n+|(?<=[.!?])\s+/).map(text => text.trim()).filter(Boolean).map(text => {
            if (text === quote && claimId) return { text, claimId, verdict: 'SUPPORTED', reason: 'Verbatim synthetic source claim.' };
            const fixtureWording = /^(An idea for Signalwork|Hi Ava,|One way to|I can outline|Would (a sample|an example))/.test(text);
            return { text, claimId: null, verdict: fixtureWording ? 'GENERIC' : 'UNSUPPORTED', reason: 'Deterministic fixture wording check.' };
          });
          data = { sentences };
          break;
        }
        case 'copilot': {
          const propose = user.endsWith('Create a campaign draft named Copilot E2E draft.');
          data = { answer: propose ? 'I can create the draft after you confirm.' : 'This is the Elite Media Networks E2E workspace. The mailbox fixture is offline.', recommendations: [],
            proposedActions: propose ? [{ type: 'create_campaign_draft', summary: 'Create Copilot E2E draft', params: [{ key: 'name', value: 'Copilot E2E draft' }] }] : [] };
          break;
        }
        default:
          throw new Error(`No deterministic browser E2E AI result for ${schemaName}.`);
      }
      return { data, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, latencyMs: 0 };
    },
  };
}
