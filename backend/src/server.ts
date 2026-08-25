import Fastify from 'fastify';
import { config, features, describeFeatures, securityPosture } from './config/environment.js';
import { ablations } from './config/ablation.js';
import supabasePlugin from './plugins/supabase.js';
import corsPlugin from './plugins/cors.js';
import rateLimitPlugin from './plugins/rate-limit.js';
import { allowedOrigins } from './plugins/cors.js';
import ethereumPlugin from './plugins/ethereum.js';
import filecoinPlugin from './plugins/filecoin.js';
import rawBody from 'fastify-raw-body';
import {
  readObservations,
  readWallet,
  unknownObservations,
  unknownWallet,
} from './services/health-observations.js';
import { createCachedProbe } from './services/probe-cache.js';

const fastify = Fastify({
  logger: {
    transport: config.nodeEnv === 'development' ? {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' }
    } : undefined,
  },
  // The deployment sits behind a platform proxy that terminates TLS and sets
  // X-Forwarded-For. Without this every caller shares the proxy's address, so
  // one abusive client would exhaust the rate limit for everybody.
  trustProxy: true,
});

// Register plugins
await fastify.register(supabasePlugin);
await fastify.register(corsPlugin);
// Before the routes, so its per-route `config.rateLimit` is available to them.
await fastify.register(rateLimitPlugin);
await fastify.register(ethereumPlugin);
await fastify.register(filecoinPlugin);
await fastify.register(rawBody, {
  field: 'rawBody',
  global: false,
  encoding: false,
  runFirst: true,
});

// Dashboard + agent APIs
await fastify.register(import('./routes/claims.js'), { prefix: '/api' });
// Encapsulated so the multipart content-type parser it registers stays scoped
// to the upload routes and does not change how any other route reads a body.
await fastify.register(import('./routes/claim-documents.js'), { prefix: '/api' });
await fastify.register(import('./routes/calls.js'), { prefix: '/api' });
await fastify.register(import('./routes/analytics.js'), { prefix: '/api' });
await fastify.register(import('./routes/escalations.js'), { prefix: '/api' });
await fastify.register(import('./routes/webhooks.js'), { prefix: '/api' });
// Razorpay's payment webhook. Separate from the agent-facing tools below and
// deliberately outside their token guard: its authentication is the signature
// Razorpay puts on the raw body, and a shared header token would add nothing.
await fastify.register(import('./routes/razorpay-webhook.js'), { prefix: '/api' });
await fastify.register(import('./routes/agent-identity.js'), { prefix: '/api' });
await fastify.register(import('./routes/agent-config.js'), { prefix: '/api' });
// The human review queue: reads adjudication recommendations, and records the
// decision a person makes about one. Writes are behind ADMIN_TOKEN.
await fastify.register(import('./routes/adjudication-review.js'), { prefix: '/api' });
await fastify.register(import('./routes/conversation-init.js'), { prefix: '/api' });

// Tool endpoints invoked by the ElevenLabs agent
await fastify.register(import('./routes/webhook-tools.js'), { prefix: '/api' });
// The deductible money loop: collection in, waiver refund out. Its own file so
// the routes that move real money through Razorpay are not mixed in with the
// lookups, and so the webhook above stays clear of the tools token guard.
await fastify.register(import('./routes/deductible-tools.js'), { prefix: '/api' });

/** Base Sepolia is the only chain the agent transacts on. */
const CHAIN_NETWORK = 'base-sepolia';

const OBSERVATION_TTL_MS = 30_000;
const WALLET_TTL_MS = 60_000;

/**
 * What the evidence pipeline last actually did, read from the rows it writes.
 *
 * Cached, single-flighted and stale-while-revalidate, so the constant
 * healthcheck polling costs at most one pair of single-row lookups every
 * 30 seconds and, after the first call, no request waits on the database at
 * all. A failed or slow lookup resolves to an all-`unknown` snapshot rather
 * than rejecting — /health must answer 200 with half the truth, because a 500
 * here has Railway restart a service that is working.
 */
const observations = createCachedProbe(
  () => readObservations(fastify.supabase),
  (reason) => unknownObservations(reason),
  {
    ttlMs: OBSERVATION_TTL_MS,
    errorTtlMs: 5_000,
    timeoutMs: 2_000,
    maxStaleMs: 5 * 60_000,
  }
);

/**
 * Agent wallet balance. Attestation needs a funded wallet and a drained one
 * fails silently with every flag still green, so the balance is reported
 * beside the address. Same cache and same fail-soft rule as above; an RPC
 * outage yields `unknown`, never an error.
 */
const wallet = createCachedProbe(
  () => readWallet(fastify.ethereum.publicClient, fastify.ethereum.account, CHAIN_NETWORK),
  (reason) => unknownWallet(fastify.ethereum.account, CHAIN_NETWORK, reason),
  {
    ttlMs: WALLET_TTL_MS,
    errorTtlMs: 10_000,
    timeoutMs: 2_000,
    maxStaleMs: 10 * 60_000,
  }
);

/**
 * Liveness, plus — for each capability that can fail — what is configured and
 * what was last observed to happen, side by side.
 *
 * The two halves are reported separately on purpose. A configuration flag only
 * ever means "a credential is present"; it read `true` for Filecoin uploads and
 * on-chain attestation over a path that had just failed in production. Anything
 * under `configured` comes from the environment, anything under `last_attempt`
 * comes from what the pipeline recorded, and neither is allowed to stand in for
 * the other.
 */
fastify.get('/health', async () => {
  const [observed, agentWallet] = await Promise.all([observations.get(), wallet.get()]);

  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    mode: features.simulated ? 'simulation' : 'live',
    features: {
      filecoin_uploads: {
        configured: features.filecoin && fastify.filecoin.synapse !== null
          ? true
          : features.simulated ? 'simulated' : false,
        unavailable_reason: fastify.filecoin.unavailableReason,
        ...observed.filecoin_uploads,
      },
      chain_attestation: {
        configured: features.attestation
          ? true
          : features.simulated ? 'simulated' : false,
        ...observed.chain_attestation,
      },
      eas_attestation: features.eas,
      webhook_signature_verification: features.webhookSignatureVerification,
      // 'simulated' links resolve nowhere, so operators must be able to see
      // which of the two a deployment is handing to callers.
      renewal_payment_links: features.renewalPaymentLinks ? 'razorpay' : 'simulated',
      /**
       * The one loop where real money moves in both directions. Collection and
       * the waiver refund are real Razorpay on ordinary keys; the settlement of
       * the claim itself is a payout and stays simulated, because payouts need
       * RazorpayX and business KYC. Reported as two separate lines so the
       * distinction cannot be read past.
       */
      deductible_collection_and_refund: features.deductiblePayments ? 'razorpay' : 'simulated',
      claim_settlement_payouts: 'simulated',
    },
    /**
     * Provenance for the observed half above. `source: 'unavailable'` means the
     * lookup failed and every `last_attempt` reads 'unknown' — the endpoint still
     * returns 200 and still reports configuration truthfully.
     */
    observed: {
      source: observed.source,
      checked_at: observed.checked_at,
      cache_ttl_seconds: OBSERVATION_TTL_MS / 1000,
      error: observed.error,
    },
    /**
     * Which guards are actually enforcing. 'enforced' means the secret is set;
     * 'development-bypass' means it is missing and requests are let through,
     * which only ever happens outside production; 'fail-closed' means it is
     * missing in production and the endpoints behind it are refusing everything.
     * Reported here so the difference between the three is visible from outside.
     */
    security: {
      webhook_signature: securityPosture.webhookSignature,
      razorpay_webhook_signature: securityPosture.razorpayWebhookSignature,
      tools_authentication: securityPosture.toolsAuthentication,
      cors_allowed_origins: allowedOrigins(),
      cors_allows_localhost: config.nodeEnv !== 'production',
      rate_limits_per_minute: {
        global: config.rateLimitMax,
        tools: config.rateLimitToolsMax,
        onchain: config.rateLimitOnchainMax,
      },
    },
    /**
     * The wallet every attestation is paid for from. `balance_status: 'empty'`
     * is the silent killer this exists to make loud: nothing about the
     * configuration changes when the funds run out, and every transaction fails.
     */
    wallet: agentWallet,
    filecoin_unavailable_reason: fastify.filecoin.unavailableReason,
    agent_address: fastify.ethereum.account,
    // Named safety layers currently disabled for measurement. Always present so
    // a server running with one removed cannot be mistaken for a normal one —
    // and so the ablation harness can verify the flags actually reached it.
    ablations: ablations.active,
  };
});

// Build/version check
fastify.get('/version', async () => ({
  git_sha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || 'unknown',
  build_time: process.env.RAILWAY_DEPLOYMENT_ID || 'unknown',
}));

const start = async () => {
  try {
    await fastify.listen({ port: config.port, host: '0.0.0.0' });
    fastify.log.info(`Server running on port ${config.port}`);
    // Fill the health caches before the platform's first probe arrives, so the
    // very first /health is answered from memory rather than waiting on a
    // database and an RPC. Fire-and-forget: neither can fail the boot.
    observations.warm();
    wallet.warm();
    for (const line of describeFeatures()) {
      fastify.log.info(`  ${line}`);
    }
    if (securityPosture.webhookSignature === 'development-bypass') {
      fastify.log.warn(
        'ELEVENLABS_WEBHOOK_SECRET is unset — post-call webhooks are accepted unverified. Do not use this configuration with real data.'
      );
    }
    if (securityPosture.webhookSignature === 'fail-closed') {
      fastify.log.error(
        'ELEVENLABS_WEBHOOK_SECRET is unset in production — post-call webhooks are being REFUSED. Set it or no call will be recorded.'
      );
    }
    if (securityPosture.razorpayWebhookSignature === 'development-bypass') {
      fastify.log.warn(
        'RAZORPAY_WEBHOOK_SECRET is unset — deductible payment webhooks are accepted unverified. A stranger could assert that a deductible was paid, and a refund can be made against a recorded capture. Do not use this configuration with real data.'
      );
    }
    if (securityPosture.razorpayWebhookSignature === 'fail-closed') {
      fastify.log.error(
        'RAZORPAY_WEBHOOK_SECRET is unset in production — Razorpay webhooks are being REFUSED. Set it or no deductible payment will ever be recorded, and no deductible can be refunded.'
      );
    }
    if (securityPosture.toolsAuthentication === 'development-bypass') {
      fastify.log.warn(
        'TOOLS_API_TOKEN is unset — tool endpoints, conversation-init and the tool-execution audit write are open. These spend on-chain funds and return customer PII; do not use this configuration with real data.'
      );
    }
    if (securityPosture.toolsAuthentication === 'fail-closed') {
      fastify.log.error(
        'TOOLS_API_TOKEN is unset in production — every agent-facing endpoint is REFUSING requests. Set it and configure the same value as a request header on the ElevenLabs agent.'
      );
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
