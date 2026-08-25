/**
 * Ablation harness — measures what each safety layer is actually worth.
 *
 * "100% accuracy" is not a claim until you say what the alternative scores.
 * This runs the same cases three times against a locally started server:
 *
 *   baseline          everything on
 *   no-normalisation  reference numbers looked up exactly as transcribed
 *   no-refusal-gates  the policy-status check that blocks filing is removed
 *
 * and reports what breaks in each arm. A layer that changes nothing when
 * removed is a layer that was not earning its place.
 *
 *   npm run ablate
 *   npm run ablate -- --json
 *
 * The server is started here rather than ablating the deployment, because a
 * deployment with its refusal gates removed would file claims against expired
 * policies for real callers. `src/config/ablation.ts` refuses to start under
 * NODE_ENV=production for the same reason.
 *
 * The no-refusal-gates arm genuinely writes claims that the system would
 * normally reject. Everything it creates is deleted afterwards; if cleanup
 * cannot run, the arm is skipped rather than left to pollute the dataset.
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import path from 'node:path';

const AS_JSON = process.argv.includes('--json');

// The tool endpoints require a shared secret once TOOLS_API_TOKEN is set. This
// harness starts its own server inheriting the same environment, so it has to
// present the token too — otherwise every arm gets 401 and the ablation reports
// that removing a layer changed nothing, which is the one failure mode it
// exists to avoid.
const TOOLS_API_TOKEN = process.env.TOOLS_API_TOKEN || null;
const AUTH_HEADERS = TOOLS_API_TOKEN ? { 'x-tools-token': TOOLS_API_TOKEN } : {};
const PORT = Number(process.env.ABLATE_PORT || 3199);
const BASE = `http://127.0.0.1:${PORT}`;

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

/**
 * Cases chosen because each one exercises a layer directly. Retrieval cases
 * that do not depend on either layer are excluded — including them would
 * dilute the result with rows that are identical across all three arms.
 */
const CASES = [
  // --- Normalisation: the transcript spelling differs from the stored one ---
  {
    id: 'dashless',
    layer: 'normalisation',
    tool: 'lookup-claim',
    body: { claim_number: 'CLM2026000456' },
    describes: 'dashes dropped by speech-to-text',
    expect: (r) => r.found === true,
  },
  {
    id: 'spaced',
    layer: 'normalisation',
    tool: 'lookup-claim',
    body: { claim_number: 'CLM 2026 000456' },
    describes: 'spoken with spaces',
    expect: (r) => r.found === true,
  },
  {
    id: 'lowercase',
    layer: 'normalisation',
    tool: 'lookup-claim',
    body: { claim_number: 'clm-2026-000456' },
    describes: 'transcribed in lower case',
    expect: (r) => r.found === true,
  },
  {
    id: 'policy-dashless',
    layer: 'normalisation',
    tool: 'check-policy',
    body: { policy_number: 'POL2024001234' },
    describes: 'policy number without dashes',
    expect: (r) => r.found === true,
  },
  {
    id: 'exact-control',
    layer: 'normalisation',
    tool: 'lookup-claim',
    body: { claim_number: 'CLM-2026-000456' },
    describes: 'control — exactly as stored, must pass in every arm',
    expect: (r) => r.found === true,
  },

  // --- Refusal gates: filings that must be declined -----------------------
  {
    id: 'expired-policy',
    layer: 'refusalGates',
    tool: 'file-claim',
    body: { policy_number: 'POL-2022-000111', incident_description: 'ablation probe' },
    describes: 'filing against an expired policy',
    // The layer is working when the write is refused and no number is issued.
    expect: (r) => r.success === false && !r.claim_number,
    createsClaim: true,
  },
  {
    id: 'cancelled-policy',
    layer: 'refusalGates',
    tool: 'file-claim',
    body: { policy_number: 'POL-2024-000222', incident_description: 'ablation probe' },
    describes: 'filing against a cancelled policy',
    expect: (r) => r.success === false && !r.claim_number,
    createsClaim: true,
  },
  {
    id: 'active-control',
    layer: 'refusalGates',
    tool: 'file-claim',
    body: { policy_number: 'POL-2026-100001', incident_description: 'ablation control' },
    describes: 'control — a legitimate filing, must succeed in every arm',
    expect: (r) => r.success === true && Boolean(r.claim_number),
    createsClaim: true,
  },
];

const ARMS = [
  { key: 'baseline', label: 'baseline (all layers on)', env: {} },
  {
    key: 'no-normalisation',
    label: 'normalisation removed',
    env: { ABLATE_NORMALISATION: 'true' },
  },
  {
    key: 'no-refusal-gates',
    label: 'refusal gates removed',
    env: { ABLATE_REFUSAL_GATES: 'true' },
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(400);
  }
  return false;
}

/**
 * Start tsx directly rather than through npx, and without a shell.
 *
 * On Windows a shell-spawned child leaves the real node process running when
 * the shell is killed. That silently invalidated an earlier version of this
 * script: every arm after the first was answered by the still-running baseline
 * server, so all three arms reported identical results.
 */
function startServer(env) {
  const tsxBin = path.resolve(
    'node_modules',
    'tsx',
    'dist',
    'cli.mjs'
  );
  const child = spawn(process.execPath, [tsxBin, 'src/server.ts'], {
    env: {
      ...process.env,
      ...env,
      PORT: String(PORT),
      // Ablation flags are refused under production; be explicit rather than
      // relying on whatever NODE_ENV happens to be set locally.
      NODE_ENV: 'development',
    },
    stdio: 'ignore',
    shell: false,
  });
  return child;
}

/** Kill the process and wait for the port to actually free up. */
async function stopServer(child) {
  child.kill('SIGTERM');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await portIsFree()) return;
    await sleep(200);
  }
  child.kill('SIGKILL');
  await sleep(500);
}

async function portIsFree() {
  try {
    await fetch(`${BASE}/health`);
    return false;
  } catch {
    return true;
  }
}

async function runArm(arm) {
  // A leftover server from a previous arm would answer for this one and make
  // every arm look identical, which is exactly the bug this guards against.
  if (!(await portIsFree())) {
    throw new Error(`port ${PORT} is already serving; refusing to run arm "${arm.key}"`);
  }

  const server = startServer(arm.env);
  const created = [];
  try {
    const up = await waitForHealth();
    if (!up) throw new Error(`server did not become healthy for arm "${arm.key}"`);

    // Confirm the server actually applied the flags we asked for, rather than
    // trusting that the environment reached it.
    const health = await (await fetch(`${BASE}/health`)).json();
    const reported = (health.ablations ?? []).slice().sort().join(',');
    const asked = Object.keys(arm.env)
      .map((k) => (k === 'ABLATE_NORMALISATION' ? 'normalisation' : 'refusalGates'))
      .sort()
      .join(',');
    if (reported !== asked) {
      throw new Error(
        `arm "${arm.key}": server reports ablations [${reported}] but was started with [${asked}]`
      );
    }

    const results = [];
    for (const c of CASES) {
      let passed = false;
      let note = '';
      try {
        const res = await fetch(`${BASE}/api/tools/${c.tool}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
          body: JSON.stringify(c.body),
        });
        const json = await res.json().catch(() => null);
        passed = Boolean(json && c.expect(json));
        if (json?.claim_number) created.push(json.claim_number);
        if (!passed) note = JSON.stringify(json).slice(0, 80);
      } catch (err) {
        note = err instanceof Error ? err.message : String(err);
      }
      results.push({ ...c, passed, note });
    }
    return { results, created };
  } finally {
    await stopServer(server);
  }
}

/** Delete claims the run created, so the dataset is unchanged afterwards. */
async function cleanup(claimNumbers) {
  if (!claimNumbers.length) return { deleted: 0 };
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { deleted: 0, error: 'no service-role credentials; claims left in place' };
  }
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await sb.from('claims').delete().in('claim_number', claimNumbers);
  if (error) return { deleted: 0, error: error.message };
  return { deleted: claimNumbers.length };
}

// --- Run ---------------------------------------------------------------------

// Refuse to run the destructive arm without a way to undo it.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'ablate: SUPABASE_SERVICE_ROLE_KEY is required.\n' +
      'The no-refusal-gates arm files claims the system would normally reject,\n' +
      'and this script will not create them without the means to delete them.'
  );
  process.exit(1);
}

if (!AS_JSON) {
  console.log('\nSafeGuard ablation — what each safety layer is worth');
  console.log('='.repeat(74));
}

const arms = {};
const allCreated = [];

for (const arm of ARMS) {
  if (!AS_JSON) console.log(`\n  ${arm.label}`);
  const { results, created } = await runArm(arm);
  allCreated.push(...created);
  arms[arm.key] = results;
  if (!AS_JSON) {
    for (const r of results) {
      const mark = r.passed ? green('holds') : red('BREAKS');
      console.log(`    ${mark}  ${r.describes}`);
    }
  }
}

const cleaned = await cleanup([...new Set(allCreated)]);

// --- Report ------------------------------------------------------------------

const passedIn = (armKey, id) => Boolean(arms[armKey]?.find((r) => r.id === id)?.passed);

const layerRows = ['normalisation', 'refusalGates'].map((layer) => {
  const cases = CASES.filter((c) => c.layer === layer && !c.id.endsWith('-control'));
  const armKey = layer === 'normalisation' ? 'no-normalisation' : 'no-refusal-gates';
  // Both columns are measured. An earlier version hardcoded "with layer" to the
  // case count, which meant a baseline that failed everything would still have
  // printed a clean comparison — the ablation could not have detected its own
  // most important failure.
  const withLayer = cases.filter((c) => passedIn('baseline', c.id)).length;
  const withoutLayer = cases.filter((c) => passedIn(armKey, c.id)).length;
  return {
    layer,
    cases: cases.length,
    withLayer,
    withoutLayer,
    broken: withLayer - withoutLayer,
  };
});

// A control that moves is a broken harness, not a finding: the whole claim rests
// on each arm removing only what it says it removes.
const controlFailures = [];
for (const [armKey, rows] of Object.entries(arms)) {
  for (const r of rows) {
    if (r.id.endsWith('-control') && !r.passed) controlFailures.push(`${armKey}/${r.id}`);
  }
}

// Likewise a baseline that does not hold invalidates every column beside it.
const baselineFailures = (arms['baseline'] ?? []).filter((r) => !r.passed).map((r) => r.id);

const summary = {
  baselineFailures,
  controlFailures,
  arms: Object.fromEntries(
    Object.entries(arms).map(([k, rs]) => [
      k,
      { total: rs.length, passed: rs.filter((r) => r.passed).length },
    ])
  ),
  layers: layerRows,
  cleanup: cleaned,
};

if (AS_JSON) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('\n' + '='.repeat(74));
  console.log('\n  Layer            Cases   With layer   Without it   Broken by removal');
  console.log('  ' + '-'.repeat(68));
  for (const r of layerRows) {
    console.log(
      `  ${r.layer.padEnd(17)}${String(r.cases).padEnd(8)}${String(r.withLayer).padEnd(13)}` +
        `${String(r.withoutLayer).padEnd(13)}${r.broken}`
    );
  }
  console.log('');
  console.log(dim(`  cleanup: ${cleaned.deleted} claim(s) removed${cleaned.error ? ' — ' + cleaned.error : ''}`));
  if (baselineFailures.length) {
    console.log(red(`  baseline did not hold (${baselineFailures.join(', ')}) — the comparison above is void`));
  }
  if (controlFailures.length) {
    console.log(red(`  controls moved (${controlFailures.join(', ')}) — an arm removed more than it claims`));
  }
  console.log('');
}

process.exitCode =
  cleaned.error || baselineFailures.length || controlFailures.length ? 1 : 0;
