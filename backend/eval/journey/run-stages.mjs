/**
 * Drive the pre-registered journey cases through the DEPLOYED API, as far as the
 * point where a human has to pay a link.
 *
 * Stages 1-6 for the eight direct cases: policy found, claim filed, adjudicated,
 * documents named, documents received, excess demanded. Renewal offered for the
 * two lapsed ones.
 *
 * Everything after that needs hands on a Razorpay checkout, so the script stops
 * there rather than pretending otherwise. Paying is stage 7 and is logged as a
 * human action, per the pre-registration.
 *
 * Reads PRE-REGISTRATION.md's case list from batch-journey-policies.json so the
 * cases cannot drift from what was registered.
 *
 *   node run-stages.mjs            # the eight direct cases
 *   node run-stages.mjs --renewals # the two lapsed ones
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '..', '.env') });

const API = 'https://safeguard-api-production-7c24.up.railway.app';
const TOOLS = process.env.TOOLS_API_TOKEN;
if (!TOOLS) { console.error('TOOLS_API_TOKEN missing'); process.exit(1); }

const DIRECT = ['POL-2026-300002', 'POL-2026-300003', 'POL-2026-300004', 'POL-2026-300005',
                'POL-2026-300006', 'POL-2026-300007', 'POL-2026-300008', 'POL-2026-300009'];
const RENEWALS = ['POL-2026-300016', 'POL-2026-300017'];

const batch = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'database', 'batch-journey-policies.json'), 'utf8'));
const spec = new Map(batch.map((r) => [r.policy.policy_number, r]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tool(pathname, body) {
  const res = await fetch(API + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tools-token': TOOLS },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// --- a minimal valid PDF, so uploads are a real file rather than a stub -----
function makePdf(lines) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let text = 'BT\n/F1 10 Tf\n50 800 Td\n12 TL\n';
  for (const l of lines) text += '(' + esc(l) + ') Tj\nT*\n';
  text += 'ET';
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    '<</Length ' + Buffer.byteLength(text, 'latin1') + '>>\nstream\n' + text + '\nendstream',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let pdf = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((b, i) => { offs.push(Buffer.byteLength(pdf, 'latin1')); pdf += (i + 1) + ' 0 obj\n' + b + '\nendobj\n'; });
  const x = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  for (const o of offs) pdf += String(o).padStart(10, '0') + ' 00000 n \n';
  pdf += 'trailer\n<</Size ' + (objs.length + 1) + '/Root 1 0 R>>\nstartxref\n' + x + '\n%%EOF\n';
  return Buffer.from(pdf, 'latin1');
}

const docText = (type, claim, policy, amount) => [
  type.replace(/_/g, ' ').toUpperCase(),
  '',
  'Claim: ' + claim + '    Policy: ' + policy,
  'Date: ' + new Date().toISOString().slice(0, 10),
  '',
  'Submitted in support of the claim. Amount claimed: INR ' + amount.toLocaleString('en-IN') + '.',
  'Prepared for the SafeGuard journey completion run; the incident is synthetic',
  'and the document is generated, which the evaluation states plainly.',
];

async function upload(claimNumber, type, policy, amount) {
  const pdf = makePdf(docText(type, claimNumber, policy, amount));
  const form = new FormData();
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), type + '.pdf');
  form.append('document_type', type);
  form.append('extracted_text', docText(type, claimNumber, policy, amount).join('\n'));
  const res = await fetch(API + '/api/claims/' + claimNumber + '/documents', { method: 'POST', body: form });
  const json = await res.json().catch(() => null);
  return { ok: res.status === 201 && json?.success, reason: json?.reason ?? null };
}

const results = [];

async function runDirect(policyNumber) {
  const s = spec.get(policyNumber);
  const row = { policy: policyNumber, type: s.policy.policy_type, stages: {}, stoppedAt: null, note: null };
  const today = new Date().toISOString().slice(0, 10);

  const pol = await tool('/api/tools/check-policy', { policy_number: policyNumber });
  row.stages['1 policy found'] = pol.json?.found !== false && pol.status === 200;
  if (!row.stages['1 policy found']) { row.stoppedAt = 1; results.push(row); return row; }

  const filed = await tool('/api/tools/file-claim', {
    policy_number: policyNumber,
    claim_type: s.journey.claim_type,
    incident_date: today,
    incident_description: 'Journey completion run. ' + s.journey.claim_type.replace(/_/g, ' ') +
      ' reported by the policyholder; supporting documents to follow on this interaction.',
    estimated_amount: s.journey.suggested_claim_amount,
  });
  row.claim = filed.json?.claim_number ?? null;
  row.stages['2 claim filed'] = Boolean(filed.json?.success && row.claim);
  if (!row.stages['2 claim filed']) { row.stoppedAt = 2; row.note = filed.json?.message; results.push(row); return row; }

  // Filing triggers adjudication in the background; give it a moment rather
  // than calling adjudicate again, which would put the claim in the queue twice.
  await sleep(6000);

  const doc = await tool('/api/tools/check-documents', { claim_number: row.claim });
  const required = doc.json?.documents_required ?? doc.json?.outstanding ?? [];
  row.stages['4 documents named'] = Array.isArray(required) && required.length > 0;
  row.required = required;

  if (row.stages['4 documents named']) {
    let all = true;
    for (const t of required) {
      const up = await upload(row.claim, t, policyNumber, s.journey.suggested_claim_amount);
      if (!up.ok) { all = false; row.note = 'upload ' + t + ': ' + up.reason; }
      await sleep(700);
    }
    row.stages['5 documents received'] = all;
  } else {
    row.stages['5 documents received'] = false;
  }

  const ded = await tool('/api/tools/collect-deductible', { claim_id: row.claim });
  row.stages['6 excess demanded'] = Boolean(ded.json?.success && ded.json?.payment_link_url);
  row.link = ded.json?.payment_link_url ?? null;
  row.excess = ded.json?.deductible_amount ?? null;
  if (!row.stages['6 excess demanded']) { row.stoppedAt = 6; row.note ??= ded.json?.message; }

  results.push(row);
  return row;
}

async function runRenewal(policyNumber) {
  const row = { policy: policyNumber, type: spec.get(policyNumber).policy.policy_type, stages: {}, stoppedAt: null, renewal: true };
  const off = await tool('/api/tools/offer-renewal', { policy_number: policyNumber });
  row.stages['R1 renewal offered'] = Boolean(off.json?.success && off.json?.payment_link_url);
  row.link = off.json?.payment_link_url ?? null;
  row.premium = off.json?.amount ?? off.json?.renewal_amount ?? null;
  if (!row.stages['R1 renewal offered']) row.note = off.json?.message;
  results.push(row);
  return row;
}

const mode = process.argv.includes('--renewals') ? 'renewals' : 'direct';
const list = mode === 'renewals' ? RENEWALS : DIRECT;

console.log('Journey run — ' + mode + ' — ' + list.length + ' cases against ' + API);
console.log('');

for (const p of list) {
  const started = Date.now();
  const row = mode === 'renewals' ? await runRenewal(p) : await runDirect(p);
  const reached = Object.entries(row.stages).filter(([, v]) => v).length;
  const total = Object.keys(row.stages).length;
  console.log('  ' + p + '  ' + String(row.claim ?? '—').padEnd(17) +
    reached + '/' + total + ' stages  ' + Math.round((Date.now() - started) / 1000) + 's' +
    (row.note ? '  note: ' + String(row.note).slice(0, 70) : ''));
  if (row.link) console.log('      pay: ' + row.link + (row.excess ? '   (₹' + row.excess.toLocaleString('en-IN') + ')' : ''));
  // ONCHAIN_RATE_LIMIT is 15/min on file-claim and collect-deductible.
  await sleep(9000);
}

const out = path.join(here, 'stages-' + mode + '.json');
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log('');
console.log('written: ' + out);
