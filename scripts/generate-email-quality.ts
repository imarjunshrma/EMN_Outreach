import fs from 'node:fs';
import { AI_PROVIDER_NAMES } from '../integrations/src/ai/types.js';
import { adapters } from '../backend/src/core/container.js';
import { EMAIL_QUALITY_DATASET } from '../shared/src/email-quality-evaluation.js';
import { generateEmailQualityCases } from './lib/email-quality-generation.js';

function arg(name: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
const partition = arg('--partition') ?? 'held_out';
if (partition !== 'tuning' && partition !== 'held_out') throw new Error('--partition must be tuning or held_out');
const provider = process.env.OUTVEXA_EVAL_PROVIDER as typeof AI_PROVIDER_NAMES[number] | undefined;
const model = process.env.OUTVEXA_EVAL_MODEL;
const apiKey = process.env.OUTVEXA_EVAL_API_KEY;
const baseUrl = process.env.OUTVEXA_EVAL_BASE_URL;
const variantId = arg('--variant-id');
const output = arg('--out');
if (!provider || !AI_PROVIDER_NAMES.includes(provider) || !model || !apiKey || !variantId || !output) {
  console.error('Set OUTVEXA_EVAL_PROVIDER, OUTVEXA_EVAL_MODEL, OUTVEXA_EVAL_API_KEY; optionally OUTVEXA_EVAL_BASE_URL. Usage: npm run eval:email-quality:generate -- --partition held_out --variant-id openai-model-prompt-v1 --out /tmp/out.json');
  process.exit(2);
}
const cases = EMAIL_QUALITY_DATASET.filter((testCase) => testCase.partition === partition);
const adapter = adapters().ai[provider];
if (!adapter) throw new Error(`No adapter is installed for ${provider}`);
let generated;
try {
  generated = await generateEmailQualityCases({ cases, variantId, provider, model, apiKey, baseUrl, adapter });
} catch (error) {
  console.error(`Synthetic evaluation generation failed for ${provider}/${model} (${error instanceof Error ? error.name : 'unknown error'}). Provider details and credentials were omitted; check the provider dashboard and retry.`);
  process.exit(1);
}
const envelope = { partition, syntheticCaseCount: cases.length, humanAnnotated: false, autoApproved: false, emailSent: false, generated };
fs.writeFileSync(output, `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(`Generated ${generated.length} synthetic ${partition} outputs for ${provider}/${model}; saved to ${output}. No email was sent. Outputs require independent human annotation.`);
