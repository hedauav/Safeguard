/**
 * Exhaustive dataset coverage for the evaluation harness.
 *
 * The hand-written cases in `evaluate.mjs` assert literal values chosen to
 * exercise interesting states. These cases do something different and
 * complementary: they read every claim and every policy straight from the
 * database and assert that the tool layer reports each one faithfully.
 *
 * That makes this a fidelity check between the source of truth and what a
 * caller is told, over the whole book of business rather than a chosen sample.
 * It is not a substitute for the literal-value cases — a bug that corrupted
 * both the database and the API identically would pass here and fail there.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Without them the group
 * is skipped and the rest of the harness still runs.
 */

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** Documents still outstanding = required minus received. */
const outstanding = (required, received) => {
  const have = new Set(received ?? []);
  return (required ?? []).filter((d) => !have.has(d));
};

const sameSet = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sorted = (xs) => [...xs].sort();
  return sorted(a).every((v, i) => v === sorted(b)[i]);
};

export async function buildCoverageCases() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { cases: [], skipped: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' };

  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const [{ data: claims, error: claimsErr }, { data: policies, error: policiesErr }] = await Promise.all([
    sb
      .from('claims')
      .select('claim_number, claim_type, status, claimed_amount, documents_required, documents_received')
      .order('claim_number'),
    sb
      .from('policies')
      .select('policy_number, policy_type, status, coverage_amount, deductible')
      .order('policy_number'),
  ]);

  if (claimsErr || policiesErr) {
    return { cases: [], skipped: (claimsErr ?? policiesErr).message };
  }

  const cases = [];

  // Every claim must come back with the type, status and amount the database holds.
  for (const c of claims ?? []) {
    cases.push({
      id: `coverage-claim-${c.claim_number}`,
      group: 'Coverage',
      utterance: `Check ${c.claim_number}.`,
      tool: 'lookup-claim',
      body: { claim_number: c.claim_number },
      expect: (r) =>
        r.found === true &&
        r.claim?.claim_type === c.claim_type &&
        r.claim?.status === c.status &&
        num(r.claim?.claimed_amount) === num(c.claimed_amount),
      describes: `${c.claim_number} reports its stored type, status and amount`,
    });

    // And its outstanding documents must be exactly required-minus-received.
    const missing = outstanding(c.documents_required, c.documents_received);
    cases.push({
      id: `coverage-docs-${c.claim_number}`,
      group: 'Coverage',
      utterance: `What is outstanding on ${c.claim_number}?`,
      tool: 'check-documents',
      body: { claim_number: c.claim_number },
      expect: (r) => r.found === true && sameSet(r.documents_missing, missing),
      describes: `${c.claim_number} lists ${missing.length} outstanding document(s)`,
    });
  }

  // Every policy must come back with its stored terms.
  for (const p of policies ?? []) {
    cases.push({
      id: `coverage-policy-${p.policy_number}`,
      group: 'Coverage',
      utterance: `What does ${p.policy_number} cover?`,
      tool: 'check-policy',
      body: { policy_number: p.policy_number },
      expect: (r) =>
        r.found === true &&
        r.policy?.policy_type === p.policy_type &&
        r.policy?.status === p.status &&
        num(r.policy?.coverage_amount) === num(p.coverage_amount) &&
        num(r.policy?.deductible) === num(p.deductible),
      describes: `${p.policy_number} reports its stored terms`,
    });
  }

  return { cases, counts: { claims: claims?.length ?? 0, policies: policies?.length ?? 0 } };
}
