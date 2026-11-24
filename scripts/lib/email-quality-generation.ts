import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AI_OUTPUT_SCHEMAS } from '../../shared/src/ai-schemas.js';
import type { EmailQualityCase } from '../../shared/src/email-quality-evaluation.js';
import type { AiProviderAdapter, AiProviderName } from '../../integrations/src/ai/types.js';

export const EMAIL_QUALITY_SYSTEM_PROMPT = `You are drafting a synthetic B2B outreach example for a human quality evaluation. Use only the supplied prospect fields, evidence and approved service records. Never invent identity, facts, proof, results, or a service match. If identity, relevance, evidence, or service eligibility is insufficient, return an explicit insufficientContext=true result with a brief reason in personalizationBasis, no generic pitch, no unsupported claim, and a null serviceVersionId. When suitable, make the opening specific to the cited evidence, connect the opportunity to an eligible service, and use a natural low-pressure CTA. Return the exact requested structured schema. This output is a benchmark artifact and must never be sent.`;

export function emailQualityUserInput(testCase: EmailQualityCase) {
  return JSON.stringify({ caseId: testCase.id, ...testCase.input });
}

export function inputFingerprint(testCase: EmailQualityCase) {
  return createHash('sha256').update(JSON.stringify(testCase.input)).digest('hex');
}

export async function generateEmailQualityCases(args: {
  cases: EmailQualityCase[]; variantId: string; provider: AiProviderName; model: string;
  apiKey: string; baseUrl?: string | null; adapter: AiProviderAdapter;
  maxOutputTokens?: number; temperature?: number;
}) {
  const schema = AI_OUTPUT_SCHEMAS.PERSONALIZATION;
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7', io: 'output' }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  const schemaHash = createHash('sha256').update(JSON.stringify(jsonSchema)).digest('hex');
  const outputs = [];
  for (const testCase of args.cases) {
    const user = emailQualityUserInput(testCase);
    let response = await args.adapter.generateStructured(args.apiKey, { model: args.model, system: EMAIL_QUALITY_SYSTEM_PROMPT, user, jsonSchema, schemaName: 'email_quality_personalization', maxOutputTokens: args.maxOutputTokens ?? 1200, temperature: args.temperature }, { baseUrl: args.baseUrl });
    let parsed = schema.safeParse(response.data);
    if (!parsed.success) {
      const repair = `${user}\n\nYour prior output did not match the required schema (${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}). Repair the output once. Preserve the supplied facts and return a complete valid object.`;
      response = await args.adapter.generateStructured(args.apiKey, { model: args.model, system: EMAIL_QUALITY_SYSTEM_PROMPT, user: repair, jsonSchema, schemaName: 'email_quality_personalization', maxOutputTokens: args.maxOutputTokens ?? 1200, temperature: args.temperature }, { baseUrl: args.baseUrl });
      parsed = schema.safeParse(response.data);
    }
    if (!parsed.success) throw new Error(`Schema-invalid output for synthetic case ${testCase.id} after one repair attempt`);
    const email = [parsed.data.subject, parsed.data.openingLine, parsed.data.body, parsed.data.cta].filter((part): part is string => !!part?.trim()).join('\n\n');
    outputs.push({ caseId: testCase.id, inputFingerprint: inputFingerprint(testCase), variantId: args.variantId, provider: args.provider, model: args.model, promptHash: createHash('sha256').update(EMAIL_QUALITY_SYSTEM_PROMPT).digest('hex'), schemaHash, generatedAt: new Date().toISOString(), generationMode: response.generationMode ?? 'structured', latencyMs: response.latencyMs, usage: response.usage, email, structured: parsed.data });
  }
  return outputs;
}
