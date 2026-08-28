#!/usr/bin/env node
/**
 * Answers one question: do the numbers written in the documentation still match
 * the system they describe?
 *
 *   node scripts/check-numbers.mjs          (or: cd backend && npm run check:numbers)
 *
 * Every count in this repository's markdown is hand-typed, and hand-typed counts
 * rot. In a single day the backend test count was wrong in eleven places across
 * five files, the tool count was written as 11, 13 and 13 when the definition
 * holds 14, the table count was written as 17 when run-all.sql creates 18, and
 * the evaluation case total was 204 everywhere while production had already
 * moved it to 206. None of that was visible: nothing read the source of truth
 * and nothing compared it to the prose. A twenty-claim test batch is planned,
 * which will move the claim, policy and case counts again.
 *
 * So this script does what check-drift.mjs does for deployments: it reads the
 * ground truth, puts it next to what the docs assert, and exits non-zero when
 * they disagree — so stale documentation is a failed command rather than
 * something a reader finds first.
 *
 * ---------------------------------------------------------------------------
 * DESIGN DECISION: verification in place, not generated blocks
 * ---------------------------------------------------------------------------
 *
 * There are two ways to keep prose and reality in step.
 *
 *   (a) Markers. Wrap every generated figure in `<!-- numbers:start -->` /
 *       `<!-- numbers:end -->` and regenerate the block. Robust — a marked
 *       block cannot silently drift, and coverage is exact by construction.
 *
 *   (b) In place. Grep the documentation as written for the phrasings that
 *       carry a number, and check the number sitting next to each one.
 *
 * This script does (b), for three reasons.
 *
 *   1. It works on the documentation that exists today. Markers require
 *      editing eight markdown files before a single check can run, and those
 *      files are being written by other people right now. A checker that first
 *      demands a coordinated rewrite of the thing it is meant to check is a
 *      checker that does not run this week.
 *   2. Markers protect only what is inside them. The 204s that went stale were
 *      not in a table anyone would have thought to mark — they were mid-
 *      sentence, in prose, in six different phrasings. Marking a block moves
 *      the risk rather than removing it: the figure that drifts next is the one
 *      nobody wrapped.
 *   3. The prose is the point. These documents argue with their numbers
 *      ("adding the model made it worse by 21 cases"). Numbers extracted into a
 *      generated block stop being part of the argument, and the sentence around
 *      them goes on being hand-written and goes on drifting.
 *
 * The cost of (b) is real and is stated plainly rather than hidden: a pattern
 * only matches the phrasings it was written for. Reword a sentence and its
 * check stops matching — so every check reports how many occurrences it found,
 * and a check that found none says so loudly instead of passing quietly. That
 * failure mode is visible. The failure mode it replaces — a number that is
 * simply wrong — was not.
 *
 * ---------------------------------------------------------------------------
 * GROUND TRUTH — every figure below is read, never assumed
 * ---------------------------------------------------------------------------
 *
 *   live database       claims, policies, customers, evidence bundles, counted
 *                       over PostgREST with the service-role key. Read-only:
 *                       GET with `Prefer: count=exact` and `Range: 0-0`, which
 *                       returns the count in a header and no rows.
 *   seeded dataset      distinct CLM-/POL- identifiers in database/run-all.sql,
 *                       which is a different number from the live one and is
 *                       supposed to be.
 *   hand-written cases  the literal CASES array in backend/scripts/evaluate.mjs,
 *                       counted in the source. Not hardcoded as 27 here: the
 *                       whole point is that a number nobody recounts goes stale.
 *   evaluation cases    27 + (2 x claims) + (1 x policies), the shape
 *                       coverage-cases.mjs generates — one lookup case and one
 *                       document case per claim, one case per policy.
 *   test counts         the runners, not a grep. `npm test` over src/**\/*.test.ts
 *                       and `npx tsx --test eval/tests/*.test.ts`. A static count
 *                       of `it(` gives 573 against the runner's 606, because
 *                       tests generated in loops are invisible to grep. The
 *                       runner is authoritative; pass --no-tests to skip it.
 *   tool count          `toolType:` inside the AGENT_TOOLS array only. The two
 *                       interface declarations further up the same file also
 *                       match a naive grep and inflate the count by one.
 *   route count         '/tools/...' route registrations. webhook-tools.ts
 *                       writes the path inline; deductible-tools.ts passes it as
 *                       a separate argument on its own line, which a
 *                       `fastify.post('/tools/` grep misses — that omission is
 *                       exactly why "13" is in circulation.
 *   table count         CREATE TABLE statements in database/run-all.sql.
 *   arm scores, rupees  backend/eval/results/run-dev.json, the machine-readable
 *                       twin of four-arm-dev.txt.
 *   pinned baseline     the book as it stood at the recorded evaluation run,
 *                       read out of the prose itself. See below — it is the one
 *                       ground truth this script cannot read from the system,
 *                       because the system no longer holds it.
 *
 * ---------------------------------------------------------------------------
 * FROZEN MEASUREMENTS: a figure that is right precisely because it is old
 * ---------------------------------------------------------------------------
 *
 * The evaluation table in EVALUATION.md and README.md reads 204 cases / 177
 * generated. A run today reports 206 / 179. Both are correct. The table is the
 * record of a run made on 2026-08-27 at commit `020462f`, when the book held 63
 * claims; `CLM-2026-976488` was filed through the live agent that morning and
 * took it to 64. Editing a measured table to a number nobody measured is the
 * failure those documents exist to avoid, so the table is left alone and the
 * drift is disclosed in prose beside it.
 *
 * An earlier version of this script had no way to see that, and failed on
 * thirteen figures that were all correct. The fix is NOT an exclusion list —
 * "ignore 204 in these nine places" would excuse a genuinely stale 204 the
 * moment somebody wrote one. Instead:
 *
 *   1. RECOMPUTE, don't hardcode. The prose declares the baseline in the open —
 *      "when the database held 63 claims and 51 policies", "at the recorded run
 *      that was 63 claims and 51 policies", and a two-column then/now table in
 *      README.md. Those declarations are collected, required to agree with each
 *      other, and the historical figures are derived from them by the same
 *      arithmetic used for the live ones: generated = 2 x claims + policies,
 *      total = hand-written + generated. 177 and 204 are computed here, never
 *      typed here. If the declared baseline changes, so do they.
 *   2. REQUIRE THE DRIFT TO BE DISCLOSED, AND CHECK THE DISCLOSURE. The
 *      `eval-drift` check below reads every sentence that states the present-day
 *      figure — "the denominator moved from 204 to 206", "a run today generates
 *      179 of them and 206 cases in total", the Today column of that table — and
 *      checks each against the LIVE database. Those are live assertions and must
 *      track the present.
 *   3. ARM ON THE CONJUNCTION. A figure is accepted as frozen only if the
 *      baseline was established (1), the drift disclosure exists and every one of
 *      its numbers is currently correct (2), and the figure equals the recomputed
 *      historical value for that quantity. All three, or it fails as before.
 *
 * WHY THIS IS SOUND. The interlock means the exclusion cannot outlive its
 * justification. When the book grows to 65 claims, the live figures become
 * 181/208, every "today" sentence in the corpus goes stale, `eval-drift` fails,
 * the arming drops, and the 204s fail too — the run goes red, and it goes red at
 * the sentence that is actually wrong. Nothing here can quietly hold a stale
 * number in place: the only way to keep the 204s excused is to keep the
 * present-day disclosure correct, which is exactly the behaviour being defended.
 * And the exclusion is narrow — it recognises only the two recomputed historical
 * values. A 205, a 178, a 200 still fails wherever it appears.
 *
 * HOW IT COULD STILL MISS. Stated plainly, because a rule that silently excuses
 * a stale number is worse than the false positive it replaces:
 *
 *   - It cannot read tense. A genuinely present-tense sentence written today as
 *     "the harness runs 204 cases" would be accepted as a frozen figure. The
 *     mitigation is visibility, not cleverness: every figure accepted as frozen
 *     is printed by file and line under `frozen` in the report, with a count, so
 *     what was excused is on the screen rather than absent from it. It is never
 *     silent.
 *   - It is corpus-wide, not per-document. SUBMISSION.md quotes 177 with no run
 *     pin of its own; it is accepted because the corpus as a whole establishes
 *     and reconciles the baseline. That is deliberate — these eight files are one
 *     deliverable and cross-reference each other — but it does mean a document
 *     can lean on a disclosure that lives in another file.
 *   - If the book ever returned to 63 claims, live and historical would coincide
 *     and the distinction would go vacuous. Harmless, but not meaningful either.
 *
 * The failure it will not have: if the baseline declarations are deleted or
 * reworded away, the pinned baseline cannot be established, arming never
 * happens, and the frozen figures fail loudly rather than passing quietly.
 *
 * ---------------------------------------------------------------------------
 * SEED VERSUS LIVE: the same sentence shape, two different truths
 * ---------------------------------------------------------------------------
 *
 * "The dataset holds 32 customers, 51 policies and 62 claims in all" and "The
 * database holds 32 customers, 51 policies, and 64 claims" are the same shape and
 * mean different things, and both are correct. The qualifier in front of `holds`
 * is what decides, so the two checks below match on it: the seed check owns
 * `dataset`, the live check owns `database`, the alternations are disjoint by
 * construction, and a sentence can only ever land in one of them. Neither check
 * matches an unqualified subject — if a sentence names neither, no check claims
 * it and the NONE line will say a check is watching nothing.
 *
 * This does NOT check every number in the corpus, and it prints how many it did
 * check. See the coverage note at the end of the output.
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(ROOT, 'backend');
const RUN_TESTS = !process.argv.includes('--no-tests');

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const DOCS = [
  'ARCHITECTURE.md',
  'DEPLOYMENT.md',
  'EVALUATION.md',
  'PRODUCT_PRD.md',
  'README.md',
  'SUBMISSION.md',
  'TECHSTACK.md',
  'TESTING.md',
];

const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

// --- number words -----------------------------------------------------------
//
// The docs write counts both ways — "18 tables" in DEPLOYMENT.md, "Fourteen
// tools" in ARCHITECTURE.md, "the other eleven" in PRODUCT_PRD.md — so a check
// that only understands digits misses half of what it is looking at.

const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen'];
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

function parseNum(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toLowerCase().replace(/,/g, '');
  if (/^\d+$/.test(s)) return Number(s);
  const compound = s.match(/^([a-z]+)-([a-z]+)$/);
  if (compound && TENS[compound[1]] !== undefined) {
    const u = UNITS.indexOf(compound[2]);
    if (u > 0) return TENS[compound[1]] + u;
  }
  if (TENS[s] !== undefined) return TENS[s];
  const u = UNITS.indexOf(s);
  return u >= 0 ? u : null;
}

// A closed alternation rather than \w+: an open one would let any word land in
// a numeric slot and turn a missed match into a confusing failure. Each word is
// written [Tt]welve so a sentence-initial "Fourteen tools" matches too.
const cap = (w) => `[${w[0].toUpperCase()}${w[0]}]${w.slice(1)}`;
const WORD_ALT = [
  ...Object.keys(TENS).map((t) => `${cap(t)}-(?:${UNITS.slice(1, 10).join('|')})`),
  ...Object.keys(TENS).map(cap),
  ...[...UNITS].reverse().map(cap),
].join('|');
const N = `(\\d{1,4}(?:,\\d{3})?|(?:${WORD_ALT}))`;

// Markdown here is hard-wrapped, so any literal space in a pattern may be a
// newline in the file. Every space becomes \s+ rather than each pattern having
// to remember.
const rx = (source, flags = 'g') =>
  new RegExp(source.replace(/ /g, '\\s+').replace(/#N#/g, N), flags);

// --- indian digit grouping, for the rupee figures ---------------------------

function inr(n) {
  const s = String(Math.abs(Math.round(n)));
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  let rest = s.slice(0, -3);
  const parts = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return `${parts.join(',')},${last3}`;
}

// ============================================================================
// GROUND TRUTH
// ============================================================================

const truth = {};
const unavailable = [];

// --- live database (read-only) ----------------------------------------------

function loadEnv() {
  const out = { ...process.env };
  for (const f of [path.join(BACKEND, '.env'), path.join(ROOT, '.env')]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      if (out[m[1]] && process.env[m[1]]) continue;
      out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

const env = loadEnv();

async function countRows(table) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    // GET only. Nothing in this script writes to the database.
    const res = await fetch(`${url}/rest/v1/${table}?select=id`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' },
      signal: AbortSignal.timeout(20_000),
    });
    const range = res.headers.get('content-range');
    const total = range?.split('/')[1];
    return total && total !== '*' ? Number(total) : null;
  } catch {
    return null;
  }
}

for (const [key, table] of [['claims', 'claims'], ['policies', 'policies'], ['customers', 'customers'], ['bundles', 'evidence_bundles']]) {
  truth[key] = await countRows(table);
  if (truth[key] === null) unavailable.push(`live ${table} count`);
}

// --- the seeded dataset, which is a different number on purpose -------------

const sql = read('backend/database/run-all.sql');
truth.seedClaims = new Set(sql.match(/'CLM-[0-9-]+'/g) ?? []).size || null;
truth.seedPolicies = new Set(sql.match(/'POL-[0-9-]+'/g) ?? []).size || null;
// One email per customer row and no two alike, so distinct addresses is the row
// count. Customers have no CLM-/POL- style identifier to count instead.
truth.seedCustomers = new Set(sql.match(/'[a-z][a-z.'-]*@email\.com'/g) ?? []).size || null;
truth.tables = (sql.match(/^\s*CREATE TABLE\b/gim) ?? []).length || null;

// --- hand-written evaluation cases, counted in the source -------------------

const evaluateSrc = read('backend/scripts/evaluate.mjs');
const casesBlock = evaluateSrc.match(/const CASES\s*=\s*\[([\s\S]*?)\n\];/);
truth.handWritten = casesBlock ? (casesBlock[1].match(/^\s{4}id:\s/gm) ?? []).length || null : null;
if (!truth.handWritten) unavailable.push('CASES array in backend/scripts/evaluate.mjs');

// --- demo fixtures are not scored, so they are not counted here -------------
//
// coverage-cases.mjs excludes the journey-batch policies listed in
// database/batch-journey-policies.json, and any claim filed against one. They
// are fixtures for a recorded walkthrough, not cases any run has executed.
//
// This file has to apply the same rule, from the same file, or the checker and
// the generator disagree about how big the evaluation is — and the checker
// would then demand the docs state a number no run produces. The rule lives in
// two places because these two scripts share nothing; the JSON is what keeps
// them honest.
//
// A missing file excludes nothing, which fails in the direction that shows.
truth.fixturePolicies = 0;
try {
  const fixtures = JSON.parse(read('backend/database/batch-journey-policies.json'));
  truth.fixturePolicies = fixtures.length;
} catch {
  truth.fixturePolicies = 0;
}

truth.scoredPolicies = truth.policies !== null ? truth.policies - truth.fixturePolicies : null;

// coverage-cases.mjs emits two cases per claim (the lookup and the documents)
// and one per policy, on top of the hand-written set.
truth.generated =
  truth.claims !== null && truth.scoredPolicies !== null
    ? 2 * truth.claims + truth.scoredPolicies
    : null;
truth.evalTotal = truth.generated !== null && truth.handWritten ? truth.handWritten + truth.generated : null;

// --- agent tools, from the AGENT_TOOLS array only ---------------------------

const agentDef = read('backend/src/config/agent-definition.ts');
const toolsBlock = agentDef.match(/export const AGENT_TOOLS[^=]*=\s*\[([\s\S]*?)\n\];/);
if (toolsBlock) {
  const types = [...toolsBlock[1].matchAll(/^\s*toolType:\s*'(\w+)'/gm)].map((m) => m[1]);
  truth.tools = types.length || null;
  truth.toolsWebhook = types.filter((t) => t === 'webhook').length || null;
  truth.toolsClient = types.filter((t) => t === 'client').length || null;
} else {
  unavailable.push('AGENT_TOOLS array in backend/src/config/agent-definition.ts');
}

// --- /api/tools/* routes ----------------------------------------------------
//
// The path is matched wherever it sits relative to the verb, because two files
// place it differently and a grep that assumes one of them undercounts.

const routePaths = new Set();
const routesDir = path.join(BACKEND, 'src', 'routes');
for (const f of existsSync(routesDir) ? readdirSync(routesDir) : []) {
  if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
  const src = readFileSync(path.join(routesDir, f), 'utf8');
  for (const m of src.matchAll(/\b(?:fastify|app|server)\.(?:post|get|put|patch|delete)\(\s*'(\/tools\/[a-z0-9-]+)'/g)) {
    routePaths.add(m[1]);
  }
}
truth.routes = routePaths.size || null;

// --- test counts, from the runners ------------------------------------------

function runTests(label, command) {
  let out = '';
  try {
    out = execSync(command, { cwd: BACKEND, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 });
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (!out) {
      unavailable.push(`${label} (runner failed: ${error.message.split('\n')[0]})`);
      return null;
    }
  }
  const total = out.match(/^(?:ℹ|#)\s*tests\s+(\d+)/m)?.[1];
  const failed = out.match(/^(?:ℹ|#)\s*fail\s+(\d+)/m)?.[1];
  if (!total) {
    unavailable.push(`${label} (runner produced no test count)`);
    return null;
  }
  if (failed && Number(failed) > 0) {
    console.log(yellow(`  note: ${label} reported ${failed} failing test(s); the count below is still the runner's.`));
  }
  return Number(total);
}

if (RUN_TESTS) {
  truth.backendTests = runTests('npm test', 'npm test');
  truth.harnessTests = runTests('eval harness tests', 'npx tsx --test "eval/tests/*.test.ts"');
} else {
  truth.backendTests = null;
  truth.harnessTests = null;
  unavailable.push('test counts (--no-tests)');
}

// --- four-arm evaluation results --------------------------------------------

let arms = null;
let runDevScores = null;
const rupeeSet = new Set([0]);
const runDevPath = path.join(BACKEND, 'eval', 'results', 'run-dev.json');
if (existsSync(runDevPath)) {
  const runDev = JSON.parse(readFileSync(runDevPath, 'utf8'));
  const s = runDev.scores ?? {};
  runDevScores = s;
  const pick = (k) => s[k]?.exact_match ?? null;
  arms = {
    A: { score: pick('arm_a'), pred: s.arm_a?.by_prediction },
    B: { score: pick('arm_b_run1'), pred: s.arm_b_run1?.by_prediction },
    C: { score: pick('arm_c_run1'), pred: s.arm_c_run1?.by_prediction },
    D: { score: pick('arm_d'), pred: s.arm_d?.by_prediction },
    truthMix: s.arm_a?.by_truth ?? null,
  };
  // Every rupee figure the run recorded, plus the within-arm pairs the docs are
  // entitled to add: SUBMISSION.md quotes arm A's wrong approvals plus its
  // unreviewed settlements as one number, and that sum is a real figure.
  const CATS = ['wrong_approvals', 'wrong_denials', 'missed_escalation_paid', 'missed_escalation_refused', 'over_escalation'];
  for (const armKey of Object.keys(s)) {
    const totals = [];
    for (const cat of CATS) {
      const v = s[armKey]?.[cat];
      if (!v) continue;
      if (typeof v.rupees === 'number') { rupeeSet.add(v.rupees); totals.push(v.rupees); }
      for (const c of v.cases ?? []) if (typeof c.rupees === 'number') rupeeSet.add(c.rupees);
    }
    for (let i = 0; i < totals.length; i++) {
      for (let j = i + 1; j < totals.length; j++) rupeeSet.add(totals[i] + totals[j]);
    }
  }
} else {
  unavailable.push('backend/eval/results/run-dev.json');
}

// ============================================================================
// THE CORPUS
// ============================================================================
//
// Read before the checks are built, because one ground truth — the book as it
// stood at the recorded evaluation run — exists nowhere else. The database has
// moved past it and no artifact of that run was kept.

const files = DOCS.filter((f) => existsSync(path.join(ROOT, f)));
const missingDocs = DOCS.filter((f) => !existsSync(path.join(ROOT, f)));
const corpus = files.map((f) => {
  const text = read(f);
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return { file: f, text, starts };
});

function lineOfIn({ starts }, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// --- the pinned baseline ----------------------------------------------------
//
// Collected from the prose, cross-checked against itself, never hardcoded. Every
// declaration found must agree; one disagreement and the baseline is refused,
// which means no figure gets excused as frozen and the run behaves as it did
// before this rule existed. See the FROZEN MEASUREMENTS note in the header.

const BASELINE_DECLARATIONS = [
  { re: rx(String.raw`when the database held #N# claims and #N# policies`), keys: ['claims', 'policies'] },
  { re: rx(String.raw`at the recorded run that was #N# claims and #N# policies`), keys: ['claims', 'policies'] },
  { re: rx(String.raw`spanned all #N# claims and all #N# policies the database held at the time`), keys: ['claims', 'policies'] },
  { re: rx(String.raw`over the #N# claims and #N# policies it then held`), keys: ['claims', 'policies'] },
  { re: rx(String.raw`\(2 ?[x×] ?#N#\) \+ #N# at the time of that run`), keys: ['claims', 'policies'] },
  { re: rx(String.raw`\|\s*Claims in the database\s*\|\s*\*{0,2}#N#\*{0,2}\s*\|`), keys: ['claims'] },
  { re: rx(String.raw`\|\s*Policies in the database\s*\|\s*\*{0,2}#N#\*{0,2}\s*\|`), keys: ['policies'] },
  { re: rx(String.raw`puts the run at #N# claims`), keys: ['claims'] },
];

const baselineVotes = { claims: new Map(), policies: new Map() };
for (const doc of corpus) {
  for (const { re, keys } of BASELINE_DECLARATIONS) {
    re.lastIndex = 0;
    for (const m of doc.text.matchAll(re)) {
      keys.forEach((key, i) => {
        const v = parseNum(m[i + 1]);
        if (v === null) return;
        if (!baselineVotes[key].has(v)) baselineVotes[key].set(v, []);
        baselineVotes[key].get(v).push(`${doc.file}:${lineOfIn(doc, m.index)}`);
      });
    }
  }
}

const pinned = { ok: false, why: null, sources: [] };
{
  const claimVotes = [...baselineVotes.claims.keys()];
  const policyVotes = [...baselineVotes.policies.keys()];
  if (claimVotes.length === 0 || policyVotes.length === 0) {
    pinned.why = 'no sentence in the eight files declares the book size at the recorded run';
  } else if (claimVotes.length > 1 || policyVotes.length > 1) {
    pinned.why = `the corpus declares the run's book size inconsistently (claims: ${claimVotes.join('/')}, policies: ${policyVotes.join('/')})`;
  } else if (!truth.handWritten) {
    pinned.why = 'the hand-written case count could not be read, so the historical total cannot be recomputed';
  } else {
    pinned.ok = true;
    pinned.claims = claimVotes[0];
    pinned.policies = policyVotes[0];
    // Same arithmetic as the live figures. Recomputed, not transcribed.
    pinned.generated = 2 * pinned.claims + pinned.policies;
    pinned.handWritten = truth.handWritten;
    pinned.total = truth.handWritten + pinned.generated;
    pinned.sources = [
      ...baselineVotes.claims.get(pinned.claims),
      ...baselineVotes.policies.get(pinned.policies),
    ];
  }
}

// Armed only after the drift-disclosure check has run and passed; see the SCAN
// loop. Until then nothing is excused.
const frozen = { armed: false, why: 'the drift-disclosure check has not run yet', accepted: [] };

// Maps a live ground truth onto the value the same quantity had at the pinned
// run. Anything not listed here has no historical twin and can never be excused.
function pinnedTwin(liveValue) {
  if (!pinned.ok || liveValue === null || liveValue === undefined) return null;
  if (liveValue === truth.evalTotal) return pinned.total;
  if (liveValue === truth.generated) return pinned.generated;
  if (liveValue === truth.handWritten) return pinned.handWritten;
  return null;
}

// ============================================================================
// CHECKS
// ============================================================================
//
// Each check names the ground truth it defends and the phrasings it recognises.
// `expect` lists the expected value per capture group, in order.

const T = truth;
const P = pinned;

// One sentence shape, two ground truths, told apart by the word in front of
// `holds`. Written once and shared by both checks so the two halves cannot drift
// apart, and disjoint by construction — `dataset` and `database` share a prefix
// and nothing else, so no sentence can match both.
const SEED_SUBJECT = String.raw`(?:[Tt]he )?(?:seeded |seed )?dataset`;
const LIVE_SUBJECT = String.raw`(?:[Tt]he )?(?:live |production )?database`;
const HOLDS_TRIPLE = String.raw` (?:now |currently )?holds[^.\n]{0,60}? #N# customers, #N# policies,? and #N# claims`;

const checks = [
  {
    id: 'backend-tests',
    label: 'backend test count',
    truth: T.backendTests,
    source: RUN_TESTS ? 'npm test (node --test over src/**/*.test.ts)' : 'skipped (--no-tests)',
    patterns: [
      rx(String.raw`npm test[^\n]*?#N# tests`),
      rx(String.raw`#N# tests[^.\n]{0,40}(?:at \x60?[0-9a-f]{7}|under \x60?src|across (?:\w+|\d+) files|, built from|, as the runner|, all passing)`),
      rx(String.raw`backend (?:test )?suite[^.\n]{0,40}?\b(?:is|stands at) \*{0,2}#N# tests`),
      rx(String.raw`out of #N# in the`),
      rx(String.raw`\*{0,2}not\*{0,2} (?:in that|in the|part of the) #N#\b`),
      rx(String.raw`backend's #N# tests`),
      rx(String.raw`#N# across \x60backend/src\x60`),
      rx(String.raw`[Aa]ll #N# and all \d+ pass`),
    ],
  },
  {
    id: 'harness-tests',
    label: 'eval-harness test count (backend/eval/tests/)',
    truth: T.harnessTests,
    source: RUN_TESTS ? 'npx tsx --test eval/tests/*.test.ts' : 'skipped (--no-tests)',
    patterns: [
      // Anchored on the eval directory or on "a further", never on a bare
      // "The N tests" — that would happily match the backend total and fail.
      rx(String.raw`[Aa] further \*{0,2}#N#\*{0,2} tests`),
      rx(String.raw`(?:The|the) #N# tests under\s*\x60?backend/eval`),
      rx(String.raw`#N# tests live in \x60?backend/eval`),
      rx(String.raw`excludes\*{0,2} the #N# harness tests`),
      rx(String.raw`[Aa]ll \d+ and all #N# pass`),
    ],
  },
  {
    // Runs BEFORE eval-cases, and arms it. Every pattern here reads a sentence
    // that states the present-day figure, and checks it against the live
    // database. These are the sentences that disclose the drift away from the
    // recorded run; if any of them is wrong, or none of them is found, the
    // frozen-figure exclusion below does not arm and the historical figures are
    // held to the live truth like everything else.
    id: 'eval-drift',
    label: 'present-day case counts (the disclosure beside the frozen table)',
    truth: T.evalTotal,
    source: `live: ${T.generated ?? '?'} generated / ${T.evalTotal ?? '?'} total; pinned run: ${P.ok ? `${P.generated} / ${P.total}` : 'not established'}`,
    hint: 'these sentences state what a run reports TODAY. While any of them is wrong the frozen 204/177 figures are not excused either, and will be reported as drift below.',
    patterns: [
      { re: rx(String.raw`taking the book from #N# claims to #N#`), expect: () => [P.claims ?? null, T.claims] },
      { re: rx(String.raw`The denominator moved from #N# to #N#`), expect: () => [P.total ?? null, T.evalTotal] },
      { re: rx(String.raw`Coverage group from #N# generated cases to #N#`), expect: () => [P.generated ?? null, T.generated] },
      { re: rx(String.raw`the current denominator is #N#, not #N#`), expect: () => [T.evalTotal, P.total ?? null] },
      { re: rx(String.raw`report today is #N#:`), expect: () => [T.evalTotal] },
      { re: rx(String.raw`[Pp]roduction currently holds #N# claims and #N# policies`), expect: () => [T.claims, T.policies] },
      { re: rx(String.raw`a run today generates \*{0,2}#N#\*{0,2} of them and \*{0,2}#N#\*{0,2} cases in total`), expect: () => [T.generated, T.evalTotal] },
      { re: rx(String.raw`[Aa] run today generates \*{0,2}#N#\*{0,2} cases`), expect: () => [T.evalTotal] },
      { re: rx(String.raw`\(2 ?[x×] ?#N#\) \+ #N# = #N# against the book as it stands today`), expect: () => [T.claims, T.scoredPolicies, T.generated] },
      { re: rx(String.raw`#N# generated in the measured run and #N# against today's book`), expect: () => [P.generated ?? null, T.generated] },
      { re: rx(String.raw`#N# generated and #N# hand-written at the recorded run, #N# and #N# today`), expect: () => [P.generated ?? null, P.handWritten ?? null, T.generated, T.handWritten] },
      { re: rx(String.raw`\*{0,2}#N# and #N# in total\*{0,2} against the database as it stands today, #N# and #N# at the run`), expect: () => [T.generated, T.evalTotal, P.generated ?? null, P.total ?? null] },
      { re: rx(String.raw`#N# cases passed at\s*\x60?[0-9a-f]{7}\x60?; #N# are generated today`), expect: () => [P.total ?? null, T.evalTotal] },
      { re: rx(String.raw`#N# against the #N# claims and #N# policies`), expect: () => [T.evalTotal, T.claims, T.scoredPolicies] },
      { re: rx(String.raw`#N# integrity checks \+ #N# written cases`), expect: () => [T.generated, T.handWritten] },
      { re: rx(String.raw`it holds \*{0,2}#N# claims and #N# policies\*{0,2}`), expect: () => [T.claims, T.policies] },
      // The then/now table in README.md, which declares both sides at once.
      { re: rx(String.raw`\|\s*Generated coverage cases[^|\n]*\|\s*\*{0,2}#N#\*{0,2}\s*\|\s*\*{0,2}#N#\*{0,2}\s*\|`), expect: () => [P.generated ?? null, T.generated] },
      { re: rx(String.raw`\|\s*Hand-written cases[^|\n]*\|\s*\*{0,2}#N#\*{0,2}\s*\|\s*\*{0,2}#N#\*{0,2}\s*\|`), expect: () => [P.handWritten ?? null, T.handWritten] },
      { re: rx(String.raw`\|\s*\*\*Total generated at run time\*\*\s*\|\s*\*{0,2}#N#\*{0,2}\s*\|\s*\*{0,2}#N#\*{0,2}\s*\|`), expect: () => [P.total ?? null, T.evalTotal] },
    ],
  },
  {
    id: 'eval-cases',
    label: 'evaluation case counts (total / generated / hand-written)',
    truth: T.evalTotal,
    // The one check that may accept a figure as a frozen measurement, and only
    // once eval-drift above has established the baseline and confirmed the
    // present-day disclosure. See the FROZEN MEASUREMENTS note in the header.
    frozen: true,
    source: `${T.handWritten ?? '?'} hand-written + (2 x ${T.claims ?? '?'} claims) + ${T.policies ?? '?'} policies`,
    patterns: [
      { re: rx(String.raw`The #N# is #N# hand-written cases plus #N# generated`), expect: () => [T.evalTotal, T.handWritten, T.generated] },
      { re: rx(String.raw`#N# automated integrity checks plus #N# hand-written`), expect: () => [T.generated, T.handWritten] },
      { re: rx(String.raw`#N# cases?\s*(?:—|-|\()\s*#N# hand-written,?\s*#N# generated`), expect: () => [T.evalTotal, T.handWritten, T.generated] },
      { re: rx(String.raw`#N# cases?\s*(?:—|-|\()\s*#N# generated,?\s*#N# hand-written`), expect: () => [T.evalTotal, T.generated, T.handWritten] },
      { re: rx(String.raw`reports #N# because production currently holds #N# claims and #N# policies`), expect: () => [T.evalTotal, T.claims, T.scoredPolicies] },
      { re: rx(String.raw`#N# \+ \(2 ?[x×] ?#N#\) \+ #N#`), expect: () => [T.handWritten, T.claims, T.scoredPolicies] },
      { re: rx(String.raw`\|\s*\*\*Overall\*\*\s*\|[^|\n]*\|\s*\*\*#N#\*\*`), expect: () => [T.evalTotal] },
      // Bracketed, because "Seven evaluation cases assert ..." elsewhere in
      // README.md is a subset of the total and not a claim about the total.
      { re: rx(String.raw`\[#N# evaluation cases\]`), expect: () => [T.evalTotal] },
      { re: rx(String.raw`(?:The|These) #N# cases above`), expect: () => [T.evalTotal] },
      { re: rx(String.raw`(?:All|all) #N# (?:measure|exercise)`), expect: () => [T.evalTotal] },
      { re: rx(String.raw`None of the #N# cases`), expect: () => [T.evalTotal] },
      { re: rx(String.raw`(?:as|read) #N# hand-built cases`), expect: () => [T.evalTotal] },
      { re: rx(String.raw`"#N# cases, 100%"`), expect: () => [T.evalTotal] },
      { re: rx(String.raw`100% over #N# cases`), expect: () => [T.evalTotal] },
      { re: rx(String.raw`only the #N# hand-written cases run`), expect: () => [T.handWritten] },
      { re: rx(String.raw`#N# hand-written behavioural cases that`), expect: () => [T.handWritten] },
      { re: rx(String.raw`plus #N# generated integrity checks`), expect: () => [T.generated] },
    ],
  },
  {
    id: 'live-dataset',
    label: 'live database row counts as quoted in prose',
    truth: null,
    source: `claims ${T.claims ?? '?'}, policies ${T.policies ?? '?'}, customers ${T.customers ?? '?'}`,
    hint: `the seeded dataset defines ${T.seedClaims ?? '?'} claims and ${T.seedPolicies ?? '?'} policies — if a sentence means the seed rather than production it should say so, and the seed check below will then cover it.`,
    patterns: [
      { re: rx(String.raw`[Cc]overage spans all #N# claims and all #N# policies`), expect: () => [T.claims, T.scoredPolicies] },
      { re: rx(String.raw`reads all #N# claims and all #N# policies`), expect: () => [T.claims, T.scoredPolicies] },
      { re: rx(String.raw`over #N# claims and #N# policies`), expect: () => [T.claims, T.scoredPolicies] },
      // `database`, never `dataset`. See SEED VERSUS LIVE in the header: the two
      // alternations are disjoint, so a seed-qualified sentence cannot land here.
      { re: rx(LIVE_SUBJECT + HOLDS_TRIPLE), expect: () => [T.customers, T.policies, T.claims] },
      { re: rx(String.raw`live database (?:now |currently )?holds \*{0,2}#N#\*{0,2} claims`), expect: () => [T.claims] },
      { re: rx(String.raw`[Cc]ustomers and policies are still #N# and #N#`), expect: () => [T.customers, T.policies] },
    ],
  },
  {
    id: 'seed-dataset',
    label: 'seeded dataset counts (run-all.sql, deliberately not the live count)',
    truth: null,
    source: `${T.seedClaims ?? '?'} distinct CLM-, ${T.seedPolicies ?? '?'} distinct POL-, ${T.seedCustomers ?? '?'} distinct customer emails in run-all.sql`,
    // Only phrasings that name the seed explicitly — "the seed", "the seeded
    // dataset", or "the dataset" as the subject of `holds`. A bare "N claims in
    // the dataset" is still not one of them: in this corpus that phrase
    // sometimes means the seeded rows and sometimes means what production
    // currently holds, and a checker that guesses will be confidently wrong half
    // the time. `dataset` never matches `database`, and the live check above
    // never matches `dataset`.
    patterns: [
      { re: rx(String.raw`seed(?:ed)? dataset defines #N# claims`), expect: () => [T.seedClaims] },
      { re: rx(String.raw`#N# the seed defines`), expect: () => [T.seedClaims] },
      { re: rx(SEED_SUBJECT + HOLDS_TRIPLE), expect: () => [T.seedCustomers, T.seedPolicies, T.seedClaims] },
      { re: rx(String.raw`the #N# seeded ones`), expect: () => [T.seedClaims] },
      { re: rx(String.raw`#N# from the seed\b`), expect: () => [T.seedClaims] },
    ],
  },
  {
    id: 'tools',
    label: 'agent tool count (AGENT_TOOLS)',
    truth: T.tools,
    source: 'backend/src/config/agent-definition.ts, AGENT_TOOLS array only',
    patterns: [
      { re: rx(String.raw`#N# tools are registered\s*—?\s*#N# webhook tools and #N# client tools`), expect: () => [T.tools, T.toolsWebhook, T.toolsClient] },
      { re: rx(String.raw`all #N# tools`), expect: () => [T.tools] },
      { re: rx(String.raw`the #N# tools\b`), expect: () => [T.tools] },
      { re: rx(String.raw`#N# tools fetched from the API`), expect: () => [T.tools] },
      { re: rx(String.raw`#N# tools, and #N# routes under`), expect: () => [T.tools, T.routes] },
      { re: rx(String.raw`the #N# backend tools above`), expect: () => [T.toolsWebhook] },
      { re: rx(String.raw`The #N# client tools`), expect: () => [T.toolsClient] },
    ],
  },
  {
    id: 'routes',
    label: 'tool route count (/api/tools/*)',
    truth: T.routes,
    source: 'route registrations across backend/src/routes/',
    patterns: [
      { re: rx(String.raw`#N# routes: the`), expect: () => [T.routes] },
      { re: rx(String.raw`#N# routes under \x60?/api/tools`), expect: () => [T.routes] },
    ],
  },
  {
    id: 'tables',
    label: 'database table count (CREATE TABLE in run-all.sql)',
    truth: T.tables,
    source: 'backend/database/run-all.sql',
    patterns: [
      { re: rx(String.raw`(?:all |\*\*)#N#\*{0,2} tables`), expect: () => [T.tables] },
      // The PRD splits the same total into "the seven below" and "the other
      // eleven". Both halves are checked against the same source of truth.
      { re: rx(String.raw`tables\*{0,2}; the #N# below[\s\S]{0,200}?The other #N# support`), expect: () => [null, null], sum: () => T.tables },
    ],
  },
  {
    id: 'arm-scores',
    label: 'four-arm exact-match scores',
    truth: arms ? `A ${arms.A?.score?.count} B ${arms.B?.score?.count} C ${arms.C?.score?.count} D ${arms.D?.score?.count}` : null,
    source: 'backend/eval/results/run-dev.json',
    patterns: !arms ? [] : [
      { re: rx(String.raw`[Aa]rm A[^.]{0,140}?right on #N# of #N#`), expect: () => [arms.A?.score?.count, arms.A?.score?.denominator] },
      { re: rx(String.raw`[Aa]rm C[^.]{0,140}?right on #N# of #N#`), expect: () => [arms.C?.score?.count, arms.C?.score?.denominator] },
      { re: rx(String.raw`[Aa]rm C[^.]{0,80}?scores #N#\b`), expect: () => [arms.C?.score?.count] },
      { re: rx(String.raw`made the system (?:WORSE|worse) by #N# cases?`), expect: () => [arms.A?.score?.count - arms.C?.score?.count] },
      { re: rx(String.raw`cost #N# exact-match cases`), expect: () => [arms.A?.score?.count - arms.C?.score?.count] },
      { re: rx(String.raw`#N#-case lead`), expect: () => [arms.A?.score?.count - arms.C?.score?.count] },
      { re: rx(String.raw`beats arm B by #N# cases`), expect: () => [arms.C?.score?.count - arms.B?.score?.count] },
      { re: rx(String.raw`#N#-case margin over it`), expect: () => [arms.C?.score?.count - arms.D?.score?.count] },
      { re: rx(String.raw`[Aa]rm ([ABCD])['’]s Wilson interval is (\d+\.\d)[–-](\d+\.\d)%`), expect: null, wilson: true },
      { re: rx(String.raw`model escalates #N# of #N# (?:cases|claims)`), expect: () => [arms.B?.pred?.escalate, arms.B?.score?.denominator] },
      { re: rx(String.raw`arm C escalates #N#`), expect: () => [arms.C?.pred?.escalate] },
      { re: rx(String.raw`ground truth escalates #N#`), expect: () => [arms.truthMix?.escalate] },
      { re: rx(String.raw`ground truth of #N#\b`), expect: () => [arms.truthMix?.approve] },
    ],
  },
  {
    id: 'rupees',
    label: 'rupee figures quoted from the four-arm run',
    truth: arms ? `${rupeeSet.size} figures recorded in run-dev.json` : null,
    source: 'backend/eval/results/run-dev.json',
    // Only lakh-scale figures — the small ones (₹2,000 deductibles, ₹50,000
    // coverage limits) are illustrative examples in walkthroughs, not results.
    patterns: !arms ? [] : [{ re: /₹(\d{1,2}(?:,\d{2})+,\d{3})/g, expect: null, rupee: true }],
  },
];

// ============================================================================
// SCAN
// ============================================================================

const lineOf = lineOfIn;

const snippet = (doc, index, len) =>
  doc.text.slice(index, index + Math.min(len, 90)).replace(/\s+/g, ' ').trim();

const problems = [];
let claimsChecked = 0;
const results = [];

for (const check of checks) {
  const mismatches = [];
  const frozenHere = [];
  let occurrences = 0;
  let unverifiable = 0; // matched the prose, but the ground truth is unavailable
  const patterns = check.patterns.map((p) => (p instanceof RegExp ? { re: p, expect: () => [check.truth] } : p));

  for (const doc of corpus) {
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0;
      for (const m of doc.text.matchAll(pattern.re)) {
        const line = lineOf(doc, m.index);
        const where = `${doc.file}:${line}`;

        if (pattern.wilson) {
          const arm = { A: 'arm_a', B: 'arm_b_run1', C: 'arm_c_run1', D: 'arm_d' }[m[1]];
          const em = runDevScores && arm ? (runDevScores[arm]?.exact_match ?? null) : null;
          if (!em) continue;
          occurrences += 2;
          claimsChecked += 2;
          const lo = (em.lo * 100).toFixed(1);
          const hi = (em.hi * 100).toFixed(1);
          if (m[2] !== lo) mismatches.push(`${where}  arm ${m[1]} Wilson low says ${m[2]}%, run-dev.json has ${lo}%`);
          if (m[3] !== hi) mismatches.push(`${where}  arm ${m[1]} Wilson high says ${m[3]}%, run-dev.json has ${hi}%`);
          continue;
        }

        if (pattern.rupee) {
          occurrences += 1;
          claimsChecked += 1;
          const value = Number(m[1].replace(/,/g, ''));
          if (!rupeeSet.has(value)) {
            mismatches.push(`${where}  ₹${m[1]} is not a figure the four-arm run recorded  ${dim(snippet(doc, m.index, 70))}`);
          }
          continue;
        }

        const found = [];
        for (let g = 1; g < m.length; g++) found.push(parseNum(m[g]));

        if (pattern.sum) {
          const want = pattern.sum();
          if (want === null || want === undefined) continue;
          occurrences += 1;
          claimsChecked += found.length;
          const total = found.reduce((a, b) => a + (b ?? 0), 0);
          if (total !== want) {
            mismatches.push(`${where}  the parts sum to ${total}, ground truth is ${want} (${found.join(' + ')})  ${dim(snippet(doc, m.index, 70))}`);
          }
          continue;
        }

        const want = pattern.expect();
        for (let i = 0; i < want.length; i++) {
          if (want[i] === null || want[i] === undefined || Number.isNaN(want[i])) {
            unverifiable += 1;
            continue;
          }
          occurrences += 1;
          claimsChecked += 1;
          if (found[i] === want[i]) continue;

          // A figure that is wrong against today but exactly right against the
          // pinned run, in a corpus that has already been confirmed to disclose
          // the difference correctly. Accepted, and named — never dropped.
          const twin = check.frozen ? pinnedTwin(want[i]) : null;
          if (frozen.armed && twin !== null && found[i] === twin) {
            frozenHere.push(`${where}  ${m[i + 1]} is the figure at the pinned run (today: ${want[i]})  ${dim(snippet(doc, m.index, 70))}`);
            continue;
          }
          mismatches.push(`${where}  says ${m[i + 1]}, ground truth is ${want[i]}  ${dim(snippet(doc, m.index, 70))}`);
        }
      }
    }
  }

  results.push({ check, occurrences, mismatches, unverifiable, frozen: frozenHere });
  for (const line of mismatches) problems.push(line);
  frozen.accepted.push(...frozenHere);

  // The interlock. eval-drift sits before eval-cases in the array above, so this
  // is decided before any figure has a chance to be excused.
  if (check.id === 'eval-drift') {
    if (!pinned.ok) frozen.why = `no pinned baseline: ${pinned.why}`;
    else if (occurrences === 0) frozen.why = 'the corpus states no present-day figure to check the drift against';
    else if (mismatches.length > 0) frozen.why = `${mismatches.length} present-day figure(s) are themselves wrong`;
    else {
      frozen.armed = true;
      frozen.why = `${pinned.claims} claims / ${pinned.policies} policies at the recorded run, giving ${pinned.generated} generated and ${pinned.total} total; ${occurrences} present-day figure(s) confirm the drift is disclosed and current`;
    }
  }
}


// ============================================================================
// REPORT
// ============================================================================

console.log('');
console.log('  Ground truth');
console.log('  ' + '-'.repeat(74));
const gt = (label, value, note) =>
  console.log(`  ${label.padEnd(26)} ${String(value ?? dim('unavailable')).padStart(6)}  ${note ? dim(note) : ''}`);

gt('live claims', truth.claims, 'PostgREST, count=exact, read-only');
gt('live policies', truth.policies, '');
gt('live customers', truth.customers, '');
gt('live evidence bundles', truth.bundles, 'no documentation claim found for this');
gt('seeded claims', truth.seedClaims, 'distinct CLM- in run-all.sql');
gt('seeded policies', truth.seedPolicies, 'distinct POL- in run-all.sql');
gt('hand-written cases', truth.handWritten, 'CASES array, counted in evaluate.mjs');
gt('generated cases', truth.generated, `2 x ${truth.claims ?? '?'} claims + ${truth.policies ?? '?'} policies`);
gt('evaluation cases', truth.evalTotal, 'hand-written + generated');
gt('backend tests', truth.backendTests, RUN_TESTS ? 'as the runner reported them' : 'skipped');
gt('harness tests', truth.harnessTests, RUN_TESTS ? 'eval/tests/*.test.ts' : 'skipped');
gt('agent tools', truth.tools, `${truth.toolsWebhook ?? '?'} webhook + ${truth.toolsClient ?? '?'} client`);
gt('tool routes', truth.routes, [...routePaths].length ? 'distinct /tools/* paths' : '');
gt('tables', truth.tables, 'CREATE TABLE in run-all.sql');
gt('seeded customers', truth.seedCustomers, 'distinct customer emails in run-all.sql');
if (pinned.ok) {
  gt('pinned run: claims', pinned.claims, `declared by ${pinned.sources.length} sentence(s): ${pinned.sources.slice(0, 3).join(', ')}`);
  gt('pinned run: policies', pinned.policies, 'the book at the recorded evaluation run, read from the prose');
  gt('pinned run: generated', pinned.generated, `recomputed: 2 x ${pinned.claims} + ${pinned.policies}`);
  gt('pinned run: total', pinned.total, `recomputed: ${pinned.handWritten} hand-written + ${pinned.generated}`);
} else {
  gt('pinned run', null, pinned.why ?? 'not established');
}
if (arms) {
  gt('arm exact match', `${arms.A?.score?.count}/${arms.B?.score?.count}/${arms.C?.score?.count}/${arms.D?.score?.count}`, 'A / B / C / D of ' + arms.A?.score?.denominator);
}

console.log('');
console.log('  Documentation checks');
console.log('  ' + '-'.repeat(74));

for (const { check, occurrences, mismatches, unverifiable, frozen: frozenHere } of results) {
  // Three distinct states, kept distinct on purpose. SKIP means this script
  // could not read the ground truth, so it verified nothing and is not claiming
  // to have. NONE means the ground truth was read but no sentence in the eight
  // files matched any phrasing this check knows — the documentation was probably
  // reworded, and the check is now watching nothing.
  const noTruth = check.patterns.length === 0 || (occurrences === 0 && unverifiable > 0);
  let mark;
  if (noTruth) mark = dim('  SKIP');
  else if (mismatches.length > 0) mark = red('  FAIL');
  else if (occurrences === 0) mark = yellow('  NONE');
  else mark = green('  PASS');

  const tail = noTruth
    ? `ground truth unavailable (${unverifiable} matching claim(s) left unverified)`
    : occurrences === 0
      ? 'no phrasing this check recognises appears in the eight files'
      : `${occurrences} claim(s) checked, ${mismatches.length} wrong${frozenHere.length ? `, ${frozenHere.length} frozen` : ''}`;
  console.log(`${mark}  ${check.label.padEnd(48)} ${dim(tail)}`);
  if (occurrences === 0 && !noTruth) {
    console.log(dim(`        the docs may have been reworded — this check is now watching nothing`));
  }
  for (const line of mismatches) console.log(`        ${line}`);
  if (mismatches.length > 0 && check.hint) console.log(dim(`        note: ${check.hint}`));
}

// --- what was accepted as frozen, named rather than dropped -----------------
//
// This block is the whole safety argument for the exclusion. An excused figure
// that nobody can see is indistinguishable from a figure nobody checked.

if (frozen.accepted.length > 0) {
  console.log('');
  console.log(yellow(`  FROZEN  ${frozen.accepted.length} figure(s) accepted as measurements pinned to the recorded run`));
  console.log(dim(`        ${frozen.why}`));
  for (const line of frozen.accepted) console.log(`        ${line}`);
  console.log(dim('        These are historical by construction and must not track the present. They'));
  console.log(dim('        are excused only while the present-day figures above are correct: when the'));
  console.log(dim('        book next moves, those fail first and these stop being excused with them.'));
} else if (!frozen.armed) {
  console.log('');
  console.log(dim(`  frozen-figure exclusion not armed — ${frozen.why}`));
}

// --- coverage, stated plainly -----------------------------------------------

console.log('');
console.log('  Coverage');
console.log('  ' + '-'.repeat(74));
console.log(`  ${claimsChecked} numeric claim(s) verified across ${files.length} file(s).`);
console.log('');
console.log(dim('  This is NOT every number in the corpus, and it is not close to it. What it'));
console.log(dim('  does not check, and why:'));
console.log(dim('    - per-file test counts ("39 tests", "65 tests in adjudication-service.test.ts",'));
console.log(dim('      "58 tests cover settlement") — the runner reports a total, not a per-file split.'));
console.log(dim('    - Foundry contract test counts (16, 30, 46) — Foundry is not installed here,'));
console.log(dim('      so the only available source is the same source the docs already quote.'));
console.log(dim('    - latency figures (p50/p95 ms) — they change on every run and a checker that'));
console.log(dim('      failed on them would fail always.'));
console.log(dim('    - McNemar counts, p-values and confusion-matrix cells beyond the arm scores.'));
console.log(dim('    - historical figures pinned to a commit ("364 at a4e6938") — those are'));
console.log(dim('      deliberately frozen and must not track the present.'));
console.log(dim('    - the 204/177 evaluation figures wherever they record the run at `020462f`.'));
console.log(dim('      They are not checked against the live database; they are checked against the'));
console.log(dim('      book that run held, recomputed from the baseline the prose declares, and'));
console.log(dim('      only while the present-day figures beside them are correct. Every one so'));
console.log(dim('      accepted is listed by file and line under FROZEN above. The rule cannot'));
console.log(dim('      read tense: a present-tense sentence written today as "204 cases" would be'));
console.log(dim('      accepted too. That is the known hole, and the FROZEN listing is what makes'));
console.log(dim('      it visible.'));
console.log(dim('    - "N customers, N policies and N claims" with no `dataset`/`database` in front'));
console.log(dim('      of `holds` — seed and live differ, and an unqualified subject cannot be'));
console.log(dim('      routed to either without guessing. Neither check claims such a sentence.'));
console.log(dim('    - illustrative rupee amounts in walkthroughs (deductibles, coverage limits).'));
console.log(dim('    - anything phrased in a way no pattern above recognises; a NONE line names'));
console.log(dim('      each check that is currently matching nothing.'));
if (missingDocs.length) console.log(dim(`    - ${missingDocs.join(', ')} — not present in the tree.`));
if (unavailable.length) {
  console.log('');
  console.log(yellow(`  ${unavailable.length} ground-truth source(s) unavailable, so their checks did not run:`));
  for (const u of unavailable) console.log(dim(`    - ${u}`));
}

console.log('');
if (problems.length === 0) {
  console.log(green('  No drift: every number this script knows how to check matches its source.'));
  console.log('');
  process.exit(0);
}

console.log(red(`  ${problems.length} number(s) in the documentation disagree with the source of truth.`));
console.log('');
console.log('  Each line above names the file and line. Fix the prose, not this script,');
console.log('  unless the ground truth itself moved — in which case the source it reads');
console.log('  has already moved with it.');
console.log('');
process.exit(1);
