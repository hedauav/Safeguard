# ClaimRegistry

The on-chain half of SafeGuard's evidence layer: a small registry that anchors a
hash of a claim's evidence bundle so later alteration is detectable without
trusting the insurer's database.

`src/ClaimRegistry.sol` is 89 lines. Everything else here is tooling.

## What it does

`fileClaim(string filecoinCid)` records a claim and emits `ClaimFiled`.
`verifyClaim(uint256 id)` marks one verified and is **owner-gated** — in the
original version it was callable by anyone, which defeats the point of an
attestation.

The value anchored is the keccak256 hash of the claim's canonical evidence
bundle, which in turn contains the content hash of every uploaded document. One
flipped byte in an archived photo changes its hash, changes the bundle hash, and
no longer matches what is on chain.

## Deployed

Base Sepolia: [`0x248522cdd800b2692c757f126b75b8c9f46d4f9d`](https://sepolia.basescan.org/address/0x248522cdd800b2692c757f126b75b8c9f46d4f9d)

## Tests

`test/ClaimRegistry.t.sol` — 16 cases covering the owner gate, the existence
check, custom errors, and ownership transfer.

```shell
forge install    # required: lib/ is not committed, see below
forge test
```

**`lib/` is deliberately not in version control.** It previously held a vendored
copy of `forge-std` — 79 files and ~33,000 lines — which made GitHub report this
repository as 74% Solidity and buried the few hundred lines that are actually ours.
`forge install` restores it.

## Deploying

The backend deploys this without Foundry, compiling with `solc` directly so the
ABI cannot drift from what is on chain:

```shell
cd ../backend && npm run deploy:registry
```

It needs `AGENT_PRIVATE_KEY` and a funded Base Sepolia wallet, and writes the
compiled ABI to `backend/src/abis/ClaimRegistry.json`. Set the address it prints
as `CLAIM_REGISTRY_ADDRESS`.
