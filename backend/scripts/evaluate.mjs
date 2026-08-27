/**
 * Evaluation harness for the SafeGuard claims agent.
 *
 * Measures the behaviour a caller actually depends on: does a tool return the
 * right record, does it refuse what it should refuse, does it recover a
 * reference number that speech-to-text mangled, and how long does it take.
 *
 *   npm run evaluate            # against the deployed API
 *   API_BASE_URL=... npm run evaluate
 *   npm run evaluate -- --json  # machine-readable output
 *
 * Cases that create data run against the demo policies and are cleaned up
 * afterwards, so repeated runs do not accumulate claims. Any claim a case that
 * was *not* meant to write nonetheless produces is removed too, and reported
 * separately: a refusal case that files a claim has found a real regression, and
 * the row it leaves behind would otherwise inflate the case count for good.
 */
import 'dotenv/config';
import { buildCoverageCases } from './coverage-cases.mjs';

const BASE = process.env.API_BASE_URL || 'https://safeguard-api-production-7c24.up.railway.app';
const AS_JSON = process.argv.includes('--json');

// The tool endpoints this harness measures are the ones the voice agent calls,
// and they are guarded by a shared secret — every case here 401s without it
// against any backend that has TOOLS_API_TOKEN set. Use the same value the
// backend has. A development backend with none set still answers unguarded.
const TOOLS_API_TOKEN = process.env.TOOLS_API_TOKEN || null;
const AUTH_HEADERS = TOOLS_API_TOKEN ? { 'x-tools-token': TOOLS_API_TOKEN } : {};

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

/**
 * Each case states the caller's intent, the tool that should serve it, and a
 * predicate over the response. `utterance` documents what a caller would say;
 * it is not sent anywhere, because this harness measures the tool layer rather
 * than the language model's routing.
 */
const CASES = [
  // --- Retrieval: the answer must come from the database ------------------
  {
    id: 'lookup-known-claim',
    group: 'Retrieval',
    utterance: 'I want to check my claim, CLM-2026-000456.',
    tool: 'lookup-claim',
    body: { claim_number: 'CLM-2026-000456' },
    expect: (r) =>
      r.found === true &&
      r.claim?.status === 'under_review' &&
      r.claim?.claim_type === 'collision' &&
      Number(r.claim?.claimed_amount) === 8275,
    describes: 'returns the correct claim with status, type and amount',
  },
  {
    id: 'lookup-approved-claim',
    group: 'Retrieval',
    utterance: "What's the status of CLM-2026-000321?",
    tool: 'lookup-claim',
    body: { claim_number: 'CLM-2026-000321' },
    expect: (r) => r.found === true && r.claim?.status === 'approved',
    describes: 'distinguishes an approved claim',
  },
  {
    id: 'lookup-denied-claim',
    group: 'Retrieval',
    utterance: 'My claim CLM-2026-000789 was denied.',
    tool: 'lookup-claim',
    body: { claim_number: 'CLM-2026-000789' },
    expect: (r) => r.found === true && r.claim?.status === 'denied',
    describes: 'reports a denial rather than softening it',
  },
  {
    id: 'policy-active',
    group: 'Retrieval',
    utterance: 'What does policy POL-2024-001234 cover?',
    tool: 'check-policy',
    body: { policy_number: 'POL-2024-001234' },
    expect: (r) =>
      r.found === true &&
      r.policy?.status === 'active' &&
      Number(r.policy?.coverage_amount) === 50000 &&
      Number(r.policy?.deductible) === 1000,
    describes: 'returns coverage, deductible and status',
  },
  {
    id: 'policy-health',
    group: 'Retrieval',
    utterance: 'Can you check my health policy POL-2024-009012?',
    tool: 'check-policy',
    body: { policy_number: 'POL-2024-009012' },
    expect: (r) => r.found === true && r.policy?.policy_type === 'health',
    describes: 'handles a non-auto policy type',
  },
  {
    id: 'docs-outstanding',
    group: 'Retrieval',
    utterance: 'What documents do you still need for CLM-2026-000456?',
    tool: 'check-documents',
    body: { claim_number: 'CLM-2026-000456' },
    expect: (r) =>
      r.found === true &&
      Array.isArray(r.documents_missing) &&
      r.documents_missing.includes('repair_estimate') &&
      r.documents_missing.includes('photos'),
    describes: 'lists exactly the outstanding documents',
  },
  {
    id: 'docs-complete',
    group: 'Retrieval',
    utterance: 'Am I missing anything on CLM-2026-000321?',
    tool: 'check-documents',
    body: { claim_number: 'CLM-2026-000321' },
    expect: (r) => r.found === true && r.documents_missing?.length === 0,
    describes: 'reports nothing outstanding when the file is complete',
  },
  {
    id: 'docs-many-outstanding',
    group: 'Retrieval',
    utterance: 'What is missing on my fire claim CLM-2026-000345?',
    tool: 'check-documents',
    body: { claim_number: 'CLM-2026-000345' },
    expect: (r) => r.found === true && r.documents_missing?.length === 3,
    describes: 'counts multiple outstanding documents correctly',
  },

  // --- Refusal: the agent must not invent what does not exist -------------
  {
    id: 'refuse-expired-policy',
    group: 'Refusal',
    // POL-2022-000111 held this fixture until 2026-08-27, when it was renewed
    // twice through the product with real Razorpay payments and went active
    // through 2028-08-26. A renewal is not reversible, so the case moved rather
    // than the policy. POL-2022-011016 is Vivek Chandran's lapsed auto policy —
    // expired 2025-02-15, and one of the two remaining lapsed policies with no
    // policy_renewals row against it, so nothing has spent it yet.
    utterance: 'I want to file a claim on POL-2022-011016.',
    tool: 'file-claim',
    body: { policy_number: 'POL-2022-011016', incident_description: 'evaluation case' },
    expect: (r) => r.success === false && !r.claim_number,
    describes: 'refuses an expired policy and issues no claim number',
  },
  {
    id: 'refuse-cancelled-policy',
    group: 'Refusal',
    utterance: 'File a claim on POL-2024-000222 please.',
    tool: 'file-claim',
    body: { policy_number: 'POL-2024-000222', incident_description: 'evaluation case' },
    expect: (r) => r.success === false && !r.claim_number,
    describes: 'refuses a cancelled policy',
  },
  {
    id: 'refuse-unknown-policy',
    group: 'Refusal',
    utterance: 'Look up policy POL-9999-999999.',
    tool: 'check-policy',
    body: { policy_number: 'POL-9999-999999' },
    expect: (r) => r.found === false && !r.policy,
    describes: 'reports a nonexistent policy as not found, inventing nothing',
  },
  {
    id: 'refuse-unknown-claim',
    group: 'Refusal',
    utterance: 'Check claim CLM-1234-567890.',
    tool: 'lookup-claim',
    body: { claim_number: 'CLM-1234-567890' },
    expect: (r) => r.found === false && !r.claim,
    describes: 'reports a nonexistent claim as not found',
  },
  {
    id: 'refuse-missing-policy-number',
    group: 'Refusal',
    utterance: 'I want to file a claim. (no policy given)',
    tool: 'file-claim',
    body: { incident_description: 'evaluation case with no policy' },
    expect: (r) => r.success === false,
    describes: 'will not file without a policy number',
  },
  {
    id: 'refuse-missing-description',
    group: 'Refusal',
    utterance: 'File a claim on POL-2026-100001. (no description)',
    tool: 'file-claim',
    body: { policy_number: 'POL-2026-100001' },
    expect: (r) => r.success === false,
    describes: 'will not file without an incident description',
  },
  {
    id: 'refuse-empty-claim-number',
    group: 'Refusal',
    utterance: 'Check my claim. (number not given)',
    tool: 'lookup-claim',
    body: {},
    expect: (r) => r.found === false && typeof r.message === 'string',
    describes: 'asks for the claim number rather than guessing',
  },

  // --- Normalisation: speech-to-text rarely produces the dashes -----------
  {
    id: 'norm-no-dashes-claim',
    group: 'Normalisation',
    utterance: 'C L M twenty twenty-six zero zero zero four five six',
    tool: 'lookup-claim',
    body: { claim_number: 'CLM2026000456' },
    expect: (r) => r.found === true && r.claim?.claim_number === 'CLM-2026-000456',
    describes: 'recovers a claim number transcribed without dashes',
  },
  {
    id: 'norm-spaces-claim',
    group: 'Normalisation',
    utterance: 'CLM 2026 000456',
    tool: 'lookup-claim',
    body: { claim_number: 'CLM 2026 000456' },
    expect: (r) => r.found === true && r.claim?.claim_number === 'CLM-2026-000456',
    describes: 'recovers a claim number transcribed with spaces',
  },
  {
    id: 'norm-lowercase-claim',
    group: 'Normalisation',
    utterance: 'clm-2026-000456',
    tool: 'lookup-claim',
    body: { claim_number: 'clm-2026-000456' },
    expect: (r) => r.found === true,
    describes: 'is case-insensitive',
  },
  {
    id: 'norm-no-dashes-policy',
    group: 'Normalisation',
    utterance: 'POL2024001234',
    tool: 'check-policy',
    body: { policy_number: 'POL2024001234' },
    expect: (r) => r.found === true && r.policy?.policy_number === 'POL-2024-001234',
    describes: 'recovers a policy number without dashes',
  },
  {
    id: 'norm-docs-no-dashes',
    group: 'Normalisation',
    utterance: 'What is missing on CLM2026000345?',
    tool: 'check-documents',
    body: { claim_number: 'CLM2026000345' },
    expect: (r) => r.found === true && r.documents_missing?.length === 3,
    describes: 'normalisation applies to document checks too',
  },

  // --- Actions: the write paths -------------------------------------------
  {
    id: 'file-claim-valid',
    group: 'Actions',
    utterance: 'Someone reversed into my car in a car park yesterday.',
    tool: 'file-claim',
    body: {
      policy_number: 'POL-2026-100001',
      claim_type: 'collision',
      incident_description: 'Evaluation run: rear door dented in a car park.',
    },
    expect: (r) => r.success === true && /^CLM-\d{4}-\d{6}$/.test(r.claim_number ?? ''),
    describes: 'files against an active policy and returns a well-formed number',
    cleanup: true,
  },
  {
    id: 'file-claim-home',
    group: 'Actions',
    utterance: 'A pipe burst in my laundry room overnight.',
    tool: 'file-claim',
    body: {
      policy_number: 'POL-2026-100002',
      claim_type: 'water_damage',
      incident_description: 'Evaluation run: supply line burst, flooding downstairs.',
    },
    expect: (r) => r.success === true && r.claim_number,
    describes: 'files a home claim with a non-default type',
    cleanup: true,
  },
  {
    id: 'callback-relative-time',
    group: 'Actions',
    utterance: 'Can someone call me back tomorrow afternoon?',
    tool: 'schedule-callback',
    body: { phone_number: '+14155550101', preferred_time: 'tomorrow at 2pm', reason: 'evaluation' },
    expect: (r) => r.success === true && !Number.isNaN(Date.parse(r.scheduled_time ?? '')),
    describes: 'parses a relative time into a concrete timestamp',
  },
  {
    id: 'callback-natural-language',
    group: 'Actions',
    utterance: 'Call me next Tuesday morning.',
    tool: 'schedule-callback',
    body: { phone_number: '+14155550101', preferred_time: 'next Tuesday morning', reason: 'evaluation' },
    expect: (r) => r.success === true && !Number.isNaN(Date.parse(r.scheduled_time ?? '')),
    describes: 'parses a weekday phrase',
  },
  {
    id: 'escalate-with-sla',
    group: 'Actions',
    utterance: "I'm not happy, I want to speak to a supervisor.",
    tool: 'escalate-to-human',
    body: { reason: 'Evaluation run: caller requested a supervisor.', priority: 'high' },
    expect: (r) => r.success === true && /^ESC-\d{4}-\d{4,8}$/.test(r.reference_number ?? ''),
    describes: 'creates an escalation with a reference number',
  },

  // --- Personalisation ----------------------------------------------------
  {
    id: 'greeting-known-caller',
    group: 'Personalisation',
    utterance: '(inbound call from a number on file)',
    method: 'GET',
    path: '/api/elevenlabs/conversation-init?phone_number=%2B14155550101',
    expect: (r) =>
      r.dynamic_variables?.customer_name === 'Arjun Mehta' &&
      typeof r.dynamic_variables?.policy_number === 'string' &&
      r.dynamic_variables.policy_number !== 'Unknown',
    describes: 'identifies a known caller and supplies their policy',
  },
  {
    id: 'greeting-unknown-caller',
    group: 'Personalisation',
    utterance: '(inbound call from an unrecognised number)',
    method: 'GET',
    path: '/api/elevenlabs/conversation-init?phone_number=%2B19998887777',
    expect: (r) => r.dynamic_variables?.customer_name === 'Customer',
    describes: 'falls back cleanly for an unknown caller',
  },
];

/**
 * Exhaustive per-record cases, built from the database at run time. Skipped
 * when service-role credentials are absent so the harness still runs without
 * them.
 */
const coverage = await buildCoverageCases();
const ALL_CASES = [...CASES, ...coverage.cases];

async function callTool(c) {
  const url = c.path ? `${BASE}${c.path}` : `${BASE}/api/tools/${c.tool}`;
  const started = performance.now();
  const res = await fetch(url, {
    method: c.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
    ...(c.method === 'GET' ? {} : { body: JSON.stringify(c.body ?? {}) }),
  });
  const latency = performance.now() - started;
  const json = await res.json().catch(() => null);
  return { json, latency, status: res.status };
}

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
};

// --- Run ---------------------------------------------------------------------

const results = [];
const created = [];
const unexpectedWrites = [];

if (!AS_JSON) {
  console.log(`\nSafeGuard agent evaluation`);
  console.log(`target: ${BASE}`);
  if (coverage.skipped) {
    console.log(dim(`coverage group skipped: ${coverage.skipped}`));
  } else {
    console.log(
      dim(
        `coverage: every one of ${coverage.counts.claims} claims and ${coverage.counts.policies} policies exercised`
      )
    );
  }
  console.log('='.repeat(74));
}

for (const c of ALL_CASES) {
  let passed = false;
  let latency = 0;
  let note = '';

  try {
    const { json, latency: ms, status } = await callTool(c);
    latency = ms;
    if (status === 401 || status === 503) {
      // Called out by name because the cause is almost always a missing or
      // mismatched TOOLS_API_TOKEN, and a wall of expectation failures does
      // not say so.
      note = `HTTP ${status} — check TOOLS_API_TOKEN matches the backend`;
    } else if (status === 429) {
      note = 'HTTP 429 — rate limited; raise RATE_LIMIT_TOOLS_MAX or slow the run';
    } else if (status >= 500) {
      note = `HTTP ${status}`;
    } else {
      passed = Boolean(json && c.expect(json));
      if (!passed) note = JSON.stringify(json).slice(0, 90);
      if (json?.claim_number) {
        // Every claim number this run receives is swept up, not only the ones
        // from cases marked `cleanup`. A case without that flag never intends
        // to write; if one comes back holding a claim number, a gate this
        // harness exists to measure has given way — usually because its fixture
        // policy stopped being what it was seeded to be. Left in place, that row
        // is permanent, and because the coverage group generates two cases per
        // claim it also enlarges the case count on every subsequent run, which
        // is how 204 became 206. So the row goes, and the fact that it existed
        // is reported rather than quietly tidied away.
        created.push(json.claim_number);
        if (!c.cleanup) unexpectedWrites.push({ id: c.id, claim_number: json.claim_number });
      }
    }
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }

  results.push({ ...c, passed, latency, note });

  if (!AS_JSON) {
    const mark = passed ? green('PASS') : red('FAIL');
    console.log(`  ${mark}  ${c.group.padEnd(16)} ${c.describes}`);
    console.log(dim(`        "${c.utterance}"  ${Math.round(latency)}ms`));
    if (!passed && note) console.log(red(`        ${note}`));
  }
}

// Remove claims this run created so the dataset stays stable. A failure to
// clean up is reported and fails the run: an evaluation that silently changes
// the dataset it measures is worse than one that does not finish.
let cleanupError = null;
if (created.length) {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    const { error } = await sb.from('claims').delete().in('claim_number', created);
    cleanupError = error?.message ?? null;
    if (!AS_JSON && !cleanupError) {
      console.log(dim(`\n  cleaned up ${created.length} claim(s) created during evaluation`));
    }
  } else {
    cleanupError = 'no service-role credentials; claims left in place';
  }
  if (cleanupError && !AS_JSON) {
    console.log(red(`\n  cleanup failed: ${cleanupError}`));
    console.log(red(`  left behind: ${created.join(', ')}`));
  }
}

if (unexpectedWrites.length && !AS_JSON) {
  console.log(
    red(`\n  ${unexpectedWrites.length} case(s) that must not write did write — a refusal gate is not holding:`)
  );
  for (const w of unexpectedWrites) console.log(red(`    ${w.id} created ${w.claim_number}`));
  console.log(dim('  check the fixture policy still has the status the case assumes'));
}

// --- Summary -----------------------------------------------------------------

const groups = [...new Set(ALL_CASES.map((c) => c.group))];
const summary = groups.map((g) => {
  const rows = results.filter((r) => r.group === g);
  const passedRows = rows.filter((r) => r.passed);
  return {
    group: g,
    total: rows.length,
    passed: passedRows.length,
    accuracy: rows.length ? passedRows.length / rows.length : 0,
    p50: Math.round(percentile(rows.map((r) => r.latency), 50)),
    p95: Math.round(percentile(rows.map((r) => r.latency), 95)),
  };
});

const totalPassed = results.filter((r) => r.passed).length;
const latencies = results.map((r) => r.latency);
const overall = {
  target: BASE,
  cases: results.length,
  passed: totalPassed,
  accuracy: totalPassed / results.length,
  p50_ms: Math.round(percentile(latencies, 50)),
  p95_ms: Math.round(percentile(latencies, 95)),
  max_ms: Math.round(Math.max(...latencies)),
  coverage: coverage.skipped ? { skipped: coverage.skipped } : coverage.counts,
  groups: summary,
  failures: results.filter((r) => !r.passed).map((r) => ({ id: r.id, note: r.note })),
  cleanup: { removed: cleanupError ? 0 : created.length, error: cleanupError },
  unexpectedWrites,
};

if (AS_JSON) {
  console.log(JSON.stringify(overall, null, 2));
} else {
  console.log('\n' + '='.repeat(74));
  console.log('\n  Group             Cases   Passed   Accuracy   p50      p95');
  console.log('  ' + '-'.repeat(60));
  for (const g of summary) {
    console.log(
      `  ${g.group.padEnd(18)}${String(g.total).padEnd(8)}${String(g.passed).padEnd(9)}` +
        `${(g.accuracy * 100).toFixed(0).padStart(3)}%      ${String(g.p50 + 'ms').padEnd(9)}${g.p95}ms`
    );
  }
  console.log('  ' + '-'.repeat(60));
  console.log(
    `  ${'Overall'.padEnd(18)}${String(overall.cases).padEnd(8)}${String(overall.passed).padEnd(9)}` +
      `${(overall.accuracy * 100).toFixed(0).padStart(3)}%      ${String(overall.p50_ms + 'ms').padEnd(9)}${overall.p95_ms}ms`
  );
  console.log('');
  if (overall.failures.length) {
    console.log(red(`  ${overall.failures.length} failing case(s):`));
    for (const f of overall.failures) console.log(`    ${f.id}: ${f.note}`);
    console.log('');
  }
}

process.exitCode =
  overall.failures.length || overall.unexpectedWrites.length || overall.cleanup.error ? 1 : 0;
