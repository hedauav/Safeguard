import type { FastifyInstance } from 'fastify';
import type { Address, Hash, Hex } from 'viem';
import { config, features } from '../config/environment.js';
import { buildEvidenceBundle } from './attestation-service.js';
import { uploadClaimBundle, type FilecoinUploadResult } from './filecoin-service.js';
import { attestClaim, anchorEvidence, resolveRegistry } from './ethereum-service.js';
import { documentEvidenceEntries } from './claim-documents-service.js';
import { createEasClient, createEasSigner, issueAttestation } from './eas-service.js';
import { keccak256, toBytes } from 'viem';

export interface EvidencePipelineResult {
  /** keccak256 of the canonical evidence bundle. Always produced. */
  evidenceHash: string;
  /** Outcome of the Filecoin upload — may be a failure. */
  filecoin: FilecoinUploadResult;
  /** Base Sepolia ClaimRegistry tx, or null if attestation was skipped or failed. */
  attestationTxHash: string | null;
  /** EAS attestation UID, or null if skipped or failed. */
  easUid: string | null;
  /** Non-fatal problems worth surfacing to operators. */
  warnings: string[];
  /** True when archival data came from demo simulation rather than real infrastructure. */
  simulated: boolean;
}

interface RunOptions {
  claimId: string;
  callLogId?: string | null;
  /** Documents to record on the claim in addition to what is already stored. */
  addDocuments?: string[];
  /** Extra fields to fold into the evidence bundle (e.g. an attached file). */
  metadata?: Record<string, unknown>;
}

/**
 * Build, store, and attest a claim's evidence bundle.
 *
 * Every step degrades independently: a Filecoin outage must not lose the
 * evidence hash, and a failed upload must never be attested on-chain as
 * though the data were stored. Whatever genuinely happened is what gets
 * written to the database.
 */
export async function runEvidencePipeline(
  fastify: FastifyInstance,
  options: RunOptions
): Promise<EvidencePipelineResult | null> {
  const warnings: string[] = [];

  const { data: claim } = await fastify.supabase
    .from('claims')
    .select('id, claim_number, policy_id, customer_id, claim_type, incident_date, incident_description, documents_received, filed_at')
    .eq('id', options.claimId)
    .single();

  if (!claim) {
    fastify.log.warn({ claimId: options.claimId }, 'Evidence pipeline: claim not found');
    return null;
  }

  const { data: policy } = await fastify.supabase
    .from('policies')
    .select('policy_number')
    .eq('id', claim.policy_id)
    .single();

  const documents = options.addDocuments?.length
    ? Array.from(new Set([...(claim.documents_received ?? []), ...options.addDocuments]))
    : (claim.documents_received ?? []);

  // Every file uploaded against this claim, by type and by the keccak256 of
  // its actual bytes. Folding these into the bundle is what makes the anchored
  // bundle hash transitively commit to the documents themselves: alter one
  // archived photo and its content hash changes, so the bundle no longer
  // hashes to the value attested on Base Sepolia, and the tampering is
  // detectable by anyone holding the bundle — no trust in this database
  // required. `documents` above is only a list of names and proves nothing.
  const { data: documentRows, error: documentError } = await fastify.supabase
    .from('claim_documents')
    .select('document_type, content_hash, cid')
    .eq('claim_id', claim.id);

  if (documentError) {
    // Anchoring a bundle that silently omits documents would attest to less
    // evidence than the claim actually holds, so say so rather than let the
    // gap pass unnoticed.
    warnings.push(`documents: ${documentError.message}`);
    fastify.log.warn(
      { claimId: claim.id, reason: documentError.message },
      'Evidence pipeline: claim documents could not be read'
    );
  }

  const documentHashes = documentEvidenceEntries(documentRows ?? []);

  const { bundle, hash } = buildEvidenceBundle({
    claim_id: claim.id,
    claim_number: claim.claim_number,
    claim_type: claim.claim_type,
    policy_number: policy?.policy_number ?? '',
    customer_id: claim.customer_id,
    incident_date: claim.incident_date,
    incident_description: claim.incident_description,
    documents,
    filed_at: claim.filed_at,
    ...(options.callLogId ? { call_log_id: options.callLogId } : {}),
    ...(options.metadata ? { metadata: options.metadata as any } : {}),
    // Omitted entirely when there are none, so hashes already anchored for
    // claims without uploads stay reproducible.
    ...(documentHashes.length ? { document_hashes: documentHashes } : {}),
  });

  // The hash is the tamper-evidence primitive and is recorded unconditionally,
  // independent of whether decentralized storage is reachable.
  await fastify.supabase.from('evidence_bundles').insert({
    claim_id: claim.id,
    bundle_json: bundle as any,
    bundle_hash: hash,
    // Only documents that were genuinely archived contribute a CID. An
    // unarchived document is still in the bundle by hash; it just has no
    // storage location, and inventing one is the bug this pipeline exists to
    // not have.
    photo_cids: (documentRows ?? []).map((row: any) => row.cid).filter(Boolean),
  });

  const filecoin = await uploadClaimBundle(fastify.filecoin.synapse, bundle);

  if (!filecoin.ok) {
    warnings.push(`filecoin: ${filecoin.error}`);
    fastify.log.warn(
      { claimId: claim.id, reason: filecoin.error, disabled: filecoin.disabled },
      'Evidence pipeline: Filecoin upload unavailable'
    );
  } else if (filecoin.partialFailures.length > 0) {
    warnings.push(...filecoin.partialFailures.map((f) => `filecoin copy: ${f}`));
  }

  await fastify.supabase.from('filecoin_uploads').insert({
    claim_id: claim.id,
    root_cid: filecoin.ok ? filecoin.pieceCid : null,
    piece_cid: filecoin.ok ? filecoin.pieceCid : null,
    dataset_id: filecoin.ok ? filecoin.datasetId : null,
    upload_status: filecoin.ok ? (filecoin.simulated ? 'simulated' : 'completed') : 'failed',
    pdp_status: filecoin.ok ? (filecoin.simulated ? 'simulated' : 'pending') : null,
    simulated: filecoin.ok ? filecoin.simulated : false,
    attempted_at: new Date().toISOString(),
    completed_at: filecoin.ok ? new Date().toISOString() : null,
  });

  // Attestation is gated on having an evidence hash, not on having archived
  // the bytes. The hash is the tamper-evidence primitive; the CID is only a
  // locator saying where the bytes live. Losing the ability to *fetch* a
  // document must not destroy the ability to *prove it unchanged*, so an
  // archival outage no longer silently costs us the integrity guarantee.
  //
  // ClaimRegistryV2 anchors the hash and takes the locator as an optional
  // string, so it can attest with archival down. V1 could only anchor a CID,
  // so on a v1 address the old dependency still holds — that contract has no
  // way to express "hashed, not stored".
  const registry = resolveRegistry(config.claimRegistryAddress);
  const canWrite = Boolean(
    features.attestation && registry && fastify.ethereum.walletClient && fastify.ethereum.account
  );

  let attestationTxHash: string | null = null;
  if (canWrite && registry && fastify.ethereum.walletClient) {
    try {
      if (registry.version === 2) {
        attestationTxHash = await anchorEvidence(
          fastify.ethereum.publicClient,
          fastify.ethereum.walletClient,
          registry.address,
          hash as Hex,
          // An empty locator is an honest record of "not archived", which is
          // exactly what happened when the upload failed. Inventing a CID here
          // is the bug this pipeline exists to not have.
          filecoin.ok ? filecoin.pieceCid : ''
        );
      } else if (filecoin.ok) {
        attestationTxHash = await attestClaim(
          fastify.ethereum.publicClient,
          fastify.ethereum.walletClient,
          registry.address,
          filecoin.pieceCid
        );
      } else {
        warnings.push(
          'attestation: skipped — ClaimRegistry v1 can only anchor a CID and archival failed (set CLAIM_REGISTRY_V2_ADDRESS)'
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`attestation: ${message}`);
      fastify.log.error({ err, claimId: claim.id }, 'Evidence pipeline: on-chain attestation failed');
    }
  } else if (filecoin.ok && filecoin.simulated) {
    // Deterministic placeholder so the dashboard has something to render. It is
    // not a transaction and will not resolve on any explorer; the simulated
    // flag on the row is what tells the reader that.
    attestationTxHash = keccak256(toBytes(`simulated-attestation:${hash}`));
    warnings.push('attestation: SIMULATED — not a real transaction');
  } else if (!features.attestation) {
    // No longer conditioned on a successful upload: attestation is now
    // independent of archival, so its absence is worth reporting either way.
    warnings.push('attestation: disabled (set AGENT_PRIVATE_KEY + CLAIM_REGISTRY_ADDRESS)');
  } else if (!registry) {
    warnings.push('attestation: no usable registry address configured');
  }

  let easUid: string | null = null;
  if (features.eas) {
    try {
      const eas = await createEasClient(config.easContractAddress as Address);
      const signer = createEasSigner(config.agentPrivateKey!, config.baseSepoliaRpcUrl);
      easUid = await issueAttestation(eas, signer, {
        recipient: fastify.ethereum.account as Address,
        schema: config.easSchema!,
        schemaUid: config.easSchemaUid as Hash,
        data: [
          { name: 'claim_id', type: 'string', value: claim.id },
          { name: 'claim_number', type: 'string', value: claim.claim_number },
          { name: 'evidence_hash', type: 'string', value: hash },
        ],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`eas: ${message}`);
      fastify.log.error({ err, claimId: claim.id }, 'Evidence pipeline: EAS attestation failed');
    }
  }

  // Only write values that reflect something that actually happened.
  await fastify.supabase
    .from('claims')
    .update({
      ...(options.addDocuments?.length ? { documents_received: documents } : {}),
      evidence_hash: hash,
      filecoin_cid: filecoin.ok ? filecoin.pieceCid : null,
      piece_cid: filecoin.ok ? filecoin.pieceCid : null,
      dataset_id: filecoin.ok ? filecoin.datasetId : null,
      pdp_proof_status: filecoin.ok ? (filecoin.simulated ? 'simulated' : 'pending') : null,
      simulated: filecoin.ok ? filecoin.simulated : false,
      attestation_tx_hash: attestationTxHash,
      eas_uid: easUid,
      agent_id: config.agentId ? Number(config.agentId) : null,
      attested_at: attestationTxHash ? new Date().toISOString() : null,
    })
    .eq('id', claim.id);

  fastify.log.info(
    {
      claimId: claim.id,
      stored: filecoin.ok,
      simulated: filecoin.ok && filecoin.simulated,
      cid: filecoin.ok ? filecoin.pieceCid : null,
      registry: registry ? `v${registry.version} ${registry.address}` : null,
      attestationTxHash,
      easUid,
      warnings,
    },
    'Evidence pipeline completed'
  );

  return {
    evidenceHash: hash,
    filecoin,
    attestationTxHash,
    easUid,
    warnings,
    simulated: filecoin.ok && filecoin.simulated,
  };
}
