import fs from 'node:fs';
import { PROSPECT_EVALUATION_DATASET, scoreProspectEvaluation, type EvaluationPrediction } from '../shared/src/evaluation-dataset.js';

const fileFlag = process.argv.indexOf('--predictions');
if (fileFlag < 0 || !process.argv[fileFlag + 1]) {
  console.error('Usage: node --import tsx scripts/score-ai-evaluation.ts --predictions <json-file> [--partition train|held_out|all]');
  process.exit(2);
}
const partitionFlag = process.argv.indexOf('--partition');
const partition = partitionFlag < 0 ? 'held_out' : process.argv[partitionFlag + 1];
if (!['train', 'held_out', 'all'].includes(partition)) throw new Error('--partition must be train, held_out or all');
const allPredictions = JSON.parse(fs.readFileSync(process.argv[fileFlag + 1], 'utf8')) as Record<string, EvaluationPrediction>;
const cases = partition === 'all' ? PROSPECT_EVALUATION_DATASET : PROSPECT_EVALUATION_DATASET.filter((c) => c.partition === partition);
const predictions = Object.fromEntries(cases.filter((c) => allPredictions[c.id]).map((c) => [c.id, allPredictions[c.id]]));
const result = scoreProspectEvaluation(cases, predictions);
console.log(JSON.stringify({ partition, ...result }, null, 2));
if (result.evaluated !== result.total) process.exitCode = 1;
