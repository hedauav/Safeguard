# ClaimRegistry

The on-chain half of SafeGuard's evidence layer: a small registry that anchors a
hash of a claim's evidence bundle so later alteration is detectable without
trusting the insurer's database.

There are two contracts. `src/ClaimRegistry.sol` is 89 lines and
`src/ClaimRegistryV2.sol` is 168. Everything else here is tooling.

## What it does

### V1 — `ClaimRegistry`

`fileClaim(string filecoinCid)` records a claim and emits `ClaimFiled`.
`verifyClaim(uint256 id)` marks one verified and is **owner-gated** — in the
original version it was callable by anyone, which defeats the point of an
attestation.

### V2 — `ClaimRegistryV2`

`anchorClaim(bytes32 evidenceHash, string storageLocator)` records a claim and
emits `ClaimAnchored`. `verifyClaim` is owner-gated here too.

V1 anchored a Filecoin CID, which conflated two different things: the *proof*
that a bundle was not altered, and the *address* at which its bytes can be
fetched. Only the first is a security primitive. A CID is derived from content
but is still a pointer — meaningful to a verifier only if some storage provider
will serve the bytes, and known to the caller only if the upload succeeded.
Gating attestation on it meant an archival outage destroyed the integrity
guarantee for claims that had already been hashed correctly.

So V2 splits them:

* `evidenceHash` is required and immutable. It is what anyone holding the bundle
  recomputes to prove nothing changed.
* `storageLocator` is an opaque, optional string — a piece CID today, something
  else tomorrow, or empty when archival was unavailable. An empty locator is a
  valid, honest record of "hashed, not stored".
* `setStorageLocator` lets the claimant who anchored a record attach a recovered
  upload later, **once**. It can never be edited or removed: a mutable pointer
  next to an immutable hash would let an operator redirect verifiers at bytes
  the hash does not cover.
* `claimIdByEvidenceHash` indexes the first claim id anchored for a hash.
  Re-anchoring the same bundle is allowed — retries happen — and mints a new
  claim, but the index keeps pointing at the earliest anchor, which is the one
  that establishes when the evidence existed. Ids are 1-based, unlike V1's
  0-based ids, so a zero in that map unambiguously means "never anchored".

In both contracts anchoring is permissionless and records who filed.

The value anchored is the keccak256 hash of the claim's canonical evidence
bundle, which in turn contains the content hash of every uploaded document. One
flipped byte in an archived photo changes its hash, changes the bundle hash, and
no longer matches what is on chain.

## Which one the backend uses

`resolveRegistry` in `backend/src/services/ethereum-service.ts` prefers V2
whenever `CLAIM_REGISTRY_V2_ADDRESS` holds a valid address, and falls back to
`CLAIM_REGISTRY_ADDRESS` otherwise — so a deployment that has not set the new
value keeps working unchanged. On a V1 address the old dependency still holds:
that contract has no way to express "hashed, not stored", so a failed Filecoin
upload skips attestation and the pipeline records a warning naming
`CLAIM_REGISTRY_V2_ADDRESS`.

Neither address is hardcoded anywhere. Both are read from the environment.

## Deployed

Base Sepolia:

| Contract | Address |
| --- | --- |
| `ClaimRegistry` | [`0x248522cdd800b2692c757f126b75b8c9f46d4f9d`](https://sepolia.basescan.org/address/0x248522cdd800b2692c757f126b75b8c9f46d4f9d) |
| `ClaimRegistryV2` | [`0x40e6607d2d6a1cb30b019d448fd6fd9370194281`](https://sepolia.basescan.org/address/0x40e6607d2d6a1cb30b019d448fd6fd9370194281) |

## Tests

`test/ClaimRegistry.t.sol` — 16 cases covering the owner gate, the existence
check, custom errors, and ownership transfer.

`test/ClaimRegistryV2.t.sol` — 30 cases covering the same ground for V2 plus the
optional locator, the write-once `setStorageLocator` gate, and the
first-anchor-wins hash index.

```shell
forge install    # required: lib/ is not committed, see below
forge test
```

**Neither suite runs automatically.** `.github/workflows/ci.yml` has a backend
job and a frontend job and no contracts job at all, so these 46 tests run only
when somebody runs them by hand. Foundry is not needed to work on the rest of
this repository, and deployment does not use it either (see below).

**`lib/` is deliberately not in version control.** It previously held a vendored
copy of `forge-std` — 79 files and ~33,000 lines — which made GitHub report this
repository as 74% Solidity and buried the few hundred lines that are actually ours.
`forge install` restores it.

## Deploying

The backend deploys these without Foundry, compiling with `solc` directly so the
ABI cannot drift from what is on chain:

```shell
cd ../backend && npm run deploy:registry      # ClaimRegistry
cd ../backend && npm run deploy:registry:v2   # ClaimRegistryV2
```

Both need `AGENT_PRIVATE_KEY` and a funded Base Sepolia wallet, and write the
compiled ABI to `backend/src/abis/<Contract>.json`. Set the address each prints
as `CLAIM_REGISTRY_ADDRESS` and `CLAIM_REGISTRY_V2_ADDRESS` respectively.
