import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readCases, readTruth, splitDir } from '../dataset.js';
import { generateSplit, SPLITS, DEV_SEED, HOLDOUT_SEED, EXPECTED_RULE, TRAP_ORDER } from '../generate.js';
import { serialise } from '../build.js';
import { deriveVerdict } from '../rules.js';
import { structuralFacts, payableIfApproved, contradictionTolerance, parseTotal, parseDate } from '../analyse.js';
import { documentsRequired, ESTIMATE_DOCUMENT, REPORT_DOCUMENT } from '../fixtures.js';
import type { EvalCase, SplitName, TrapCategory, Verdict } from '../types.js';

const SPLIT_NAMES: SplitName[] = ['dev', 'holdout'];
const VERDICTS: Verdict[] = ['approve', 'deny', 'escalate'];

const loaded = Object.fromEntries(
  SPLIT_NAMES.map((s) => [s, { cases: readCases(s), truth: readTruth(s) }])
) as Record<SplitName, { cases: ReturnType<typeof readCases>; truth: ReturnType<typeof readTruth> }>;

// --- Size and shape ---------------------------------------------------------

test('the two splits together are the ~150 cases the set claims to be', () => {
  assert.equal(loaded.dev.cases.count, 100);
  assert.equal(loaded.holdout.cases.count, 50);
  assert.equal(loaded.dev.cases.count + loaded.holdout.cases.count, 150);
  for (const s of SPLIT_NAMES) {
    assert.equal(loaded[s].cases.cases.length, loaded[s].cases.count);
    assert.equal(loaded[s].truth.entries.length, loaded[s].truth.count);
  }
});

test('every case has exactly one label, matched by id and by position', () => {
  for (const s of SPLIT_NAMES) {
    const { cases, truth } = loaded[s];
    assert.equal(cases.cases.length, truth.entries.length);
    cases.cases.forEach((c, i) => {
      assert.equal(truth.entries[i]!.case_id, c.case_id, `${s} index ${i} is misaligned`);
    });
    assert.equal(new Set(truth.entries.map((e) => e.case_id)).size, truth.entries.length);
  }
});

// --- The seeds are the whole argument for the holdout ------------------------

test('the holdout is drawn from a different seed than the dev set', () => {
  assert.equal(loaded.dev.cases.seed, DEV_SEED);
  assert.equal(loaded.holdout.cases.seed, HOLDOUT_SEED);
  assert.notEqual(
    loaded.dev.cases.seed,
    loaded.holdout.cases.seed,
    'a holdout drawn from the dev seed is the dev set with a different filename'
  );
  for (const s of SPLIT_NAMES) assert.equal(loaded[s].cases.seed, loaded[s].truth.seed);
});

test('the two splits share no person, no policy number, no claim number and no narrative', () => {
  const fields = (split: SplitName) => {
    const cs = loaded[split].cases.cases;
    return {
      ids: new Set(cs.map((c) => c.case_id)),
      policies: new Set(cs.map((c) => c.policy.policy_number)),
      claims: new Set(cs.flatMap((c) => [c.claim.claim_number, ...c.related_claims.map((r) => r.claim_number)])),
      people: new Set(cs.map((c) => `${c.customer.full_name}|${c.customer.phone}`)),
      stories: new Set(cs.map((c) => c.claim.incident_description)),
    };
  };
  const dev = fields('dev');
  const hold = fields('holdout');
  for (const key of ['ids', 'policies', 'claims', 'people', 'stories'] as const) {
    const overlap = [...hold[key]].filter((v) => dev[key].has(v));
    assert.deepEqual(overlap, [], `${key} overlap between dev and holdout: ${overlap.slice(0, 3).join(', ')}`);
  }
});

test('regenerating from the recorded seed reproduces the shipped bytes exactly', () => {
  for (const s of SPLIT_NAMES) {
    const { seed, plan } = SPLITS[s];
    const regenerated = generateSplit(s, seed, plan);
    for (const [file, value] of [
      ['cases.json', regenerated.cases],
      ['ground-truth.json', regenerated.truth],
    ] as const) {
      const onDisk = readFileSync(join(splitDir(s), file), 'utf8');
      assert.equal(
        serialise(value),
        onDisk,
        `${s}/${file} on disk is not what seed ${seed} produces — either the file was edited or the generator changed`
      );
    }
  }
});

test('the same seed is reproducible and a different seed is a different dataset', () => {
  const a = generateSplit('dev', DEV_SEED, SPLITS.dev.plan);
  const b = generateSplit('dev', DEV_SEED, SPLITS.dev.plan);
  assert.equal(serialise(a.cases), serialise(b.cases));

  const other = generateSplit('dev', DEV_SEED + 1, SPLITS.dev.plan);
  assert.notEqual(serialise(a.cases), serialise(other.cases));
});

// --- Conventions from the live schema ---------------------------------------

test('claim and policy numbers follow the CLM-YYYY-NNNNNN / POL-YYYY-NNNNNN convention', () => {
  for (const s of SPLIT_NAMES) {
    for (const c of loaded[s].cases.cases) {
      assert.match(c.claim.claim_number, /^CLM-\d{4}-\d{6}$/, c.case_id);
      assert.match(c.policy.policy_number, /^POL-\d{4}-\d{6}$/, c.case_id);
      for (const r of c.related_claims) assert.match(r.claim_number, /^CLM-\d{4}-\d{6}$/, c.case_id);
    }
  }
});

test('these numbers do not collide with the seeded database ranges', () => {
  // The live dataset uses CLM-2026-0NNNNN and reserves CLM-2026-2NNNNN for
  // runtime creation. Fixtures live in the 7- and 8- blocks, so a fixture can
  // never be mistaken for a row and a row can never be mistaken for a fixture.
  const prefix: Record<SplitName, string> = { dev: '7', holdout: '8' };
  for (const s of SPLIT_NAMES) {
    for (const c of loaded[s].cases.cases) {
      assert.equal(c.claim.claim_number.slice(9, 10), prefix[s], c.case_id);
      assert.equal(c.policy.policy_number.slice(9, 10), prefix[s], c.case_id);
    }
  }
});

test('documents_required is exactly getDefaultDocuments for the claim type', () => {
  for (const s of SPLIT_NAMES) {
    for (const c of loaded[s].cases.cases) {
      assert.deepEqual(c.claim.documents_required, documentsRequired(c.claim.claim_type), c.case_id);
      for (const got of c.claim.documents_received) {
        assert.ok(c.claim.documents_required.includes(got), `${c.case_id} received an unrequired ${got}`);
      }
      assert.deepEqual(
        c.documents.map((d) => d.document_type),
        c.claim.documents_received,
        `${c.case_id} uploaded documents disagree with documents_received`
      );
    }
  }
});

test('incident descriptions read like filings, not like field values', () => {
  for (const s of SPLIT_NAMES) {
    for (const c of loaded[s].cases.cases) {
      const sentences = c.claim.incident_description.split(/(?<=\.)\s+/);
      assert.ok(sentences.length >= 3, `${c.case_id} has only ${sentences.length} sentence(s)`);
      assert.ok(c.claim.incident_description.length > 180, `${c.case_id} description is too thin`);
    }
  }
});

// --- The answer key must be checkable, not merely asserted -------------------

test('every recorded fact that can be read off the case file agrees with the case file', () => {
  for (const s of SPLIT_NAMES) {
    const { cases, truth } = loaded[s];
    cases.cases.forEach((c: EvalCase, i) => {
      const recorded = truth.entries[i]!.facts;
      const observed = structuralFacts(c);
      assert.equal(observed.in_force, recorded.in_force, `${c.case_id} in_force`);
      assert.equal(observed.over_coverage_limit, recorded.over_coverage_limit, `${c.case_id} over_coverage_limit`);
      assert.equal(
        observed.deductible_swallows_claim,
        recorded.deductible_swallows_claim,
        `${c.case_id} deductible_swallows_claim`
      );
      assert.equal(
        observed.evidence_contradiction,
        recorded.evidence_contradiction,
        `${c.case_id} evidence_contradiction`
      );
      assert.equal(observed.duplicate_filing, recorded.duplicate_filing, `${c.case_id} duplicate_filing`);
    });
  }
});

test('every label is what the rulebook returns for that case, and cites the rule that fired', () => {
  for (const s of SPLIT_NAMES) {
    for (const e of loaded[s].truth.entries) {
      const derived = deriveVerdict(e.facts);
      assert.equal(derived.verdict, e.label, `${e.case_id} label disagrees with the rulebook`);
      assert.equal(derived.rule, e.rule, `${e.case_id} cites the wrong rule`);
      assert.equal(derived.rule, EXPECTED_RULE[e.trap], `${e.case_id} does not exercise the rule its trap is for`);
    }
  }
});

test('every case carries a one-line justification with something specific in it', () => {
  for (const s of SPLIT_NAMES) {
    for (const e of loaded[s].truth.entries) {
      assert.ok(e.justification.length > 40, `${e.case_id} justification is too thin`);
      assert.ok(!e.justification.includes('\n'), `${e.case_id} justification is more than one line`);
    }
  }
});

test('payable_if_approved_inr is the case arithmetic, not an average', () => {
  for (const s of SPLIT_NAMES) {
    const { cases, truth } = loaded[s];
    cases.cases.forEach((c, i) => {
      const e = truth.entries[i]!;
      assert.equal(e.claimed_amount_inr, c.claim.claimed_amount, c.case_id);
      assert.equal(e.payable_if_approved_inr, payableIfApproved(c), c.case_id);
      assert.equal(
        e.payable_if_approved_inr,
        Math.max(0, Math.min(c.claim.claimed_amount, c.policy.coverage_amount) - c.policy.deductible),
        c.case_id
      );
    });
  }
});

// --- The distribution has to be adversarial, and has to be checked -----------

test('every label and every trap category appears in both splits', () => {
  for (const s of SPLIT_NAMES) {
    const labels = new Set(loaded[s].truth.entries.map((e) => e.label));
    for (const v of VERDICTS) assert.ok(labels.has(v), `${s} has no ${v} case`);

    const traps = new Map<TrapCategory, number>();
    for (const e of loaded[s].truth.entries) traps.set(e.trap, (traps.get(e.trap) ?? 0) + 1);
    for (const trap of TRAP_ORDER) {
      assert.ok((traps.get(trap) ?? 0) >= 2, `${s} has fewer than 2 ${trap} cases`);
    }
  }
});

test('a meaningful share of the set is genuinely straightforward', () => {
  for (const s of SPLIT_NAMES) {
    const entries = loaded[s].truth.entries;
    const approvals = entries.filter((e) => e.label === 'approve').length;
    const share = approvals / entries.length;
    assert.ok(share > 0.3, `${s} is only ${(share * 100).toFixed(0)}% approvals; a set of nothing but traps measures nothing`);
    assert.ok(share < 0.6, `${s} is ${(share * 100).toFixed(0)}% approvals, which is not adversarial enough to be worth running`);
  }
});

test('the coverage-limit boundary is one rupee either side, in both directions', () => {
  for (const s of SPLIT_NAMES) {
    const { cases, truth } = loaded[s];
    let over = 0;
    let under = 0;
    cases.cases.forEach((c, i) => {
      const e = truth.entries[i]!;
      if (e.trap === 'limit_boundary_over') {
        assert.equal(c.claim.claimed_amount, c.policy.coverage_amount + 1, c.case_id);
        assert.equal(e.label, 'escalate', c.case_id);
        over++;
      }
      if (e.trap === 'limit_boundary_under') {
        assert.equal(c.claim.claimed_amount, c.policy.coverage_amount - 1, c.case_id);
        assert.equal(e.label, 'approve', c.case_id);
        under++;
      }
    });
    assert.ok(over >= 2 && under >= 2, `${s} needs both sides of the boundary`);
  }
});

test('the lapse boundary is one day either side of the incident', () => {
  for (const s of SPLIT_NAMES) {
    const { cases, truth } = loaded[s];
    cases.cases.forEach((c, i) => {
      const e = truth.entries[i]!;
      if (e.trap === 'policy_lapsed_before') {
        const gap = Date.parse(c.claim.incident_date) - Date.parse(c.policy.end_date);
        assert.equal(gap, 86_400_000, `${c.case_id} should lapse exactly one day before the incident`);
        assert.equal(e.label, 'deny', c.case_id);
      }
      if (e.trap === 'policy_lapsed_after') {
        const gap = Date.parse(c.policy.end_date) - Date.parse(c.claim.incident_date);
        assert.equal(gap, 86_400_000, `${c.case_id} should expire exactly one day after the incident`);
        assert.equal(e.label, 'approve', c.case_id);
      }
    });
  }
});

test('a contradicted estimate really contradicts, and a consistent one really agrees', () => {
  for (const s of SPLIT_NAMES) {
    const { cases, truth } = loaded[s];
    cases.cases.forEach((c, i) => {
      const e = truth.entries[i]!;
      const doc = c.documents.find((d) => d.document_type === ESTIMATE_DOCUMENT[c.claim.claim_type]);
      if (!doc) return;
      const total = parseTotal(doc.content);
      assert.notEqual(total, null, `${c.case_id} estimate has no readable total`);
      const gap = Math.abs(total! - c.claim.claimed_amount);
      const tolerance = contradictionTolerance(c.claim.claimed_amount);
      if (e.trap === 'estimate_contradiction' || e.trap === 'stacked_lapse_and_contradiction') {
        assert.ok(gap > tolerance, `${c.case_id} was meant to contradict but is within tolerance`);
      } else {
        assert.ok(gap <= tolerance, `${c.case_id} contradicts by accident (gap ${gap} > ${tolerance})`);
      }
    });
  }
});

test('a mismatched report really states a different date, and every other report agrees', () => {
  for (const s of SPLIT_NAMES) {
    const { cases, truth } = loaded[s];
    cases.cases.forEach((c, i) => {
      const e = truth.entries[i]!;
      const type = REPORT_DOCUMENT[c.claim.claim_type];
      if (!type) return;
      const doc = c.documents.find((d) => d.document_type === type);
      if (!doc) return;
      const stated = parseDate(doc.content);
      assert.notEqual(stated, null, `${c.case_id} report has no readable date of occurrence`);
      if (e.trap === 'report_date_mismatch') {
        assert.notEqual(stated, c.claim.incident_date, `${c.case_id} was meant to disagree on the date`);
      } else {
        assert.equal(stated, c.claim.incident_date, `${c.case_id} disagrees on the date by accident`);
      }
    });
  }
});

test('a near-duplicate shares the incident, and unrelated history does not', () => {
  for (const s of SPLIT_NAMES) {
    const { cases, truth } = loaded[s];
    let noise = 0;
    cases.cases.forEach((c, i) => {
      const e = truth.entries[i]!;
      const shares = c.related_claims.filter(
        (r) => r.incident_date === c.claim.incident_date && r.claim_type === c.claim.claim_type
      );
      if (e.trap === 'near_duplicate_filing') {
        assert.equal(shares.length, 1, `${c.case_id} should have exactly one near-duplicate on file`);
        assert.equal(e.label, 'escalate', c.case_id);
      } else {
        assert.equal(shares.length, 0, `${c.case_id} has an accidental duplicate`);
        if (c.related_claims.length > 0) noise++;
      }
    });
    // Unrelated prior claims exist, so "there is another claim on file" is not
    // by itself the duplicate signal.
    assert.ok(noise > 0, `${s} has no unrelated claim history anywhere, which makes the duplicate trap trivial`);
  }
});

test('deductible cases really leave nothing payable', () => {
  for (const s of SPLIT_NAMES) {
    const { cases, truth } = loaded[s];
    cases.cases.forEach((c, i) => {
      const e = truth.entries[i]!;
      if (e.trap !== 'deductible_exceeds_claim') return;
      assert.ok(c.claim.claimed_amount <= c.policy.deductible, c.case_id);
      assert.equal(e.payable_if_approved_inr, 0, `${c.case_id} should have nothing payable`);
      assert.equal(e.label, 'deny', c.case_id);
    });
  }
});

test('an exclusion that applies is quoted in the policy wording; a near miss is quoted and does not fire', () => {
  for (const s of SPLIT_NAMES) {
    const { cases, truth } = loaded[s];
    cases.cases.forEach((c, i) => {
      const e = truth.entries[i]!;
      if (e.trap === 'exclusion_applies') {
        assert.ok(e.facts.exclusion_clause, `${c.case_id} names no clause`);
        assert.ok(
          c.policy.exclusions.includes(e.facts.exclusion_clause!),
          `${c.case_id} denies on a clause the policy does not contain`
        );
        assert.equal(e.label, 'deny', c.case_id);
      }
      if (e.trap === 'exclusion_near_miss') {
        assert.equal(e.facts.exclusion_applies, false, c.case_id);
        assert.equal(e.label, 'approve', c.case_id);
        assert.ok(c.policy.exclusions.length >= 2, `${c.case_id} needs a wording with something to nearly match`);
      }
    });
  }
});

test('stacked cases are decided by precedence, not by the last thing noticed', () => {
  for (const s of SPLIT_NAMES) {
    const stacked = loaded[s].truth.entries.filter((e) => e.trap === 'stacked_lapse_and_contradiction');
    assert.ok(stacked.length >= 2, `${s} needs stacked cases to test precedence at all`);
    for (const e of stacked) {
      assert.equal(e.facts.in_force, false, e.case_id);
      assert.equal(e.facts.evidence_contradiction, true, e.case_id);
      assert.equal(e.label, 'deny', `${e.case_id} must be decided by R1, not by the R4 that is also true`);
      assert.equal(e.rule, 'R1', e.case_id);
    }
  }
});

// --- The questions must not contain the answers ------------------------------

test('cases.json leaks neither the label nor the trap category', () => {
  for (const s of SPLIT_NAMES) {
    const raw = readFileSync(join(splitDir(s), 'cases.json'), 'utf8');
    for (const v of VERDICTS) {
      assert.equal(
        new RegExp(`\\b${v}\\b`, 'i').test(raw),
        false,
        `${s}/cases.json contains the word "${v}"; a case file that announces its own answer is not a question`
      );
    }
    for (const trap of TRAP_ORDER) {
      assert.equal(raw.includes(trap), false, `${s}/cases.json names the trap "${trap}"`);
    }
    assert.equal(raw.includes('payable_if_approved'), false, `${s}/cases.json leaks the payout arithmetic`);
  }
});

test('case order carries no information about which trap a case is', () => {
  // Traps are shuffled before numbering. If they were not, the first N cases
  // would all be the same category and this correlation would be perfect.
  for (const s of SPLIT_NAMES) {
    const entries = loaded[s].truth.entries;
    const firstQuarter = new Set(entries.slice(0, Math.ceil(entries.length / 4)).map((e) => e.trap));
    assert.ok(
      firstQuarter.size >= 5,
      `${s} opens with only ${firstQuarter.size} distinct trap(s); the set is ordered by category`
    );
  }
});
