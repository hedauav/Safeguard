/**
 * Writes the dataset files.
 *
 *   npx tsx eval/build.ts            # from backend/
 *   npx tsx eval/build.ts --dev-only
 *
 * The holdout is refused once it has been sealed. Regeneration is
 * deterministic, so the bytes would come out identical — but "it would have
 * been the same anyway" is exactly the reasoning that gets an answer key
 * overwritten the one time it would not have been. If the lock is there, this
 * script checks the holdout instead of rewriting it.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSplit, SPLITS } from './generate.js';
import { DEFAULT_LOCK_PATH, verifySeal, renderSealStatus } from './seal.js';
import type { SplitName } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATASET_DIR = join(HERE, 'dataset');

/** One canonical serialisation, so a rebuild is byte-identical or is a change. */
export function serialise(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeSplit(split: SplitName): { cases: string; truth: string } {
  const { seed, plan } = SPLITS[split];
  const generated = generateSplit(split, seed, plan);
  const dir = join(DATASET_DIR, split);
  mkdirSync(dir, { recursive: true });

  const casesPath = join(dir, 'cases.json');
  const truthPath = join(dir, 'ground-truth.json');
  writeFileSync(casesPath, serialise(generated.cases), 'utf8');
  writeFileSync(truthPath, serialise(generated.truth), 'utf8');
  return { cases: casesPath, truth: truthPath };
}

function main(): number {
  const devOnly = process.argv.includes('--dev-only');

  const dev = writeSplit('dev');
  console.log(`dev      -> ${dev.cases}`);
  console.log(`            ${dev.truth}`);

  if (existsSync(DEFAULT_LOCK_PATH)) {
    const status = verifySeal();
    console.log('');
    console.log('Holdout is sealed; not rewriting it.');
    console.log(renderSealStatus(status));
    return status.ok ? 0 : 1;
  }

  if (devOnly) {
    console.log('');
    console.log('--dev-only: holdout not written, and it is not sealed either.');
    return 0;
  }

  const holdout = writeSplit('holdout');
  console.log(`holdout  -> ${holdout.cases}`);
  console.log(`            ${holdout.truth}`);
  console.log('');
  console.log('Holdout written and NOT yet sealed. Seal it before measuring anything against it:');
  console.log('  npx tsx eval/seal-cli.ts seal');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
