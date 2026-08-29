# Journey completion run — results

Run 2026-08-29 against the deployed system. Cases, stage definitions and rules
were fixed in [PRE-REGISTRATION.md](PRE-REGISTRATION.md) and committed in
`5d0edea` **before the first claim was filed**. This file is rendered from the
database by `build-results.mjs`, so it cannot drift from what the run did.

## Per-stage completion, n = 10

| Stage | Reached | |
| --- | ---: | ---: |
| Filed, adjudicated, documents named, documents received, excess demanded | **10 of 10** | (100%) |
| Excess captured | **10 of 10** | (100%) |
| Decision recorded, with a fault finding | **10 of 10** | (100%) |
| Settled | **10 of 10** | (100%) |
| Deductible refunded | **10 of 10** | (100%) |
| — of which the refund was real, not simulated | **10 of 10** | |

Eight cases took the direct path. Two required renewing a lapsed policy first;
both of those were **refused while lapsed** and accepted after renewal, which is
the behaviour the renewal path exists for.

Counts lead, percentages follow in brackets. At n = 10 one case is ten points,
which is why every stage is reported rather than a single headline rate.

## Money

| | |
| --- | ---: |
| Collected — real, on Razorpay's ledger | **₹29,000** |
| Returned — real, on Razorpay's ledger | **₹29,000** |
| Settlements recorded as simulated | **10 of 10** |

**The claim amounts never moved.** Every settlement issued a `pout_sim_` id with a
`SIMUTR` reference because payouts need RazorpayX and business KYC this account
does not have. The deductible in and out is the only real money on these claims,
and the system says so unprompted in the sentence it gives the caller.

## Every case

| Claim | Policy | Type | Claimed | Excess paid | Settled | Refund id | Refunded | |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- |
| `CLM-2026-964201` | POL-2026-300002 | windshield | ₹14,500 | ₹1,000 | ₹13,500 | `rfnd_TVUzoSqD8UNKpD` | ₹1,000 | **real** |
| `CLM-2026-347594` | POL-2026-300003 | theft | ₹48,000 | ₹2,000 | ₹46,000 | `rfnd_TVV2LqmJOua3ce` | ₹2,000 | **real** |
| `CLM-2026-292075` | POL-2026-300004 | vandalism | ₹17,200 | ₹1,000 | ₹16,200 | `rfnd_TVV7syMUODWtla` | ₹1,000 | **real** |
| `CLM-2026-676396` | POL-2026-300005 | comprehensive | ₹38,500 | ₹2,000 | ₹36,500 | `rfnd_TVV8HDJzZYRg5s` | ₹2,000 | **real** |
| `CLM-2026-338720` | POL-2026-300006 | collision | ₹21,800 | ₹1,000 | ₹20,800 | `rfnd_TVV8hLY3TKfrDu` | ₹1,000 | **real** |
| `CLM-2026-898489` | POL-2026-300007 | water_damage | ₹39,500 | ₹5,000 | ₹34,500 | `rfnd_TVV95taJihrpI6` | ₹5,000 | **real** |
| `CLM-2026-935659` | POL-2026-300008 | fire_damage | ₹51,000 | ₹5,000 | ₹46,000 | `rfnd_TVV9UfGMnzVv2p` | ₹5,000 | **real** |
| `CLM-2026-432500` | POL-2026-300009 | storm_damage | ₹37,600 | ₹10,000 | ₹27,600 | `rfnd_TVV9tXEoMUZDlv` | ₹10,000 | **real** |
| `CLM-2026-110071` | POL-2026-300016 | collision | ₹22,500 | ₹1,000 | ₹21,500 | `rfnd_TVVGERNYUJFsh0` | ₹1,000 | **real** |
| `CLM-2026-429770` | POL-2026-300017 | windshield | ₹13,400 | ₹1,000 | ₹12,400 | `rfnd_TVVGczb2IqfrAm` | ₹1,000 | **real** |

## Evidence

`journey_events` carries **83 timestamped rows** across these ten
claims, each with the actor that caused it — `agent`, `system`, `human` or
`provider`. That table, not this document, is the record.

Every refund id above is resolvable through Razorpay's own API.

## What this run does not show

- **It is not a containment rate.** Seeded policies, claims written by the
  operator, operator as caller. It shows the workflow holds end to end, not that
  real claimants would be contained at this rate.
- **n = 10**, and one case is ten percentage points.
- **No industry baseline exists to compare against** — there is no published
  Indian contacts-per-claim figure. The numerator is measured; the denominator
  does not exist, and inventing one would be worse than saying so.
- **Settlement is simulated**, so nothing here is evidence about a claim payout
  reaching a claimant.

## Nine policies are held back for you to run

`POL-2026-300010`–`300015` and `POL-2026-300018`–`300020` were deliberately
left untouched, carrying no claims. Run the same journey against them and get
your own number rather than accepting this one. If any of the nine carries a
claim when you look, this result is void and should be treated as such.
