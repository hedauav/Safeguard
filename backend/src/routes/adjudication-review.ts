import crypto from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/environment.js';

/**
 * The human half of adjudication.
 *
 * `adjudication-service.ts` produces recommendations and is careful never to
 * decide anything: it writes one `adjudications` row and touches neither
 * `claims.status` nor `claims.approved_amount`. That is the correct boundary,
 * and until this file existed it was also a dead end — there was nowhere for a
 * person's answer to go, so nothing distinguished a claim nobody had read from
 * a claim somebody had read and approved.
 *
 * These two endpoints are that answer, and everything here is arranged around
 * one rule: the screen must never be able to show a state that is not true.
 *
 *  1. THE QUEUE REPORTS ITS OWN LIMITS. It scans a bounded window of the newest
 *     adjudications rather than pretending to have read the table. When the
 *     window fills, `truncated` says so and the counts that cannot be exact
 *     come back null instead of approximate. A number a reviewer cannot trust
 *     is worse than a blank.
 *
 *  2. A MISSING TABLE IS A STATE, NOT AN ERROR TO SWALLOW. Migration 0019 is
 *     applied by hand, like every other migration in this project. Until it is,
 *     `reviews_available` is false and the queue says plainly that decisions
 *     cannot be read or recorded — rather than rendering every recommendation
 *     as though it were awaiting review, which is what a caught-and-ignored
 *     error would look like on screen.
 *
 *  3. THE DECISION IS RECORDED BEFORE THE CLAIM IS MOVED. The audit row goes in
 *     first. If the status update then fails, `claim_status_after` stays NULL
 *     and both the response and the queue show a decision that did not move the
 *     claim. The opposite order can silently change a claim with no record of
 *     who changed it.
 *
 * Nothing here is exposed to the ElevenLabs agent. Writes require ADMIN_TOKEN.
 */

/** Columns of `adjudications` the dashboard is allowed to see. */
const ADJUDICATION_COLUMNS = [
  'id',
  'claim_id',
  'claim_number',
  'verdict',
  'confidence',
  'computed_payable_amount',
  'model_proposed_amount',
  'amount_agreement',
  'policy_clauses',
  'inconsistencies',
  'checks',
  'vetoed_by',
  'model_invoked',
  'model_provider',
  'model_id',
  'model_latency_ms',
  'simulated',
  'parse_error',
  'created_at',
].join(', ');
//
// Deliberately absent: prompt_system, prompt_user, raw_response. 0017's RLS
// note warns that prompt_user carries the incident description and the full
// text of the claimant's documents, and asks that publishing it be weighed
// before any dashboard renders these rows. It is not needed to decide a claim,
// so it does not cross the wire. The audit trail keeps it either way.

/** Largest number of adjudications one queue request will read. */
const DEFAULT_SCAN_CAP = 500;
const MAX_SCAN_CAP = 2000;

/** Statuses this endpoint refuses to overwrite. */
const TERMINAL_CLAIM_STATUSES = new Set(['paid', 'closed']);

/**
 * Guard for the write endpoint, copied in shape from agent-config.ts.
 *
 * Fails closed: with no ADMIN_TOKEN configured it refuses rather than falling
 * open. An unauthenticated write here would let anyone record a human approval
 * naming an adjuster who never saw the claim, and then move the claim into
 * `approved`, which is the one status the settlement path will disburse from.
 */
function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!config.adminToken) {
    reply.code(503).send({
      data: null,
      error: 'Recording decisions is disabled: ADMIN_TOKEN is not configured on the server.',
    });
    return false;
  }

  const header = request.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

  const a = Buffer.from(provided);
  const b = Buffer.from(config.adminToken);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    reply.code(401).send({ data: null, error: 'Invalid or missing admin token.' });
    return false;
  }
  return true;
}

/**
 * Whether a PostgREST error means "that table is not there".
 *
 * Checked explicitly rather than treated as a generic failure so the queue can
 * distinguish an unapplied migration — a fixable, nameable state — from a
 * database that is down. Postgres reports 42P01; PostgREST reports PGRST205
 * when its schema cache has never seen the relation.
 */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  const message = (error.message ?? '').toLowerCase();
  return message.includes('does not exist') || message.includes('schema cache');
}

/** A decision as it is read back. */
interface ReviewRow {
  id: string;
  adjudication_id: string;
  decision: string;
  reviewer: string;
  note: string | null;
  recommended_verdict: string;
  model_invoked: boolean;
  claim_status_before: string | null;
  claim_status_after: string | null;
  decided_at: string;
}

export default async function adjudicationReviewRoutes(fastify: FastifyInstance) {
  /**
   * GET /adjudications/queue
   *
   * The recommendations a human has not answered yet, newest first, one per
   * claim. Query: `state` (pending | decided | all), `limit`, `scan`.
   *
   * Only the LATEST adjudication for a claim is offered for decision. An older
   * run superseded by a newer one is not a second thing to approve, so it is
   * counted (`superseded_count`) and not listed.
   */
  fastify.get('/adjudications/queue', async (request: FastifyRequest<{
    Querystring: { state?: string; limit?: string; scan?: string };
  }>, reply) => {
    const state = ['pending', 'decided', 'all'].includes(request.query.state ?? '')
      ? (request.query.state as 'pending' | 'decided' | 'all')
      : 'pending';
    const limit = Math.min(200, Math.max(1, parseInt(request.query.limit || '50', 10)));
    const scanCap = Math.min(
      MAX_SCAN_CAP,
      Math.max(limit, parseInt(request.query.scan || String(DEFAULT_SCAN_CAP), 10) || DEFAULT_SCAN_CAP)
    );

    const { data: adjudicationRows, error: adjudicationError } = await fastify.supabase
      .from('adjudications')
      .select(ADJUDICATION_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(scanCap);

    if (adjudicationError) {
      // An outage rendered as an empty queue reads on screen as "nothing needs
      // a human", which is the most dangerous possible lie for this page.
      fastify.log.error({ err: adjudicationError }, 'Failed to read adjudications');
      reply.code(503);
      return {
        data: null,
        error: isMissingTable(adjudicationError)
          ? 'The adjudications table is not present. Apply database/0017_adjudications.sql.'
          : 'Adjudication records are temporarily unavailable.',
      };
    }

    const scanned = adjudicationRows?.length ?? 0;
    const truncated = scanned >= scanCap;

    // Newest-first, so the first row seen for a claim is its current one.
    const latest: Record<string, unknown>[] = [];
    const supersededByClaim = new Map<string, number>();
    const seenClaims = new Set<string>();
    for (const row of (adjudicationRows ?? []) as unknown as Record<string, unknown>[]) {
      const claimId = String(row.claim_id);
      if (seenClaims.has(claimId)) {
        supersededByClaim.set(claimId, (supersededByClaim.get(claimId) ?? 0) + 1);
        continue;
      }
      seenClaims.add(claimId);
      latest.push(row);
    }

    const adjudicationIds = latest.map((row) => String(row.id));
    const claimIds = [...seenClaims];

    // --- The decisions, if the table for them exists yet --------------------
    let reviewsAvailable = true;
    let reviewsUnavailableReason: string | null = null;
    const reviewByAdjudication = new Map<string, ReviewRow>();

    if (adjudicationIds.length > 0) {
      const { data: reviewRows, error: reviewError } = await fastify.supabase
        .from('adjudication_reviews')
        .select('id, adjudication_id, decision, reviewer, note, recommended_verdict, model_invoked, claim_status_before, claim_status_after, decided_at')
        .in('adjudication_id', adjudicationIds);

      if (reviewError) {
        reviewsAvailable = false;
        reviewsUnavailableReason = isMissingTable(reviewError)
          ? 'The adjudication_reviews table is not present. Apply database/0019_adjudication_reviews.sql to record and read human decisions.'
          : 'Human decisions could not be read from the database.';
        fastify.log.error({ err: reviewError }, 'Failed to read adjudication reviews');
      } else {
        for (const row of (reviewRows ?? []) as unknown as ReviewRow[]) {
          reviewByAdjudication.set(row.adjudication_id, row);
        }
      }
    }

    // --- The claims those recommendations are about -------------------------
    const claimById = new Map<string, {
      id: string;
      claim_number: string;
      status: string;
      claimed_amount: number | null;
      customer_name: string;
    }>();

    if (claimIds.length > 0) {
      const { data: claimRows, error: claimError } = await fastify.supabase
        .from('claims')
        .select('id, claim_number, status, claimed_amount, customers(full_name)')
        .in('id', claimIds);

      if (claimError) {
        fastify.log.error({ err: claimError }, 'Failed to read claims for the review queue');
      } else {
        for (const row of (claimRows ?? []) as unknown as Record<string, unknown>[]) {
          const customers = row.customers as { full_name?: string } | { full_name?: string }[] | null;
          const fullName = Array.isArray(customers) ? customers[0]?.full_name : customers?.full_name;
          claimById.set(String(row.id), {
            id: String(row.id),
            claim_number: String(row.claim_number),
            status: String(row.status),
            claimed_amount: row.claimed_amount === null || row.claimed_amount === undefined
              ? null
              : Number(row.claimed_amount),
            // Empty, not "Unknown Customer": an absent join is absent.
            customer_name: fullName ?? '',
          });
        }
      }
    }

    // --- How many claims have never been adjudicated at all -----------------
    //
    // The page has to be able to say "this claim has no recommendation" as
    // something different from "this claim was adjudicated and escalated". The
    // queue itself can only ever show claims that HAVE a recommendation, so the
    // count of the others is reported alongside it. It is exact only when the
    // scan window held every adjudication; otherwise it is null, because a
    // wrong number here would invent the distinction it exists to make.
    let claimsTotal: number | null = null;
    let claimsNeverAdjudicated: number | null = null;
    {
      const { count, error: countError } = await fastify.supabase
        .from('claims')
        .select('id', { count: 'exact', head: true });
      if (countError) {
        fastify.log.error({ err: countError }, 'Failed to count claims');
      } else if (count !== null && count !== undefined) {
        claimsTotal = count;
        if (!truncated) claimsNeverAdjudicated = Math.max(0, count - seenClaims.size);
      }
    }

    // --- Assemble ------------------------------------------------------------
    const items = latest.map((row) => {
      const review = reviewByAdjudication.get(String(row.id)) ?? null;
      return {
        adjudication: row,
        claim: claimById.get(String(row.claim_id)) ?? null,
        review,
        superseded_count: supersededByClaim.get(String(row.claim_id)) ?? 0,
      };
    });

    // With no reviews table there is no way to know what is pending, so nothing
    // is filtered and the flag above tells the page to stop claiming otherwise.
    const pendingCount = reviewsAvailable ? items.filter((i) => i.review === null).length : null;
    const decidedCount = reviewsAvailable ? items.filter((i) => i.review !== null).length : null;

    const filtered = !reviewsAvailable
      ? items
      : state === 'pending'
        ? items.filter((i) => i.review === null)
        : state === 'decided'
          ? items.filter((i) => i.review !== null)
          : items;

    return {
      data: filtered.slice(0, limit),
      total: filtered.length,
      state,
      limit,
      // Everything the caller needs to know how much of the truth this is.
      scanned,
      scan_cap: scanCap,
      truncated,
      claims_with_adjudication: seenClaims.size,
      claims_total: claimsTotal,
      claims_never_adjudicated: claimsNeverAdjudicated,
      pending_count: pendingCount,
      decided_count: decidedCount,
      reviews_available: reviewsAvailable,
      reviews_unavailable_reason: reviewsUnavailableReason,
      // Whether the buttons can do anything at all, so a deployment with no
      // admin token says so up front rather than after a 503.
      decisions_enabled: Boolean(config.adminToken),
      error: null,
    };
  });

  /**
   * POST /adjudications/:id/decision
   *
   * Record a human's answer to one recommendation, and — because this is the
   * act the recommendation was waiting for — move the claim.
   *
   * `approve` sets the claim to `approved`, which is the status settle-claim
   * requires before it will disburse anything. It does NOT set
   * `approved_amount`: the settlement path computes and writes that figure at
   * payout time, and a second copy of that arithmetic here is how the two
   * drift apart.
   */
  fastify.post('/adjudications/:id/decision', async (request: FastifyRequest<{
    Params: { id: string };
    Body: { decision?: string; reviewer?: string; note?: string };
  }>, reply) => {
    if (!requireAdmin(request, reply)) return;

    const { id } = request.params;
    const body = request.body ?? {};

    const decision = body.decision === 'approve'
      ? 'approved'
      : body.decision === 'reject'
        ? 'rejected'
        : null;
    if (!decision) {
      reply.code(400);
      return { data: null, error: "decision must be either 'approve' or 'reject'." };
    }

    const reviewer = (body.reviewer ?? '').trim();
    if (!reviewer) {
      reply.code(400);
      return {
        data: null,
        error: 'reviewer is required: a decision with nobody attached to it is not an audit record.',
      };
    }
    if (reviewer.length > 200) {
      reply.code(400);
      return { data: null, error: 'reviewer must be 200 characters or fewer.' };
    }

    const note = (body.note ?? '').trim().slice(0, 2000) || null;

    // --- The recommendation being answered ----------------------------------
    const { data: adjudication, error: adjudicationError } = await fastify.supabase
      .from('adjudications')
      .select('id, claim_id, claim_number, verdict, model_invoked')
      .eq('id', id)
      .single();

    if (adjudicationError || !adjudication) {
      reply.code(404);
      return { data: null, error: 'Adjudication not found.' };
    }

    const adj = adjudication as unknown as {
      id: string;
      claim_id: string;
      claim_number: string;
      verdict: string;
      model_invoked: boolean;
    };

    // --- Is this still the current recommendation for the claim? ------------
    //
    // Deciding a superseded run would record an answer to a question that has
    // since been asked again, and the reviewer would not know.
    const { data: newest } = await fastify.supabase
      .from('adjudications')
      .select('id')
      .eq('claim_id', adj.claim_id)
      .order('created_at', { ascending: false })
      .limit(1);

    const newestId = (newest as unknown as { id: string }[] | null)?.[0]?.id;
    if (newestId && newestId !== adj.id) {
      reply.code(409);
      return {
        data: null,
        error: 'This recommendation has been superseded by a newer adjudication on the same claim. Reload the queue and decide the current one.',
      };
    }

    // --- The claim as it stands now -----------------------------------------
    const { data: claimRow, error: claimError } = await fastify.supabase
      .from('claims')
      .select('id, status')
      .eq('id', adj.claim_id)
      .single();

    if (claimError || !claimRow) {
      reply.code(404);
      return { data: null, error: 'The claim this recommendation refers to no longer exists.' };
    }

    const statusBefore = String((claimRow as unknown as { status: string }).status);

    // --- Record the decision, before anything is changed ---------------------
    const { data: inserted, error: insertError } = await fastify.supabase
      .from('adjudication_reviews')
      .insert({
        adjudication_id: adj.id,
        claim_id: adj.claim_id,
        claim_number: adj.claim_number,
        decision,
        reviewer,
        note,
        recommended_verdict: adj.verdict,
        model_invoked: adj.model_invoked,
        claim_status_before: statusBefore,
        claim_status_after: null,
      })
      .select('id, adjudication_id, decision, reviewer, note, recommended_verdict, model_invoked, claim_status_before, claim_status_after, decided_at')
      .single();

    if (insertError) {
      if (isMissingTable(insertError)) {
        fastify.log.error({ err: insertError }, 'adjudication_reviews table missing');
        reply.code(503);
        return {
          data: null,
          error: 'Decisions cannot be recorded: the adjudication_reviews table is not present. Apply database/0019_adjudication_reviews.sql.',
        };
      }
      // The unique constraint on adjudication_id. A second decision on one
      // recommendation is not an update, it is two people disagreeing, and
      // that needs a fresh adjudication rather than a quiet overwrite.
      if (insertError.code === '23505') {
        reply.code(409);
        return { data: null, error: 'This recommendation has already been decided.' };
      }
      fastify.log.error({ err: insertError }, 'Failed to record adjudication decision');
      reply.code(503);
      return { data: null, error: 'The decision could not be recorded.' };
    }

    const review = inserted as unknown as ReviewRow;
    const warnings: string[] = [];
    let statusAfter: string | null = null;

    // --- Move the claim ------------------------------------------------------
    if (TERMINAL_CLAIM_STATUSES.has(statusBefore)) {
      // A paid claim is not un-paid by a review, and a closed one is not
      // reopened by one. The decision stands recorded; the claim does not move.
      warnings.push(
        `The claim is already ${statusBefore}, so its status was not changed. The decision is recorded against the recommendation.`
      );
    } else {
      const target = decision === 'approved' ? 'approved' : 'denied';
      const { error: statusError } = await fastify.supabase
        .from('claims')
        .update({ status: target })
        .eq('id', adj.claim_id);

      if (statusError) {
        fastify.log.error({ err: statusError }, 'Decision recorded but claim status not updated');
        warnings.push(
          `The decision was recorded, but the claim status could not be changed to '${target}'. It is still '${statusBefore}'.`
        );
      } else {
        statusAfter = target;
        const { error: patchError } = await fastify.supabase
          .from('adjudication_reviews')
          .update({ claim_status_after: target })
          .eq('id', review.id);
        if (patchError) {
          fastify.log.error({ err: patchError }, 'Claim moved but claim_status_after not written');
          warnings.push(
            `The claim was moved to '${target}', but the audit row still reads as though it was not. The two disagree; the claim row is correct.`
          );
        }
      }
    }

    fastify.log.info(
      { adjudication_id: adj.id, claim_number: adj.claim_number, decision, reviewer, statusBefore, statusAfter },
      'Human decision recorded'
    );

    return {
      data: {
        ...review,
        claim_status_after: statusAfter,
        claim_number: adj.claim_number,
        // Stated rather than left for the reader to work out: the case where a
        // human went against the recommendation is the one worth counting.
        overrode_recommendation:
          (decision === 'approved' && adj.verdict !== 'approve') ||
          (decision === 'rejected' && adj.verdict !== 'deny'),
        warnings,
      },
      error: null,
    };
  });
}
