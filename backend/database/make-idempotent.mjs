/**
 * One-off: add `ON CONFLICT (id) DO NOTHING` to every unguarded INSERT in
 * seed.sql, so re-running the setup file is genuinely safe rather than
 * failing on primary-key violations.
 *
 * Statement boundaries are found by tracking parenthesis depth outside of
 * single-quoted strings — the seeded transcripts contain both semicolons and
 * parentheses inside JSON, so a naive split on ';' would corrupt them.
 *
 *   node database/make-idempotent.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, 'seed.sql');
const sql = readFileSync(path, 'utf8');

/**
 * Split into top-level statements.
 *
 * Handles '' -escaped single-quoted strings AND `--` line comments. Comments
 * matter: the seed contains prose like "Other driver's insurance", and treating
 * that apostrophe as a string delimiter desynchronises the whole scan.
 */
function statementRanges(text) {
  const ranges = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  let inComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inComment) {
      if (ch === '\n') inComment = false;
      continue;
    }

    if (inString) {
      if (ch === "'") {
        if (text[i + 1] === "'") i++; // escaped quote inside the literal
        else inString = false;
      }
      continue;
    }

    if (ch === '-' && text[i + 1] === '-') { inComment = true; i++; continue; }
    if (ch === "'") { inString = true; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }

    if (ch === ';' && depth === 0) {
      ranges.push({ start, end: i, text: text.slice(start, i) });
      start = i + 1;
    }
  }
  return ranges;
}

const ranges = statementRanges(sql);
const edits = [];

/** Drop leading blank lines and `--` comments so the verb is first. */
const stripLeadingComments = (text) =>
  text
    .split('\n')
    .reduce((acc, line) => {
      if (acc.started) { acc.lines.push(line); return acc; }
      const t = line.trim();
      if (t === '' || t.startsWith('--')) return acc;
      acc.started = true;
      acc.lines.push(line);
      return acc;
    }, { started: false, lines: [] })
    .lines.join('\n')
    .trim();

for (const r of ranges) {
  const body = stripLeadingComments(r.text);
  const match = /^INSERT\s+INTO\s+([a-z_]+)/i.exec(body);
  if (!match) continue;
  if (/ON\s+CONFLICT/i.test(body)) continue;
  edits.push({ at: r.end, table: match[1] });
}

let out = sql;
// Apply from the end so earlier offsets stay valid.
for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
  out = out.slice(0, edit.at) + '\nON CONFLICT (id) DO NOTHING' + out.slice(edit.at);
}

writeFileSync(path, out);

console.log(`Statements scanned : ${ranges.length}`);
console.log(`Guards added       : ${edits.length}`);
for (const e of edits) console.log(`  + ON CONFLICT (id) DO NOTHING  ->  ${e.table}`);
