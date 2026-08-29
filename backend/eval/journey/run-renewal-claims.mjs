/**
 * The second half of the two renewal cases: the claims filed against
 * POL-2026-300016 and POL-2026-300017 after their renewals were paid and the
 * policies came back into force.
 *
 * Both policies refused a claim outright while lapsed (`policy_not_active`, at
 * intake, before any row was written — see PRE-REGISTRATION.md, Amendments).
 * The same policies accept one now. That transition is the renewal path.
 *
 * Takes documents and demands the excess; stops at the payment link, because
 * paying is a human step.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '..', '.env') });

const API = 'https://safeguard-api-production-7c24.up.railway.app';
const T = process.env.TOOLS_API_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const post = async (p, body) =>
  (await fetch(API + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tools-token': T },
    body: JSON.stringify(body),
  })).json();

const out = [];

for (const claim of ['CLM-2026-110071', 'CLM-2026-429770']) {
  const row = { claim };
  const d = await post('/api/tools/check-documents', { claim_number: claim });
  const required = d.documents_required ?? d.outstanding ?? [];
  row.required = required;
  console.log(claim + '  requires: ' + required.join(', '));

  let allOk = true;
  for (const t of required) {
    const lines = [
      t.replace(/_/g, ' ').toUpperCase(), '',
      'Claim: ' + claim,
      'Filed after the policy was renewed and returned to active.',
      'Synthetic document, generated for the journey completion run.',
    ];
    const fd = new FormData();
    fd.append('file', new Blob([makePdf(lines)], { type: 'application/pdf' }), t + '.pdf');
    fd.append('document_type', t);
    fd.append('extracted_text', lines.join('\n'));
    const res = await fetch(API + '/api/claims/' + claim + '/documents', { method: 'POST', body: fd });
    const ok = res.status === 201;
    if (!ok) allOk = false;
    console.log('    ' + t.padEnd(20) + (ok ? 'ok' : 'FAIL ' + res.status));
    await sleep(700);
  }
  row.documentsReceived = allOk;

  const ded = await post('/api/tools/collect-deductible', { claim_id: claim });
  row.excess = ded.deductible_amount ?? null;
  row.link = ded.payment_link_url ?? null;
  console.log('    excess ₹' + row.excess + '   ' + row.link);
  out.push(row);
  await sleep(9000);
}

fs.writeFileSync(path.join(here, 'renewal-claims.json'), JSON.stringify(out, null, 2));
console.log('\nwritten renewal-claims.json');
