import { FastifyInstance, FastifyRequest } from 'fastify';
import { PaginatedResponse, Escalation } from '../types/index.js';

interface EscalationWithDetails extends Escalation {
  customer_name: string;
  claim_number: string | null;
  call_summary: string | null;
}

export default async function escalationsRoutes(fastify: FastifyInstance) {
  // GET /escalations — list escalations with optional filters and pagination
  fastify.get('/escalations', async (request: FastifyRequest<{
    Querystring: { status?: string; priority?: string; page?: string; limit?: string };
  }>, reply) => {
    const { status, priority } = request.query;
    const page = Math.max(1, parseInt(request.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '20', 10)));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = fastify.supabase
      .from('escalations')
      .select(
        '*, customers(full_name), claims(claim_number), call_logs(summary)',
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })
      .range(from, to);

    if (status) query = query.eq('status', status);
    if (priority) query = query.eq('priority', priority);

    const { data, error, count } = await query;

    if (error) {
      // An empty escalation list means nobody is waiting on a human. Saying
      // that when the database is unreachable is the most dangerous of the
      // three: it is the queue somebody is meant to be working.
      fastify.log.error({ err: error }, 'Failed to list escalations');
      reply.code(503);
      return { data: null, error: 'Escalation records are temporarily unavailable.' };
    }

    const escalations: EscalationWithDetails[] = (data || []).map((row: any) => {
      const { customers, claims, call_logs, ...escalation } = row;
      return {
        ...escalation,
        customer_name: customers?.full_name ?? '',
        claim_number: claims?.claim_number ?? null,
        call_summary: call_logs?.summary ?? null,
      };
    });

    const response: PaginatedResponse<EscalationWithDetails> = {
      data: escalations,
      total: count ?? 0,
      page,
      limit,
    };

    return response;
  });
}
