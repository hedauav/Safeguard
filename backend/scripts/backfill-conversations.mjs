/**
 * Backfills `call_logs` for ElevenLabs conversations the post-call webhook
 * never delivered.
 *
 * After an account migration the agent was left with `events: ["transcript"]`
 * but `post_call_webhook_id: null`, so completed conversations were parsed and
 * posted to nobody. The webhook is wired again, but the conversations that
 * happened in the gap are absent from the dashboard.
 *
 * They are still readable. `GET /v1/convai/conversations/{id}` returns the same
 * object the webhook posts under its `data` key — same `transcript`, same
 * `metadata`, same `analysis` — which is what makes this safe: the row is built
 * by the *webhook's own* parser, imported from src, not by a second one written
 * here. Two parsers that drift is the bug this project keeps finding.
 *
 *   node scripts/backfill-conversations.mjs                  dry run (default)
 *   node scripts/backfill-conversations.mjs --write          actually insert
 *   node scripts/backfill-conversations.mjs --discover       also list other gaps
 *   node scripts/backfill-conversations.mjs conv_a conv_b    specific ids
 *
 * Reads from backend/.env:
 *   ELEVENLABS_API_KEY           to read the conversations
 *   ELEVENLABS_AGENT_ID          cross-checked against each conversation
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY    writes bypass RLS, hence the dry-run default
 *
 * Idempotent by `elevenlabs_conversation_id`: a conversation already present is
 * left exactly as it is — not updated, not duplicated. Running twice is safe.
 *
 * Deliberately NOT written: `journey_events`. Those rows carry a timestamp for
 * when a step happened, and for a call reconstructed after the fact that
 * timestamp would be a guess. A fabricated timeline entry is worse than an
 * absent one. Also skipped: the evidence pipeline and the `call-updates`
 * realtime broadcast, which are side effects of a *live* call, not part of the
 * record it leaves behind.
 */
import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// process env wins, then a .env in the cwd, then backend/.env — so this works
// whether it is run from backend/ or from the repo root.
loadEnv();
loadEnv({ path: join(HERE, '..', '.env') });

const EL = 'https://api.elevenlabs.io/v1';

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// --- Arguments --------------------------------------------------------------

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const DISCOVER = argv.includes('--discover');
const explicitIds = argv.filter((a) => !a.startsWith('--'));

if (argv.some((a) => a === '--help' || a === '-h')) {
  console.log(
    [
      '',
      'Usage: node scripts/backfill-conversations.mjs [conv_id ...] [--write] [--discover]',
      '',
      '  (no flags)   dry run — prints the rows it would write, touches nothing',
      '  --write      actually insert the rows',
      '  --discover   also list conversations on the agent that are missing from call_logs',
      '',
    ].join('\n')
  );
  process.exit(0);
}

/**
 * The window the webhook was unwired for.
 *
 * Hardcoded rather than discovered so a dry run is reproducible and so an
 * accidental `--write` cannot sweep in conversations nobody has looked at.
 * `--discover` exists to check this list is still complete; ids given as
 * arguments override it entirely.
 */
const GAP_CONVERSATIONS = [
  { id: 'conv_1501m10se63yfg291zy4g4epgbjk', expected: '2026-08-27T05:00:16' },
  { id: 'conv_7401m0ygc1eefm9bw3v3s8v62bhj', expected: '2026-08-26T07:43:20' },
  { id: 'conv_4701m0yg6bxkfnvvjtp9v05qfmjn', expected: '2026-08-26T07:40:14' },
  { id: 'conv_4301m0yet5mqeddatwna779x6agm', expected: '2026-08-26T07:16:05' },
  { id: 'conv_4401m0yerxaqf3qa2ma567z3ttam', expected: '2026-08-26T07:15:24' },
  { id: 'conv_9801m0yc1h0bevgshdywjpnzpmjk', expected: '2026-08-26T06:27:41' },
];

const targets = explicitIds.length
  ? explicitIds.map((id) => ({ id, expected: null }))
  : GAP_CONVERSATIONS;

// --- Credentials ------------------------------------------------------------

const API_KEY = process.env.ELEVENLABS_API_KEY;
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID || null;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const missingEnv = [
  !API_KEY && 'ELEVENLABS_API_KEY',
  !SUPABASE_URL && 'SUPABASE_URL',
  !SERVICE_KEY && 'SUPABASE_SERVICE_ROLE_KEY',
].filter(Boolean);

if (missingEnv.length) {
  console.error(red(`\nMissing from backend/.env: ${missingEnv.join(', ')}\n`));
  process.exit(1);
}

// --- The webhook's own logic, loaded from source -----------------------------

/**
 * Imported from `src/`, not from `dist/`, and not reimplemented here.
 *
 * `dist/` is a build artefact that can be — and at time of writing is — stale:
 * it predates `deriveOutcome`, `extractCallerPhone` and `resolveCustomerId`, so
 * a backfill built on it would silently write worse rows than the live webhook
 * writes. tsx is already a devDependency (it runs `npm run dev`), so pointing
 * it at the TypeScript source costs nothing and cannot go out of date.
 */
let parser;
let writer;
try {
  const { register } = await import('tsx/esm/api');
  register();
  parser = await import(new URL('../src/services/elevenlabs-webhook.ts', import.meta.url).href);
  writer = await import(new URL('../src/services/call-log-service.ts', import.meta.url).href);
} catch (err) {
  console.error(red('\nCould not load the webhook parser from src/.'));
  console.error(dim(`  ${err.message}`));
  console.error(dim('  Try: npm install (tsx is a devDependency), then re-run.'));
  console.error(
    dim('  Or run under the loader directly: node --import tsx scripts/backfill-conversations.mjs')
  );
  process.exit(1);
}

const {
  extractToolExecutions,
  extractClaimId,
  extractCallerPhone,
  calculateDuration,
  deriveOutcome,
  mapDirection,
  resolveCustomerId,
} = parser;
const { createCallLog, logToolExecution } = writer;

// A stale or partial module would fail later, deep inside a write. Fail now.
const required = {
  extractToolExecutions,
  extractClaimId,
  extractCallerPhone,
  calculateDuration,
  deriveOutcome,
  mapDirection,
  resolveCustomerId,
  createCallLog,
  logToolExecution,
};
const absent = Object.entries(required)
  .filter(([, fn]) => typeof fn !== 'function')
  .map(([name]) => name);
if (absent.length) {
  console.error(red(`\nThe webhook module is missing: ${absent.join(', ')}`));
  console.error(dim('  src/services/elevenlabs-webhook.ts has changed shape. Fix this script.'));
  process.exit(1);
}

const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// --- ElevenLabs -------------------------------------------------------------

async function el(path) {
  const res = await fetch(`${EL}${path}`, { headers: { 'xi-api-key': API_KEY } });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    const error = new Error(`${res.status} — ${String(detail).slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }
  return body;
}

// --- Shape checking ---------------------------------------------------------

/**
 * What is wrong with this payload, before anything is built from it.
 *
 * `blocking` means a field the row genuinely depends on is absent, so writing
 * would put a hole in the record — the API has drifted and a human should look.
 * `warnings` are things worth saying out loud but which the webhook itself
 * tolerates, so tolerating them here keeps the two paths identical.
 */
function inspect(id, data) {
  const blocking = [];
  const warnings = [];

  if (!data || typeof data !== 'object') {
    return { blocking: ['response body is not an object'], warnings };
  }

  if (data.conversation_id !== id) {
    blocking.push(`conversation_id is "${data.conversation_id}", asked for "${id}"`);
  }
  if (!Array.isArray(data.transcript)) {
    blocking.push('transcript is absent or not an array');
  }
  // The webhook falls back to Date.now() here. For a live delivery that is
  // within seconds of the truth; for a call from days ago it would stamp the
  // row with today, which is a fabricated timestamp in the one column the
  // dashboard sorts on. Refuse instead.
  if (typeof data.metadata?.start_time_unix_secs !== 'number') {
    blocking.push('metadata.start_time_unix_secs is absent — cannot date this call honestly');
  }

  if (AGENT_ID && data.agent_id && data.agent_id !== AGENT_ID) {
    warnings.push(`agent_id is ${data.agent_id}, expected ${AGENT_ID}`);
  }
  if (data.status && data.status !== 'done') {
    warnings.push(`status is "${data.status}" — ElevenLabs may not have finished processing it`);
  }
  if (!data.analysis) {
    warnings.push('no analysis block — summary will be null and outcome comes from tools alone');
  } else if (!data.analysis.transcript_summary) {
    warnings.push('analysis has no transcript_summary — summary will be null');
  }
  if (typeof data.metadata?.call_duration_secs !== 'number') {
    warnings.push('metadata.call_duration_secs absent — duration inferred from the last turn');
  }
  if (Array.isArray(data.transcript) && data.transcript.length === 0) {
    warnings.push('transcript is empty');
  }

  return { blocking, warnings };
}

// --- Row assembly -----------------------------------------------------------

/**
 * The same row `handleTranscription` builds in src/routes/webhooks.ts.
 *
 * Every value here comes out of an imported function; nothing is parsed twice.
 * The field list itself is the one thing that could not be imported —
 * `handleTranscription` is module-local to webhooks.ts and this script may not
 * edit that file. If you add a column there, add it here. Better still: export
 * the assembly from webhooks.ts and delete this function.
 *
 * One value differs on purpose. The webhook sets `ended_at` to the moment the
 * delivery arrived, which is a few seconds after the call ends. Copying that
 * literally would mean stamping a two-day-old call with today's clock, so
 * `ended_at` is start + duration: the same instant the webhook would have
 * recorded, had it fired when it should have.
 */
function buildRow({ data, executions, callerPhone, customerId }) {
  const transcript = data.transcript ?? [];
  const startedAtMs = data.metadata.start_time_unix_secs * 1000;
  const durationSeconds = calculateDuration(data);

  return {
    elevenlabs_conversation_id: data.conversation_id,
    direction: mapDirection(data),
    status: 'completed',
    phone_number: callerPhone,
    duration_seconds: durationSeconds,
    transcript: transcript.map((turn) => ({
      role: turn.role,
      message: turn.message ?? '',
      ...(turn.time_in_call_secs != null ? { time_in_call_secs: turn.time_in_call_secs } : {}),
    })),
    summary: data.analysis?.transcript_summary ?? null,
    outcome: deriveOutcome(data.analysis?.call_successful, executions),
    tools_used: Array.from(new Set(executions.map((e) => e.toolName))),
    ...(customerId ? { customer_id: customerId } : {}),
    analysis: data.analysis?.data_collection_results ?? null,
    evaluation: data.analysis?.evaluation_criteria_results ?? null,
    metadata: data.metadata ?? null,
    webhook_payload: data,
    started_at: new Date(startedAtMs).toISOString(),
    ended_at: new Date(startedAtMs + durationSeconds * 1000).toISOString(),
  };
}

// --- Which of these are already in the database -----------------------------

async function existingIds(ids) {
  const { data, error } = await supabase
    .from('call_logs')
    .select('id, elevenlabs_conversation_id, started_at')
    .in('elevenlabs_conversation_id', ids);
  if (error) throw new Error(`Reading call_logs failed: ${error.message}`);
  return new Map((data ?? []).map((row) => [row.elevenlabs_conversation_id, row]));
}

// --- Report -----------------------------------------------------------------

console.log('');
console.log('SafeGuard post-call backfill');
console.log('='.repeat(66));
console.log(`  mode        : ${WRITE ? red('WRITE — this inserts rows') : green('dry run')}`);
console.log(`  supabase    : ${new URL(SUPABASE_URL).hostname}`);
console.log(`  agent       : ${AGENT_ID ?? dim('(ELEVENLABS_AGENT_ID unset — no cross-check)')}`);
console.log(`  targets     : ${targets.length} conversation(s)`);
console.log('');

const present = await existingIds(targets.map((t) => t.id));

const tally = { written: 0, wouldWrite: 0, skipped: 0, blocked: 0, missing: 0, failed: 0 };

for (const target of targets) {
  console.log(cyan(target.id));
  if (target.expected) console.log(dim(`  gap list says  ${target.expected}`));

  const already = present.get(target.id);
  if (already) {
    tally.skipped++;
    console.log(
      `  ${yellow('SKIP')}  already in call_logs as ${already.id} (started ${already.started_at})`
    );
    console.log(dim('        left untouched — this script never overwrites an existing row'));
    console.log('');
    continue;
  }

  let data;
  try {
    data = await el(`/convai/conversations/${target.id}`);
  } catch (err) {
    if (err.status === 404) {
      tally.missing++;
      console.log(`  ${red('NOT FOUND')}  ElevenLabs has no such conversation`);
    } else {
      tally.failed++;
      console.log(`  ${red('ERROR')}  ${err.message}`);
    }
    console.log('');
    continue;
  }

  const { blocking, warnings } = inspect(target.id, data);
  for (const w of warnings) console.log(`  ${yellow('warn')}  ${w}`);

  if (blocking.length) {
    tally.blocked++;
    for (const b of blocking) console.log(`  ${red('BLOCKED')}  ${b}`);
    console.log(dim('        no row written — the payload is missing something the row needs'));
    console.log('');
    continue;
  }

  const executions = extractToolExecutions(data.transcript ?? []);
  const claimId = extractClaimId(data.analysis?.data_collection_results, executions);
  const callerPhone = extractCallerPhone(data);
  const customerId = await resolveCustomerId(supabase, { phone: callerPhone, claimId });

  const row = buildRow({ data, executions, callerPhone, customerId });

  console.log(dim(`  started ${row.started_at}  ended ${row.ended_at}  (${row.duration_seconds}s)`));
  console.log(`  direction ${row.direction}   outcome ${green(row.outcome)}`);
  console.log(
    `  phone ${row.phone_number ?? dim('none')}   customer ${
      customerId ? customerId : yellow('unresolved')
    }${claimId ? `   claim ${claimId}` : ''}`
  );
  console.log(
    `  ${row.transcript.length} turns, ${executions.length} tool execution(s)` +
      (row.tools_used.length ? `: ${row.tools_used.join(', ')}` : '')
  );
  const failedTools = executions.filter((e) => !e.success).map((e) => e.toolName);
  if (failedTools.length) console.log(dim(`  failed tools: ${failedTools.join(', ')}`));
  if (!customerId) {
    console.log(
      dim('  customer unresolved — normal for a browser call, worth a look for a phone call')
    );
  }

  if (!WRITE) {
    tally.wouldWrite++;
    console.log(`  ${green('WOULD WRITE')}  1 call_logs row + ${executions.length} tool row(s)`);
    console.log('');
    continue;
  }

  // Re-checked immediately before the insert, not just in the batch above, so a
  // row that appeared in between (a late webhook redelivery) is still respected.
  const { data: raced } = await supabase
    .from('call_logs')
    .select('id')
    .eq('elevenlabs_conversation_id', target.id)
    .maybeSingle();
  if (raced) {
    tally.skipped++;
    console.log(`  ${yellow('SKIP')}  appeared in call_logs during this run (${raced.id})`);
    console.log('');
    continue;
  }

  try {
    const callLog = await createCallLog(supabase, row);
    for (const execution of executions) {
      await logToolExecution(supabase, {
        call_log_id: callLog.id,
        tool_name: execution.toolName,
        tool_args: execution.args,
        tool_result: execution.result,
        success: execution.success,
        latency_ms: execution.latencyMs,
      });
    }
    tally.written++;
    console.log(`  ${green('WRITTEN')}  call_logs ${callLog.id} + ${executions.length} tool row(s)`);
  } catch (err) {
    tally.failed++;
    console.log(`  ${red('WRITE FAILED')}  ${err.message ?? err}`);
    console.log(dim('        a call_logs row may exist without its tool rows — check before retry'));
  }
  console.log('');
}

// --- Optionally check the gap list is complete ------------------------------

if (DISCOVER) {
  console.log('-'.repeat(66));
  console.log('Checking the agent for other conversations missing from call_logs ...');
  try {
    const seen = [];
    let cursor = null;
    do {
      const query = new URLSearchParams({ page_size: '100' });
      if (AGENT_ID) query.set('agent_id', AGENT_ID);
      if (cursor) query.set('cursor', cursor);
      const page = await el(`/convai/conversations?${query}`);
      for (const c of page.conversations ?? []) {
        if (c.conversation_id) seen.push(c);
      }
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);

    console.log(dim(`  ${seen.length} conversation(s) on the agent`));

    const known = await existingIds(seen.map((c) => c.conversation_id));
    const handled = new Set(targets.map((t) => t.id));
    const extra = seen.filter((c) => !known.has(c.conversation_id) && !handled.has(c.conversation_id));

    if (extra.length === 0) {
      console.log(green('  no conversations missing beyond the ones handled above'));
    } else {
      console.log(yellow(`  ${extra.length} further conversation(s) absent from call_logs:`));
      for (const c of extra) {
        const when = c.start_time_unix_secs
          ? new Date(c.start_time_unix_secs * 1000).toISOString()
          : 'unknown time';
        console.log(`    ${c.conversation_id}  ${when}  ${c.status ?? ''}`);
      }
      console.log(dim('  the gap may be wider than six. Pass these as arguments to include them.'));
    }
  } catch (err) {
    console.log(red(`  discovery failed — ${err.message}`));
  }
  console.log('');
}

// --- Summary ----------------------------------------------------------------

console.log('='.repeat(66));
const parts = [
  tally.written && green(`${tally.written} written`),
  tally.wouldWrite && `${tally.wouldWrite} would be written`,
  tally.skipped && `${tally.skipped} already present`,
  tally.blocked && red(`${tally.blocked} blocked`),
  tally.missing && red(`${tally.missing} not found`),
  tally.failed && red(`${tally.failed} failed`),
].filter(Boolean);
console.log(parts.length ? parts.join(', ') : 'nothing to do');

if (!WRITE && tally.wouldWrite > 0) {
  console.log('');
  console.log('Dry run — nothing was written. To apply:');
  console.log('  node scripts/backfill-conversations.mjs --write');
}

if (tally.blocked || tally.failed || tally.missing) process.exitCode = 1;
console.log('');
