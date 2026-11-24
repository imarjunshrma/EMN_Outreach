import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import {
  EMAIL_QUALITY_DATASET,
  EMAIL_QUALITY_DIMENSIONS,
  compareEmailQualityOnSameInputs,
  type EmailQualityAnnotation,
} from '../shared/src/email-quality-evaluation.js';

const partitionFlag = process.argv.indexOf('--partition');
const partition = partitionFlag < 0 ? 'held_out' : process.argv[partitionFlag + 1];
if (!['tuning', 'held_out', 'all'].includes(partition)) throw new Error('--partition must be tuning, held_out or all');
const exportFlag = process.argv.indexOf('--export');
if (exportFlag >= 0) {
  const target = process.argv[exportFlag + 1];
  if (!target) throw new Error('--export requires a file path');
  const cases = EMAIL_QUALITY_DATASET.filter((c) => partition === 'all' || c.partition === partition);
  const exported = cases.map((testCase) => ({
    ...testCase,
    inputFingerprint: createHash('sha256').update(JSON.stringify(testCase.input)).digest('hex'),
  }));
  fs.writeFileSync(target, `${JSON.stringify(exported, null, 2)}\n`, { flag: 'wx' });
  console.log(`Exported ${cases.length} synthetic ${partition} cases to ${target}`);
  process.exit(0);
}

const fileFlag = process.argv.indexOf('--annotations');
if (fileFlag < 0 || !process.argv[fileFlag + 1]) {
  console.error('Usage: node --import tsx scripts/score-email-quality.ts --export <cases.json> [--partition tuning|held_out|all]\n   or: node --import tsx scripts/score-email-quality.ts --annotations <file> [--partition tuning|held_out|all]');
  process.exit(2);
}

const scoreShape = Object.fromEntries(EMAIL_QUALITY_DIMENSIONS.map((key) => [key, z.number().int().min(0).max(5)]));
const AnnotationSchema = z.object({
  caseId: z.string().min(1), inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/), variantId: z.string().min(1), annotationMethod: z.literal('HUMAN'), reviewerId: z.string().trim().min(2).max(120),
  email: z.string().min(1), scores: z.object(scoreShape), unsupportedClaim: z.boolean(), genericContent: z.boolean(), humanCorrectionRequired: z.boolean(),
}).strict();
const parsed = z.array(AnnotationSchema).min(1).parse(JSON.parse(fs.readFileSync(process.argv[fileFlag + 1], 'utf8'))) as EmailQualityAnnotation[];
const cases = EMAIL_QUALITY_DATASET.filter((c) => partition === 'all' || c.partition === partition);
const caseById = new Map(cases.map((c) => [c.id, c]));
const seen = new Set<string>();
for (const annotation of parsed) {
  const testCase = caseById.get(annotation.caseId);
  if (!testCase) throw new Error(`Case ${annotation.caseId} is outside the requested ${partition} partition`);
  const fingerprint = createHash('sha256').update(JSON.stringify(testCase.input)).digest('hex');
  if (annotation.inputFingerprint !== fingerprint) throw new Error(`Input fingerprint mismatch for ${annotation.caseId}; model/prompt variants must receive identical benchmark input`);
  const key = `${annotation.variantId}:${annotation.caseId}`;
  if (seen.has(key)) throw new Error(`Duplicate annotation for variant ${annotation.variantId}, case ${annotation.caseId}`);
  seen.add(key);
}
const variants = [...new Set(parsed.map((a) => a.variantId))];
const expectedKeys = cases.map((c) => c.id).sort().join('|');
for (const variantId of variants) {
  const actualKeys = parsed.filter((a) => a.variantId === variantId).map((a) => a.caseId).sort().join('|');
  if (actualKeys !== expectedKeys) throw new Error(`Variant ${variantId} must have exactly one annotation for every ${partition} case (${cases.length})`);
}
const result = compareEmailQualityOnSameInputs(parsed);
if (!result.sameInputs) throw new Error('Variants were not evaluated on the same input cases');
console.log(JSON.stringify({
  partition,
  syntheticCases: cases.length,
  annotationMethod: 'reviewer-declared HUMAN ratings (0–5); no model judge or provider call; reviewer identity is file supplied and not independently verified',
  rubric: EMAIL_QUALITY_DIMENSIONS,
  variants: result.variants,
}, null, 2));
