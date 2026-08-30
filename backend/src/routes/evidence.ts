import { FastifyInstance } from 'fastify';
import { config, features } from '../config/environment.js';
import { computeEvidenceHash } from '../services/attestation-service.js';
import { readObservations } from '../services/health-observations.js';
import {
  BUILD_DIRTY,
  BUILD_GIT_DESCRIBE,
  BUILD_GIT_SHA,
  BUILD_STAMPED,
} from '../generated/version.js';

/**
 * GET /api/evidence/recent — what this deployment has actually done, readable
 * from outside with no key.
 *
 * PUBLIC AND UNAUTHENTICATED, DELIBERATELY. It is a reviewer's entry point.
 * Every other claim this repository makes about real payments and real
 * attestation is a claim a reader has to take on trust, because the Razorpay
 * ids live in `eval/journey/RESULTS.md` and nowhere a stranger can reach. A
 * probe of the deployed API sees a payments integration indistinguishable from
 * a simulated one. This endpoint is the disproof, and a disproof behind a token
 * is not one.
 *
 * THREE RULES, and the endpoint is worthless the moment any is broken:
 *
 *  1. NO PERSONAL DATA. Claim numbers and Razorpay ids only. No name, email,
 *     phone, address, incident narrative or transcript passes through here.
 *     Every column this file selects is listed below, and evidence.test.ts
 *     asserts the serialised response carries none of the PII column names.
 *  2. NO SECRETS. `configured` is a boolean derived from whether a key is set.
 *     The key, its length and its prefix are never read here and never echoed.
 *  3. DERIVED, NEVER HARDCODED. Every number is a query result. Empty tables
 *     produce 0 or null, never a figure copied out of RESULTS.md. A hardcoded
 *     value here would be the exact defect this endpoint exists to disprove,
 *     restated in the place a reviewer looks to check it.
 *
 * Rate limiting is the global per-IP tier from plugins/rate-limit.ts — no
 * per-route `config.rateLimit` override. This route spends nothing: it reads
 * rows, calls no provider and signs nothing, so it belongs in the same tier as
 * the other public readers rather than in the on-chain one.
 *
 * A failed read answers 503 rather than zeroes. claims.ts already learned this
 * on the integrity check: "the evidence is not there" is a serious claim, and
 * it must never be produced by an outage.
 */

/** How many captures the recent list carries. Newest first. */
const RECENT_LIMIT = 10;

/**
 * The only chain the agent transacts on, matching server.ts. Stated rather
 * than imported because importing server.ts would boot a second listener.
 */
const CHAIN_NETWORK = 'base-sepolia';

/**
 * The Razorpay key tier this integration is stated to run on.
 *
 * A constant, and deliberately not derived from the key: deriving it would mean
 * reading the key's prefix, and this file does not touch key material at all.
 * It says 'test' and can only ever say 'test' — nothing here is permitted to
 * claim live money moved.
 */
const RAZORPAY_MODE = 'test';

/** The language model rail adjudication would use. See llm-provider.ts. */
const LLM_PROVIDER_NAME = 'groq';

interface RecentCapture {
  claim_number: string | null;
  payment_id: string;
  refund_id: string | null;
  /**
   * What the rail says was captured — `captured_amount_paise`, the same column
   * `collected_paise` sums. Not `amount_paise`, which is the deductible that
   * was demanded and may never have been paid.
   */
  amount_paise: number | null;
  captured_at: string | null;
  refunded_at: string | null;
}

interface EvidenceResponse {
  razorpay: {
    mode: string;
    collected_paise: number;
    refunded_paise: number;
    recent: RecentCapture[];
  };
  audit_chain: {
    records_checked: number;
    chain_ok: boolean;
    first_bad_seq: number | null;
    head: string | null;
  };
  attestation: {
    network: string;
    last_success_tx: string | null;
    last_success_at: string | null;
  };
  adjudication: {
    provider: string;
    model: string;
    configured: boolean;
    /** Adjudications a real provider answered. Excludes simulated ones. */
    model_invoked: number;
    /** Adjudications FakeLlmProvider answered. No model read anything. */
    model_simulated: number;
    vetoed_before_model: number;
    veto_reasons: Record<string, number>;
  };
  generated_at: string;
}

/**
 * A BIGINT arrives over PostgREST as a number or a string depending on its
 * magnitude. Anything that is not a finite number contributes nothing rather
 * than becoming NaN and poisoning a total that reads as a real figure.
 */
function toPaise(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sumPaise(rows: Array<Record<string, unknown>>, column: string): number {
  let total = 0;
  for (const row of rows) {
    total += toPaise(row[column]) ?? 0;
  }
  return total;
}

export default async function evidenceRoutes(fastify: FastifyInstance) {
  fastify.get('/evidence/recent', async (_request, reply) => {
    const [totalsResult, recentResult, bundlesResult, adjudicationsResult] = await Promise.all([
      // Every capture, for the two totals. Restricted to rows that actually
      // received money: a NULL payment_id means no money arrived, and counting
      // the link amount would report a demand as a collection.
      fastify.supabase
        .from('deductible_payments')
        .select('captured_amount_paise, refund_amount_paise')
        .not('payment_id', 'is', null),

      // The visible tail of the same table.
      fastify.supabase
        .from('deductible_payments')
        .select('claim_id, payment_id, refund_id, captured_amount_paise, captured_at, refunded_at')
        .not('payment_id', 'is', null)
        .order('captured_at', { ascending: false })
        .limit(RECENT_LIMIT),

      // Oldest first, so the position reported in `first_bad_seq` counts in
      // the order the bundles were written rather than the order they were read.
      fastify.supabase
        .from('evidence_bundles')
        .select('bundle_json, bundle_hash, created_at')
        .order('created_at', { ascending: true }),

      // Two columns and nothing else. `adjudications` also holds prompt_user
      // and raw_response, which carry the incident narrative and the text of
      // the claimant's documents; neither is selected here, and neither may be.
      fastify.supabase.from('adjudications').select('model_invoked, simulated, vetoed_by'),
    ]);

    for (const result of [totalsResult, recentResult, bundlesResult, adjudicationsResult]) {
      if (result.error) {
        fastify.log.error({ err: result.error }, 'Evidence endpoint could not read the database');
        reply.code(503);
        return { error: 'Evidence records are temporarily unavailable.' };
      }
    }

    // --- Razorpay -----------------------------------------------------------

    const captures = (totalsResult.data ?? []) as Array<Record<string, unknown>>;
    const recentRows = (recentResult.data ?? []) as Array<Record<string, unknown>>;

    // Claim numbers come from a second lookup keyed on the ids just read. The
    // claims table is never selected wholesale here: it holds the incident
    // description, and `claim_number` is the only column of it this endpoint
    // is allowed to publish.
    const claimIds = [...new Set(recentRows.map((row) => row['claim_id']).filter(Boolean))];
    const claimNumbers = new Map<string, string>();
    if (claimIds.length > 0) {
      const claimsResult = await fastify.supabase
        .from('claims')
        .select('id, claim_number')
        .in('id', claimIds as string[]);
      if (claimsResult.error) {
        fastify.log.error({ err: claimsResult.error }, 'Evidence endpoint could not read claim numbers');
        reply.code(503);
        return { error: 'Evidence records are temporarily unavailable.' };
      }
      for (const row of (claimsResult.data ?? []) as Array<Record<string, unknown>>) {
        claimNumbers.set(String(row['id']), String(row['claim_number']));
      }
    }

    const recent: RecentCapture[] = recentRows.map((row) => ({
      claim_number: claimNumbers.get(String(row['claim_id'])) ?? null,
      payment_id: String(row['payment_id']),
      refund_id: (row['refund_id'] as string | null) ?? null,
      amount_paise: toPaise(row['captured_amount_paise']),
      captured_at: (row['captured_at'] as string | null) ?? null,
      refunded_at: (row['refunded_at'] as string | null) ?? null,
    }));

    // --- Evidence hashes ----------------------------------------------------
    //
    // Every stored bundle is rehashed and compared against the hash recorded
    // beside it, using the same function the pipeline used to produce it. This
    // is a per-record integrity check over `evidence_bundles`, not a linked
    // hash chain: no table in this schema carries a `prev_hash`, so nothing
    // here may claim one exists. `first_bad_seq` is the 1-based position, in
    // creation order, of the first bundle whose stored hash does not match a
    // rehash of its own JSON.

    const bundles = (bundlesResult.data ?? []) as Array<Record<string, unknown>>;
    let firstBadSeq: number | null = null;
    for (let index = 0; index < bundles.length; index++) {
      const stored = bundles[index]['bundle_hash'];
      let recomputed: string | null = null;
      try {
        recomputed = computeEvidenceHash(bundles[index]['bundle_json'] as any);
      } catch {
        // Unhashable JSON is a mismatch, not a crash. A bundle nobody can
        // rehash is exactly the row this check exists to surface.
        recomputed = null;
      }
      if (recomputed === null || recomputed !== stored) {
        firstBadSeq = index + 1;
        break;
      }
    }

    // The most recently written bundle's stored hash, or null when there are
    // none. Never a placeholder.
    const head = bundles.length > 0
      ? ((bundles[bundles.length - 1]['bundle_hash'] as string | null) ?? null)
      : null;

    // --- Attestation --------------------------------------------------------
    //
    // Read through health-observations.ts, which already works out what the
    // last genuine, non-simulated attestation was. Restating that logic here
    // is how the two answers drift apart. It throws on a database fault; the
    // catch turns that into the same 503 the reads above give.

    let attestation: { last_success_tx: string | null; last_success_at: string | null };
    try {
      const observed = await readObservations(fastify.supabase);
      attestation = {
        last_success_tx: observed.chain_attestation.last_success_tx,
        last_success_at: observed.chain_attestation.last_success_at,
      };
    } catch (err) {
      fastify.log.error({ err }, 'Evidence endpoint could not read attestation state');
      reply.code(503);
      return { error: 'Evidence records are temporarily unavailable.' };
    }

    // --- Adjudication -------------------------------------------------------

    const adjudications = (adjudicationsResult.data ?? []) as Array<Record<string, unknown>>;
    let modelInvoked = 0;
    let modelSimulated = 0;
    let vetoedBeforeModel = 0;
    const vetoReasons: Record<string, number> = {};
    for (const row of adjudications) {
      // `model_invoked` alone is not "a model ran". A row written by
      // FakeLlmProvider — no key configured, canned answer, nothing read —
      // also carries model_invoked: true, and 0017 says in as many words that
      // such a row must never be presented as a model-reviewed claim. So the
      // two are counted apart: `model_invoked` is genuine calls only, and the
      // simulated ones are reported beside it rather than folded in or hidden.
      if (row['model_invoked'] === true) {
        if (row['simulated'] === true) modelSimulated++;
        else modelInvoked++;
      }
      const vetoedBy = row['vetoed_by'];
      if (typeof vetoedBy === 'string' && vetoedBy.length > 0) {
        vetoedBeforeModel++;
        vetoReasons[vetoedBy] = (vetoReasons[vetoedBy] ?? 0) + 1;
      }
    }

    const response: EvidenceResponse = {
      razorpay: {
        mode: RAZORPAY_MODE,
        collected_paise: sumPaise(captures, 'captured_amount_paise'),
        refunded_paise: sumPaise(captures, 'refund_amount_paise'),
        recent,
      },
      audit_chain: {
        records_checked: bundles.length,
        chain_ok: firstBadSeq === null,
        first_bad_seq: firstBadSeq,
        head,
      },
      attestation: {
        network: CHAIN_NETWORK,
        ...attestation,
      },
      adjudication: {
        provider: LLM_PROVIDER_NAME,
        model: config.groqModel,
        // Boolean only. Derived from whether GROQ_API_KEY is set, by way of the
        // same flag /health reports. Nothing about the key itself is read.
        configured: features.adjudicationModel,
        model_invoked: modelInvoked,
        model_simulated: modelSimulated,
        vetoed_before_model: vetoedBeforeModel,
        veto_reasons: vetoReasons,
      },
      generated_at: new Date().toISOString(),
    };

    return response;
  });
}

/**
 * GET / — a one-screen index, so the API root is something rather than a 404.
 *
 * Registered at the root rather than under `/api`, and exported from here
 * rather than declared inline in server.ts, so that a test can boot it without
 * booting a listener. It reads nothing and changes no other route's behaviour.
 */
export async function rootIndexRoutes(fastify: FastifyInstance) {
  fastify.get('/', async () => ({
    service: 'safeguard-api',
    version: {
      git_sha: BUILD_STAMPED ? BUILD_GIT_SHA : 'unstamped',
      git_describe: BUILD_STAMPED ? BUILD_GIT_DESCRIBE : 'unstamped',
      stamped: BUILD_STAMPED,
      // True when the running code exists on no commit anywhere. Same caveat
      // /version carries, for the same reason.
      dirty: BUILD_DIRTY,
    },
    links: {
      health: '/health',
      version: '/version',
      evidence: '/api/evidence/recent',
      // The same records checked against Razorpay. Listed beside `evidence`
      // rather than instead of it: one is what we recorded, the other is what
      // the rail says, and a reader wanting to trust neither on its own needs
      // to be told both exist.
      verify: '/api/evidence/verify',
      verify_one: '/api/evidence/verify/{payment_id}',
    },
  }));
}
