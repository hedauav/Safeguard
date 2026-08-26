import { FastifyInstance } from 'fastify';
import { requireToolsToken } from '../plugins/tools-auth.js';
import { TOOL_RATE_LIMIT } from '../plugins/rate-limit.js';
import { UNKNOWN_CALLER_VARIABLES } from '../config/agent-definition.js';

/**
 * What an unrecognised number gets: the placeholders, and nothing borrowed
 * from anyone else's record.
 *
 * Spread into a fresh object each time rather than returned directly, because
 * the imported constant is one shared object and a route handler must never
 * hand back something a later request could mutate.
 */
function unknownCaller() {
  return { dynamic_variables: { ...UNKNOWN_CALLER_VARIABLES } };
}

export default async function conversationInitRoutes(fastify: FastifyInstance) {
  /**
   * Personalisation for an inbound call: ElevenLabs sends the caller's number
   * and gets back the name, policy and recent claims to greet them with.
   *
   * Left open this answered the same question for anybody: hand it a phone
   * number, get a real customer's name, policy number and claim history. It
   * carries the same shared secret as the tool endpoints, and the same
   * per-IP ceiling so a leaked token cannot be used to walk the number space.
   *
   * The three variables are consumed by name in the system prompt — see the
   * "Who you are speaking to" section in `config/agent-definition.ts`, which
   * reads `{{customer_name}}`, `{{policy_number}}` and `{{claim_history}}` and
   * is told, in those exact strings, which values mean "we do not know". They
   * were returned and discarded for the whole of the project's first life,
   * which is why the agent used to ask a known caller to recite the policy
   * number it had already been handed.
   *
   * Every fallback below is the shared placeholder, never a guess and never a
   * blank. An empty name substituted into the greeting would have the agent
   * say "Hi, " and stop.
   */
  fastify.get<{ Querystring: { phone_number?: string } }>('/elevenlabs/conversation-init', {
    preHandler: requireToolsToken,
    config: { rateLimit: TOOL_RATE_LIMIT },
  }, async (request) => {
    const phoneNumber = request.query.phone_number?.trim();

    if (!phoneNumber) {
      return unknownCaller();
    }

    const { data: customer } = await fastify.supabase
      .from('customers')
      .select('id, full_name, phone')
      .eq('phone', phoneNumber)
      .single();

    if (!customer) {
      return unknownCaller();
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
        // A row with a blank or whitespace-only name is a row we cannot greet
        // anybody by, so it falls back to the placeholder the prompt knows to
        // treat as "no name" rather than being read out as one.
        customer_name: customer.full_name?.trim() || UNKNOWN_CALLER_VARIABLES.customer_name,
        policy_number: policy?.policy_number ?? UNKNOWN_CALLER_VARIABLES.policy_number,
        claim_history: claimHistory || UNKNOWN_CALLER_VARIABLES.claim_history,
      },
    };
  });
}
