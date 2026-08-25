/**
 * Deterministic generator for the labelled adjudication set.
 *
 * Two things about the design are deliberate and worth stating plainly.
 *
 * **The label is constructed, not guessed.** Each builder plants a specific
 * fact pattern and records the facts it planted. `deriveVerdict` in
 * `rules.ts` then turns those facts into the label. No case was labelled by
 * eye, so no label can quietly drift from the rulebook.
 *
 * **The dev set and the holdout come from different seeds.** The two splits
 * share this generator and share the rulebook, and share nothing else: no
 * person, no policy number, no claim number, no amount. A holdout drawn from
 * the same seed as the development set is the development set with a new
 * filename, and a score against it is a score against training data.
 *
 * The generator refuses to emit a case whose label does not match the rule it
 * was built to exercise. That check runs on every build, which is the only
 * reason a set this adversarial can be trusted to be internally consistent.
 */
import { Rng, addDays, inr } from './rng.js';
import { deriveVerdict, RULEBOOK_VERSION } from './rules.js';
import { structuralFacts, payableIfApproved } from './analyse.js';
import { renderDocument, type DocContext } from './documents.js';
import {
  AFTERMATH,
  AMBIGUOUS_CORES,
  AUTO_THEFT_AFTERMATH,
  AUTO_THEFT_CIRCUMSTANCES,
  APARTMENTS,
  CIRCUMSTANCES,
  CITIES,
  CLAIM_BANDS,
  CLAIM_TYPES_BY_POLICY,
  CONTRACTORS,
  documentsRequired,
  ESTIMATE_DOCUMENT,
  EXCLUSIONS,
  GARAGES,
  GIVEN_NAMES,
  HOSPITALS,
  PLAIN_CORES,
  POLICY_BANDS,
  REPORT_DOCUMENT,
  SURNAMES,
  VEHICLES,
  type CitySpec,
  type ExclusionSpec,
} from './fixtures.js';
import type {
  CaseFacts,
  CasesFile,
  ClaimType,
  EvalCase,
  EvalClaim,
  EvalCustomer,
  EvalDocument,
  EvalPolicy,
  GroundTruthEntry,
  GroundTruthFile,
  PolicyType,
  SplitName,
  TrapCategory,
} from './types.js';

// ---------------------------------------------------------------------------
// Seeds and plans
// ---------------------------------------------------------------------------

/**
 * The two seeds. They are recorded in both the dataset files and the holdout
 * lock, so "was the holdout drawn from the dev seed?" is a question anyone can
 * answer from the artefacts rather than from a claim in a README.
 */
export const DEV_SEED = 4_172_026;
export const HOLDOUT_SEED = 9_930_517;

/** Registration-plate prefixes, so a document and an address agree. */
const RTO: Record<string, string> = {
  Bengaluru: 'KA-01',
  Pune: 'MH-12',
  Mumbai: 'MH-02',
  Hyderabad: 'TS-09',
  Chennai: 'TN-10',
  Ahmedabad: 'GJ-01',
  Kolkata: 'WB-02',
  Jaipur: 'RJ-14',
  Kochi: 'KL-07',
  Lucknow: 'UP-32',
};

/**
 * How many of each trap each split gets.
 *
 * The shape is not uniform on purpose. Two fifths of the set reaches the plain
 * approval rule, because a set made entirely of traps measures a system's
 * appetite for suspicion rather than its judgement. Every category appears in
 * both splits at least twice, so a holdout result can be broken down the same
 * way a dev result can.
 */
export type TrapPlan = Record<TrapCategory, number>;

export const DEV_PLAN: TrapPlan = {
  straightforward_approve: 16,
  documents_complete_approve: 6,
  limit_boundary_under: 6,
  policy_lapsed_after: 5,
  exclusion_near_miss: 8,
  policy_lapsed_before: 7,
  policy_cancelled: 4,
  exclusion_applies: 9,
  deductible_exceeds_claim: 7,
  stacked_lapse_and_contradiction: 4,
  limit_boundary_over: 6,
  estimate_contradiction: 8,
  report_date_mismatch: 6,
  near_duplicate_filing: 5,
  ambiguous_evidence: 3,
};

export const HOLDOUT_PLAN: TrapPlan = {
  straightforward_approve: 8,
  documents_complete_approve: 3,
  limit_boundary_under: 3,
  policy_lapsed_after: 2,
  exclusion_near_miss: 4,
  policy_lapsed_before: 3,
  policy_cancelled: 2,
  exclusion_applies: 5,
  deductible_exceeds_claim: 3,
  stacked_lapse_and_contradiction: 2,
  limit_boundary_over: 3,
  estimate_contradiction: 4,
  report_date_mismatch: 3,
  near_duplicate_filing: 2,
  ambiguous_evidence: 3,
};

/** The rule each trap exists to exercise. Enforced at build time. */
export const EXPECTED_RULE: Record<TrapCategory, string> = {
  straightforward_approve: 'R8',
  documents_complete_approve: 'R8',
  limit_boundary_under: 'R8',
  policy_lapsed_after: 'R8',
  exclusion_near_miss: 'R8',
  policy_lapsed_before: 'R1',
  policy_cancelled: 'R1',
  exclusion_applies: 'R2',
  deductible_exceeds_claim: 'R3',
  stacked_lapse_and_contradiction: 'R1',
  limit_boundary_over: 'R6',
  estimate_contradiction: 'R4',
  report_date_mismatch: 'R4',
  near_duplicate_filing: 'R5',
  ambiguous_evidence: 'R7',
};

/** Fixed iteration order, so a plan produces the same draw every time. */
export const TRAP_ORDER = Object.keys(EXPECTED_RULE) as TrapCategory[];

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

/** Everything a builder needs before it decides what to break. */
interface Base {
  customer: EvalCustomer;
  city: CitySpec;
  policyType: PolicyType;
  claimType: ClaimType;
  vehicle: string;
  registration: string;
  apartment: string;
  garage: string;
  contractor: string;
  hospital: string;
  road: string;
  incidentDate: string;
  coverage: number;
  deductible: number;
  premium: number;
  startDate: string;
  endDate: string;
}

/** A case before it has been given its numbers. */
interface Draft {
  trap: TrapCategory;
  base: Base;
  status: EvalPolicy['status'];
  exclusions: string[];
  core: string;
  claimedAmount: number;
  /** Total the money document states; defaults to the claimed amount. */
  documentTotal: number;
  /** Date the report document asserts; defaults to the incident date. */
  reportDate: string;
  dropDocuments: string[];
  duplicateOf: { claim_type: ClaimType; incident_date: string; amount: number; core: string } | null;
  facts: CaseFacts;
  justify: (c: EvalCase) => string;
}

const AS_OF = '2026-05-31';
const INCIDENT_WINDOW: [string, string] = ['2026-01-05', '2026-05-12'];

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function makeCustomer(rng: Rng, city: CitySpec, apartment: string): EvalCustomer {
  const given = rng.pick(GIVEN_NAMES);
  const surname = rng.pick(SURNAMES);
  const full = `${given} ${surname}`;
  return {
    full_name: full,
    email: `${given.toLowerCase()}.${surname.toLowerCase()}@email.com`,
    phone: `+91${rng.int(70, 99)}${rng.int(10_000_000, 99_999_999)}`,
    date_of_birth: `${rng.int(1962, 2000)}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`,
    address: `Flat ${rng.int(1, 18)}${rng.pick(['A', 'B', 'C', 'D'])}, ${apartment}, ${rng.pick(city.roads)}, ${city.city} ${city.pinPrefix}${String(rng.int(1, 99)).padStart(2, '0')}, ${city.state}`,
  };
}

function scaffold(
  rng: Rng,
  opts: { policyType?: PolicyType; claimType?: ClaimType; lowCoverage?: boolean; highDeductible?: boolean } = {}
): Base {
  const city = rng.pick(CITIES);
  const apartment = rng.pick(APARTMENTS);
  const customer = makeCustomer(rng, city, apartment);
  const policyType = opts.policyType ?? rng.pick(['auto', 'auto', 'home', 'home', 'health'] as PolicyType[]);
  const claimType = opts.claimType ?? rng.pick(CLAIM_TYPES_BY_POLICY[policyType]);

  const band = POLICY_BANDS[policyType];
  const [covLo, covHi] = band.coverage;
  const coverage = opts.lowCoverage
    ? rng.rupees(covLo, covLo + Math.round((covHi - covLo) / 3))
    : rng.rupees(covLo, covHi);
  const [dedLo, dedHi] = band.deductible;
  const deductible = opts.highDeductible
    ? rng.rupees(Math.round((dedLo + dedHi) / 2), dedHi)
    : rng.rupees(dedLo, dedHi);

  const spanDays = daysBetween(INCIDENT_WINDOW[0], INCIDENT_WINDOW[1]);
  const incidentDate = addDays(INCIDENT_WINDOW[0], rng.int(0, spanDays));

  const vehicleSpec = rng.pick(VEHICLES);
  return {
    customer,
    city,
    policyType,
    claimType,
    vehicle: `${vehicleSpec.year} ${vehicleSpec.model}`,
    registration: `${RTO[city.city] ?? 'KA-01'}-${rng.pick(['AB', 'MJ', 'CQ', 'HL', 'PZ'])}-${rng.int(1000, 9999)}`,
    apartment,
    garage: rng.pick(GARAGES),
    contractor: rng.pick(CONTRACTORS),
    hospital: rng.pick(HOSPITALS),
    road: rng.pick(city.roads),
    incidentDate,
    coverage,
    deductible,
    premium: rng.rupees(band.premium[0], band.premium[1]),
    // In force by default; the builders that care overwrite both dates.
    startDate: addDays(incidentDate, -rng.int(90, 900)),
    endDate: addDays(incidentDate, rng.int(30, 700)),
  };
}

/** A claim amount that is plausible, inside the limit and above the deductible. */
function normalAmount(rng: Rng, base: Base): number {
  const [lo, hi] = CLAIM_BANDS[base.claimType];
  const cap = Math.floor((base.coverage * 0.85) / 100) * 100;
  const floor = base.deductible + 5_000;
  let amount = rng.rupees(lo, hi);
  if (amount > cap) amount = cap;
  if (amount < floor) amount = floor + rng.rupees(1_000, 20_000);
  if (amount > base.coverage) amount = base.coverage - rng.rupees(1_000, 20_000);
  return amount;
}

const CLEAN_FACTS: CaseFacts = Object.freeze({
  in_force: true,
  exclusion_applies: false,
  exclusion_clause: null,
  deductible_swallows_claim: false,
  over_coverage_limit: false,
  evidence_contradiction: false,
  contradiction_detail: null,
  duplicate_filing: false,
  evidence_insufficient: false,
});

function facts(over: Partial<CaseFacts> = {}): CaseFacts {
  return { ...CLEAN_FACTS, ...over };
}

/** Documents whose absence does not decide anything on its own. */
const NON_DECISIVE = ['photos', 'damage_photos', 'other_driver_info', 'referral_letter', 'incident_report'];

/** Three or four exclusion clauses for the policy wording, target clause included. */
function exclusionList(rng: Rng, policyType: PolicyType, mustInclude?: string): string[] {
  const pool = EXCLUSIONS[policyType].map((e) => e.clause);
  const others = pool.filter((c) => c !== mustInclude);
  const picked = rng.sample(others, Math.min(others.length, rng.int(2, 3)));
  const all = mustInclude ? [mustInclude, ...picked] : picked;
  return all.sort();
}

/** Three or four sentences that read like something a person filed. */
function narrate(rng: Rng, base: Base, core: string, date = base.incidentDate): string {
  const where =
    base.policyType === 'auto'
      ? `The incident occurred on ${base.road}, ${base.city.city} on ${date}.`
      : base.policyType === 'home'
        ? `The premises affected are the flat at ${base.apartment}, ${base.city.city}, and the date of loss is ${date}.`
        : `The admission was at ${base.hospital}, ${base.city.city} on ${date}.`;
  const vehicleTheft = base.policyType === 'auto' && base.claimType === 'theft';
  const circumstance = vehicleTheft ? AUTO_THEFT_CIRCUMSTANCES : CIRCUMSTANCES[base.policyType];
  const aftermath = vehicleTheft ? AUTO_THEFT_AFTERMATH : AFTERMATH[base.policyType];
  return [`${core}.`, where, rng.pick(circumstance), rng.pick(aftermath)].join(' ');
}

// ---------------------------------------------------------------------------
// Trap builders
// ---------------------------------------------------------------------------

type Builder = (rng: Rng) => Draft;

function plainDraft(rng: Rng, trap: TrapCategory, opts: Parameters<typeof scaffold>[1] = {}): Draft {
  const base = scaffold(rng, opts);
  const core = rng.pick(PLAIN_CORES[base.claimType]);
  const amount = normalAmount(rng, base);
  return {
    trap,
    base,
    status: 'active',
    exclusions: exclusionList(rng, base.policyType),
    core,
    claimedAmount: amount,
    documentTotal: amount,
    reportDate: base.incidentDate,
    dropDocuments: [],
    duplicateOf: null,
    facts: facts(),
    justify: () => '',
  };
}

const BUILDERS: Record<TrapCategory, Builder> = {
  // --- approve -------------------------------------------------------------

  straightforward_approve: (rng) => {
    const d = plainDraft(rng, 'straightforward_approve');
    // A quarter of these are missing a document that does not decide anything,
    // so "a document is missing" cannot be used as a shortcut to escalation.
    if (rng.bool(0.25)) {
      const droppable = documentsRequired(d.base.claimType).filter((t) => NON_DECISIVE.includes(t));
      if (droppable.length > 0) d.dropDocuments = [rng.pick(droppable)];
    }
    d.justify = (c) =>
      `Policy in force on ${c.claim.incident_date}, no exclusion reaches the incident, and Rs ${inr(c.claim.claimed_amount)} sits inside the Rs ${inr(c.policy.coverage_amount)} limit and above the Rs ${inr(c.policy.deductible)} deductible.`;
    return d;
  },

  documents_complete_approve: (rng) => {
    const d = plainDraft(rng, 'documents_complete_approve');
    d.justify = (c) =>
      `Every one of the ${c.claim.documents_required.length} required documents is on file and the ${ESTIMATE_DOCUMENT[c.claim.claim_type]} agrees with the claimed Rs ${inr(c.claim.claimed_amount)}; there is nothing here to refuse or refer.`;
    return d;
  },

  limit_boundary_under: (rng) => {
    const d = plainDraft(rng, 'limit_boundary_under', { lowCoverage: true });
    d.claimedAmount = d.base.coverage - 1;
    d.documentTotal = d.claimedAmount;
    d.justify = (c) =>
      `Rs ${inr(c.claim.claimed_amount)} is one rupee under the Rs ${inr(c.policy.coverage_amount)} limit, so the cap is never reached and the claim is payable in full.`;
    return d;
  },

  policy_lapsed_after: (rng) => {
    const d = plainDraft(rng, 'policy_lapsed_after');
    d.base.endDate = addDays(d.base.incidentDate, 1);
    d.base.startDate = addDays(d.base.endDate, -rng.pick([365, 730, 1095]));
    d.justify = (c) =>
      `Cover ran to ${c.policy.end_date}, one day after the incident on ${c.claim.incident_date}, so the policy was still live when it happened.`;
    return d;
  },

  exclusion_near_miss: (rng) => {
    const policyType = rng.pick(['auto', 'home', 'health'] as PolicyType[]);
    const spec: ExclusionSpec = rng.pick(EXCLUSIONS[policyType]);
    const base = scaffold(rng, { policyType, claimType: spec.claim_type });
    if (spec.clause.includes('8.6')) base.startDate = addDays(base.incidentDate, -425);
    const amount = normalAmount(rng, base);
    return {
      trap: 'exclusion_near_miss',
      base,
      status: 'active',
      exclusions: exclusionList(rng, policyType, spec.clause),
      core: spec.near_miss_core,
      claimedAmount: amount,
      documentTotal: amount,
      reportDate: base.incidentDate,
      dropDocuments: [],
      duplicateOf: null,
      facts: facts(),
      justify: () =>
        `"${spec.clause}" is the nearest exclusion in the wording and does not reach this incident: ${spec.near_miss_reason}.`,
    };
  },

  // --- deny ----------------------------------------------------------------

  policy_lapsed_before: (rng) => {
    const d = plainDraft(rng, 'policy_lapsed_before');
    d.base.endDate = addDays(d.base.incidentDate, -1);
    d.base.startDate = addDays(d.base.endDate, -rng.pick([365, 730, 1095]));
    d.status = 'expired';
    d.facts = facts({ in_force: false });
    d.justify = (c) =>
      `Cover ended ${c.policy.end_date}, the day before the incident on ${c.claim.incident_date}; nothing was in force when it happened.`;
    return d;
  },

  policy_cancelled: (rng) => {
    const d = plainDraft(rng, 'policy_cancelled');
    d.status = 'cancelled';
    d.facts = facts({ in_force: false });
    d.justify = (c) =>
      `The policy was cancelled before the incident on ${c.claim.incident_date}; the printed term still runs to ${c.policy.end_date}, which is exactly the detail a date-only check gets wrong.`;
    return d;
  },

  exclusion_applies: (rng) => {
    const policyType = rng.pick(['auto', 'home', 'health'] as PolicyType[]);
    const spec: ExclusionSpec = rng.pick(EXCLUSIONS[policyType]);
    const base = scaffold(rng, { policyType, claimType: spec.claim_type });
    if (spec.clause.includes('8.6')) base.startDate = addDays(base.incidentDate, -425);
    const amount = normalAmount(rng, base);
    return {
      trap: 'exclusion_applies',
      base,
      status: 'active',
      exclusions: exclusionList(rng, policyType, spec.clause),
      core: spec.applies_core,
      claimedAmount: amount,
      documentTotal: amount,
      reportDate: base.incidentDate,
      dropDocuments: [],
      duplicateOf: null,
      facts: facts({ exclusion_applies: true, exclusion_clause: spec.clause }),
      justify: () => `"${spec.clause}" covers this incident as described, so the loss is excluded.`,
    };
  },

  deductible_exceeds_claim: (rng) => {
    const policyType = rng.pick(['auto', 'auto', 'home', 'health'] as PolicyType[]);
    const probe = scaffold(rng, { policyType, highDeductible: true });
    const affordable = CLAIM_TYPES_BY_POLICY[policyType].filter(
      (t) => CLAIM_BANDS[t][0] <= probe.deductible
    );
    const claimType = affordable.length > 0 ? rng.pick(affordable) : probe.claimType;
    const base = { ...probe, claimType };
    const exact = rng.bool(1 / 3);
    const amount = exact ? base.deductible : Math.max(2_000, base.deductible - rng.rupees(500, 5_000));
    return {
      trap: 'deductible_exceeds_claim',
      base,
      status: 'active',
      exclusions: exclusionList(rng, policyType),
      core: rng.pick(PLAIN_CORES[claimType]),
      claimedAmount: amount,
      documentTotal: amount,
      reportDate: base.incidentDate,
      dropDocuments: [],
      duplicateOf: null,
      facts: facts({ deductible_swallows_claim: true }),
      justify: (c) =>
        `Rs ${inr(c.claim.claimed_amount)} is ${exact ? 'exactly' : 'below'} the Rs ${inr(c.policy.deductible)} deductible, so nothing is payable and the answer is a refusal with the arithmetic shown, not a settlement of zero.`,
    };
  },

  stacked_lapse_and_contradiction: (rng) => {
    const d = plainDraft(rng, 'stacked_lapse_and_contradiction');
    d.base.endDate = addDays(d.base.incidentDate, -rng.int(3, 60));
    d.base.startDate = addDays(d.base.endDate, -rng.pick([365, 730]));
    d.status = 'expired';
    const gap = Math.max(50_000, Math.round(d.claimedAmount * rng.int(35, 65) / 100));
    d.documentTotal = Math.max(5_000, d.claimedAmount - gap);
    d.facts = facts({
      in_force: false,
      evidence_contradiction: true,
      contradiction_detail: `${ESTIMATE_DOCUMENT[d.base.claimType]} totals ${d.documentTotal} against a claimed ${d.claimedAmount}`,
    });
    d.justify = (c) =>
      `Cover ended ${c.policy.end_date}, before the incident on ${c.claim.incident_date}; the estimate also disagrees with the claimed Rs ${inr(c.claim.claimed_amount)}, but R1 decides the case before R4 is ever reached.`;
    return d;
  },

  // --- escalate ------------------------------------------------------------

  limit_boundary_over: (rng) => {
    const d = plainDraft(rng, 'limit_boundary_over', { lowCoverage: true });
    d.claimedAmount = d.base.coverage + 1;
    d.documentTotal = d.claimedAmount;
    d.facts = facts({ over_coverage_limit: true });
    d.justify = (c) =>
      `Rs ${inr(c.claim.claimed_amount)} is one rupee over the Rs ${inr(c.policy.coverage_amount)} limit, so any payment has to be capped and the shortfall explained by a person.`;
    return d;
  },

  estimate_contradiction: (rng) => {
    const d = plainDraft(rng, 'estimate_contradiction');
    // The gap is large and in either direction: a claimant who inflates and a
    // claimant who understates are both worth a second look, and only one of
    // them is what a fraud heuristic goes looking for.
    const pct = rng.int(30, 70) / 100;
    const inflated = rng.bool(0.65);
    const total = inflated
      ? Math.max(5_000, Math.round((d.claimedAmount * (1 - pct)) / 100) * 100)
      : Math.round((d.claimedAmount * (1 + pct)) / 100) * 100;
    d.documentTotal = total;
    d.facts = facts({
      evidence_contradiction: true,
      contradiction_detail: `${ESTIMATE_DOCUMENT[d.base.claimType]} totals ${total} against a claimed ${d.claimedAmount}`,
    });
    d.justify = (c) => {
      const docType = ESTIMATE_DOCUMENT[c.claim.claim_type];
      return `The ${docType} totals Rs ${inr(total)} against a claimed Rs ${inr(c.claim.claimed_amount)}; the gap has to be put to the claimant before anything is paid or refused.`;
    };
    return d;
  },

  report_date_mismatch: (rng) => {
    const withReport = Object.keys(REPORT_DOCUMENT) as ClaimType[];
    const claimType = rng.pick(withReport);
    const policyType: PolicyType = claimType === 'fire_damage' ? 'home' : rng.pick(['auto', 'home'] as PolicyType[]);
    const usable = CLAIM_TYPES_BY_POLICY[policyType].includes(claimType) ? claimType : 'theft';
    const d = plainDraft(rng, 'report_date_mismatch', { policyType, claimType: usable });
    const drift = rng.pick([-9, -5, -3, -2, -1, 1, 2, 4, 7]);
    d.reportDate = addDays(d.base.incidentDate, drift);
    d.facts = facts({
      evidence_contradiction: true,
      contradiction_detail: `${REPORT_DOCUMENT[usable]} records ${d.reportDate} against a declared incident date of ${d.base.incidentDate}`,
    });
    d.justify = (c) =>
      `The ${REPORT_DOCUMENT[c.claim.claim_type]} records the event on ${d.reportDate} while the claim declares ${c.claim.incident_date}; one of the two is wrong and the file cannot say which.`;
    return d;
  },

  near_duplicate_filing: (rng) => {
    const d = plainDraft(rng, 'near_duplicate_filing');
    const otherCore = rng.pick(PLAIN_CORES[d.base.claimType].filter((c) => c !== d.core) ?? []) ?? d.core;
    d.duplicateOf = {
      claim_type: d.base.claimType,
      incident_date: d.base.incidentDate,
      amount: Math.round((d.claimedAmount * rng.int(94, 106)) / 100 / 100) * 100,
      core: otherCore,
    };
    d.facts = facts({ duplicate_filing: true });
    d.justify = (c) => {
      const other = c.related_claims[0]!;
      return `${other.claim_number} already covers a ${c.claim.claim_type} on ${c.claim.incident_date} for Rs ${inr(other.claimed_amount)}; two filings for one event go to a person, not to a payment run.`;
    };
    return d;
  },

  ambiguous_evidence: (rng) => {
    const claimType = rng.pick(Object.keys(AMBIGUOUS_CORES) as ClaimType[]);
    const policyType: PolicyType =
      claimType === 'medical' ? 'health' : claimType === 'water_damage' ? 'home' : rng.pick(['auto', 'home'] as PolicyType[]);
    const usable = CLAIM_TYPES_BY_POLICY[policyType].includes(claimType) ? claimType : 'theft';
    const pick = rng.pick(AMBIGUOUS_CORES[usable] ?? AMBIGUOUS_CORES[claimType]!);
    const base = scaffold(rng, { policyType, claimType: usable });
    const amount = normalAmount(rng, base);
    // Half of these have every document on file. Ambiguity is a property of
    // what the documents say, not of how many of them arrived.
    const droppable = documentsRequired(usable).filter((t) => NON_DECISIVE.includes(t));
    const drop = rng.bool(0.5) && droppable.length > 0 ? [rng.pick(droppable)] : [];
    return {
      trap: 'ambiguous_evidence',
      base,
      status: 'active',
      exclusions: exclusionList(rng, policyType),
      core: pick.core,
      claimedAmount: amount,
      documentTotal: amount,
      reportDate: base.incidentDate,
      dropDocuments: drop,
      duplicateOf: null,
      facts: facts({ evidence_insufficient: true }),
      justify: () =>
        `The file does not settle the question: ${pick.why}. Escalation is the honest answer here, not a coin flip dressed as a verdict.`,
    };
  },
};

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function assemble(
  rng: Rng,
  draft: Draft,
  ids: { caseId: string; policyNumber: string; claimNumber: string; relatedNumber: string }
): EvalCase {
  const { base } = draft;
  const description = narrate(rng, base, draft.core);
  const summary = `${draft.core}.`;

  const required = documentsRequired(base.claimType);
  const received = required.filter((t) => !draft.dropDocuments.includes(t));

  const coverageDetails: Record<string, unknown> =
    base.policyType === 'auto'
      ? {
          vehicle: base.vehicle,
          registration: base.registration,
          idv: base.coverage,
          own_damage: true,
          third_party: true,
          zero_depreciation: rng.bool(0.5),
          roadside_assistance: rng.bool(0.6),
        }
      : base.policyType === 'home'
        ? {
            property_type: rng.pick(['apartment', 'row_house', 'independent_house']),
            carpet_area_sqft: rng.int(650, 2400),
            year_built: rng.int(1996, 2022),
            structure_cover: base.coverage,
            contents_cover: Math.round(base.coverage / 2 / 1000) * 1000,
            burglary: true,
            fire: true,
            flood: false,
          }
        : {
            plan_type: rng.pick(['individual', 'family_floater']),
            network: rng.pick(['pan_india', 'south_india', 'metro_only']),
            room_rent_limit: rng.rupees(4_000, 12_000),
            day_care: true,
            pre_post_hospitalisation_days: rng.pick([30, 60, 90]),
            maternity: false,
          };

  const policy: EvalPolicy = {
    policy_number: ids.policyNumber,
    policy_type: base.policyType,
    provider: base.policyType === 'health' ? 'SafeGuard Health' : 'SafeGuard Insurance',
    coverage_amount: base.coverage,
    deductible: base.deductible,
    premium_monthly: base.premium,
    start_date: base.startDate,
    end_date: base.endDate,
    status: draft.status,
    coverage_details: coverageDetails,
    exclusions: draft.exclusions,
  };

  const filedOffset = rng.int(1, 9);
  const claim: EvalClaim = {
    claim_number: ids.claimNumber,
    claim_type: base.claimType,
    incident_date: base.incidentDate,
    incident_description: description,
    claimed_amount: draft.claimedAmount,
    documents_required: required,
    documents_received: received,
    filed_at: `${addDays(base.incidentDate, filedOffset)} ${String(rng.int(9, 19)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}:00+05:30`,
  };

  const estimateType = ESTIMATE_DOCUMENT[base.claimType];
  const reportType = REPORT_DOCUMENT[base.claimType];

  const documents: EvalDocument[] = received.map((type) => {
    const ctx: DocContext = {
      rng,
      claimType: base.claimType,
      incidentDate: base.incidentDate,
      // Only the designated report document carries a planted date. Everything
      // else agrees with the claim, so a mismatch has exactly one source.
      documentDate: type === reportType ? draft.reportDate : base.incidentDate,
      total: type === estimateType ? draft.documentTotal : draft.claimedAmount,
      customerName: base.customer.full_name,
      city: base.city.city,
      road: base.road,
      station: base.city.station,
      garage: base.garage,
      contractor: base.contractor,
      hospital: base.hospital,
      vehicle: base.vehicle,
      registration: base.registration,
      summary,
    };
    return renderDocument(type, ctx);
  });

  const related: EvalClaim[] = [];
  if (draft.duplicateOf) {
    const dup = draft.duplicateOf;
    related.push({
      claim_number: ids.relatedNumber,
      claim_type: dup.claim_type,
      incident_date: dup.incident_date,
      incident_description: narrate(rng, base, dup.core),
      claimed_amount: dup.amount,
      documents_required: documentsRequired(dup.claim_type),
      documents_received: [],
      filed_at: `${addDays(dup.incident_date, Math.max(1, filedOffset - rng.int(0, 1)))} ${String(rng.int(9, 19)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}:00+05:30`,
    });
  } else if (rng.bool(0.2)) {
    // Unrelated history on the same policy, so "there is another claim on file"
    // is not by itself the duplicate signal.
    const otherTypes = CLAIM_TYPES_BY_POLICY[base.policyType];
    const otherType = rng.pick(otherTypes);
    const otherDate = addDays(base.incidentDate, -rng.int(70, 420));
    related.push({
      claim_number: ids.relatedNumber,
      claim_type: otherType,
      incident_date: otherDate,
      incident_description: narrate(rng, { ...base, claimType: otherType }, rng.pick(PLAIN_CORES[otherType]), otherDate),
      claimed_amount: rng.rupees(CLAIM_BANDS[otherType][0], Math.min(CLAIM_BANDS[otherType][1], base.coverage / 3)),
      documents_required: documentsRequired(otherType),
      documents_received: documentsRequired(otherType),
      filed_at: `${addDays(otherDate, rng.int(1, 6))} ${String(rng.int(9, 19)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}:00+05:30`,
    });
  }

  return { case_id: ids.caseId, customer: base.customer, policy, claim, documents, related_claims: related };
}

export interface GeneratedSplit {
  cases: CasesFile;
  truth: GroundTruthFile;
}

/**
 * Build one split. The same seed always produces the same bytes; two different
 * seeds produce two disjoint sets of people, numbers and amounts.
 */
export function generateSplit(split: SplitName, seed: number, plan: TrapPlan): GeneratedSplit {
  const rng = new Rng(seed);
  const drafts: Draft[] = [];
  for (const trap of TRAP_ORDER) {
    for (let i = 0; i < plan[trap]; i++) drafts.push(BUILDERS[trap](rng));
  }

  // Shuffled before numbering, so case_id order carries no information about
  // which trap a case is. A set where the first sixteen are the easy ones is a
  // set that can be gamed by position.
  rng.shuffle(drafts);

  const numberPrefix = split === 'dev' ? 7 : 8;
  const cases: EvalCase[] = [];
  const entries: GroundTruthEntry[] = [];

  drafts.forEach((draft, i) => {
    const n = i + 1;
    const ids = {
      caseId: `${split}-${String(n).padStart(3, '0')}`,
      policyNumber: `POL-2025-${numberPrefix}${String(n).padStart(5, '0')}`,
      claimNumber: `CLM-2026-${numberPrefix}${String(n).padStart(5, '0')}`,
      relatedNumber: `CLM-2026-${numberPrefix}${String(90_000 + n).padStart(5, '0')}`,
    };
    const evalCase = assemble(rng, draft, ids);

    // The generator refuses to ship a case whose planted facts and whose file
    // disagree, and refuses to ship one that does not exercise the rule it was
    // written for. Both failures are silent corruptions of an answer key, and
    // an answer key that is quietly wrong is worse than no answer key.
    const observed = structuralFacts(evalCase);
    const planted = draft.facts;
    const mismatches: string[] = [];
    if (observed.in_force !== planted.in_force) mismatches.push('in_force');
    if (observed.over_coverage_limit !== planted.over_coverage_limit) mismatches.push('over_coverage_limit');
    if (observed.deductible_swallows_claim !== planted.deductible_swallows_claim)
      mismatches.push('deductible_swallows_claim');
    if (observed.evidence_contradiction !== planted.evidence_contradiction) mismatches.push('evidence_contradiction');
    if (observed.duplicate_filing !== planted.duplicate_filing) mismatches.push('duplicate_filing');
    if (mismatches.length > 0) {
      throw new Error(
        `generateSplit: ${ids.caseId} (${draft.trap}) has facts its own file contradicts: ${mismatches.join(', ')}`
      );
    }

    const derived = deriveVerdict(planted);
    if (derived.rule !== EXPECTED_RULE[draft.trap]) {
      throw new Error(
        `generateSplit: ${ids.caseId} was built as ${draft.trap} (expects ${EXPECTED_RULE[draft.trap]}) but the rulebook returns ${derived.rule}`
      );
    }

    cases.push(evalCase);
    entries.push({
      case_id: ids.caseId,
      label: derived.verdict,
      rule: derived.rule,
      justification: draft.justify(evalCase),
      trap: draft.trap,
      facts: planted,
      claimed_amount_inr: evalCase.claim.claimed_amount,
      payable_if_approved_inr: payableIfApproved(evalCase),
    });
  });

  return {
    cases: {
      split,
      seed,
      rulebook_version: RULEBOOK_VERSION,
      currency: 'INR',
      count: cases.length,
      labels: 'withheld — see ground-truth.json',
      cases,
    },
    truth: {
      split,
      seed,
      rulebook_version: RULEBOOK_VERSION,
      currency: 'INR',
      count: entries.length,
      entries,
    },
  };
}

/** Everything a build or a test needs to reproduce the shipped files. */
export const SPLITS: Record<SplitName, { seed: number; plan: TrapPlan }> = {
  dev: { seed: DEV_SEED, plan: DEV_PLAN },
  holdout: { seed: HOLDOUT_SEED, plan: HOLDOUT_PLAN },
};

export const EVALUATION_AS_OF = AS_OF;
