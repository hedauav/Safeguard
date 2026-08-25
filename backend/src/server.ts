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
await fastify.register(import('./routes/agent-identity.js'), { prefix: '/api' });
await fastify.register(import('./routes/agent-config.js'), { prefix: '/api' });
await fastify.register(import('./routes/conversation-init.js'), { prefix: '/api' });

// Tool endpoints invoked by the ElevenLabs agent
await fastify.register(import('./routes/webhook-tools.js'), { prefix: '/api' });

/**
 * Liveness plus a truthful report of which integrations are actually
 * configured, so a deployment cannot look healthy while silently having
 * every optional feature switched off.
 */
fastify.get('/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
  environment: config.nodeEnv,
  mode: features.simulated ? 'simulation' : 'live',
  features: {
    filecoin_uploads: features.filecoin && fastify.filecoin.synapse !== null
      ? true
      : features.simulated ? 'simulated' : false,
    chain_attestation: features.attestation
      ? true
      : features.simulated ? 'simulated' : false,
    eas_attestation: features.eas,
    webhook_signature_verification: features.webhookSignatureVerification,
    // 'simulated' links resolve nowhere, so operators must be able to see
    // which of the two a deployment is handing to callers.
    renewal_payment_links: features.renewalPaymentLinks ? 'razorpay' : 'simulated',
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
    tools_authentication: securityPosture.toolsAuthentication,
    cors_allowed_origins: allowedOrigins(),
    cors_allows_localhost: config.nodeEnv !== 'production',
    rate_limits_per_minute: {
      global: config.rateLimitMax,
      tools: config.rateLimitToolsMax,
      onchain: config.rateLimitOnchainMax,
    },
  },
  filecoin_unavailable_reason: fastify.filecoin.unavailableReason,
  agent_address: fastify.ethereum.account,
  // Named safety layers currently disabled for measurement. Always present so
  // a server running with one removed cannot be mistaken for a normal one —
  // and so the ablation harness can verify the flags actually reached it.
  ablations: ablations.active,
}));

// Build/version check
fastify.get('/version', async () => ({
  git_sha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || 'unknown',
  build_time: process.env.RAILWAY_DEPLOYMENT_ID || 'unknown',
}));

const start = async () => {
  try {
    await fastify.listen({ port: config.port, host: '0.0.0.0' });
    fastify.log.info(`Server running on port ${config.port}`);
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
