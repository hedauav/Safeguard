import { FastifyInstance, FastifyRequest } from 'fastify';
import { computeEvidenceHash } from '../services/attestation-service.js';
import { ClaimsFilter, PaginatedResponse, ApiResponse, Claim } from '../types/index.js';

interface ClaimWithCustomer extends Claim {
  customer_name: string;
}

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

  // GET /claims/:id — single claim detail
  fastify.get('/claims/:id', async (request: FastifyRequest<{
    Params: { id: string };
  }>, reply) => {
    const { id } = request.params;

    // Fetch claim with customer name and policy info
    const { data: claimRow, error: claimError } = await fastify.supabase
      .from('claims')
      .select('*, customers!inner(full_name), policies!inner(id, policy_number, policy_type, provider, coverage_amount, deductible, status)')
      .eq('id', id)
      .single();

    if (claimError || !claimRow) {
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

    const detail: ClaimDetail = {
      ...claim,
      customer_name: customers?.full_name ?? '',
      policy: policies ?? null,
      call_logs: callLogs ?? [],
    };

    const response: ApiResponse<ClaimDetail> = { data: detail, error: null };
    return response;
  });

  // POST /claims/:id/verify-integrity — recompute evidence hash and compare
  fastify.post('/claims/:id/verify-integrity', async (request: FastifyRequest<{
    Params: { id: string };
  }>, reply) => {
    const { id } = request.params;

    const { data: claim, error: claimError } = await fastify.supabase
      .from('claims')
      .select('id, evidence_hash')
      .eq('id', id)
      .single();

    if (claimError || !claim) {
      reply.code(404);
      return { data: null, error: 'Claim not found' } as ApiResponse<null>;
    }

    const { data: bundleRow } = await fastify.supabase
      .from('evidence_bundles')
      .select('bundle_json, bundle_hash')
      .eq('claim_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

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
