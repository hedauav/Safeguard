import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { calibration } from '@filoz/synapse-core/chains';
import type { Synapse } from '@filoz/synapse-sdk';
import { config, features } from '../config/environment.js';

export interface FilecoinPlugin {
  publicClient: PublicClient;
  /** Null whenever uploads are unavailable — callers must handle that, not assume it. */
  synapse: Synapse | null;
  /** Why synapse is null, for surfacing in logs and health checks. */
  unavailableReason: string | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    filecoin: FilecoinPlugin;
  }
}

export default fp(async function filecoinPlugin(fastify: FastifyInstance) {
  const publicClient = createPublicClient({
    chain: calibration,
    transport: http(config.filecoinRpcUrl),
  }) as PublicClient;

  let synapse: Synapse | null = null;
  let unavailableReason: string | null = null;

  if (!features.filecoin) {
    unavailableReason = 'AGENT_PRIVATE_KEY not set';
    fastify.log.warn('Filecoin uploads disabled — AGENT_PRIVATE_KEY not set');
  } else {
    try {
      const { Synapse } = await import('@filoz/synapse-sdk');
      const account = privateKeyToAccount(config.agentPrivateKey as Address);

      // Synapse.create is synchronous in synapse-sdk v0.38.
      synapse = Synapse.create({
        account,
        chain: calibration,
        transport: http(config.filecoinRpcUrl),
      });

      fastify.log.info({ account: account.address }, 'Filecoin Synapse SDK initialized');
    } catch (err) {
      synapse = null;
      unavailableReason = err instanceof Error ? err.message : String(err);
      fastify.log.error({ err }, 'Failed to initialize Filecoin Synapse SDK — uploads disabled');
    }
  }

  fastify.decorate('filecoin', { publicClient, synapse, unavailableReason });
}, {
  name: 'filecoin',
});
