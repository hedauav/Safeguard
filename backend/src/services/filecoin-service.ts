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

/**
 * Upload bytes to Filecoin via Synapse.
 *
 * Returns a discriminated result rather than throwing or fabricating a CID:
 * data that was never stored must never be recorded as stored, because a fake
 * CID would then be attested on-chain as if it were real evidence.
 *
 * With SIMULATE_BLOCKCHAIN=true and no agent wallet, returns a simulated
 * success instead — flagged, so nothing downstream can mistake it for real.
 */
async function uploadBytes(
  synapse: Synapse | null,
  data: Uint8Array
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
      error: 'Filecoin uploads are disabled: no Synapse client (set AGENT_PRIVATE_KEY).',
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
    // Common real cause: InsufficientLockupFunds — the agent wallet has no USDFC
    // payment rail funded for Warm Storage. That is a setup problem, not a bug,
    // and the caller needs to see it rather than receive a placeholder CID.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, disabled: false, error: message };
  }
}

/** Archive the canonical JSON of a claim's evidence bundle. */
export async function uploadClaimBundle(
  synapse: Synapse | null,
  bundle: unknown
): Promise<FilecoinUploadResult> {
  return uploadBytes(synapse, new TextEncoder().encode(JSON.stringify(bundle)));
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
  data: Uint8Array
): Promise<FilecoinUploadResult> {
  return uploadBytes(synapse, data);
}
