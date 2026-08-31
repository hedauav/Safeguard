import { FastifyInstance } from 'fastify';
import { ApiResponse, AnalyticsData } from '../types/index.js';
import { requireDashboardAuth } from '../plugins/dashboard-auth.js';

export default async function analyticsRoutes(fastify: FastifyInstance) {
  // Every route in this file is read by an adjuster looking at customer data,
  // so the guard is a scope-wide hook rather than a per-route option: a read
  // added below later is behind the password by default instead of by
  // remembering. See plugins/dashboard-auth.ts for what is deliberately not.
  fastify.addHook('preHandler', requireDashboardAuth);

  // GET /analytics — aggregated dashboard stats
  fastify.get('/analytics', async () => {
    // Run all queries in parallel
    const [
      callsResult,
      completedCallsResult,
      claimsResult,
      escalationsResult,
      pendingEscalationsResult,
      recentCallsResult,
    ] = await Promise.all([
      // Total calls + all call data for grouping
      fastify.supabase
        .from('call_logs')
        .select('direction, status', { count: 'exact' }),

      // Completed calls for avg duration
      fastify.supabase
        .from('call_logs')
        .select('duration_seconds')
        .eq('status', 'completed')
        .not('duration_seconds', 'is', null),

      // Claims with status
      fastify.supabase
        .from('claims')
        .select('status', { count: 'exact' }),

      // Total escalations
      fastify.supabase
        .from('escalations')
        .select('id', { count: 'exact', head: true }),

      // Pending escalations
      fastify.supabase
        .from('escalations')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending'),

      // Calls over last 30 days
      fastify.supabase
        .from('call_logs')
        .select('started_at')
        .gte('started_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
    ]);

    // Total calls
    const total_calls = callsResult.count ?? 0;

    // Avg duration
    const completedCalls = completedCallsResult.data ?? [];
    const avg_duration_seconds = completedCalls.length > 0
      ? Math.round(
          completedCalls.reduce((sum: number, c: any) => sum + (c.duration_seconds ?? 0), 0)
          / completedCalls.length
        )
      : 0;

    // Calls by direction
    const callRows = callsResult.data ?? [];
    const calls_by_direction: Record<string, number> = { inbound: 0, outbound: 0, webrtc: 0 };
    for (const row of callRows) {
      const dir = (row as any).direction;
      if (dir in calls_by_direction) calls_by_direction[dir]++;
    }

    // Calls by status
    const calls_by_status: Record<string, number> = { in_progress: 0, completed: 0, failed: 0 };
    for (const row of callRows) {
      const st = (row as any).status;
      if (st in calls_by_status) calls_by_status[st]++;
    }

    // Claims by status
    const claimRows = claimsResult.data ?? [];
    const claims_by_status: Record<string, number> = {};
    for (const row of claimRows) {
      const st = (row as any).status;
      claims_by_status[st] = (claims_by_status[st] ?? 0) + 1;
    }

    const total_claims = claimsResult.count ?? 0;
    const total_escalations = escalationsResult.count ?? 0;
    const pending_escalations = pendingEscalationsResult.count ?? 0;

    // Calls over time — group by date in JS
    const recentCalls = recentCallsResult.data ?? [];
    const dateCountMap: Record<string, number> = {};

    // Pre-fill last 30 days with 0
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().split('T')[0];
      dateCountMap[dateStr] = 0;
    }

    for (const row of recentCalls) {
      const dateStr = (row as any).started_at?.split('T')[0];
      if (dateStr && dateStr in dateCountMap) {
        dateCountMap[dateStr]++;
      }
    }

    const calls_over_time = Object.entries(dateCountMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    const analytics: AnalyticsData = {
      total_calls,
      avg_duration_seconds,
      calls_by_direction,
      calls_by_status,
      claims_by_status,
      total_claims,
      total_escalations,
      pending_escalations,
      calls_over_time,
    };

    const response: ApiResponse<AnalyticsData> = { data: analytics, error: null };
    return response;
  });
}
