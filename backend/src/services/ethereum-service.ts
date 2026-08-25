import { getContract, isAddress, type Address, type Hash, type Hex, type PublicClient, type WalletClient, type Transport, type Chain, type Account } from 'viem';
import ClaimRegistryAbi from '../abis/ClaimRegistry.json' with { type: 'json' };
import ClaimRegistryV2Abi from '../abis/ClaimRegistryV2.json' with { type: 'json' };

/** Which registry a write should go to, and therefore which call shape to use. */
export interface RegistryTarget {
  address: Address;
  /** 1 anchors a Filecoin CID; 2 anchors the evidence hash. */
  version: 1 | 2;
}

/**
 * Pick the registry to write to.
 *
 * V2 is preferred whenever it is configured, because it anchors the evidence
 * hash and treats the storage locator as optional — so a Filecoin outage can
 * no longer cost us the on-chain integrity guarantee. V1 stays supported
 * because it is already deployed and CLAIM_REGISTRY_ADDRESS must keep working
 * for anyone who has not set the new value yet.
 *
 * The V2 address is read from the process environment rather than the shared
 * config object so that `features.attestation`, which is derived from
 * CLAIM_REGISTRY_ADDRESS, keeps its existing meaning.
 */
export function resolveRegistry(v1Address?: string | null): RegistryTarget | null {
  const v2 = process.env.CLAIM_REGISTRY_V2_ADDRESS?.trim();
  if (v2 && isAddress(v2)) return { address: v2 as Address, version: 2 };

  const v1 = v1Address?.trim();
  if (v1 && isAddress(v1)) return { address: v1 as Address, version: 1 };

  return null;
}

/**
 * Record a claim's evidence CID in the on-chain ClaimRegistry (v1).
 * Throws on revert or timeout — callers decide how to degrade.
 */
export async function attestClaim(
  publicClient: PublicClient,
  walletClient: WalletClient<Transport, Chain, Account>,
  claimRegistryAddress: Address,
  filecoinCid: string
): Promise<Hash> {
  const contract = getContract({
    address: claimRegistryAddress,
    abi: ClaimRegistryAbi.abi,
    client: { public: publicClient, wallet: walletClient },
  });

  const hash = await contract.write.fileClaim([filecoinCid], { account: walletClient.account });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Anchor a claim's evidence hash in ClaimRegistryV2.
 *
 * `storageLocator` is deliberately allowed to be empty: the hash is what
 * proves the bundle was not altered, and losing the ability to *fetch* a
 * document must not destroy the ability to *prove it unchanged*. Pass the
 * piece CID when archival succeeded and '' when it did not — an empty locator
 * is an honest record, not a failure.
 *
 * Throws on revert or timeout — callers decide how to degrade.
 */
export async function anchorEvidence(
  publicClient: PublicClient,
  walletClient: WalletClient<Transport, Chain, Account>,
  claimRegistryAddress: Address,
  evidenceHash: Hex,
  storageLocator: string
): Promise<Hash> {
  const contract = getContract({
    address: claimRegistryAddress,
    abi: ClaimRegistryV2Abi.abi,
    client: { public: publicClient, wallet: walletClient },
  });

  const hash = await contract.write.anchorClaim([evidenceHash, storageLocator], {
    account: walletClient.account,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
