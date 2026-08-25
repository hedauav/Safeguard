/**
 * Reading the dataset off disk.
 *
 * `loadSplit('holdout')` checks the seal first and refuses to hand back a
 * broken one. That refusal is the point: the moment a holdout can be read
 * without its seal being checked, the seal is decoration.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LOCK_PATH, renderSealStatus, verifySeal, type SealStatus } from './seal.js';
import type { CasesFile, GroundTruthFile, SplitName } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATASET_DIR = join(HERE, 'dataset');

export interface LoadedSplit {
  cases: CasesFile;
  truth: GroundTruthFile;
  /** Present for the holdout, absent for the dev set. */
  seal: SealStatus | null;
}

export function splitDir(split: SplitName): string {
  return join(DATASET_DIR, split);
}

export function readCases(split: SplitName): CasesFile {
  return JSON.parse(readFileSync(join(splitDir(split), 'cases.json'), 'utf8')) as CasesFile;
}

export function readTruth(split: SplitName): GroundTruthFile {
  return JSON.parse(readFileSync(join(splitDir(split), 'ground-truth.json'), 'utf8')) as GroundTruthFile;
}

export interface LoadOptions {
  /** Read a broken holdout anyway. Only for a tool whose job is to show the
   *  damage; never for anything that produces a score. */
  allowBrokenSeal?: boolean;
}

export function loadSplit(split: SplitName, opts: LoadOptions = {}): LoadedSplit {
  const cases = readCases(split);
  const truth = readTruth(split);

  if (cases.count !== cases.cases.length || truth.count !== truth.entries.length) {
    throw new Error(`loadSplit(${split}): declared count does not match the number of records on disk`);
  }
  if (cases.seed !== truth.seed) {
    throw new Error(`loadSplit(${split}): cases were generated from seed ${cases.seed}, labels from ${truth.seed}`);
  }

  let seal: SealStatus | null = null;
  if (split === 'holdout') {
    if (!existsSync(DEFAULT_LOCK_PATH)) {
      throw new Error(
        `loadSplit(holdout): no lock at ${DEFAULT_LOCK_PATH}. An unsealed holdout is a second ` +
          'development set, and a number produced against it should not be called a held-out number.'
      );
    }
    seal = verifySeal();
    if (!seal.ok && !opts.allowBrokenSeal) {
      throw new Error(`loadSplit(holdout): the seal is broken.\n${renderSealStatus(seal)}`);
    }
  }

  return { cases, truth, seal };
}
