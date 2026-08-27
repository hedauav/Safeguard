import type { Synapse } from '@filoz/synapse-sdk';
import { config } from '../config/environment.js';
import { cidForBytes } from './cid.js';

export interface FilecoinUploadSuccess {
  ok: true;
  /**
   * True when this result came from SIMULATE_BLOCKCHAIN demo mode: the CID is a
   * genuine content address for the bundle, but nothing was uploaded anywhere.
   * Callers must persist this flag so simulated archival stays distinguishable
   * from real archival.
   */
  simulated: boolean;
  /** PieceCID from the storage provider, or the content CID when simulated. */
  pieceCid: string;
  /** Bytes stored. */
  size: number;
  /** Warm Storage data set the piece landed in, if a copy succeeded. */
  datasetId: string | null;
  /** Direct retrieval URL from the primary copy, when the provider supplied one. */
  retrievalUrl: string | null;
  /** Non-fatal per-provider copy failures. The piece is stored, with fewer copies. */
  partialFailures: string[];
}

export interface FilecoinUploadFailure {
  ok: false;
  /** Why the upload did not happen, suitable for logs and the dashboard. */
  error: string;
  /** True when the cause is missing configuration rather than a runtime fault. */
  disabled: boolean;
}

export type FilecoinUploadResult = FilecoinUploadSuccess | FilecoinUploadFailure;

/** Used only when nobody told us why there is no client. See describeUnavailable. */
const ASSUMED_DISABLED_REASON = 'no Synapse client (set AGENT_PRIVATE_KEY)';

/**
 * Why there is no Synapse client to upload with.
 *
 * The plugin already worked this out at startup and parked it on
 * `fastify.filecoin.unavailableReason` — either "AGENT_PRIVATE_KEY not set" or
 * whatever Synapse.create threw. This function used to ignore that and assume,
 * always the same way: set AGENT_PRIVATE_KEY. On a deployment where the key IS
 * set and the SDK failed to initialise for some other reason, that sentence
 * sends the reader to check an environment variable that was never the
 * problem — and it is the sentence that gets persisted and shown, so the wrong
 * guess outlives the run that made it. Assume only when nobody has told us.
 */
function describeUnavailable(reason?: string | null): string {
  const detail = reason?.trim();
  return `Filecoin uploads are disabled: ${detail || ASSUMED_DISABLED_REASON}`;
}

/**
 * A thrown value as a sentence that is never empty.
 *
 * `error.message` is blank often enough to matter — rejections that carry
 * their detail on other properties, and non-Error throws — and a blank reason
 * recorded against a failure is indistinguishable from the NULL this whole
 * change exists to replace. The error's class name is kept in front of the
 * message because for a contract revert that name is the part worth grepping
 * for across attempts.
 */
function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    const name = error.name?.trim();
    if (message) return name && name !== 'Error' ? `${name}: ${message}` : message;
    if (name) return name;
  }
  const text = String(error).trim();
  return text || 'upload failed with a value carrying no message';
}

/**
 * Upload bytes to Filecoin via Synapse.
 *
 * Returns a discriminated result rather than throwing or fabricating a CID:
 * data that was never stored must never be recorded as stored, because a fake
 * CID would then be attested on-chain as if it were real evidence.
 *
 * With SIMULATE_BLOCKCHAIN=true and no agent wallet, returns a simulated
 * success instead — flagged, so nothing downstream can mistake it for real.
 *
 * `unavailableReason` is the plugin's account of why `synapse` is null. It is
 * optional so that a caller with nothing better to say still gets a usable
 * result, not so that callers may leave it out.
 */
async function uploadBytes(
  synapse: Synapse | null,
  data: Uint8Array,
  unavailableReason?: string | null
): Promise<FilecoinUploadResult> {
  if (!synapse) {
    if (config.simulateBlockchain) {
      return {
        ok: true,
        simulated: true,
        // A real content address for these exact bytes — verifiable by anyone
        // holding the bundle, and honest about what it is: an identifier, not
        // evidence that an upload happened.
        pieceCid: cidForBytes(data),
        size: data.byteLength,
        datasetId: null,
        retrievalUrl: null,
        partialFailures: [],
      };
    }

    return {
      ok: false,
      disabled: true,
      error: describeUnavailable(unavailableReason),
    };
  }

  try {
    const result = await synapse.storage.upload(data);

    const primary =
      result.copies.find((copy) => copy.role === 'primary') ?? result.copies[0] ?? null;

    return {
      ok: true,
      simulated: false,
      pieceCid: result.pieceCid.toString(),
      size: result.size,
      datasetId: primary ? primary.dataSetId.toString() : null,
      retrievalUrl: primary?.retrievalUrl ?? null,
      partialFailures: result.failures.map(
        (failure) => `provider ${failure.providerId} (${failure.role}): ${failure.error}`
      ),
    };
  } catch (error) {
    // Long suspected here: InsufficientLockupFunds — the agent wallet has no
    // USDFC payment rail funded for Warm Storage. Suspected, not established:
    // this message was written to a log line and nowhere else until 0022 added
    // somewhere to keep it, so nobody has yet read the sentence that would
    // confirm or kill that theory. Whatever it says, it is what the caller
    // needs, and it is not a placeholder CID.
    return { ok: false, disabled: false, error: describeThrown(error) };
  }
}

/** Archive the canonical JSON of a claim's evidence bundle. */
export async function uploadClaimBundle(
  synapse: Synapse | null,
  bundle: unknown,
  unavailableReason?: string | null
): Promise<FilecoinUploadResult> {
  return uploadBytes(
    synapse,
    new TextEncoder().encode(JSON.stringify(bundle)),
    unavailableReason
  );
}

/**
 * Archive an uploaded claim document byte-for-byte.
 *
 * Deliberately not wrapped in JSON: the archived object has to be the same
 * bytes the claimant sent, or the content hash recorded against it describes
 * something other than what was stored.
 */
export async function uploadDocumentBytes(
  synapse: Synapse | null,
  data: Uint8Array,
  unavailableReason?: string | null
): Promise<FilecoinUploadResult> {
  return uploadBytes(synapse, data, unavailableReason);
}
