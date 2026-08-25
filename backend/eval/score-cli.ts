/**
 * Score a set of predictions and print the report.
 *
 *   npx tsx eval/score-cli.ts dev predictions.json
 *   npx tsx eval/score-cli.ts holdout predictions.json
 *
 * `predictions.json` is either `[{"case_id":"dev-001","verdict":"approve"}, ...]`
 * or `{"dev-001":"approve", ...}`. There must be exactly one verdict per case
 * in the split; scoring refuses a partial run.
 *
 * Scoring the holdout checks the seal first and stops if it is broken, because
 * a held-out number from a moved holdout is not a held-out number.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadSplit } from './dataset.js';
import { renderSealStatus } from './seal.js';
import { renderReport, score, type Prediction } from './scoring.js';
import type { SplitName, Verdict } from './types.js';

function readPredictions(path: string): Prediction[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (Array.isArray(raw)) return raw as Prediction[];
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, Verdict>).map(([case_id, verdict]) => ({ case_id, verdict }));
  }
  throw new Error(`${path}: expected an array of {case_id, verdict} or an object of case_id -> verdict`);
}

function main(): number {
  const split = (process.argv[2] ?? '') as SplitName;
  const path = process.argv[3];
  if ((split !== 'dev' && split !== 'holdout') || !path) {
    console.error('usage: npx tsx eval/score-cli.ts <dev|holdout> <predictions.json>');
    return 1;
  }

  const loaded = loadSplit(split);
  const predictions = readPredictions(path);
  const result = score(predictions, loaded.truth.entries, split);
  console.log(renderReport(result, loaded.seal ? renderSealStatus(loaded.seal) : 'Split: dev (not sealed; it is the set you are allowed to look at).'));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
