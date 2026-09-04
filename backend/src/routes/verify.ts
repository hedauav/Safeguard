import { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config/environment.js';
import { RATE_LIMIT_WINDOW_MS } from '../plugins/rate-limit.js';
import { createCachedProbe } from '../services/probe-cache.js';
import {
  createPaymentLinkProvider,
  type PaymentRailProvider,
  type RailPayment,
  type RailPaymentReport,
  type Refund,
} from '../services/payment-link-provider.js';

/**
 * GET /api/evidence/verify — the money loop, checked against Razorpay, by
 * anyone, with no credentials and no repository access.
 *
 * ## The gap this closes
 *
 * `/api/evidence/recent` already publishes the payment ids and the totals, and
 * that was a real improvement over ids that lived only in a markdown file. But
 * every figure it serves is read out of our own database, so the strongest
 * thing an outsider could conclude from it was "this system is internally
 * consistent about what it says it did". A database we control asserting that
 * we collected ₹79,000 is not evidence that we collected ₹79,000. Reviewers
 * said so, and they were right: verifying this project meant reading the repo.
 *
 * These two routes ask Razorpay instead, per payment, and publish both answers
 * side by side:
 *
 *   `stored` — what SafeGuard wrote down when the webhook landed.
 *   `rail`   — what Razorpay's API says about that same payment id, just now.
 *
 * They are never merged, for the reason refund-receipt.ts gives at length: a
 * refund is issued `pending` and settles later, so ours is a snapshot and
 * theirs is current. Merging them means at some point telling somebody their
 * money is still pending when it cleared, or that it cleared when it has not.
 *
 * `agreement` is then computed by comparing the two, field by field, and it is
 * the only field here worth much. A disagreement is reported as loudly as a
 * match — an endpoint that could only ever say "confirmed" would be a nicer
 * way of asserting the same thing we were already asserting.
 *
 * ## Three rules, inherited from evidence.ts and extended
 *
 *  1. **NO PERSONAL DATA.** Claim numbers and rail identifiers only. Razorpay's
 *     payment object carries the payer's email, phone, card fingerprint and
 *     VPA; none of it reaches this file, because `fetchPayment` projects the
 *     object onto `RailPayment` rather than spreading it. See that interface.
 *  2. **NO SECRETS.** The key is used to make the call and is never read,
 *     echoed, logged or described here.
 *  3. **DERIVED, NEVER HARDCODED.** Every figure is either a database row or a
 *     Razorpay response. There is no constant in this file that a reader could
 *     mistake for a measurement.
 *
 * And one rule of its own:
 *
 *  4. **ONLY IDS WE ALREADY HANDLED.** A payment id that is not in
 *     `deductible_payments` gets a 404 and is never sent to Razorpay. Without
 *     that gate this endpoint is a free, unauthenticated oracle over our
 *     merchant account: anybody could enumerate ids and learn which ones exist
 *     on it. The gate costs a reviewer nothing — every id worth checking is
 *     printed by `/api/evidence/recent` — and it keeps the blast radius of a
 *     public endpoint to the rows this project already publishes.
 *
 * ## Why the sweep is cached and the single check is not
 *
 * `/verify` walks every capture, which is one outbound call to Razorpay per
 * payment. Left uncached, a page refresh in a loop would turn a public URL
 * into an outbound flood against a third party we depend on. `createCachedProbe`
 * gives it a TTL and, more importantly, single-flight: a hundred simultaneous
 * readers share one sweep. `/verify/:paymentId` is one call and is left live,
 * because the whole point of the per-row button is that the reader sees an
 * answer fetched in front of them.
 */

/** How long a completed sweep is served before Razorpay is asked again. */
const SWEEP_TTL_MS = 60_000;

/** A failed sweep is retried sooner than a good one is refreshed. */
const SWEEP_ERROR_TTL_MS = 10_000;

/** Longest a reader with no cached sweep waits before getting a partial answer. */
const SWEEP_TIMEOUT_MS = 25_000;

/** Past this age a cached sweep stops being served while it revalidates. */
const SWEEP_MAX_STALE_MS = 5 * 60_000;

/**
 * Outbound calls to Razorpay in flight at once during a sweep.
 *
 * Low deliberately. This runs against a payment processor's API on a shared
 * test key, and the sweep is a background nicety rather than anything a caller
 * is waiting on — being a well-behaved client matters more than finishing a
 * second sooner.
 */
const SWEEP_CONCURRENCY = 4;

/**
 * Per-IP ceiling for both routes.
 *
 * Tighter than the global tier because these are the only public routes that
 * cause outbound traffic to a third party. Stated here rather than reusing
 * ONCHAIN_RATE_LIMIT, which is documented as the tier for routes that *spend*
 * money; nothing here spends anything, and filing it under that name would
 * make the next reader of rate-limit.ts believe otherwise.
 */
const VERIFY_RATE_LIMIT = { max: 30, timeWindow: RATE_LIMIT_WINDOW_MS };

/**
 * One Razorpay account this deployment can read, and a label for it.
 *
 * There is more than one because the book spans more than one. Part of it was
 * collected through an earlier test account that has since hit its transaction
 * limit, and a Razorpay key reads only the account it belongs to — so the
 * current key answers 400 for those payments, exactly as it would for an id
 * that never existed. Consulting both accounts is what lets the endpoint tell
 * a reviewer which of those two things is true.
 *
 * The label is opaque and fixed. It says which account answered without
 * saying anything whatever about the credentials that opened it — no key, no
 * prefix, no length. Rule 2 holds here as everywhere in this file.
 */
interface RailAccount {
  /** 'primary' or 'archive'. Published; must stay free of key material. */
  label: string;
  provider: PaymentRailProvider;
}

/** What SafeGuard recorded. Rail identifiers and claim numbers only. */
interface StoredPayment {
  claim_number: string | null;
  payment_id: string;
  captured_amount_paise: number | null;
  captured_at: string | null;
  refund_id: string | null;
  refund_status: string | null;
  refund_amount_paise: number | null;
  refunded_at: string | null;
  /** True when the link was issued by the simulated rail: no money moved. */
  simulated: boolean;
  /** True when the refund was simulated, even if the capture was not. */
  refund_simulated: boolean;
}

/** What Razorpay says, projected. Null when the rail could not be asked. */
interface RailView {
  payment: RailPayment | null;
  refund: {
    id: string;
    status: string;
    amount_paise: number;
    payment_id: string;
    created_at: string;
  } | null;
}

/**
 * The comparison, which is the entire point of the endpoint.
 *
 * Every field is a three-valued answer and the third value carries weight:
 * `null` means the question could not be put to the rail, which is not the
 * same as the rail disagreeing, and reporting the two the same way would be
 * the exact dishonesty this file exists to remove.
 */
interface Agreement {
  /** Razorpay says this payment was captured. */
  rail_confirms_capture: boolean | null;
  /** Razorpay's captured figure equals the one we recorded. */
  capture_amount_matches: boolean | null;
  /** Razorpay says money went back against this payment. */
  rail_confirms_refund: boolean | null;
  /** Razorpay's refunded figure equals the one we recorded. */
  refund_amount_matches: boolean | null;
}

/**
 * `confirmed`            — the rail answered and agrees with every figure we hold.
 * `disagrees`            — the rail answered and does not. Reported as loudly
 *                          as a match, because an endpoint that could only ever
 *                          say "confirmed" is just a nicer assertion.
 * `not_on_this_account`  — the rail answered and has no such payment under the
 *                          credentials in use.
 * `unavailable`          — the rail could not be asked at all.
 * `simulated`            — the row was written by the simulated rail; there is
 *                          nothing at Razorpay to check, and pretending
 *                          otherwise is the one failure mode this whole
 *                          endpoint is aimed at.
 *
 * `not_on_this_account` was split out of `unavailable` after running this
 * against the live book, where eight of twenty-six stored payments came back
 * 400 "The id provided does not exist". Folding a definite answer from the
 * rail into the same bucket as a timeout understated it.
 *
 * It is equally important that it is not folded into `disagrees`. Those eight
 * were collected through a second Razorpay test account that has since reached
 * its limit; the payments are real and the ids are real, and the key in use
 * simply cannot see them. "Not on this account" is a fact about the
 * credentials. "Disagrees" would be an accusation about the money.
 */
type Verdict = 'confirmed' | 'disagrees' | 'not_on_this_account' | 'unavailable' | 'simulated';

interface VerifiedPayment {
  stored: StoredPayment;
  rail: RailView | null;
  rail_error: string | null;
  agreement: Agreement;
  verdict: Verdict;
  /**
   * Which account produced the answer, or null when none did. A label, never
   * a credential.
   */
  answered_by: string | null;
}

interface SweepSummary {
  payments_checked: number;
  confirmed: number;
  disagrees: number;
  /** Answered for by the rail, but under different credentials to ours. */
  not_on_this_account: number;
  unavailable: number;
  simulated: number;
  /** Totals as SafeGuard recorded them, over the payments checked. */
  stored_collected_paise: number;
  stored_refunded_paise: number;
  /**
   * The same two totals, summed from Razorpay's answers instead of ours, over
   * only the payments the rail actually answered for. Deliberately not summed
   * over all rows: including a payment the rail never answered about would
   * silently substitute our figure for theirs inside a total labelled theirs.
   */
  rail_collected_paise: number;
  rail_refunded_paise: number;
  /** How many payments those rail totals are summed over. */
  rail_totals_cover: number;
  /** True when every payment the rail answered for agreed with us. */
  totals_agree: boolean;
}

function toPaise(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Run `task` over `items`, at most `limit` at a time, preserving order.
 *
 * A plain `Promise.all` over twenty-four payments would open twenty-four
 * sockets to Razorpay at once, which is how a verification page becomes the
 * reason the payment rail rate-limits the merchant account it is verifying.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Ask the rail about one stored payment and compare the two answers.
 *
 * Never throws. A rail that is down produces `unavailable` with a reason, which
 * is a true statement about what we were able to establish; an exception here
 * would produce a 500, which is a statement about our own service and would
 * read to a reviewer as the endpoint being broken rather than the rail being
 * unreachable.
 */
async function verifyOne(
  accounts: RailAccount[],
  stored: StoredPayment
): Promise<VerifiedPayment> {
  const emptyAgreement: Agreement = {
    rail_confirms_capture: null,
    capture_amount_matches: null,
    rail_confirms_refund: null,
    refund_amount_matches: null,
  };

  // A simulated row is short-circuited before any network call. It has no
  // counterpart at Razorpay, so asking would produce a 404 that then has to be
  // distinguished from a genuine outage — and getting that distinction wrong
  // is how "no money moved here" would come to be displayed as "we couldn't
  // check". Saying it plainly is both cheaper and more honest.
  if (stored.simulated) {
    return {
      stored,
      rail: null,
      rail_error:
        'This payment was issued by the simulated rail, so no money moved and there is nothing at Razorpay to check.',
      agreement: emptyAgreement,
      verdict: 'simulated',
      answered_by: null,
    };
  }

  // Each account in turn, stopping at the first that holds the payment. The
  // order matters only for cost: the primary account holds most of the book,
  // so it is asked first and the archive is usually never reached.
  let found: { payment: RailPayment; account: RailAccount } | null = null;
  let deniedByAll = accounts.length > 0;
  let lastUnreachableReason: string | null = null;

  for (const account of accounts) {
    let report: RailPaymentReport;
    try {
      report = await account.provider.fetchPayment(stored.payment_id);
    } catch (err) {
      // fetchPayment is documented as never throwing, so this guards against a
      // future implementation that forgets. It resolves to unreachable and
      // never to a denial: an exception establishes nothing about the payment,
      // and the one thing this endpoint must not do is invent a finding.
      report = {
        known: false,
        reachable: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    if (report.known) {
      found = { payment: report.payment, account };
      break;
    }

    // One account that could not be asked is enough to disqualify the
    // collective "none of them has it". The others may have denied it, but
    // this one never got the question, so the set of accounts that answered
    // is incomplete and no conclusion may be drawn from their unanimity.
    if (!report.reachable) {
      deniedByAll = false;
      lastUnreachableReason = report.reason;
    }
  }

  if (!found) {
    // The distinction the live book forced. Every account answering "not here"
    // is a fact about which accounts these credentials open; an account not
    // answering is a fact about the network. Rendering them the same way was
    // the defect running this against real data exposed.
    return {
      stored,
      rail: null,
      rail_error: deniedByAll
        ? `Razorpay answered, and has no payment with this id on ${accounts.length === 1 ? 'the account' : 'any of the accounts'} these credentials open. That is a statement about the credentials, not about the payment: a real payment made through an account this deployment cannot read looks exactly like this.`
        : `Razorpay could not be asked about this payment (${lastUnreachableReason ?? 'no rail is configured'}). The figures shown are the ones this system recorded, and are unconfirmed.`,
      agreement: emptyAgreement,
      verdict: deniedByAll ? 'not_on_this_account' : 'unavailable',
      answered_by: null,
    };
  }

  const payment: RailPayment = found.payment;

  // The refund is read from the account that held the payment, and only once
  // that account is known. A refund lives on the same account as the payment
  // it was made against, so asking any other one is a round trip spent to be
  // told nothing.
  let refund: Refund | null = null;
  if (stored.refund_id && !stored.refund_simulated) {
    try {
      refund = await found.account.provider.fetchRefund(stored.refund_id);
    } catch {
      refund = null;
    }
  }

  const storedCaptured = stored.captured_amount_paise;
  const storedRefunded = stored.refund_amount_paise;

  const agreement: Agreement = {
    rail_confirms_capture: payment.captured,
    capture_amount_matches:
      storedCaptured === null ? null : payment.amountPaise === storedCaptured,
    // A refund we never made is not a disagreement, so both refund fields stay
    // null on a row with no refund_id rather than reporting `false` for a
    // question nobody asked.
    rail_confirms_refund: stored.refund_id ? payment.amountRefundedPaise > 0 : null,
    refund_amount_matches:
      stored.refund_id === null || storedRefunded === null
        ? null
        : payment.amountRefundedPaise === storedRefunded,
  };

  // `false` anywhere is a disagreement. `null` never is — it is the absence of
  // an answer, and the two must not collapse into each other.
  const disagrees = Object.values(agreement).some((value) => value === false);

  return {
    stored,
    rail: {
      payment,
      refund: refund
        ? {
            id: refund.id,
            status: refund.status,
            amount_paise: refund.amountPaise,
            payment_id: refund.paymentId,
            created_at: refund.createdAt,
          }
        : null,
    },
    rail_error:
      stored.refund_id && !stored.refund_simulated && !refund
        ? 'Razorpay answered for the payment but not for the refund id. The payment figures below are theirs; the refund figures are ours.'
        : null,
    agreement,
    verdict: disagrees ? 'disagrees' : 'confirmed',
    answered_by: found.account.label,
  };
}

function summarise(results: VerifiedPayment[]): SweepSummary {
  let confirmed = 0;
  let disagrees = 0;
  let notOnThisAccount = 0;
  let unavailable = 0;
  let simulated = 0;
  let storedCollected = 0;
  let storedRefunded = 0;
  let railCollected = 0;
  let railRefunded = 0;
  let railCover = 0;

  for (const result of results) {
    switch (result.verdict) {
      case 'confirmed':
        confirmed++;
        break;
      case 'disagrees':
        disagrees++;
        break;
      case 'not_on_this_account':
        notOnThisAccount++;
        break;
      case 'unavailable':
        unavailable++;
        break;
      case 'simulated':
        simulated++;
        break;
    }

    storedCollected += result.stored.captured_amount_paise ?? 0;
    storedRefunded += result.stored.refund_amount_paise ?? 0;

    const railPayment = result.rail?.payment;
    if (railPayment) {
      railCollected += railPayment.amountPaise;
      railRefunded += railPayment.amountRefundedPaise;
      railCover++;
    }
  }

  return {
    payments_checked: results.length,
    confirmed,
    disagrees,
    not_on_this_account: notOnThisAccount,
    unavailable,
    simulated,
    stored_collected_paise: storedCollected,
    stored_refunded_paise: storedRefunded,
    rail_collected_paise: railCollected,
    rail_refunded_paise: railRefunded,
    rail_totals_cover: railCover,
    // Every payment the rail produced figures for agreed with ours. It says
    // nothing whatever about the ones it did not, which is exactly why
    // `rail_totals_cover` sits beside it and must be rendered beside it: a
    // bare `totals_agree: true` over a book the rail could only see half of
    // would be the most flattering possible reading of a partial answer.
    totals_agree: disagrees === 0,
  };
}

/** Raised inside the sweep so a read fault becomes a 503 rather than zeroes. */
class EvidenceUnavailable extends Error {}

export interface VerifyRouteOptions {
  /**
   * Injectable rail, for tests. Production leaves it unset and gets the
   * provider built from configured credentials — real when they exist,
   * simulated when they do not, which is `createPaymentLinkProvider`'s whole
   * contract and not something this file should second-guess.
   */
  provider?: PaymentRailProvider;
  /**
   * The archived account, likewise injectable. Omitted in production unless
   * RAZORPAY_ARCHIVE_KEY_ID and _SECRET are both set.
   */
  archiveProvider?: PaymentRailProvider;
}

export default async function verifyRoutes(
  fastify: FastifyInstance,
  options: VerifyRouteOptions = {}
) {
  const provider =
    options.provider ??
    createPaymentLinkProvider({
      keyId: config.razorpayKeyId,
      keySecret: config.razorpayKeySecret,
    });

  /**
   * The accounts to consult, in order.
   *
   * The archive is added only when a real key pair was supplied for it.
   * `createPaymentLinkProvider` falls back to the simulated rail when handed
   * nothing, and a simulated rail in this list would be pure cost: it answers
   * unreachable for every id, which would turn every honest
   * `not_on_this_account` into a vaguer `unavailable` and make the endpoint
   * less informative than having no archive at all.
   */
  const accounts: RailAccount[] = [{ label: 'primary', provider }];

  const archiveProvider =
    options.archiveProvider ??
    (config.razorpayArchiveKeyId && config.razorpayArchiveKeySecret
      ? createPaymentLinkProvider({
          keyId: config.razorpayArchiveKeyId,
          keySecret: config.razorpayArchiveKeySecret,
        })
      : null);

  if (archiveProvider) accounts.push({ label: 'archive', provider: archiveProvider });

  /**
   * Every capture on record, newest first.
   *
   * Restricted to rows that actually received money, matching evidence.ts: a
   * NULL payment_id means the link was issued and never paid, and listing it
   * here would present a demand as something a rail could confirm.
   */
  async function readStored(paymentId?: string): Promise<StoredPayment[]> {
    let query = fastify.supabase
      .from('deductible_payments')
      .select(
        'claim_id, payment_id, captured_amount_paise, captured_at, refund_id, refund_status, refund_amount_paise, refunded_at, simulated, refund_simulated'
      )
      .not('payment_id', 'is', null);

    if (paymentId) query = query.eq('payment_id', paymentId);

    const { data, error } = await query.order('captured_at', { ascending: false });
    if (error) throw new EvidenceUnavailable('deductible_payments read failed');

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    if (rows.length === 0) return [];

    // Claim numbers come from a keyed second lookup. The claims table is never
    // selected wholesale here: it holds the incident description, and
    // `claim_number` is the only column of it this endpoint may publish.
    const claimIds = [...new Set(rows.map((row) => row['claim_id']).filter(Boolean))];
    const claimNumbers = new Map<string, string>();
    if (claimIds.length > 0) {
      const claims = await fastify.supabase
        .from('claims')
        .select('id, claim_number')
        .in('id', claimIds as string[]);
      if (claims.error) throw new EvidenceUnavailable('claims read failed');
      for (const row of (claims.data ?? []) as Array<Record<string, unknown>>) {
        claimNumbers.set(String(row['id']), String(row['claim_number']));
      }
    }

    return rows.map((row) => ({
      claim_number: claimNumbers.get(String(row['claim_id'])) ?? null,
      payment_id: String(row['payment_id']),
      captured_amount_paise: toPaise(row['captured_amount_paise']),
      captured_at: (row['captured_at'] as string | null) ?? null,
      refund_id: (row['refund_id'] as string | null) ?? null,
      refund_status: (row['refund_status'] as string | null) ?? null,
      refund_amount_paise: toPaise(row['refund_amount_paise']),
      refunded_at: (row['refunded_at'] as string | null) ?? null,
      simulated: row['simulated'] === true,
      refund_simulated: row['refund_simulated'] === true,
    }));
  }

  interface Sweep {
    ok: boolean;
    reason: string | null;
    summary: SweepSummary | null;
    payments: VerifiedPayment[];
    checked_at: string;
  }

  const sweep = createCachedProbe<Sweep>(
    async () => {
      const stored = await readStored();
      const payments = await mapWithConcurrency(stored, SWEEP_CONCURRENCY, (row) =>
        verifyOne(accounts, row)
      );
      return {
        ok: true,
        reason: null,
        summary: summarise(payments),
        payments,
        checked_at: new Date().toISOString(),
      };
    },
    // A failed sweep reports the failure. It does not report zero payments,
    // zero confirmations and agreeing totals — which is what an empty success
    // would look like, and would read as "nothing to see here" on the one page
    // whose job is to show there is.
    (reason) => ({
      ok: false,
      reason,
      summary: null,
      payments: [],
      checked_at: new Date().toISOString(),
    }),
    {
      ttlMs: SWEEP_TTL_MS,
      errorTtlMs: SWEEP_ERROR_TTL_MS,
      timeoutMs: SWEEP_TIMEOUT_MS,
      maxStaleMs: SWEEP_MAX_STALE_MS,
    }
  );

  /**
   * Fill the sweep cache before the first visitor arrives.
   *
   * This page is handed to a reviewer as a URL and opened once, and the once
   * is very often the first request after a deploy — precisely when the cache
   * is empty and the sweep has to make a call per payment across both
   * accounts. A cold reader waits for all of it, and past SWEEP_TIMEOUT_MS
   * gets a 503 telling them the payments could not be checked. That is a true
   * sentence and a terrible first impression, and it is avoidable: the work
   * does not depend on the request, so it can happen before one arrives.
   *
   * `onListen` rather than `onReady`, deliberately. onReady fires on
   * `app.ready()`, which every route test calls, and a boot-time sweep would
   * put outbound calls into tests that assert exactly which ids the rail was
   * asked about. onListen fires only when a socket is actually bound — which
   * is production, and never `inject()`.
   *
   * Fire-and-forget, like the /health probes server.ts warms for the same
   * reason. A sweep that fails here costs nothing; the first real request
   * retries it.
   */
  fastify.addHook('onListen', async () => {
    sweep.warm();
  });

  /**
   * GET /api/evidence/verify — every capture, checked against Razorpay.
   *
   * The single request a reviewer's browser makes. One call in; up to one call
   * per payment out, shared between concurrent readers and cached for a minute.
   */
  fastify.get('/evidence/verify', { config: { rateLimit: VERIFY_RATE_LIMIT } }, async (_request, reply) => {
    const result = await sweep.get();

    if (!result.ok) {
      fastify.log.error({ reason: result.reason }, 'Verification sweep failed');
      reply.code(503);
      return {
        error: 'The payment records could not be checked right now.',
        detail: result.reason,
      };
    }

    return {
      // Which rail was asked — as opposed to `payments[].rail`, which is what
      // that rail said. Two different meanings of the word, so they do not
      // share a key.
      checked_against: {
        provider: provider.name,
        // Which accounts were consulted, by label. Lets a reader see that a
        // `not_on_this_account` was reached after asking everything available
        // rather than after asking one thing.
        accounts: accounts.map((account) => account.label),
        // A constant in the same sense evidence.ts's is: this integration runs
        // on a test key and is only ever permitted to claim test-mode money.
        // Not derived from the key, because deriving it would mean reading key
        // material, and nothing in this file touches that.
        mode: 'test',
      },
      summary: result.summary,
      payments: result.payments,
      checked_at: result.checked_at,
      // Named so a reader can tell a fresh sweep from one served out of cache
      // and judge for themselves whether "just now" means what they want.
      cache_ttl_seconds: SWEEP_TTL_MS / 1000,
    };
  });

  /**
   * GET /api/evidence/verify/:paymentId — one capture, checked live.
   *
   * Uncached on purpose. The per-row button on the verification page exists so
   * that a sceptical reader can watch a request leave and an answer come back;
   * serving that from a cache would technically be the same JSON and would
   * defeat the only reason the button is there.
   */
  fastify.get(
    '/evidence/verify/:paymentId',
    { config: { rateLimit: VERIFY_RATE_LIMIT } },
    async (request: FastifyRequest<{ Params: { paymentId: string } }>, reply) => {
      const { paymentId } = request.params;

      let stored: StoredPayment[];
      try {
        stored = await readStored(paymentId);
      } catch (err) {
        fastify.log.error({ err, paymentId }, 'Verification: payment lookup failed');
        reply.code(503);
        return { error: 'The payment records could not be read right now.' };
      }

      // Rule 4. An id this deployment never handled is refused here and is
      // never forwarded to Razorpay, so the endpoint cannot be used to probe
      // which payment ids exist on the merchant account.
      if (stored.length === 0) {
        reply.code(404);
        return {
          error:
            'This deployment has no record of that payment id, so it was not looked up. The ids it does hold are listed at /api/evidence/recent.',
        };
      }

      const result = await verifyOne(accounts, stored[0]);

      return {
        checked_against: {
          provider: provider.name,
          mode: 'test',
          accounts: accounts.map((account) => account.label),
        },
        ...result,
        checked_at: new Date().toISOString(),
      };
    }
  );
}
