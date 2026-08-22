import Fastify from 'fastify';
import { config, features, describeFeatures } from './config/environment.js';
import supabasePlugin from './plugins/supabase.js';
import corsPlugin from './plugins/cors.js';
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
});

// Register plugins
await fastify.register(supabasePlugin);
await fastify.register(corsPlugin);
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
  },
  filecoin_unavailable_reason: fastify.filecoin.unavailableReason,
  agent_address: fastify.ethereum.account,
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
    if (!features.webhookSignatureVerification) {
      fastify.log.warn(
        'ELEVENLABS_WEBHOOK_SECRET is unset — post-call webhooks are accepted unverified. Do not use this configuration with real data.'
      );
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
