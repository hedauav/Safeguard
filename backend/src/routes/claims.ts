import { FastifyInstance, FastifyRequest } from 'fastify';
import { computeEvidenceHash } from '../services/attestation-service.js';
import { ClaimsFilter, PaginatedResponse, ApiResponse, Claim } from '../types/index.js';

interface ClaimWithCustomer extends Claim {
  customer_name: string;
}

/**
 * One row of `journey_events` (migration 0021), returned verbatim.
 *
 * Nothing here is derived or inferred. The whole point of the table is that a
 * claim's history stops being guessed at by UNION-ing ten per-step tables on
 * their own timestamps, so this endpoint must not reintroduce the guessing by
 * synthesising rows the writer never wrote.
 */
interface JourneyEvent {
  id: string;
  claim_id: string | null;
  policy_id: string | null;
  event_type: string;
  /** 'agent' | 'system' | 'human' | 'provider' — kept as string, see below. */
  actor: string;
  detail: Record<string, unknown> | null;
  occurred_at: string;
  call_log_id: string | null;
}

/**
 * How many events one claim's timeline may carry back.
 *
 * Generous — a claim that genuinely produced 200 events is pathological — but
 * finite, because an append-only table has no natural ceiling and a runaway
 * writer must not be able to turn one page load into an unbounded read. When
 * the cap is hit the response says so rather than silently showing a prefix.
 */
const JOURNEY_EVENT_LIMIT = 200;

interface ClaimDetail extends Claim {
  customer_name: string;
  policy: {
    id: string;
    policy_number: string;
    policy_type: string;
    provider: string;
    coverage_amount: number;
    deductible: number;
    status: string;
  } | null;
  call_logs: Array<{
    id: string;
    direction: string;
    status: string;
    summary: string | null;
    started_at: string;
    duration_seconds: number | null;
  }>;
  /**
   * Everything recorded against this claim, oldest first.
   *
   * Empty means one of two different things, and the caller is given enough to
   * tell them apart: `journey_available: false` (the 0021 migration has not
   * been applied), `journey_error` non-null (the read failed), or genuinely
   * nothing written — which for a claim filed before this table existed is the
   * truth, and the dashboard says so instead of inventing a "filed" step out
   * of `filed_at`.
   */
  journey_events: JourneyEvent[];
  /**
   * Events written against this claim's POLICY that belong to no claim.
   *
   * Renewals are policy-level: a lapsed policy is renewed, and only then is a
   * claim filed against it. Carrying those here is what makes "lapsed →
   * renewed → filed → paid" readable as one story on the claim page. They are
   * kept in a separate array rather than merged, because a renewal is not a
   * step of this claim and merging them would imply it was. Events belonging
   * to a *different* claim on the same policy are excluded outright.
   */
  policy_events: JourneyEvent[];
  /** False when migration 0021 has not been applied — a nameable, fixable state. */
  journey_available: boolean;
  /**
   * Why the timeline could not be read, or null when it was read fine.
   *
   * An empty array has to mean "nothing has happened yet". Returning `[]`
   * after a failed query says that about a claim that may have travelled its
   * whole journey, which is the same class of lie as inventing a step.
   */
  journey_error: string | null;
  /** True when the event cap was hit, so the timeline shown is a prefix. */
  journey_truncated: boolean;
}

/**
 * Both read endpoints below take a uuid, and Postgres should not be the one to
 * find out otherwise.
 *
 * This matters more since the handlers started separating an outage from a
 * miss: without it a malformed id reaches Postgres, comes back as error 22P02,
 * and gets reported as "temporarily unavailable" — telling the user the
 * database is down when in fact they typed a bad id. Mirrors the schema
 * `routes/calls.ts` already applies to `/calls/:id`, spelled out rather than
 * using `format: 'uuid'` so it does not depend on which ajv format plugins
 * happen to be registered.
 */
const uuidParamsSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    },
  },
} as const;

/**
 * Whether a PostgREST error means "that table is not there".
 *
 * Duplicated from `routes/adjudication-review.ts:114` rather than shared,
 * because that copy is a module-private helper in a file this change does not
 * own. Both exist for the same reason: an unapplied migration is a different
 * fact from a database that is down, and the dashboard can only say which if
 * the API distinguishes them. Postgres reports 42P01; PostgREST reports
 * PGRST205 when its schema cache has never seen the relation.
 */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  const message = (error.message ?? '').toLowerCase();
  return message.includes('does not exist') || message.includes('schema cache');
}

export default async function claimsRoutes(fastify: FastifyInstance) {
  // GET /claims — list claims with optional filters and pagination
  fastify.get('/claims', async (request: FastifyRequest<{
    Querystring: ClaimsFilter & { page?: string; limit?: string };
  }>, reply) => {
    const { status, claim_type, customer_id } = request.query;
    const page = Math.max(1, parseInt(request.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '20', 10)));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = fastify.supabase
      .from('claims')
      .select('*, customers!inner(full_name)', { count: 'exact' })
      .order('filed_at', { ascending: false })
      .range(from, to);

    if (status) query = query.eq('status', status);
    if (claim_type) query = query.eq('claim_type', claim_type);
    if (customer_id) query = query.eq('customer_id', customer_id);

    const { data, error, count } = await query;

    if (error) {
      // A database outage reported as an empty list reads on the dashboard as
      // "no claims", which is the failure mode this project set out to remove.
      // The raw Postgres message is logged rather than returned: it names
      // schemas, columns and constraints to whoever asked.
      fastify.log.error({ err: error }, 'Failed to list claims');
      reply.code(503);
      return { data: null, error: 'Claim records are temporarily unavailable.' };
    }

    const claims: ClaimWithCustomer[] = (data || []).map((row: any) => {
      const { customers, ...claim } = row;
      return { ...claim, customer_name: customers?.full_name ?? '' };
    });

    const response: PaginatedResponse<ClaimWithCustomer> = {
      data: claims,
      total: count ?? 0,
      page,
      limit,
    };

    return response;
  });

  // GET /claims/:id — single claim detail, with the journey timeline
  fastify.get('/claims/:id', { schema: uuidParamsSchema }, async (request: FastifyRequest<{
    Params: { id: string };
  }>, reply) => {
    const { id } = request.params;

    // Fetch claim with customer name and policy info.
    //
    // The joins are deliberately NOT `!inner` any more. An inner join makes an
    // unreadable — or, for `policies`, a since-deleted — related row delete the
    // claim from the result, which the handler below would then report as
    // "Claim not found". The detail type already declares `policy` nullable and
    // defaults `customer_name` to an empty string, so a left join is what the
    // response shape has always promised.
    const { data: claimRow, error: claimError } = await fastify.supabase
      .from('claims')
      .select('*, customers(full_name), policies(id, policy_number, policy_type, provider, coverage_amount, deductible, status)')
      .eq('id', id)
      .maybeSingle();

    if (claimError) {
      // `claimError || !claimRow` used to fold an unreachable database into the
      // same 404 as a claim that does not exist, so the dashboard told the user
      // their claim was gone when it was merely unreadable. `routes/calls.ts`
      // fixed exactly this for call logs and left claims behind. `.maybeSingle()`
      // separates them: an error here is an outage, a null row is a miss.
      //
      // The raw Postgres message is logged rather than returned: it names
      // schemas, columns and constraints to whoever asked.
      fastify.log.error({ err: claimError, claimId: id }, 'Failed to read claim');
      reply.code(503);
      const response: ApiResponse<null> = { data: null, error: 'Claim records are temporarily unavailable.' };
      return response;
    }

    if (!claimRow) {
      reply.code(404);
      const response: ApiResponse<null> = { data: null, error: 'Claim not found' };
      return response;
    }

    // Fetch related call logs for this claim's customer
    const { data: callLogs } = await fastify.supabase
      .from('call_logs')
      .select('id, direction, status, summary, started_at, duration_seconds')
      .eq('customer_id', claimRow.customer_id)
      .order('started_at', { ascending: false })
      .limit(50);

    const { customers, policies, ...claim } = claimRow as any;

    const journeySelect = 'id, claim_id, policy_id, event_type, actor, detail, occurred_at, call_log_id';

    // The claim's own timeline, oldest first — the order the steps happened in
    // is the whole value of the table, so it is the order it is read in.
    const { data: claimEvents, error: claimEventsError } = await fastify.supabase
      .from('journey_events')
      .select(journeySelect)
      .eq('claim_id', id)
      .order('occurred_at', { ascending: true })
      .limit(JOURNEY_EVENT_LIMIT);

    // Policy-level events that belong to no claim: renewals, payment failures,
    // reactivation. `.is('claim_id', null)` is what keeps a *sibling* claim's
    // steps out — without it this would show another claim's history on this
    // claim's page. Skipped entirely when the claim carries no policy_id, and
    // skipped when the table is missing, since the first query already said so.
    const policyId: string | null = policies?.id ?? claim.policy_id ?? null;
    const canReadPolicyEvents = policyId && !isMissingTable(claimEventsError);
    const { data: policyEvents, error: policyEventsError } = canReadPolicyEvents
      ? await fastify.supabase
          .from('journey_events')
          .select(journeySelect)
          .eq('policy_id', policyId)
          .is('claim_id', null)
          .order('occurred_at', { ascending: true })
          .limit(JOURNEY_EVENT_LIMIT)
      : { data: null, error: null };

    // An unapplied migration is a nameable, fixable state; a failed read is an
    // outage; neither is "nothing has happened". They are reported as three
    // distinguishable things so the page can say which one it is looking at.
    const journeyMissing = isMissingTable(claimEventsError);
    const journeyFault = (!journeyMissing && claimEventsError) || policyEventsError || null;

    if (journeyFault) {
      fastify.log.error({ err: journeyFault, claimId: id }, 'Failed to read journey events');
    } else if (journeyMissing) {
      fastify.log.warn({ claimId: id }, 'journey_events table is absent — migration 0021 not applied');
    }

    // A timeline fault does not fail the whole request. The claim itself was
    // read, and refusing to render a readable claim because one of its panels
    // could not load hides more than it protects. The fault travels as a field
    // instead, and the page shows that panel as unreadable rather than empty.
    const rows = (journeyMissing || journeyFault ? [] : (claimEvents ?? [])) as JourneyEvent[];
    const policyRows = (journeyMissing || journeyFault ? [] : (policyEvents ?? [])) as JourneyEvent[];

    const detail: ClaimDetail = {
      ...claim,
      customer_name: customers?.full_name ?? '',
      policy: policies ?? null,
      call_logs: callLogs ?? [],
      journey_events: rows,
      policy_events: policyRows,
      journey_available: !journeyMissing,
      journey_error: journeyFault ? 'The journey timeline could not be read.' : null,
      journey_truncated: rows.length >= JOURNEY_EVENT_LIMIT || policyRows.length >= JOURNEY_EVENT_LIMIT,
    };

    const response: ApiResponse<ClaimDetail> = { data: detail, error: null };
    return response;
  });

  // POST /claims/:id/verify-integrity — recompute evidence hash and compare
  fastify.post('/claims/:id/verify-integrity', { schema: uuidParamsSchema }, async (request: FastifyRequest<{
    Params: { id: string };
  }>, reply) => {
    const { id } = request.params;

    const { data: claim, error: claimError } = await fastify.supabase
      .from('claims')
      .select('id, evidence_hash')
      .eq('id', id)
      .maybeSingle();

    // Same fix as the detail route above, and it matters more here: this
    // endpoint exists to answer "is the evidence intact?", so telling the
    // caller the claim does not exist when the database merely could not be
    // reached is the worst possible answer to give about an integrity check.
    if (claimError) {
      fastify.log.error({ err: claimError, claimId: id }, 'Failed to read claim for integrity check');
      reply.code(503);
      return { data: null, error: 'Claim records are temporarily unavailable.' } as ApiResponse<null>;
    }

    if (!claim) {
      reply.code(404);
      return { data: null, error: 'Claim not found' } as ApiResponse<null>;
    }

    const { data: bundleRow, error: bundleError } = await fastify.supabase
      .from('evidence_bundles')
      .select('bundle_json, bundle_hash')
      .eq('claim_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // A failed read used to fall through to `match: false, 'No evidence bundle
    // stored'` — an integrity check reporting the evidence as absent when the
    // table was merely unreadable. "The evidence is not there" is a serious
    // claim about a claim; it must not be produced by an outage.
    if (bundleError) {
      fastify.log.error({ err: bundleError, claimId: id }, 'Failed to read evidence bundle');
      reply.code(503);
      return { data: null, error: 'Evidence records are temporarily unavailable.' } as ApiResponse<null>;
    }

    if (!bundleRow) {
      return {
        data: { match: false, reason: 'No evidence bundle stored' },
        error: null,
      } as ApiResponse<{ match: boolean; reason?: string }>;
    }

    const hash = computeEvidenceHash(bundleRow.bundle_json as any);
    const storedHash = bundleRow.bundle_hash as string;
    const match = hash === storedHash && (!claim.evidence_hash || claim.evidence_hash === storedHash);

    return {
      data: {
        match,
        computed_hash: hash,
        stored_hash: storedHash,
        claim_hash: claim.evidence_hash,
      },
      error: null,
    } as ApiResponse<{ match: boolean; computed_hash: string; stored_hash: string; claim_hash: string | null }>;
  });
}
