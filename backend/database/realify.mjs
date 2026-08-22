/**
 * One-off transform: replace fixture-looking identifiers in seed.sql with
 * realistic ones.
 *
 * Placeholders like 11111111-1111-1111-1111-111111111111 and
 * conv_arjun_status_001 read as obviously synthetic. The business identifiers
 * (POL-…, CLM-…) are deliberately left alone — real policy and claim numbers
 * genuinely look like that, and keeping them stable is what makes the dataset
 * testable by voice.
 *
 * Mapping is derived by hashing each original id, so re-running produces the
 * same output and the emitted id-map stays valid.
 *
 *   node database/realify.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const seedPath = join(here, 'seed.sql');
const mapPath = join(here, 'id-map.json');

/** Deterministic byte stream for a given label. */
function bytesFor(label, count) {
  const out = [];
  let counter = 0;
  while (out.length < count) {
    const digest = createHash('sha256').update(`safeguard:${label}:${counter++}`).digest();
    for (const b of digest) {
      if (out.length < count) out.push(b);
    }
  }
  return Buffer.from(out);
}

/** RFC 4122 version 4 UUID, deterministic in `label`. */
function uuidFor(label) {
  const b = Buffer.from(bytesFor(label, 16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** ElevenLabs-style conversation id: conv_ + 26 lowercase base32 chars. */
function convIdFor(label) {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  const b = bytesFor(`conv:${label}`, 26);
  return 'conv_' + Array.from(b, (byte) => alphabet[byte % alphabet.length]).join('');
}

let sql = readFileSync(seedPath, 'utf8');

// --- UUIDs ------------------------------------------------------------------
// Only rewrite ids that look like fixtures: a single repeated nibble, or a
// short prefix followed by long runs of zeroes.
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const isFixture = (id) => {
  const bare = id.replace(/-/g, '');
  if (/^(.)\1{31}$/.test(bare)) return true;           // all one character
  if (/^(..)\1{15}$/.test(bare)) return true;          // repeated pair, e.g. a1a1a1…
  if ((bare.match(/0/g) || []).length >= 20) return true; // zero-padded counters
  return false;
};

const idMap = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, 'utf8')) : {};

const found = new Set();
for (const match of sql.matchAll(uuidPattern)) {
  if (isFixture(match[0])) found.add(match[0]);
}

for (const original of found) {
  if (!idMap[original]) idMap[original] = uuidFor(original);
}

// Longest-first so no id is a prefix of another during replacement.
for (const original of [...found].sort((a, b) => b.length - a.length)) {
  sql = sql.split(original).join(idMap[original]);
}

// --- Conversation ids -------------------------------------------------------
const convPattern = /conv_[a-z0-9_]+/g;
const convs = new Set(sql.match(convPattern) ?? []);
for (const original of convs) {
  if (!idMap[original]) idMap[original] = convIdFor(original);
  sql = sql.split(original).join(idMap[original]);
}

// --- Transcript role ---------------------------------------------------------
// ElevenLabs emits "user", and that is what the post-call webhook writes.
// Seeded transcripts said "customer", so the dashboard rendered seeded and
// live calls differently.
const roleFixes = (sql.match(/"role":"customer"/g) ?? []).length;
sql = sql.split('"role":"customer"').join('"role":"user"');

writeFileSync(seedPath, sql);
writeFileSync(mapPath, JSON.stringify(idMap, null, 2) + '\n');

console.log(`Rewrote ${found.size} fixture UUIDs`);
console.log(`Rewrote ${convs.size} conversation ids`);
console.log(`Fixed ${roleFixes} transcript role values ("customer" -> "user")`);
console.log(`Wrote id map to ${mapPath}`);
