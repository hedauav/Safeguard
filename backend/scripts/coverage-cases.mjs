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
 *
 * ## Demo fixtures are excluded, and why that is not hiding them
 *
 * This generator used to read the tables unfiltered, which coupled the size of
 * the evaluation to whatever happened to be sitting in the database. On
 * 2026-08-28 twenty policies were seeded so a claim could be driven end to end
 * for a recorded walkthrough, and the generated total silently moved from 206
 * to 230 — twenty-four cases that no run had ever executed, presented by the
 * count as though it had.
 *
 * A denominator anybody can inflate by seeding is not a measurement. So the
 * journey-batch policies named in `database/batch-journey-policies.json`, and
 * any claim filed against one of them, are excluded here. They are demo
 * fixtures: they exist to be driven by hand on camera, not to be scored.
 *
 * The exclusion is counted and returned in `excluded`, so a caller reports it
 * rather than discovering a smaller number than the table holds. Deleting the
 * JSON file excludes nothing and the count returns to the whole book.
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

  // --- Demo fixtures out, before anything is counted ----------------------
  //
  // Read from the same file the migration is generated from, so the two cannot
  // drift. A missing or unreadable file excludes nothing: the evaluation
  // measuring more than it should is a visible error, whereas silently
  // measuring less would not be.
  const fixturePolicies = new Set();
  try {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const here = dirname(fileURLToPath(import.meta.url));
    for (const manifest of ['batch-journey-policies.json', 'refusal-batch-policies.json']) {
      try {
        const raw = readFileSync(join(here, '..', 'database', manifest), 'utf8');
        for (const r of JSON.parse(raw)) fixturePolicies.add(r.policy.policy_number);
      } catch {
        // One unreadable manifest must not discard the other.
      }
    }
  } catch {
    // handled per manifest above
  }

  const allPolicies = policies ?? [];
  const allClaims = claims ?? [];

  const scoredPolicies = allPolicies.filter((p) => !fixturePolicies.has(p.policy_number));

  // A claim on a fixture policy is a fixture claim. `claims` does not carry
  // policy_number, so the link is made through the ids the fixture file holds.
  let fixtureClaimNumbers = new Set();
  if (fixturePolicies.size > 0) {
    const { data: fixtureClaims } = await sb
      .from('claims')
      .select('claim_number, policies!inner(policy_number)')
      .in('policies.policy_number', [...fixturePolicies]);
    fixtureClaimNumbers = new Set((fixtureClaims ?? []).map((c) => c.claim_number));
  }

  const scoredClaims = allClaims.filter((c) => !fixtureClaimNumbers.has(c.claim_number));

  const excluded = {
    policies: allPolicies.length - scoredPolicies.length,
    claims: allClaims.length - scoredClaims.length,
    reason: 'demo fixtures — the journey batch and the refusal batch, listed in database/*-policies.json',
  };

  const claimsToScore = scoredClaims;
  const policiesToScore = scoredPolicies;

  const cases = [];

  // Every claim must come back with the type, status and amount the database holds.
  for (const c of claimsToScore) {
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
  for (const p of policiesToScore) {
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

  return { cases, counts: { claims: claimsToScore.length, policies: policiesToScore.length }, excluded };
}
