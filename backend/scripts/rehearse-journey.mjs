/**
 * Drive one claim the whole way through the DEPLOYED API, as a rehearsal.
 *
 * Run from backend/:
 *   node scripts/rehearse-journey.mjs POL-2026-300015 --stage-1
 *   node scripts/rehearse-journey.mjs POL-2026-300015 --stage-2 CLM-....
 *
 * Stage 1 goes as far as the deductible payment link and stops, because the
 * next thing that has to happen is a human (or a browser) paying it. Stage 2
 * picks up after the link is paid: reconcile the capture, approve with a fault
 * finding, settle, and confirm the refund.
 *
 * Split rather than one run because the pause is real. Anything that pretended
 * to paper over it would be rehearsing a journey the demo does not have.
 *
 * Tokens come from ../.env and are never printed. Everything else is printed,
 * including the failures — the point of a rehearsal is to find them here.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env') });

const API = process.env.REHEARSAL_API ?? 'https://safeguard-api-production-7c24.up.railway.app';
const TOOLS = process.env.TOOLS_API_TOKEN;
const ADMIN = process.env.ADMIN_TOKEN;

if (!TOOLS || !ADMIN) {
  console.error('TOOLS_API_TOKEN and ADMIN_TOKEN must be set in backend/.env');
  process.exit(1);
}

const policyNumber = process.argv[2];
const stage = process.argv.includes('--stage-2') ? 2 : 1;
const claimArg = process.argv[4];

if (!policyNumber) {
  console.error('Usage: node scripts/rehearse-journey.mjs <POLICY_NUMBER> [--stage-1|--stage-2 <CLAIM_NUMBER>]');
  process.exit(1);
}

const money = (n) => (n === null || n === undefined ? '—' : '₹' + Number(n).toLocaleString('en-IN'));

let step = 0;
async function call(label, pathname, body, auth = 'tools') {
  step += 1;
  const started = Date.now();
  const headers = { 'Content-Type': 'application/json' };
  if (auth === 'tools') headers['x-tools-token'] = TOOLS;
  else headers['Authorization'] = 'Bearer ' + ADMIN;

  let res, json;
  try {
    res = await fetch(API + pathname, {
      method: body === null ? 'GET' : 'POST',
      headers,
      body: body === null ? undefined : JSON.stringify(body),
    });
    json = await res.json();
  } catch (err) {
    console.log('  ' + step + '. ' + label + '  NETWORK ERROR: ' + err.message);
    return { ok: false, json: null };
  }

  const ms = Date.now() - started;
  const ok = res.ok && json?.success !== false;
  console.log('  ' + step + '. ' + label.padEnd(34) + (ok ? 'ok  ' : 'FAIL') + String(ms).padStart(6) + ' ms   HTTP ' + res.status);
  if (!ok) {
    console.log('       ' + JSON.stringify(json).slice(0, 400));
  }
  return { ok, json };
}

console.log('Rehearsing against ' + API);
console.log('Policy ' + policyNumber + ', stage ' + stage);
console.log('');

if (stage === 1) {
  const today = new Date().toISOString().slice(0, 10);

  const policy = await call('check-policy', '/api/tools/check-policy', { policy_number: policyNumber });
  if (!policy.ok) process.exit(1);
  const p = policy.json;
  console.log('       ' + (p.policy_type ?? '?') + ', cover ' + money(p.coverage_amount) + ', excess ' + money(p.deductible) + ', status ' + (p.status ?? '?'));

  const filed = await call('file-claim', '/api/tools/file-claim', {
    policy_number: policyNumber,
    claim_type: 'medical',
    incident_date: today,
    incident_description:
      'Rehearsal for the demo recording. Day-care procedure at a network hospital; discharge summary and final bill available.',
    estimated_amount: 33300,
  });
  if (!filed.ok) process.exit(1);
  const claimNumber = filed.json.claim_number;
  console.log('       claim ' + claimNumber);

  const adj = await call('adjudicate-claim', '/api/tools/adjudicate-claim', { claim_id: claimNumber });
  if (adj.ok) {
    const a = adj.json;
    console.log('       verdict ' + a.verdict + ', payable ' + money(a.payable_amount) +
      ', model ' + (a.model_invoked ? (a.model_id ?? 'yes') : 'not called') +
      (a.vetoed_by ? ', vetoed by ' + a.vetoed_by : '') +
      ', latency ' + (a.model_latency_ms ?? '—') + ' ms');
    if (a.warnings?.length) console.log('       warnings: ' + a.warnings.join(' | '));
  }

  const ded = await call('collect-deductible', '/api/tools/collect-deductible', { claim_id: claimNumber });
  if (!ded.ok) process.exit(1);
  const d = ded.json;
  console.log('       amount ' + money(d.amount ?? d.deductible_amount));
  console.log('');
  console.log('  PAYMENT LINK: ' + (d.payment_link ?? d.short_url ?? JSON.stringify(d).slice(0, 300)));
  console.log('');
  console.log('  Pay it, then run:');
  console.log('    node scripts/rehearse-journey.mjs ' + policyNumber + ' --stage-2 ' + claimNumber);
  process.exit(0);
}

// --- Stage 2 ---------------------------------------------------------------
const claimNumber = claimArg;
if (!claimNumber) {
  console.error('Stage 2 needs the claim number: --stage-2 CLM-2026-XXXXXX');
  process.exit(1);
}

const recon = await call('collect-deductible (reconcile)', '/api/tools/collect-deductible', { claim_id: claimNumber });
console.log('       ' + JSON.stringify(recon.json).slice(0, 300));

const queue = await call('adjudications/queue', '/api/adjudications/queue?limit=50', null, 'admin');
if (!queue.ok) process.exit(1);
const rows = queue.json?.data?.reviews ?? queue.json?.data?.queue ?? queue.json?.data ?? [];
const list = Array.isArray(rows) ? rows : (rows.items ?? []);
const mine = list.find((r) => r.claim_number === claimNumber);
if (!mine) {
  console.log('       claim ' + claimNumber + ' not found in the queue; keys: ' + JSON.stringify(Object.keys(queue.json?.data ?? {})));
  console.log('       ' + JSON.stringify(queue.json).slice(0, 500));
  process.exit(1);
}
console.log('       adjudication ' + mine.id + ', recommended ' + (mine.verdict ?? mine.recommended_verdict));

const decision = await call('decision (approve + fault)', '/api/adjudications/' + mine.id + '/decision', {
  decision: 'approve',
  reviewer: 'Rehearsal — demo dry run',
  note: 'Approved during a rehearsal of the recorded walkthrough.',
  fault_determination: 'other_party',
}, 'admin');
if (decision.ok) console.log('       ' + JSON.stringify(decision.json?.data ?? decision.json).slice(0, 300));

const settled = await call('settle-claim', '/api/tools/settle-claim', { claim_id: claimNumber });
console.log('');
console.log('  SETTLEMENT RESULT');
console.log('  ' + JSON.stringify(settled.json, null, 2).split('\n').join('\n  ').slice(0, 2000));
