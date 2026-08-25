import { FastifyInstance } from 'fastify';
import { requireToolsToken } from '../plugins/tools-auth.js';
import { TOOL_RATE_LIMIT } from '../plugins/rate-limit.js';

export default async function conversationInitRoutes(fastify: FastifyInstance) {
  /**
   * Personalisation for an inbound call: ElevenLabs sends the caller's number
   * and gets back the name, policy and recent claims to greet them with.
   *
   * Left open this answered the same question for anybody: hand it a phone
   * number, get a real customer's name, policy number and claim history. It
   * carries the same shared secret as the tool endpoints, and the same
   * per-IP ceiling so a leaked token cannot be used to walk the number space.
   */
  fastify.get<{ Querystring: { phone_number?: string } }>('/elevenlabs/conversation-init', {
    preHandler: requireToolsToken,
    config: { rateLimit: TOOL_RATE_LIMIT },
  }, async (request) => {
    const phoneNumber = request.query.phone_number?.trim();

    if (!phoneNumber) {
      return { dynamic_variables: { customer_name: 'Customer', policy_number: 'Unknown', claim_history: 'No history' } };
    }

    const { data: customer } = await fastify.supabase
      .from('customers')
      .select('id, full_name, phone')
      .eq('phone', phoneNumber)
      .single();

    if (!customer) {
      return { dynamic_variables: { customer_name: 'Customer', policy_number: 'Unknown', claim_history: 'No history' } };
    }

    const { data: policy } = await fastify.supabase
      .from('policies')
      .select('policy_number, status')
      .eq('customer_id', customer.id)
      .order('start_date', { ascending: false })
      .limit(1)
      .single();

    const { data: claims } = await fastify.supabase
      .from('claims')
      .select('claim_number, status, claim_type, filed_at')
      .eq('customer_id', customer.id)
      .order('filed_at', { ascending: false })
      .limit(3);

    const claimHistory = (claims || [])
      .map((claim) => `${claim.claim_number} (${claim.claim_type}, ${claim.status})`)
      .join('; ');

    return {
      dynamic_variables: {
        customer_name: customer.full_name,
        policy_number: policy?.policy_number ?? 'Unknown',
        claim_history: claimHistory || 'No history',
      },
    };
  });
}
