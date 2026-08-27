/**
 * Verifies a Supabase project is correctly set up for SafeGuard.
 *
 * Checks connectivity, that every table exists, that the dataset loaded, and
 * that a seeded evidence bundle actually verifies. Reports what is wrong
 * rather than failing on the first problem.
 *
 *   npm run check:setup
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { computeEvidenceHash } from '../dist/services/attestation-service.js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const PASS = green('  PASS');
const FAIL = red('  FAIL');
const WARN = yellow('  WARN');

let failures = 0;
let warnings = 0;
const fail = (msg, detail) => { failures++; console.log(`${FAIL}  ${msg}`); if (detail) console.log(dim(`        ${detail}`)); };
const pass = (msg) => console.log(`${PASS}  ${msg}`);
const warn = (msg, detail) => { warnings++; console.log(`${WARN}  ${msg}`); if (detail) console.log(dim(`        ${detail}`)); };

console.log('\nSafeGuard setup check\n' + '='.repeat(60));

// --- Credentials present ----------------------------------------------------

if (!url) {
  fail('SUPABASE_URL is not set', 'Add it to backend/.env — Supabase dashboard > Settings > API > Project URL');
}
if (!key) {
  fail('SUPABASE_SERVICE_ROLE_KEY is not set', 'Supabase dashboard > Settings > API. Accepts sb_secret_... or the legacy service_role JWT.');
}
if (!url || !key) {
  console.log(`\n${red('Cannot continue without both values.')}\n`);
  process.exit(1);
}

// --- Key shape --------------------------------------------------------------

// A legacy service_role key is a static JWT: its iat claim was stamped once, at
// issue, and never moves. If this machine's clock drifts behind Supabase's,
// PostgREST rejects every request with "JWT issued at future" — the key is
// correct, the clock is not. An sb_secret_... key has no iat at all and cannot
// fail this way.
if (key.startsWith('eyJ')) {
  warn('SUPABASE_SERVICE_ROLE_KEY is a legacy service_role JWT',
    'Its fixed iat claim is validated against Supabase\'s clock, so clock skew on this machine\n' +
    '        surfaces as PostgREST "JWT issued at future" on every read. Prefer an sb_secret_... key\n' +
    '        (Supabase dashboard > Settings > API Keys) — those carry no iat and cannot skew.');
} else if (key.startsWith('sb_secret_')) {
  pass('SUPABASE_SERVICE_ROLE_KEY is a modern sb_secret_ key (no iat claim to skew)');
} else {
  warn('SUPABASE_SERVICE_ROLE_KEY is neither an sb_secret_... key nor a JWT',
    'Check you copied the secret / service_role key, not the anon or publishable key.');
}

// --- Hostname resolves ------------------------------------------------------

let host;
try {
  host = new URL(url).hostname;
  pass(`SUPABASE_URL parsed (${host})`);
} catch {
  fail(`SUPABASE_URL is not a valid URL: ${url}`);
  process.exit(1);
}

let serverDate;
try {
  const res = await fetch(`${url}/rest/v1/`, { headers: { apikey: key }, signal: AbortSignal.timeout(15000) });
  serverDate = res.headers.get('date');
  if (res.status === 401 || res.status === 403) {
    // Print the body verbatim: a wrong key and a rejected iat claim both land
    // here, and only the body tells them apart.
    const body = (await res.text().catch(() => '')).trim();
    fail('Project reachable but the key was rejected',
      `HTTP ${res.status} ${body || '(no body)'}\n` +
      '        Check you copied the secret / service_role key, not the anon or publishable key.');
  } else {
    pass(`Project reachable and key accepted (HTTP ${res.status})`);
  }
} catch (err) {
  const msg = String(err?.cause?.code ?? err?.message ?? err);
  if (msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN')) {
    fail(`${host} does not resolve`, 'The project may be deleted or paused. Check the URL in the Supabase dashboard.');
  } else {
    fail(`Could not reach ${host}`, msg);
  }
  console.log(`\n${red(`${failures} check(s) failed.`)}\n`);
  process.exit(1);
}

// --- Local clock ------------------------------------------------------------

// The Date header on the reply above is the clock that validates the iat claim,
// which makes it the only time source worth comparing against.
if (serverDate) {
  // The Date header is second-resolution and the round trip costs under a second,
  // so anything past a few seconds is real drift rather than measurement noise.
  const skew = Math.round((Date.now() - Date.parse(serverDate)) / 1000);
  if (Math.abs(skew) <= 5) {
    pass(`local clock within ${Math.abs(skew)}s of the Supabase server clock`);
  } else {
    warn(`local clock is ${Math.abs(skew)}s ${skew < 0 ? 'behind' : 'ahead of'} the Supabase server clock`,
      'A JWT minted by a clock running ahead carries an iat Supabase reads as the future, and it\n' +
      '        rejects the request. Sync this machine\'s time (w32tm /resync on Windows).');
  }
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

// --- Live round-trip --------------------------------------------------------

// The probe above only proves the gateway answered. Issue one real PostgREST
// read through the same client the server uses, so faults that appear only at
// query time — a rejected iat claim, RLS, a paused project — are caught here
// rather than discovered in production.
const { error: probeError } = await supabase.from('customers').select('id').limit(1);

if (!probeError) {
  pass('live Supabase read succeeded');
} else if (probeError.code === '42P01') {
  // Postgres answered "no such relation", so the key was accepted and the query
  // reached the database. That is a schema problem, and the section below names it.
  pass('live Supabase read reached Postgres (schema not loaded yet)');
} else {
  const verbatim = [probeError.message, probeError.details, probeError.hint, probeError.code && `code ${probeError.code}`]
    .filter(Boolean).join(' | ');
  fail('live Supabase read failed', verbatim);
  if (/issued at future|JWTIssuedAtFuture/i.test(verbatim)) {
    console.log(dim('        Supabase rejected the iat claim of a legacy service_role JWT against its own'));
    console.log(dim('        clock. Fix the clock skew above, or switch to an sb_secret_... key, which has no iat.'));
  }
}

// --- Tables -----------------------------------------------------------------

console.log('\nSchema\n' + '-'.repeat(60));

const TABLES = [
  'customers', 'policies', 'claims', 'call_logs', 'call_tool_executions',
  'escalations', 'scheduled_callbacks',
  'agent_registrations', 'filecoin_uploads', 'evidence_bundles',
];

const counts = {};
let missingTables = 0;

for (const table of TABLES) {
  // A head:true count returns a null count with no error when the table is
  // absent, which reads as success. Issue a real select so a missing table
  // surfaces as the error it is.
  const { error } = await supabase.from(table).select('*').limit(1);
  if (error) {
    missingTables++;
    fail(`table "${table}" — ${error.message}`);
    continue;
  }

  const { count, error: countError } = await supabase
    .from(table)
    .select('*', { count: 'exact', head: true });

  if (countError || count === null || count === undefined) {
    missingTables++;
    fail(`table "${table}" — could not count rows`, countError?.message ?? 'no count returned');
    continue;
  }

  counts[table] = count;
  if (count === 0) warn(`table "${table}" exists but is empty`);
  else pass(`table "${table}" — ${count} row${count === 1 ? '' : 's'}`);
}

if (missingTables > 0) {
  console.log(dim('\n        Run backend/database/run-all.sql in the Supabase SQL editor.'));
}

// --- Dataset spot checks ----------------------------------------------------

if (missingTables === 0) {
  console.log('\nDataset\n' + '-'.repeat(60));

  const expect = async (label, table, column, value, extra) => {
    let q = supabase.from(table).select('*').eq(column, value).limit(1);
    const { data, error } = await q;
    if (error) return fail(`${label} — ${error.message}`);
    if (!data?.length) return fail(`${label} — not found`, 'Dataset may be partially loaded; re-run run-all.sql.');
    if (extra) {
      const problem = extra(data[0]);
      if (problem) return fail(`${label} — ${problem}`);
    }
    pass(label);
  };

  await expect('POL-2024-001234 is active', 'policies', 'policy_number', 'POL-2024-001234',
    (r) => (r.status === 'active' ? null : `expected status active, got ${r.status}`));

  await expect('POL-2022-000111 is expired (file_claim rejection path)', 'policies', 'policy_number', 'POL-2022-000111',
    (r) => (r.status === 'expired' ? null : `expected status expired, got ${r.status}`));

  await expect('POL-2024-000222 is cancelled', 'policies', 'policy_number', 'POL-2024-000222',
    (r) => (r.status === 'cancelled' ? null : `expected status cancelled, got ${r.status}`));

  await expect('CLM-2026-000456 is under review with missing documents', 'claims', 'claim_number', 'CLM-2026-000456',
    (r) => {
      if (r.status !== 'under_review') return `expected under_review, got ${r.status}`;
      const missing = (r.documents_required ?? []).filter((d) => !(r.documents_received ?? []).includes(d));
      return missing.length ? null : 'expected outstanding documents, found none';
    });

  await expect('CLM-2026-000601 water_damage claim exists', 'claims', 'claim_number', 'CLM-2026-000601');

  // A customer with no claims exercises the clean file_claim path.
  const { data: meera } = await supabase.from('customers').select('id').eq('full_name', 'Meera Joshi').limit(1);
  if (!meera?.length) {
    fail('Meera Joshi (no claim history) — not found');
  } else {
    const { count } = await supabase.from('claims').select('*', { count: 'exact', head: true }).eq('customer_id', meera[0].id);
    if (count === 0) pass('Meera Joshi exists with no claim history');
    else fail(`Meera Joshi should have 0 claims, has ${count}`);
  }

  // A failed tool execution, so the dashboard error state has data.
  const { count: failedExecs } = await supabase
    .from('call_tool_executions').select('*', { count: 'exact', head: true }).eq('success', false);
  if (failedExecs > 0) pass(`${failedExecs} failed tool execution(s) present for error-state rendering`);
  else warn('no failed tool executions — dashboard error state will have no data');

  // --- Evidence integrity ---------------------------------------------------

  console.log('\nEvidence integrity\n' + '-'.repeat(60));

  const { data: bundles, error: bundleErr } = await supabase
    .from('evidence_bundles').select('claim_id, bundle_json, bundle_hash');

  if (bundleErr) {
    fail(`could not read evidence_bundles — ${bundleErr.message}`);
  } else if (!bundles?.length) {
    warn('no evidence bundles seeded — Verify Integrity will have nothing to check');
  } else {
    for (const b of bundles) {
      const recomputed = computeEvidenceHash(b.bundle_json);
      if (recomputed === b.bundle_hash) {
        pass(`bundle ${b.bundle_hash.slice(0, 18)}… verifies against its stored JSON`);
      } else {
        fail('bundle hash mismatch', `stored ${b.bundle_hash}\n        recomputed ${recomputed}`);
      }
    }
  }
}

// --- Optional integrations --------------------------------------------------

console.log('\nOptional integrations\n' + '-'.repeat(60));

const report = (name, on, hint) =>
  console.log(on ? `${PASS}  ${name} enabled` : `${dim('  ----')}  ${name} disabled ${dim(`(${hint})`)}`);

report('webhook signature verification', Boolean(process.env.ELEVENLABS_WEBHOOK_SECRET), 'set ELEVENLABS_WEBHOOK_SECRET');
report('Filecoin uploads', Boolean(process.env.AGENT_PRIVATE_KEY), 'set AGENT_PRIVATE_KEY');
report('on-chain attestation', Boolean(process.env.AGENT_PRIVATE_KEY && process.env.CLAIM_REGISTRY_ADDRESS), 'set AGENT_PRIVATE_KEY + CLAIM_REGISTRY_ADDRESS');

if (!process.env.ELEVENLABS_WEBHOOK_SECRET) {
  console.log(dim('\n        Without the webhook secret, post-call webhooks are accepted unverified.'));
}

// --- Summary ----------------------------------------------------------------

console.log('\n' + '='.repeat(60));
if (failures === 0) {
  console.log(green(`All checks passed${warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}.`));
  console.log('Next: npm run dev, then work through TESTING.md.\n');
} else {
  console.log(red(`${failures} check(s) failed`) + (warnings ? `, ${warnings} warning(s)` : '') + '.');
  console.log('');
  process.exitCode = 1;
}
