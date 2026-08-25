/**
 * The holdout seal.
 *
 * A held-out score is only worth anything if the holdout did not move. The
 * failure this guards against is not a villain editing the answer key. It is
 * doing it half-deliberately, at 2am, after a disappointing number, and not
 * quite noticing that the held-out claim died in the process — a case
 * "clarified", a label "corrected", a file reformatted by an editor on save.
 * Each of those is defensible on its own and none of them is defensible after
 * the number has been seen.
 *
 * So: a sha256 per file, taken over the raw bytes, recorded before any
 * adjudication code was measured against the set. Raw bytes, not parsed JSON,
 * because an answer key that survives being reformatted is an answer key that
 * can be edited and reformatted back.
 *
 * Three ways the seal can break, and all three are breaks:
 *   changed — a sealed file's bytes differ
 *   missing — a sealed file is gone
 *   added   — a file appeared in the sealed directory that was not sealed
 *
 * The third one matters as much as the first. A holdout you can append to is a
 * holdout you can dilute.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCK_VERSION = 1;

export interface LockFile {
  version: number;
  algorithm: 'sha256';
  split: string;
  /** The seed the sealed split was generated from. Recorded so anyone can
   *  check it is not the development seed. */
  seed: number;
  /** The rulebook the sealed labels were derived under. */
  rulebook_version: string;
  sealed_at: string;
  /** Sealed directory, relative to the directory holding the lock file. */
  root: string;
  /** Relative path (POSIX separators) -> lowercase hex sha256 of the bytes. */
  files: Record<string, string>;
  /** What re-sealing destroys. Written into the artefact, not just the docs. */
  note: string;
}

export interface SealStatus {
  ok: boolean;
  /** Sealed files whose bytes differ from the recorded digest. */
  changed: string[];
  /** Sealed files that are no longer on disk. */
  missing: string[];
  /** Files in the sealed directory that the lock does not cover. */
  added: string[];
  lockPath: string;
  rootPath: string;
  lock: LockFile;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** `backend/eval/holdout.lock.json`. */
export const DEFAULT_LOCK_PATH = join(HERE, 'holdout.lock.json');

/** What the lock file says about what re-sealing costs. */
export const SEAL_NOTE =
  'Re-sealing destroys the only evidence that the holdout predates the measurement. ' +
  'Every number ever reported against this split becomes a number reported against a ' +
  'dataset that could have been adjusted to produce it, including the numbers already ' +
  'published. There is no way to re-earn that, because the thing being proved is an ' +
  'ordering in time and the proof is the fact that this file was not touched. ' +
  'If the holdout genuinely has to change: delete this lock in a commit of its own, ' +
  'whose message states what was wrong and who decided, then re-seal in a separate ' +
  'commit and treat every prior holdout number as void.';

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

/** Every file under `root`, recursively, as sorted POSIX-relative paths. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

export function hashTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const rel of listFiles(root)) files[rel] = sha256File(join(root, rel));
  return files;
}

export function readLock(lockPath = DEFAULT_LOCK_PATH): LockFile {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as LockFile;
  if (lock.version !== LOCK_VERSION) {
    throw new Error(`readLock: unsupported lock version ${lock.version}, expected ${LOCK_VERSION}`);
  }
  if (lock.algorithm !== 'sha256') {
    throw new Error(`readLock: unsupported algorithm ${lock.algorithm}`);
  }
  return lock;
}

/**
 * Check the sealed directory against the lock.
 *
 * Never throws on a broken seal — a broken seal is a result, and the caller
 * decides what to do about it. Throws only when the lock itself is unreadable.
 */
export function verifySeal(lockPath = DEFAULT_LOCK_PATH): SealStatus {
  const lock = readLock(lockPath);
  const rootPath = join(dirname(lockPath), lock.root);

  const changed: string[] = [];
  const missing: string[] = [];

  for (const [rel, expected] of Object.entries(lock.files)) {
    const full = join(rootPath, ...rel.split('/'));
    if (!existsSync(full)) {
      missing.push(rel);
      continue;
    }
    if (sha256File(full) !== expected) changed.push(rel);
  }

  const onDisk = existsSync(rootPath) ? listFiles(rootPath) : [];
  const added = onDisk.filter((rel) => !(rel in lock.files));

  return {
    ok: changed.length === 0 && missing.length === 0 && added.length === 0,
    changed: changed.sort(),
    missing: missing.sort(),
    added: added.sort(),
    lockPath,
    rootPath,
    lock,
  };
}

/** Raised when a seal already exists and someone asks for another one. */
export class ResealRefused extends Error {
  constructor(public readonly lockPath: string, public readonly lock: LockFile) {
    super(
      [
        `Refusing to re-seal: ${lockPath} already exists.`,
        '',
        `It was sealed at ${lock.sealed_at}, over ${Object.keys(lock.files).length} file(s),`,
        `from seed ${lock.seed} under rulebook v${lock.rulebook_version}.`,
        '',
        lock.note,
        '',
        'There is no --force for this. Deleting the lock is the override, and it has to',
        'be its own commit with a stated reason, so that the decision is visible to',
        'someone reading the history later rather than buried in a diff.',
      ].join('\n')
    );
    this.name = 'ResealRefused';
  }
}

export interface SealOptions {
  lockPath?: string;
  /** Sealed directory, relative to the lock file's directory. */
  root: string;
  split: string;
  seed: number;
  rulebook_version: string;
  /** Injectable for tests; defaults to now. */
  now?: () => Date;
}

/**
 * Write a lock over `root`.
 *
 * Refuses outright if a lock is already there. This is the whole mechanism:
 * the refusal is not a safety rail around the real operation, it *is* the
 * operation, and the only way past it is an explicit deletion that leaves a
 * trace in the history.
 */
export function seal(opts: SealOptions): LockFile {
  const lockPath = opts.lockPath ?? DEFAULT_LOCK_PATH;
  if (existsSync(lockPath)) throw new ResealRefused(lockPath, readLock(lockPath));

  const rootPath = join(dirname(lockPath), opts.root);
  if (!existsSync(rootPath)) throw new Error(`seal: nothing to seal at ${rootPath}`);

  const files = hashTree(rootPath);
  if (Object.keys(files).length === 0) throw new Error(`seal: ${rootPath} is empty`);
  if (!('ground-truth.json' in files)) {
    // The one file whose integrity is the entire point. Sealing a holdout
    // without its answer key seals the questions and leaves the answers loose.
    throw new Error(`seal: ${rootPath} has no ground-truth.json; refusing to seal a holdout without its answer key`);
  }

  const lock: LockFile = {
    version: LOCK_VERSION,
    algorithm: 'sha256',
    split: opts.split,
    seed: opts.seed,
    rulebook_version: opts.rulebook_version,
    sealed_at: (opts.now?.() ?? new Date()).toISOString(),
    root: opts.root,
    files,
    note: SEAL_NOTE,
  };

  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return lock;
}

/** Human-readable seal status, for a CLI or a report header. */
export function renderSealStatus(status: SealStatus): string {
  const lines: string[] = [];
  lines.push(`Holdout seal: ${status.ok ? 'INTACT' : 'BROKEN'}`);
  lines.push(`  sealed_at    ${status.lock.sealed_at}`);
  lines.push(`  seed         ${status.lock.seed}`);
  lines.push(`  rulebook     v${status.lock.rulebook_version}`);
  lines.push(`  files sealed ${Object.keys(status.lock.files).length}`);
  if (status.ok) return lines.join('\n');

  const section = (title: string, items: string[], gloss: string) => {
    if (items.length === 0) return;
    lines.push('');
    lines.push(`  ${title} (${items.length}) — ${gloss}`);
    for (const item of items) lines.push(`    ${item}`);
  };
  section('changed', status.changed, 'the bytes are not the bytes that were sealed');
  section('missing', status.missing, 'a sealed file is gone');
  section('added', status.added, 'a file appeared that was never sealed; a holdout you can append to is a holdout you can dilute');
  lines.push('');
  lines.push('  Any held-out number produced against this directory is not a held-out number.');
  return lines.join('\n');
}
