import { FastifyInstance, FastifyRequest } from 'fastify';
import { createPaymentLinkProvider } from '../services/payment-link-provider.js';
import { config } from '../config/environment.js';

/**
 * The refund receipt a claimant can be shown.
 *
 * ## Why this endpoint exists at all
 *
 * The deductible refund is the only real movement of money on a settled claim
 * in this deployment — the settlement payout is simulated and says so. Until
 * now that refund existed as a row in `deductible_payments` and a sentence the
 * voice agent spoke once. A policyholder had nothing to look at, which is the
 * same complaint the whole product was built after: a figure with no working
 * shown.
 *
 * ## Two sources, and the difference between them is the point
 *
 * `stored` is what this system wrote down when it asked for the refund.
 * `rail` is what Razorpay says about that refund right now.
 *
 * They are returned separately and never merged. A refund is issued `pending`
 * and settles later, so our stored status is a snapshot that goes stale; the
 * rail's answer is current. Showing one as the other would mean telling
 * somebody their money is still pending when it cleared, or worse, that it
 * cleared when it has not.
 *
 * When the rail cannot be reached, `rail` is null and `rail_error` says why.
 * The receipt still renders from `stored`, labelled as ours rather than
 * theirs. A page that fails entirely because a third party is briefly
 * unreachable is a worse answer than a page that says which half it is missing.
 *
 * ## What this is not
 *
 * It is not a Razorpay document. Razorpay processed the refund; this receipt is
 * SafeGuard's, and it prints the refund id precisely so the reader does not
 * have to take our word for it — that id resolves against Razorpay's own API.
 * Presenting it as something Razorpay issued would be a claim about provenance
 * that is not ours to make.
 */
export default async function refundReceiptRoutes(fastify: FastifyInstance) {
  for (const path of ['/claims/:claimNumber/outcome', '/claims/:claimNumber/refund-receipt'])
  fastify.get(
    path,
    async (request: FastifyRequest<{ Params: { claimNumber: string } }>, reply) => {
      const { claimNumber } = request.params;

      const { data: claim, error: claimError } = await fastify.supabase
        .from('claims')
        .select('id, claim_number, status, claimed_amount, approved_amount, payout_id, payout_simulated, payout_utr, paid_at, fault_determination, customer_id, policy_id')
        .eq('claim_number', claimNumber)
        .maybeSingle();

      if (claimError) {
        request.log.error({ err: claimError, claimNumber }, 'Refund receipt: claim lookup failed');
        reply.code(503);
        return { data: null, error: 'Claim records are unavailable right now.' };
      }

      if (!claim) {
        reply.code(404);
        return { data: null, error: `No claim found with the number ${claimNumber}.` };
      }

      // --- The decision, and the reason a reader can be shown ---------------
      //
      // A refused claim has no receipt; what it has is a reason, and until now
      // that reason existed only in an adjudication row nobody rendered. The
      // reviewer's own note comes first because a person wrote it. Where they
      // left it blank, the failing deterministic check is quoted instead — it is
      // already written in English for exactly this purpose — and failing that,
      // the model's stated inconsistency.
      const { data: adjudications } = await fastify.supabase
        .from('adjudications')
        .select('id, verdict, vetoed_by, checks, inconsistencies, model_invoked, created_at')
        .eq('claim_id', claim.id)
        .order('created_at', { ascending: false });

      const latest = (adjudications ?? [])[0] ?? null;

      const { data: reviews } = await fastify.supabase
        .from('adjudication_reviews')
        .select('decision, reviewer, note, decided_at, recommended_verdict, overrode_recommendation')
        .eq('claim_id', claim.id)
        .order('decided_at', { ascending: false });

      const review = (reviews ?? [])[0] ?? null;

      const failedCheck = Array.isArray(latest?.checks)
        ? (latest.checks as any[]).find((c) => c?.passed === false)
        : null;

      const inconsistency = Array.isArray(latest?.inconsistencies) && latest.inconsistencies.length
        ? String(latest.inconsistencies[0])
        : null;

      const decision = review
        ? {
            decision: review.decision,
            reviewer: review.reviewer,
            decided_at: review.decided_at,
            recommended_verdict: review.recommended_verdict,
            overrode_recommendation: review.overrode_recommendation,
            /** In order of who is most entitled to have written it. */
            reason: review.note || failedCheck?.detail || inconsistency || null,
            reason_source: review.note
              ? 'the reviewer'
              : failedCheck?.detail
                ? 'a deterministic check'
                : inconsistency
                  ? 'the model'
                  : null,
            failed_check: failedCheck?.id ?? latest?.vetoed_by ?? null,
            model_invoked: latest?.model_invoked ?? null,
          }
        : null;

      const { data: payments } = await fastify.supabase
        .from('deductible_payments')
        .select('provider, payment_id, payment_link_id, captured_amount_paise, captured_at, refund_id, refund_status, refund_amount_paise, refund_receipt, refund_simulated, refunded_at')
        .eq('claim_id', claim.id);

      const refunded = (payments ?? []).find((p: any) => p.refund_id);

      if (!refunded) {
        // Not an error. Most claims have no refund, and saying so plainly is
        // better than a 404 that reads as though the claim were missing.
        return {
          data: {
            claim_number: claim.claim_number,
            status: claim.status,
            decision,
            has_refund: false,
            reason:
              claim.fault_determination === 'other_party'
                ? 'No deductible refund is recorded against this claim.'
                : 'The deductible on this claim has not been waived, so no refund was issued.',
          },
          error: null,
        };
      }

      const [{ data: customer }, { data: policy }] = await Promise.all([
        fastify.supabase.from('customers').select('full_name, email').eq('id', claim.customer_id).maybeSingle(),
        fastify.supabase.from('policies').select('policy_number, policy_type, deductible').eq('id', claim.policy_id).maybeSingle(),
      ]);

      // --- What the rail says now ------------------------------------------
      let rail: Record<string, unknown> | null = null;
      let railError: string | null = null;

      if (refunded.refund_simulated) {
        railError = 'This refund was issued by the simulated rail, so there is nothing to look up.';
      } else {
        try {
          const provider = createPaymentLinkProvider({
            keyId: config.razorpayKeyId,
            keySecret: config.razorpayKeySecret,
          });
          const live = await provider.fetchRefund(refunded.refund_id);
          if (live) {
            rail = {
              id: live.id,
              status: live.status,
              amount_paise: live.amountPaise,
              currency: live.currency,
              payment_id: live.paymentId,
              receipt: live.receipt,
              created_at: live.createdAt,
            };
          } else {
            railError = 'Razorpay did not return this refund. The figures below are the ones this system recorded.';
          }
        } catch (err) {
          request.log.warn({ err, claimNumber }, 'Refund receipt: rail lookup failed');
          railError = 'Razorpay could not be reached. The figures below are the ones this system recorded.';
        }
      }

      return {
        data: {
          claim_number: claim.claim_number,
          status: claim.status,
          decision,
          has_refund: true,

          claimant: { name: customer?.full_name ?? null, email: customer?.email ?? null },
          policy: {
            number: policy?.policy_number ?? null,
            type: policy?.policy_type ?? null,
            deductible: policy?.deductible ?? null,
          },

          /** What this system wrote down when the refund was asked for. */
          stored: {
            provider: refunded.provider,
            refund_id: refunded.refund_id,
            status: refunded.refund_status,
            amount_paise: refunded.refund_amount_paise,
            receipt: refunded.refund_receipt,
            refunded_at: refunded.refunded_at,
            simulated: refunded.refund_simulated,
            against_payment_id: refunded.payment_id,
            captured_amount_paise: refunded.captured_amount_paise,
            captured_at: refunded.captured_at,
          },

          /** What the rail says about it right now. Null when unavailable. */
          rail,
          rail_error: railError,

          /**
           * The settlement is disclosed alongside deliberately. On this
           * deployment the payout is simulated, which makes this refund the
           * only real money on the claim — a receipt that showed the refund
           * without saying so would imply the settlement had been paid too.
           */
          settlement: {
            approved_amount: claim.approved_amount,
            payout_id: claim.payout_id,
            payout_reference: claim.payout_utr,
            paid_at: claim.paid_at,
            simulated: claim.payout_simulated,
            disclosure: claim.payout_simulated
              ? 'The settlement payout on this claim was simulated, not transferred. This deductible refund is the only money that actually moved.'
              : null,
          },
        },
        error: null,
      };
    }
  );
}
