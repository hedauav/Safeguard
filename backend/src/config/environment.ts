import dotenv from 'dotenv';
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string | null = null): string | null {
  const value = process.env[name];
  return value || fallback;
}

// Public testnet RPCs — safe defaults so the app boots without web3 credentials.
const DEFAULT_BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
const DEFAULT_FILECOIN_CALIBRATION_RPC = 'https://api.calibration.node.glif.io/rpc/v1';

const agentPrivateKey = optionalEnv('AGENT_PRIVATE_KEY');
const claimRegistryAddress = optionalEnv('CLAIM_REGISTRY_ADDRESS');
const easContractAddress = optionalEnv('EAS_CONTRACT_ADDRESS');
const easSchemaUid = optionalEnv('EAS_SCHEMA_UID');
const easSchema = optionalEnv('EAS_SCHEMA');

export const config = {
  // --- Required: the app cannot serve anything without a database ---
  supabaseUrl: requireEnv('SUPABASE_URL'),
  supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),

  // --- Optional: unused by the backend today (frontend uses its own anon key) ---
  supabaseAnonKey: optionalEnv('SUPABASE_ANON_KEY'),

  // --- ElevenLabs ---
  elevenlabsWebhookSecret: optionalEnv('ELEVENLABS_WEBHOOK_SECRET'),
  /** Only used to push agent config from the dashboard. Never used to serve calls. */
  elevenlabsApiKey: optionalEnv('ELEVENLABS_API_KEY'),
  elevenlabsAgentId: optionalEnv('ELEVENLABS_AGENT_ID'),

  /**
   * Shared secret guarding the agent-config write endpoints. Without it those
   * endpoints refuse to run: an unauthenticated write would let anyone rewrite
   * the agent's prompt and re-point its tools.
   */
  adminToken: optionalEnv('ADMIN_TOKEN'),

  // --- Web3: all optional. Absent credentials disable the feature, never fake it. ---
  baseSepoliaRpcUrl: optionalEnv('BASE_SEPOLIA_RPC_URL', DEFAULT_BASE_SEPOLIA_RPC)!,
  filecoinRpcUrl: optionalEnv('FILECOIN_RPC_URL', DEFAULT_FILECOIN_CALIBRATION_RPC)!,
  claimRegistryAddress,
  easContractAddress,
  easSchemaUid,
  easSchema,
  agentId: optionalEnv('AGENT_ID'),
  agentPrivateKey,

  // --- Server ---
  /**
   * Demo mode. Produces well-formed, clearly-labelled placeholder archival data
   * so the evidence pipeline can be demonstrated without funded testnet wallets.
   * Everything it writes is marked simulated=true and is never presented as a
   * real upload or transaction.
   */
  simulateBlockchain: process.env.SIMULATE_BLOCKCHAIN === 'true',

  port: parseInt(process.env.PORT || '3005', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
};

/**
 * Feature availability, derived from which credentials are actually present.
 * Every web3 code path checks these instead of assuming configuration exists.
 */
const simulate = process.env.SIMULATE_BLOCKCHAIN === 'true';

export const features = {
  /** Demo simulation. Never combined with real credentials — real always wins. */
  simulated: simulate && !agentPrivateKey,
  /** Filecoin uploads require a funded agent wallet. */
  filecoin: Boolean(agentPrivateKey),
  /** On-chain claim attestation requires a wallet and a deployed registry. */
  attestation: Boolean(agentPrivateKey && claimRegistryAddress),
  /** EAS attestations require the full schema triple plus a wallet. */
  eas: Boolean(agentPrivateKey && easContractAddress && easSchema && easSchemaUid),
  /** Webhook signatures can only be verified when a shared secret is configured. */
  webhookSignatureVerification: Boolean(process.env.ELEVENLABS_WEBHOOK_SECRET),
  /** Dashboard can edit agent settings only when an admin token is set. */
  agentConfigEditing: Boolean(process.env.ADMIN_TOKEN),
  /** Dashboard can push those settings to ElevenLabs. */
  agentConfigSync: Boolean(
    process.env.ADMIN_TOKEN && process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID
  ),
};

/** Human-readable startup report so operators can see what is on and what is off. */
export function describeFeatures(): string[] {
  return [
    features.simulated
      ? 'MODE=SIMULATION (archival data is placeholder, marked simulated=true)'
      : 'MODE=live',
    `filecoin_uploads=${features.filecoin ? 'enabled' : features.simulated ? 'simulated' : 'disabled (set AGENT_PRIVATE_KEY)'}`,
    `chain_attestation=${features.attestation ? 'enabled' : features.simulated ? 'simulated' : 'disabled (set AGENT_PRIVATE_KEY + CLAIM_REGISTRY_ADDRESS)'}`,
    `eas_attestation=${features.eas ? 'enabled' : 'disabled (set EAS_CONTRACT_ADDRESS + EAS_SCHEMA + EAS_SCHEMA_UID)'}`,
    `webhook_signature=${features.webhookSignatureVerification ? 'enforced' : 'NOT ENFORCED (set ELEVENLABS_WEBHOOK_SECRET)'}`,
    `agent_config_editing=${features.agentConfigEditing ? 'enabled' : 'disabled (set ADMIN_TOKEN)'}`,
    `agent_config_sync=${features.agentConfigSync ? 'enabled' : 'disabled (set ADMIN_TOKEN + ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID)'}`,
  ];
}
