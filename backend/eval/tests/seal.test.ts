import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_LOCK_PATH,
  ResealRefused,
  SEAL_NOTE,
  renderSealStatus,
  seal,
  verifySeal,
  hashTree,
  listFiles,
  type LockFile,
} from '../seal.js';
import { splitDir } from '../dataset.js';
import { HOLDOUT_SEED } from '../generate.js';
import { RULEBOOK_VERSION } from '../rules.js';

/**
 * A throwaway copy of the real holdout, sealed. Every test works on its own
 * copy: a test that mutates the shipped holdout to prove the seal works would
 * be breaking the thing it is checking.
 */
function sealedSandbox(): { dir: string; lockPath: string; root: string; lock: LockFile } {
  const dir = mkdtempSync(join(tmpdir(), 'safeguard-seal-'));
  const root = join(dir, 'holdout');
  mkdirSync(root, { recursive: true });
  cpSync(splitDir('holdout'), root, { recursive: true });
  const lockPath = join(dir, 'holdout.lock.json');
  const lock = seal({
    lockPath,
    root: 'holdout',
    split: 'holdout',
    seed: HOLDOUT_SEED,
    rulebook_version: RULEBOOK_VERSION,
    now: () => new Date('2026-05-31T00:00:00.000Z'),
  });
  return { dir, lockPath, root, lock };
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

// --- The lock itself --------------------------------------------------------

test('the lock records a digest per file, the seed, a timestamp and what re-sealing costs', () => {
  const box = sealedSandbox();
  try {
    assert.equal(box.lock.algorithm, 'sha256');
    assert.equal(box.lock.seed, HOLDOUT_SEED);
    assert.equal(box.lock.sealed_at, '2026-05-31T00:00:00.000Z');
    assert.equal(box.lock.rulebook_version, RULEBOOK_VERSION);
    assert.ok(box.lock.note.length > 200, 'the note has to say what is lost, not just that something is');
    assert.match(box.lock.note, /destroys/i);
    assert.match(box.lock.note, /commit of its own/i);

    // The answer key is sealed, not just the questions.
    assert.ok('ground-truth.json' in box.lock.files, 'the ground-truth file must be under seal');
    assert.ok('cases.json' in box.lock.files);
    for (const digest of Object.values(box.lock.files)) assert.match(digest, /^[0-9a-f]{64}$/);
  } finally {
    cleanup(box.dir);
  }
});

test('a freshly sealed directory verifies clean', () => {
  const box = sealedSandbox();
  try {
    const status = verifySeal(box.lockPath);
    assert.equal(status.ok, true);
    assert.deepEqual(status.changed, []);
    assert.deepEqual(status.missing, []);
    assert.deepEqual(status.added, []);
    assert.match(renderSealStatus(status), /INTACT/);
  } finally {
    cleanup(box.dir);
  }
});

// --- The one that matters ---------------------------------------------------

test('a whitespace-only reformat of the ground-truth file breaks the seal', () => {
  const box = sealedSandbox();
  try {
    const path = join(box.root, 'ground-truth.json');
    const before = readFileSync(path, 'utf8');
    const parsed = JSON.parse(before);

    // Exactly the edit an editor makes on save, or a "tidy up the JSON" commit
    // at 2am: identical data, different bytes. An answer key that survives this
    // is an answer key that can be adjusted after the fact and reformatted back.
    const reformatted = `${JSON.stringify(parsed, null, 4)}\n`;
    assert.notEqual(reformatted, before, 'the reformat must actually change the bytes');
    assert.deepEqual(JSON.parse(reformatted), parsed, 'the reformat must not change the data');

    writeFileSync(path, reformatted, 'utf8');

    const status = verifySeal(box.lockPath);
    assert.equal(status.ok, false, 'a reformatted answer key must break the seal');
    assert.deepEqual(status.changed, ['ground-truth.json']);
    assert.deepEqual(status.missing, []);
    assert.deepEqual(status.added, []);
    assert.match(renderSealStatus(status), /BROKEN/);
    assert.match(renderSealStatus(status), /not a held-out number/);
  } finally {
    cleanup(box.dir);
  }
});

test('changing a single label breaks the seal', () => {
  const box = sealedSandbox();
  try {
    const path = join(box.root, 'ground-truth.json');
    const truth = JSON.parse(readFileSync(path, 'utf8'));
    const victim = truth.entries.find((e: { label: string }) => e.label === 'deny');
    victim.label = 'approve';
    writeFileSync(path, `${JSON.stringify(truth, null, 2)}\n`, 'utf8');

    const status = verifySeal(box.lockPath);
    assert.equal(status.ok, false);
    assert.deepEqual(status.changed, ['ground-truth.json']);
  } finally {
    cleanup(box.dir);
  }
});

// --- changed / missing / added are three different things -------------------

test('a missing file is reported as missing, not as unchanged', () => {
  const box = sealedSandbox();
  try {
    rmSync(join(box.root, 'cases.json'));
    const status = verifySeal(box.lockPath);
    assert.equal(status.ok, false);
    assert.deepEqual(status.missing, ['cases.json']);
    assert.deepEqual(status.changed, []);
    assert.deepEqual(status.added, []);
  } finally {
    cleanup(box.dir);
  }
});

test('an added file breaks the seal, because a holdout you can append to is a holdout you can dilute', () => {
  const box = sealedSandbox();
  try {
    writeFileSync(join(box.root, 'extra-cases.json'), '{"cases":[]}\n', 'utf8');
    const status = verifySeal(box.lockPath);
    assert.equal(status.ok, false, 'an addition is as much a change as an edit');
    assert.deepEqual(status.added, ['extra-cases.json']);
    assert.deepEqual(status.changed, []);
    assert.deepEqual(status.missing, []);
    assert.match(renderSealStatus(status), /dilute/);
  } finally {
    cleanup(box.dir);
  }
});

test('a file added in a subdirectory is found too', () => {
  const box = sealedSandbox();
  try {
    mkdirSync(join(box.root, 'nested'));
    writeFileSync(join(box.root, 'nested', 'sneaky.json'), '{}\n', 'utf8');
    const status = verifySeal(box.lockPath);
    assert.equal(status.ok, false);
    assert.deepEqual(status.added, ['nested/sneaky.json']);
  } finally {
    cleanup(box.dir);
  }
});

test('the three kinds of break are reported together, each named', () => {
  const box = sealedSandbox();
  try {
    writeFileSync(join(box.root, 'ground-truth.json'), '{"entries":[]}\n', 'utf8');
    rmSync(join(box.root, 'cases.json'));
    writeFileSync(join(box.root, 'appendix.json'), '{}\n', 'utf8');

    const status = verifySeal(box.lockPath);
    assert.deepEqual(status.changed, ['ground-truth.json']);
    assert.deepEqual(status.missing, ['cases.json']);
    assert.deepEqual(status.added, ['appendix.json']);

    const rendered = renderSealStatus(status);
    assert.match(rendered, /changed \(1\)/);
    assert.match(rendered, /missing \(1\)/);
    assert.match(rendered, /added \(1\)/);
  } finally {
    cleanup(box.dir);
  }
});

// --- Re-sealing -------------------------------------------------------------

test('re-sealing is refused, and the refusal names the cost', () => {
  const box = sealedSandbox();
  try {
    assert.throws(
      () =>
        seal({
          lockPath: box.lockPath,
          root: 'holdout',
          split: 'holdout',
          seed: HOLDOUT_SEED,
          rulebook_version: RULEBOOK_VERSION,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ResealRefused);
        assert.match(err.message, /Refusing to re-seal/);
        assert.match(err.message, /destroys/i);
        assert.match(err.message, /every prior holdout number as void/i);
        assert.match(err.message, /commit of its own/i);
        assert.match(err.message, /no --force/i);
        return true;
      }
    );
  } finally {
    cleanup(box.dir);
  }
});

test('re-sealing is refused even after the holdout has been tampered with', () => {
  const box = sealedSandbox();
  try {
    // The exact 2am move: the number was bad, a case was "clarified", and now
    // the seal is in the way. It stays in the way.
    writeFileSync(join(box.root, 'ground-truth.json'), '{"entries":[]}\n', 'utf8');
    assert.throws(
      () =>
        seal({
          lockPath: box.lockPath,
          root: 'holdout',
          split: 'holdout',
          seed: HOLDOUT_SEED,
          rulebook_version: RULEBOOK_VERSION,
        }),
      ResealRefused
    );
    assert.equal(verifySeal(box.lockPath).ok, false, 'and the seal still reports the damage');
  } finally {
    cleanup(box.dir);
  }
});

test('deleting the lock is the only way through, and it re-seals the tampered state visibly', () => {
  const box = sealedSandbox();
  try {
    writeFileSync(join(box.root, 'ground-truth.json'), '{"entries":[]}\n', 'utf8');
    rmSync(box.lockPath);
    const relock = seal({
      lockPath: box.lockPath,
      root: 'holdout',
      split: 'holdout',
      seed: HOLDOUT_SEED,
      rulebook_version: RULEBOOK_VERSION,
      now: () => new Date('2026-06-01T00:00:00.000Z'),
    });
    // The new lock verifies, which is precisely why the deletion has to be its
    // own commit: after this point nothing in the files says anything went
    // wrong, and only the history does.
    assert.equal(verifySeal(box.lockPath).ok, true);
    assert.notEqual(relock.files['ground-truth.json'], box.lock.files['ground-truth.json']);
    assert.notEqual(relock.sealed_at, box.lock.sealed_at);
  } finally {
    cleanup(box.dir);
  }
});

test('sealing refuses a directory with no answer key in it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'safeguard-seal-'));
  try {
    mkdirSync(join(dir, 'holdout'));
    writeFileSync(join(dir, 'holdout', 'cases.json'), '{"cases":[]}\n', 'utf8');
    assert.throws(
      () =>
        seal({
          lockPath: join(dir, 'holdout.lock.json'),
          root: 'holdout',
          split: 'holdout',
          seed: HOLDOUT_SEED,
          rulebook_version: RULEBOOK_VERSION,
        }),
      /no ground-truth\.json/
    );
  } finally {
    cleanup(dir);
  }
});

// --- Hashing behaviour ------------------------------------------------------

test('hashing is over raw bytes, so a trailing newline is a change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'safeguard-hash-'));
  try {
    const a = join(dir, 'a.json');
    writeFileSync(a, '{"x":1}', 'utf8');
    const first = hashTree(dir)['a.json'];
    writeFileSync(a, '{"x":1}\n', 'utf8');
    assert.notEqual(hashTree(dir)['a.json'], first);
  } finally {
    cleanup(dir);
  }
});

test('listFiles walks nested directories and returns stable POSIX paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'safeguard-list-'));
  try {
    mkdirSync(join(dir, 'b', 'c'), { recursive: true });
    writeFileSync(join(dir, 'z.json'), '{}');
    writeFileSync(join(dir, 'b', 'y.json'), '{}');
    writeFileSync(join(dir, 'b', 'c', 'x.json'), '{}');
    assert.deepEqual(listFiles(dir), ['b/c/x.json', 'b/y.json', 'z.json']);
  } finally {
    cleanup(dir);
  }
});

// --- The shipped holdout ----------------------------------------------------

test('the holdout that ships in this repository is sealed and intact', () => {
  assert.ok(
    existsSync(DEFAULT_LOCK_PATH),
    'there is no holdout.lock.json; an unsealed holdout is a second development set'
  );
  const status = verifySeal();
  assert.equal(status.ok, true, renderSealStatus(status));
  assert.equal(status.lock.seed, HOLDOUT_SEED);
  assert.equal(status.lock.note, SEAL_NOTE);
  assert.ok('ground-truth.json' in status.lock.files);
});
