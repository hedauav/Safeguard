import dotenv from 'dotenv';
import { DEFAULT_SETTLEMENT_AUTO_APPROVE_LIMIT } from '../services/settlement-service.js';
import {
  DEFAULT_RENEWAL_MAX_LINK_AMOUNT,
  DEFAULT_RENEWAL_TERM_MONTHS,
} from '../services/renewal-service.js';
import { DEFAULT_DEDUCTIBLE_MAX_LINK_AMOUNT } from '../services/deductible-service.js';
import { DEFAULT_GROQ_MODEL, DEFAULT_LLM_TIMEOUT_MS } from '../services/llm-provider.js';
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

/**
 * A malformed numeric setting falls back rather than becoming NaN, which
 * compares false against every threshold and would quietly remove the limit
 * it was meant to impose.
 */
function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * A rate limit of zero would block every request, so a deliberately-set 0 is
 * treated as a mistake rather than honoured.
 */
function limitEnv(name: string, fallback: number): number {
  const parsed = numberEnv(name, fallback);
  return parsed >= 1 ? Math.floor(parsed) : fallback;
}

/**
 * Where this is running decides what an *unset* secret means. In production a
 * missing secret disables the endpoint it guards; in development it falls open
 * so the server runs out of the box. Read once here so every fail-open path is
 * derived from the same answer.
 */
const isProduction = (process.env.NODE_ENV || 'development') === 'production';

// Public testnet RPCs — safe defaults so the app boots without web3 credentials.
const DEFAULT_BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
const DEFAULT_FILECOIN_CALIBRATION_RPC = 'https://api.calibration.node.glif.io/rpc/v1';

const agentPrivateKey = optionalEnv('AGENT_PRIVATE_KEY');
const claimRegistryAddress = optionalEnv('CLAIM_REGISTRY_ADDRESS');
const easContractAddress = optionalEnv('EAS_CONTRACT_ADDRESS');
const easSchemaUid = optionalEnv('EAS_SCHEMA_UID');
const easSchema = optionalEnv('EAS_SCHEMA');

// Payment links work on ordinary Razorpay keys; payouts would need RazorpayX,
// which this account does not have. Absent keys fall back to a simulated
// provider rather than disabling renewal offers outright.
const razorpayKeyId = optionalEnv('RAZORPAY_KEY_ID');
const razorpayKeySecret = optionalEnv('RAZORPAY_KEY_SECRET');

// Separate from the API keys: Razorpay's webhook secret is configured on the
// webhook itself in the dashboard, not derived from the key pair. Without it
// no delivery can be verified, and an unverified delivery is a stranger
// asserting that money arrived — so in production the endpoint refuses.
const razorpayWebhookSecret = optionalEnv('RAZORPAY_WEBHOOK_SECRET');

// The adjudication model. Absent, the service falls back to a fake provider
// whose only answer is "escalate, no model was configured" — clearly labelled
// simulated=true on every row it writes, never a fake review passed off as one.
const groqApiKey = optionalEnv('GROQ_API_KEY');

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

  /**
   * Shared secret guarding everything the voice agent calls: the tool
   * endpoints, the conversation-init lookup, and the tool-execution audit
   * write. Those endpoints spend real testnet funds, release payouts and
   * return customer PII, so in production an unset token disables them rather
   * than leaving them open. Configure the same value as a request header on
   * the ElevenLabs agent's webhook tools.
   *
   * The evaluation harness (`npm run evaluate`) calls the same endpoints and
   * needs this token in its environment too.
   */
  toolsApiToken: optionalEnv('TOOLS_API_TOKEN'),

  /** Per-IP requests a minute across the whole API. */
  rateLimitMax: limitEnv('RATE_LIMIT_MAX', 300),

  /** Per-IP requests a minute on the agent-facing routes. */
  rateLimitToolsMax: limitEnv('RATE_LIMIT_TOOLS_MAX', 120),

  /** Per-IP requests a minute on the routes that spend or move money. */
  rateLimitOnchainMax: limitEnv('RATE_LIMIT_ONCHAIN_MAX', 15),

  /**
   * Ceiling on a settlement the agent may release unaided. Anything above it
   * is refused and sent for human authorisation, so the blast radius of a
   * mistaken or manipulated payout stays bounded.
   */
  settlementAutoApproveLimit: numberEnv(
    'SETTLEMENT_AUTO_APPROVE_LIMIT',
    DEFAULT_SETTLEMENT_AUTO_APPROVE_LIMIT
  ),

  /**
   * Policy term a renewal payment link covers. Server-side only: the agent
   * never names a term, so it cannot be talked into a longer or shorter one.
   */
  renewalTermMonths: numberEnv('RENEWAL_TERM_MONTHS', DEFAULT_RENEWAL_TERM_MONTHS),

  /**
   * Ceiling on a renewal the agent may put behind a link unaided. Above it the
   * offer is refused and routed to a human, so an automated caller cannot ask
   * an unbounded amount of money of someone.
   */
  renewalMaxLinkAmount: numberEnv('RENEWAL_MAX_LINK_AMOUNT', DEFAULT_RENEWAL_MAX_LINK_AMOUNT),

  // --- Razorpay: absent keys mean simulated links, never a faked real one ---
  razorpayKeyId,
  razorpayKeySecret,
  /**
   * Shared secret Razorpay signs webhook deliveries with. Deductible captures
   * are recorded from those deliveries and a recorded capture is what makes a
   * refund possible, so an unverifiable one is refused rather than believed.
   */
  razorpayWebhookSecret,

  /**
   * Ceiling on a deductible the agent may put behind a link unaided. Above it
   * the demand is refused and routed to a human, so an automated caller cannot
   * ask an unbounded amount of money of someone.
   */
  deductibleMaxLinkAmount: numberEnv(
    'DEDUCTIBLE_MAX_LINK_AMOUNT',
    DEFAULT_DEDUCTIBLE_MAX_LINK_AMOUNT
  ),

  // --- Adjudication model: absent key means a labelled fake, never a fake review ---
  groqApiKey,
  /**
   * Not validated against a list of Groq's current models. A wrong id fails
   * the call loudly, and the adjudication escalates with the reason recorded,
   * which is better than us maintaining a list that goes stale.
   */
  groqModel: optionalEnv('GROQ_MODEL', DEFAULT_GROQ_MODEL)!,
  /**
   * How long an adjudication waits for the model. A caller is on the phone,
   * and a timeout escalates rather than guessing, so this is a bound on
   * patience and not on correctness.
   */
  adjudicationTimeoutMs: numberEnv('ADJUDICATION_TIMEOUT_MS', DEFAULT_LLM_TIMEOUT_MS),

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
  /**
   * The single browser origin allowed to make credentialed requests. Reflecting
   * whatever Origin arrived — which is what `origin: true` did — let any page
   * on the internet call this API with the visitor's cookies attached.
   */
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
  /**
   * Whether an unverifiable webhook is processed anyway. Development only:
   * in production a missing secret rejects the delivery instead, because an
   * accepted-unverified webhook writes the compliance record.
   */
  webhookUnverifiedAccepted: !process.env.ELEVENLABS_WEBHOOK_SECRET && !isProduction,
  /** Agent-facing endpoints require a shared secret when one is configured. */
  toolsAuth: Boolean(process.env.TOOLS_API_TOKEN),
  /** Same asymmetry: unauthenticated tool calls are a development convenience only. */
  toolsUnauthenticatedAccepted: !process.env.TOOLS_API_TOKEN && !isProduction,
  /** Dashboard can edit agent settings only when an admin token is set. */
  agentConfigEditing: Boolean(process.env.ADMIN_TOKEN),
  /** Renewal links are real only with Razorpay credentials; simulated otherwise. */
  renewalPaymentLinks: Boolean(razorpayKeyId && razorpayKeySecret),
  /**
   * Deductible collection and refund are real Razorpay on ordinary keys.
   * Without credentials the link is simulated and can never be paid, so no
   * capture can be recorded and no refund can follow. Claim settlement is a
   * payout and stays simulated regardless — see payout-provider.ts.
   */
  deductiblePayments: Boolean(razorpayKeyId && razorpayKeySecret),
  /** Razorpay deliveries can only be verified when the webhook secret is set. */
  razorpayWebhookSignatureVerification: Boolean(razorpayWebhookSecret),
  /**
   * Whether an unverifiable Razorpay delivery is processed anyway. Development
   * only, and matching the ElevenLabs asymmetry: in production a missing
   * secret rejects the delivery, because an accepted-unverified one records a
   * capture that a refund can later be made against.
   */
  razorpayWebhookUnverifiedAccepted: !razorpayWebhookSecret && !isProduction,
  /**
   * Whether a real model reads claim documents. Without a key the adjudication
   * endpoint still works and still runs every deterministic check — it simply
   * never reaches a verdict better than 'escalate', and says so.
   */
  adjudicationModel: Boolean(groqApiKey),
  /** Dashboard can push those settings to ElevenLabs. */
  agentConfigSync: Boolean(
    process.env.ADMIN_TOKEN && process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID
  ),
};

export type SecurityPosture = 'enforced' | 'development-bypass' | 'fail-closed';

/**
 * How each shared-secret guard is currently behaving. `fail-closed` says the
 * secret is missing in production and the endpoints behind it are refusing
 * every request — a broken deployment rather than a quietly open one, which is
 * the trade this makes deliberately. Reported at /health so the difference is
 * visible without reading logs.
 */
export const securityPosture: Record<
  'webhookSignature' | 'razorpayWebhookSignature' | 'toolsAuthentication',
  SecurityPosture
> = {
  webhookSignature: features.webhookSignatureVerification
    ? 'enforced'
    : features.webhookUnverifiedAccepted
      ? 'development-bypass'
      : 'fail-closed',
  razorpayWebhookSignature: features.razorpayWebhookSignatureVerification
    ? 'enforced'
    : features.razorpayWebhookUnverifiedAccepted
      ? 'development-bypass'
      : 'fail-closed',
  toolsAuthentication: features.toolsAuth
    ? 'enforced'
    : features.toolsUnauthenticatedAccepted
      ? 'development-bypass'
      : 'fail-closed',
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
    `webhook_signature=${securityPosture.webhookSignature}${features.webhookSignatureVerification ? '' : ' (set ELEVENLABS_WEBHOOK_SECRET)'}`,
    `tools_authentication=${securityPosture.toolsAuthentication}${features.toolsAuth ? '' : ' (set TOOLS_API_TOKEN)'}`,
    `rate_limits=global ${config.rateLimitMax}/min, tools ${config.rateLimitToolsMax}/min, on-chain ${config.rateLimitOnchainMax}/min`,
    `cors_allowed_origin=${config.frontendUrl}${isProduction ? '' : ' (+ localhost in development)'}`,
    `renewal_payment_links=${features.renewalPaymentLinks ? 'live (razorpay)' : 'simulated (set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET)'}`,
    `deductible_collection_and_refund=${features.deductiblePayments ? 'live (razorpay)' : 'simulated (set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET)'}`,
    `razorpay_webhook_signature=${securityPosture.razorpayWebhookSignature}${features.razorpayWebhookSignatureVerification ? '' : ' (set RAZORPAY_WEBHOOK_SECRET)'}`,
    'claim_settlement_payouts=simulated (payouts need RazorpayX + business KYC)',
    `claim_adjudication=${features.adjudicationModel ? `live (groq ${config.groqModel})` : 'rules-only, every claim escalates (set GROQ_API_KEY)'}`,
    `agent_config_editing=${features.agentConfigEditing ? 'enabled' : 'disabled (set ADMIN_TOKEN)'}`,
    `agent_config_sync=${features.agentConfigSync ? 'enabled' : 'disabled (set ADMIN_TOKEN + ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID)'}`,
  ];
}
