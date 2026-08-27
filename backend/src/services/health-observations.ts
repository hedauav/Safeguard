import type { SupabaseClient } from '@supabase/supabase-js';
import { formatEther, type Address } from 'viem';

/**
 * What /health can honestly say about a capability *after the fact*.
 *
 * A configuration flag only ever means "a credential is present". It read
 * `true` for Filecoin uploads and on-chain attestation over a code path that
 * had just failed in production, which is a health endpoint telling a reader
 * something untrue. These states describe what the last run of the pipeline
 * actually did, read back out of the rows the pipeline itself wrote.
 *
 * - `succeeded`  the capability really did the thing, most recently
 * - `simulated`  it produced clearly-labelled placeholder data, not real work
 * - `failed`     it was attempted and did not work
 * - `skipped`    it was not attempted, because an earlier step failed
 * - `never`      nothing has ever been recorded (a fresh database, not a fault)
 * - `unknown`    the record could not be read. This is the honest answer, and
 *                it is deliberately not `succeeded`.
 */
export type ObservedOutcome =
  | 'succeeded'
  | 'simulated'
  | 'failed'
  | 'skipped'
  | 'never'
  | 'unknown';

export interface CapabilityObservation {
  /** Outcome of the most recent run of this capability. */
  last_attempt: ObservedOutcome;
  /** When that run happened, ISO-8601, or null if it never has. */
  last_attempt_at: string | null;
  /** When this capability last genuinely worked (not simulated), or null. */
  last_success_at: string | null;
  /** Why the last attempt is not a plain success, when that needs saying. */
  reason: string | null;
}

export interface AttestationObservation extends CapabilityObservation {
  /** Transaction hash of the last genuine on-chain attestation, if any. */
  last_success_tx: string | null;
}

export interface CapabilityObservations {
  filecoin_uploads: CapabilityObservation;
  chain_attestation: AttestationObservation;
  /** 'database' when these came from the rows, 'unavailable' when they could not be read. */
  source: 'database' | 'unavailable';
  /** When this snapshot was taken. It can be older than the response carrying it. */
  checked_at: string;
  /** Why `source` is 'unavailable'. Null on the happy path. */
  error: string | null;
}

/**
 * Prefix that marks a reason as describing *the health probe*, not the
 * capability the reason sits next to.
 *
 * Production reported `JWT issued at future` — one PostgREST error from a
 * single database read — as the `reason` for both `filecoin_uploads` and
 * `chain_attestation`. Nothing in this service mints, signs or decodes a JWT,
 * so the string described neither capability; it was the database read
 * failing, copied verbatim into two unrelated fields. Read cold it announced
 * two broken subsystems and sent people hunting for a credential fault that
 * does not exist here. The blip self-recovered in minutes with no deploy.
 *
 * Qualifying the text is the whole fix: a reader can now tell "we could not
 * find out" apart from "the capability is broken", whatever the upstream
 * client happens to say.
 */
export const PROBE_READ_FAILURE_PREFIX = 'health probe could not read the database';

/** Every field 'unknown' — the shape returned when the database cannot be read. */
export function unknownObservations(
  reason: string,
  checkedAt = new Date().toISOString()
): CapabilityObservations {
  // Stamped onto every capability, so no single database fault can ever again
  // be mistaken for two capability faults.
  const qualified = `${PROBE_READ_FAILURE_PREFIX}: ${reason}`;
  const blank: CapabilityObservation = {
    last_attempt: 'unknown',
    last_attempt_at: null,
    last_success_at: null,
    reason: qualified,
  };
  return {
    filecoin_uploads: { ...blank },
    chain_attestation: {
      last_attempt: 'unknown',
      last_attempt_at: null,
      last_success_at: null,
      last_success_tx: null,
      reason: qualified,
    },
    source: 'unavailable',
    checked_at: checkedAt,
    // Top-level `error` sits beside `source: 'unavailable'`, which already says
    // whose fault this is, so it keeps the upstream text verbatim — that exact
    // string is what makes an incident diagnosable after the fact.
    error: reason,
  };
}

/** Upload states the pipeline writes that mean the bundle was actually stored. */
const STORED_STATUSES = ['completed', 'simulated'];

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as any).message);
  return String(err);
}

/**
 * Read what actually happened out of the tables the evidence pipeline writes.
 *
 * Deliberately reads the database rather than in-memory counters: process
 * memory resets on every deploy, so a service that has been archiving evidence
 * for weeks would report "never attempted" minutes after a restart — the same
 * misleading-by-omission this function exists to remove.
 *
 * Four single-row lookups over indexed columns, in two round trips. Throws on
 * any database error; the caller turns that into `unknown`, never into a 500.
 *
 * Retried once, immediately, before giving up. The failure that prompted this
 * was a single blip: one bad sample, self-recovered with no deploy, twelve
 * clean samples behind it. One retry absorbs that entire class of fault, and a
 * fault that survives a second attempt is worth reporting. The retry is
 * deliberately immediate rather than backed off — the caller is a healthcheck
 * on a hard timeout, so sleeping here would only convert a recoverable read
 * into a timed-out one.
 */
export async function readObservations(supabase: SupabaseClient): Promise<CapabilityObservations> {
  try {
    return await readObservationsOnce(supabase);
  } catch {
    return await readObservationsOnce(supabase);
  }
}

/** One full pass. Every database error is raised; `readObservations` retries. */
async function readObservationsOnce(supabase: SupabaseClient): Promise<CapabilityObservations> {
  const checkedAt = new Date().toISOString();

  const [lastUpload, lastStoredUpload, lastAttestation] = await Promise.all([
    // The most recent run of the evidence pipeline, whatever it did.
    supabase
      .from('filecoin_uploads')
      .select('claim_id, upload_status, attempted_at, completed_at, simulated')
      .order('attempted_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // The most recent run that genuinely stored the bundle.
    supabase
      .from('filecoin_uploads')
      .select('attempted_at, completed_at')
      .eq('simulated', false)
      .in('upload_status', STORED_STATUSES)
      .order('attempted_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // The most recent genuine on-chain attestation.
    supabase
      .from('claims')
      .select('attestation_tx_hash, attested_at')
      .eq('simulated', false)
      .not('attested_at', 'is', null)
      .order('attested_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  for (const result of [lastUpload, lastStoredUpload, lastAttestation]) {
    if (result.error) throw new Error(errorMessage(result.error));
  }

  const upload = lastUpload.data as any;

  // Attestation happens inside the same pipeline run, so the claim behind the
  // latest upload is where its outcome was written. A primary-key lookup, and
  // only issued when there is a run to ask about.
  let attestedClaim: any = null;
  if (upload?.claim_id) {
    const result = await supabase
      .from('claims')
      .select('attestation_tx_hash, attested_at, evidence_hash, simulated')
      .eq('id', upload.claim_id)
      .maybeSingle();
    if (result.error) throw new Error(errorMessage(result.error));
    attestedClaim = result.data;
  }

  const stored = lastStoredUpload.data as any;
  const filecoinSuccessAt = stored?.completed_at ?? stored?.attempted_at ?? null;

  const filecoin = observeFilecoin(upload, filecoinSuccessAt);

  const attested = lastAttestation.data as any;
  const attestation = observeAttestation(upload, attestedClaim, {
    at: attested?.attested_at ?? null,
    tx: attested?.attestation_tx_hash ?? null,
  });

  return {
    filecoin_uploads: filecoin,
    chain_attestation: attestation,
    source: 'database',
    checked_at: checkedAt,
    error: null,
  };
}

function observeFilecoin(upload: any, lastSuccessAt: string | null): CapabilityObservation {
  if (!upload) {
    return {
      last_attempt: 'never',
      last_attempt_at: null,
      last_success_at: lastSuccessAt,
      reason: 'no upload has ever been recorded',
    };
  }
  const at = upload.attempted_at ?? null;
  if (upload.upload_status === 'failed') {
    return {
      last_attempt: 'failed',
      last_attempt_at: at,
      last_success_at: lastSuccessAt,
      reason: 'the most recent upload was recorded as failed',
    };
  }
  if (upload.simulated === true || upload.upload_status === 'simulated') {
    return {
      last_attempt: 'simulated',
      last_attempt_at: at,
      last_success_at: lastSuccessAt,
      reason: 'placeholder archival data, not a real upload',
    };
  }
  if (upload.upload_status === 'completed') {
    return {
      last_attempt: 'succeeded',
      last_attempt_at: at,
      last_success_at: lastSuccessAt,
      reason: null,
    };
  }
  // 'pending', 'uploading', or anything unrecognised. Report what the row
  // actually holds rather than rounding it towards success.
  return {
    last_attempt: 'unknown',
    last_attempt_at: at,
    last_success_at: lastSuccessAt,
    reason: `upload_status is "${upload.upload_status}", which is neither a success nor a failure`,
  };
}

function observeAttestation(
  upload: any,
  claim: any,
  lastSuccess: { at: string | null; tx: string | null }
): AttestationObservation {
  const base = { last_success_at: lastSuccess.at, last_success_tx: lastSuccess.tx };
  if (!upload) {
    return {
      last_attempt: 'never',
      last_attempt_at: null,
      ...base,
      reason: 'no claim has ever reached the attestation step',
    };
  }
  const at = upload.attempted_at ?? null;
  // A recorded transaction is checked first and beats every other signal.
  // Attestation is no longer conditional on the upload succeeding — a v2
  // registry anchors the evidence hash with an empty locator — so a failed
  // upload alongside a real transaction is a genuine, reportable success.
  if (claim?.attestation_tx_hash) {
    const simulated = claim.simulated === true;
    return {
      last_attempt: simulated ? 'simulated' : 'succeeded',
      last_attempt_at: claim.attested_at ?? at,
      ...base,
      reason: simulated ? 'placeholder transaction hash, not a real transaction' : null,
    };
  }
  if (upload.upload_status === 'failed') {
    // The exact production case: both flags read green while the upload had
    // failed and nothing was ever put on chain.
    return {
      last_attempt: 'skipped',
      last_attempt_at: at,
      ...base,
      reason: 'the evidence upload failed and no attestation transaction was recorded for that run',
    };
  }
  return {
    last_attempt: 'failed',
    last_attempt_at: at,
    ...base,
    reason: 'the most recently stored bundle carries no attestation transaction',
  };
}

// --- Wallet -----------------------------------------------------------------

export interface WalletObservation {
  address: string | null;
  network: string;
  /** Balance in ETH as a decimal string, or null when it could not be read. */
  balance_eth: string | null;
  /**
   * A zero balance is a silent killer: everything stays configured and every
   * transaction fails, so it gets its own state rather than hiding in a number
   * a reader has to interpret.
   */
  balance_status: 'funded' | 'empty' | 'not-configured' | 'unknown';
  checked_at: string;
  reason: string | null;
}

/** The one method of viem's PublicClient this needs, so tests can supply it. */
export interface BalanceReader {
  getBalance(args: { address: Address }): Promise<bigint>;
}

/** Throws on RPC failure; the caller turns that into `unknownWallet`. */
export async function readWallet(
  client: BalanceReader,
  address: string | null,
  network: string
): Promise<WalletObservation> {
  const checkedAt = new Date().toISOString();
  if (!address) {
    return {
      address: null,
      network,
      balance_eth: null,
      balance_status: 'not-configured',
      checked_at: checkedAt,
      reason: 'AGENT_PRIVATE_KEY not set, so there is no agent wallet',
    };
  }
  const balance = await client.getBalance({ address: address as Address });
  const funded = balance > 0n;
  return {
    address,
    network,
    balance_eth: formatEther(balance),
    balance_status: funded ? 'funded' : 'empty',
    checked_at: checkedAt,
    reason: funded
      ? null
      : 'wallet holds no funds — on-chain attestation will fail until it is topped up',
  };
}

export function unknownWallet(
  address: string | null,
  network: string,
  reason: string,
  checkedAt = new Date().toISOString()
): WalletObservation {
  return {
    address,
    network,
    balance_eth: null,
    balance_status: 'unknown',
    checked_at: checkedAt,
    reason,
  };
}
