import { FastifyInstance, FastifyRequest } from 'fastify';
import { CallsFilter, PaginatedResponse, ApiResponse, CallLog, CallToolExecution } from '../types/index.js';
import { requireToolsToken } from '../plugins/tools-auth.js';
import { TOOL_RATE_LIMIT } from '../plugins/rate-limit.js';

interface CallLogWithCustomer extends CallLog {
  customer_name: string;
}

interface CallLogDetail extends CallLog {
  customer_name: string;
  tool_executions: CallToolExecution[];
}

/**
 * What a tool-execution row may contain.
 *
 * Enforced by Fastify rather than trusted from `request.body as any`, because
 * these rows are the compliance record the dashboard renders as evidence of
 * what the agent did on a call. `additionalProperties: false` matters as much
 * as the types: an unlisted field would otherwise be persisted verbatim into
 * the JSON columns and read back as though the agent had produced it.
 *
 * Note what that setting actually does here. Fastify's ajv runs with
 * `removeAdditional: true`, so an unlisted field is stripped from the body
 * rather than rejected — the request still succeeds, minus the injected key.
 * The property the record depends on holds either way: only listed fields
 * survive validation, so nothing unlisted reaches the insert below.
 */
const toolExecutionSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      // Spelled out rather than `format: uuid` so validation does not depend on
      // which ajv format plugins happen to be registered.
      id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    },
  },
  body: {
    type: 'object',
    required: ['tool_name'],
    additionalProperties: false,
    properties: {
      tool_name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9_-]+$' },
      tool_args: { type: 'object' },
      tool_result: { type: 'object' },
      success: { type: 'boolean' },
      latency_ms: { type: 'integer', minimum: 0, maximum: 600_000 },
    },
  },
} as const;

export default async function callsRoutes(fastify: FastifyInstance) {
  // GET /calls — list call logs with optional filters and pagination
  fastify.get('/calls', async (request: FastifyRequest<{
    Querystring: CallsFilter & { page?: string; limit?: string };
  }>, reply) => {
    const { status, direction, customer_id } = request.query;
    const page = Math.max(1, parseInt(request.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '20', 10)));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = fastify.supabase
      .from('call_logs')
      .select('*, customers(full_name)', { count: 'exact' })
      .order('started_at', { ascending: false })
      .range(from, to);

    if (status) query = query.eq('status', status);
    if (direction) query = query.eq('direction', direction);
    if (customer_id) query = query.eq('customer_id', customer_id);

    const { data, error, count } = await query;

    if (error) {
      // An unreachable database is an outage, not an empty list. Returning
      // 200 with `[]` is the bug this project already claims to have fixed:
      // the dashboard cannot tell "no calls yet" from "records unavailable".
      // The Postgres message is logged, never returned — it names schemas,
      // columns and constraints to whoever asked.
      fastify.log.error({ err: error }, 'Failed to list call logs');
      reply.code(503);
      return { data: null, error: 'Call records are temporarily unavailable.' };
    }

    const calls: CallLogWithCustomer[] = (data || []).map((row: any) => {
      const { customers, ...call } = row;
      return { ...call, customer_name: customers?.full_name ?? '' };
    });

    const response: PaginatedResponse<CallLogWithCustomer> = {
      data: calls,
      total: count ?? 0,
      page,
      limit,
    };

    return response;
  });

  // GET /calls/:id — single call log with tool executions
  fastify.get('/calls/:id', async (request: FastifyRequest<{
    Params: { id: string };
  }>, reply) => {
    const { id } = request.params;

    // Fetch call log with customer name
    const { data: callRow, error: callError } = await fastify.supabase
      .from('call_logs')
      .select('*, customers(full_name)')
      .eq('id', id)
      .single();

    if (callError || !callRow) {
      reply.code(404);
      const response: ApiResponse<null> = { data: null, error: 'Call log not found' };
      return response;
    }

    // Fetch tool executions for this call
    const { data: toolExecs } = await fastify.supabase
      .from('call_tool_executions')
      .select('*')
      .eq('call_log_id', id)
      .order('executed_at', { ascending: true });

    const { customers, ...call } = callRow as any;

    const detail: CallLogDetail = {
      ...call,
      customer_name: customers?.full_name ?? '',
      tool_executions: toolExecs ?? [],
    };

    const response: ApiResponse<CallLogDetail> = { data: detail, error: null };
    return response;
  });

  /**
   * POST /calls/:id/tool-executions — log a tool execution during a live call.
   *
   * This writes the audit trail the dashboard presents as the record of what
   * the agent did. Unauthenticated, it let anyone insert fabricated rows into
   * a compliance record — so it carries the same shared secret as the tool
   * endpoints that produce those executions, and the body is schema-validated
   * rather than spread from `any`.
   */
  fastify.post('/calls/:id/tool-executions', {
    preHandler: requireToolsToken,
    config: { rateLimit: TOOL_RATE_LIMIT },
    schema: toolExecutionSchema,
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: {
      tool_name: string;
      tool_args?: Record<string, any>;
      tool_result?: Record<string, any>;
      success?: boolean;
      latency_ms?: number;
    };
  }>, reply) => {
    const { id } = request.params;
    const body = request.body;

    // Verify the call log exists
    const { data: callLog, error: callError } = await fastify.supabase
      .from('call_logs')
      .select('id')
      .eq('id', id)
      .single();

    if (callError || !callLog) {
      reply.code(404);
      return { data: null, error: 'Call log not found' };
    }

    // Log the tool execution
    const { data: execution, error } = await fastify.supabase
      .from('call_tool_executions')
      .insert({
        call_log_id: id,
        tool_name: body.tool_name,
        tool_args: body.tool_args || {},
        tool_result: body.tool_result || {},
        success: body.success !== false,
        latency_ms: body.latency_ms || null,
      })
      .select()
      .single();

    if (error) {
      fastify.log.error(error, 'Failed to log tool execution');
      reply.code(500);
      return { data: null, error: 'Failed to log tool execution' };
    }

    // Update the call_logs tools_used array
    const { data: currentCall } = await fastify.supabase
      .from('call_logs')
      .select('tools_used')
      .eq('id', id)
      .single();

    const currentTools = (currentCall?.tools_used as string[]) || [];
    if (!currentTools.includes(body.tool_name)) {
      await fastify.supabase
        .from('call_logs')
        .update({ tools_used: [...currentTools, body.tool_name] })
        .eq('id', id);
    }

    // Broadcast real-time event for live dashboard updates
    await fastify.supabase.channel('call-updates').send({
      type: 'broadcast',
      event: 'tool-executed',
      payload: {
        call_log_id: id,
        tool_execution: execution,
      },
    });

    return { data: execution, error: null };
  });
}
