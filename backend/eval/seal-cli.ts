/**
 * The seal, from a terminal.
 *
 *   npx tsx eval/seal-cli.ts verify    # exits non-zero if the seal is broken
 *   npx tsx eval/seal-cli.ts seal      # refused if a lock already exists
 *
 * `verify` is the one meant to run in CI, before any holdout number is
 * believed. It distinguishes changed, missing and added files, and treats all
 * three as a broken seal.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LOCK_PATH, ResealRefused, renderSealStatus, seal, verifySeal } from './seal.js';
import { HOLDOUT_SEED } from './generate.js';
import { RULEBOOK_VERSION } from './rules.js';

function verify(): number {
  if (!existsSync(DEFAULT_LOCK_PATH)) {
    console.error(`No lock at ${DEFAULT_LOCK_PATH}.`);
    console.error('The holdout is unsealed, so a score against it proves nothing about when it was written.');
    console.error('Seal it first:  npx tsx eval/seal-cli.ts seal');
    return 1;
  }
  const status = verifySeal();
  console.log(renderSealStatus(status));
  return status.ok ? 0 : 1;
}

function doSeal(): number {
  try {
    const lock = seal({
      root: 'dataset/holdout',
      split: 'holdout',
      seed: HOLDOUT_SEED,
      rulebook_version: RULEBOOK_VERSION,
    });
    console.log(`Sealed ${Object.keys(lock.files).length} file(s) at ${lock.sealed_at}.`);
    for (const [file, digest] of Object.entries(lock.files)) {
      console.log(`  ${digest}  ${file}`);
    }
    console.log('');
    console.log(lock.note);
    return 0;
  } catch (err) {
    if (err instanceof ResealRefused) {
      console.error(err.message);
      return 2;
    }
    console.error(String(err instanceof Error ? err.message : err));
    return 1;
  }
}

function main(): number {
  const cmd = process.argv[2] ?? 'verify';
  switch (cmd) {
    case 'verify':
    case 'status':
      return verify();
    case 'seal':
      return doSeal();
    default:
      console.error(`Unknown command "${cmd}". Use: verify | seal`);
      return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
