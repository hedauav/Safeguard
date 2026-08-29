/**
 * The twelve approvable cases of the 0026 batch, driven to the payment link.
 *
 * Stages 1-6: policy found, claim filed, adjudicated, documents named,
 * documents received, excess demanded. It stops there deliberately — paying is
 * a human step, and every case beyond that point in this repository was paid by
 * a person at a Razorpay checkout.
 *
 * Which makes these twelve useful in a way the journey ten are not: a reviewer
 * can pick up any of them at exactly the point a human is needed and finish it
 * themselves. The links below are real and unpaid.
 *
 * Each case carries an expected payable figure from
 * refusal-batch-policies.json, written before the batch ran. The adjudication's
 * computed_payable_amount is compared against it, so a case that computes a
 * different number is visible as one.
 *
 *   node run-approval-batch.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '..', '.env') });

const API = 'https://safeguard-api-production-7c24.up.railway.app';
const T = process.env.TOOLS_API_TOKEN;
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const batch = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'database', 'refusal-batch-policies.json'), 'utf8'));
const cases = batch.filter((r) => r.expectation.kind === 'approve');

const post = async (p, body) =>
  (await fetch(API + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tools-token': T },
    body: JSON.stringify(body),
  })).json();

function makePdf(lines) {
  const esc = (v) => v.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
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

const out = [];

for (const c of cases) {
  const p = c.policy.policy_number;
  const e = c.expectation;
  const row = { policy: p, type: c.policy.policy_type, claim_type: e.claim_type, expectedPayable: e.payable, stages: {} };

  const pol = await post('/api/tools/check-policy', { policy_number: p });
  row.stages['1 policy found'] = pol.found !== false;

  const filed = await post('/api/tools/file-claim', {
    policy_number: p,
    claim_type: e.claim_type,
    incident_date: e.incident_date,
    incident_description: 'Approval batch case. ' + e.claim_type.replace(/_/g, ' ') +
      ' reported by the policyholder; documents provided on the same interaction.',
    estimated_amount: e.claimed_amount,
  });
  row.claim = filed.claim_number ?? null;
  row.stages['2 claim filed'] = Boolean(filed.success && row.claim);

  if (!row.stages['2 claim filed']) {
    row.note = String(filed.message ?? '').slice(0, 110);
    console.log(p + '  FILE FAILED  ' + row.note);
    out.push(row);
    await sleep(9000);
    continue;
  }

  await sleep(7000);

  const doc = await post('/api/tools/check-documents', { claim_number: row.claim });
  const required = doc.documents_required ?? doc.outstanding ?? [];
  row.required = required;
  row.stages['4 documents named'] = required.length > 0;

  let allOk = required.length > 0;
  for (const t of required) {
    const lines = [
      t.replace(/_/g, ' ').toUpperCase(), '',
      'Claim: ' + row.claim + '    Policy: ' + p,
      'Submitted in support of a ' + e.claim_type.replace(/_/g, ' ') + ' claim.',
      'Synthetic document, generated for the approval batch.',
    ];
    const fd = new FormData();
    fd.append('file', new Blob([makePdf(lines)], { type: 'application/pdf' }), t + '.pdf');
    fd.append('document_type', t);
    fd.append('extracted_text', lines.join('\n'));
    const res = await fetch(API + '/api/claims/' + row.claim + '/documents', { method: 'POST', body: fd });
    if (res.status !== 201) allOk = false;
    await sleep(600);
  }
  row.stages['5 documents received'] = allOk;

  const ded = await post('/api/tools/collect-deductible', { claim_id: row.claim });
  row.stages['6 excess demanded'] = Boolean(ded.success && ded.payment_link_url);
  row.link = ded.payment_link_url ?? null;
  row.excess = ded.deductible_amount ?? null;

  const { data: adj } = await s.from('adjudications')
    .select('verdict,vetoed_by,model_invoked,computed_payable_amount')
    .eq('claim_number', row.claim).order('created_at').limit(1);
  const a = adj?.[0];
  row.verdict = a?.verdict ?? null;
  row.vetoedBy = a?.vetoed_by ?? null;
  row.computedPayable = a?.computed_payable_amount ?? null;
  row.payableMatches = Number(row.computedPayable) === Number(e.payable);

  const reached = Object.values(row.stages).filter(Boolean).length;
  console.log(p + '  ' + String(row.claim).padEnd(17) + reached + '/5  ' +
    'payable ₹' + Number(row.computedPayable ?? 0).toLocaleString('en-IN') +
    (row.payableMatches ? ' (as expected)' : ' (EXPECTED ₹' + e.payable.toLocaleString('en-IN') + ')') +
    '  verdict=' + row.verdict);
  console.log('      pay ₹' + row.excess + '  ' + row.link);

  out.push(row);
  await sleep(9000);
}

fs.writeFileSync(path.join(here, 'approval-batch.json'), JSON.stringify(out, null, 2));

const full = out.filter((r) => Object.values(r.stages).filter(Boolean).length === 5).length;
const payableOk = out.filter((r) => r.payableMatches).length;
console.log('\n' + full + ' of ' + out.length + ' reached the payment link.');
console.log(payableOk + ' of ' + out.length + ' computed the payable figure predicted before the run.');
console.log('written approval-batch.json');
