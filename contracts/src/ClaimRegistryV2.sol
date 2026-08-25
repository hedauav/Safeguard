// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ClaimRegistryV2
/// @notice Tamper-evident record of insurance claim evidence, anchored by
///         evidence hash rather than by storage locator.
///
///         V1 anchored a Filecoin CID. That conflated two different things:
///         the *proof* that a bundle was not altered, and the *address* at
///         which its bytes can be fetched. Only the first is a security
///         primitive. A CID is derived from content, but it is still a
///         pointer: it is meaningful to a verifier only if some storage
///         provider will serve the bytes, and the caller only learns it if
///         the upload succeeded. Gating attestation on it meant an archival
///         outage silently destroyed the integrity guarantee for claims that
///         had already been hashed correctly.
///
///         So V2 splits the two. `evidenceHash` is required and immutable —
///         it is what anyone holding the bundle recomputes to prove nothing
///         changed. `storageLocator` is an opaque, optional string: a piece
///         CID today, something else tomorrow, or empty when archival was
///         unavailable. It may be filled in later, once, by the claimant who
///         anchored the record, so a recovered upload can be attached without
///         re-anchoring the proof. It can never be edited or removed, because
///         a mutable pointer next to an immutable hash would let an operator
///         redirect verifiers at bytes the hash does not cover.
///
///         Anchoring stays permissionless — anyone may anchor a hash they are
///         accountable for, and `claimant` records who did. Verification stays
///         restricted to the registry owner, because a claim anyone can mark
///         verified carries no attestation value at all.
contract ClaimRegistryV2 {
    struct Claim {
        uint256 id;
        address claimant;
        /// @dev The tamper-evidence primitive. keccak256 of the canonical
        ///      evidence bundle. Required, and never changes.
        bytes32 evidenceHash;
        /// @dev Where the bytes live. Opaque to this contract and optional —
        ///      an empty string is a valid, honest record of "not archived".
        string storageLocator;
        uint256 timestamp;
        bool isVerified;
    }

    mapping(uint256 => Claim) public claims;

    /// @notice First claim id anchored for a given evidence hash, or 0 if the
    ///         hash has never been anchored. Re-anchoring the same bundle is
    ///         allowed (retries happen) and mints a new claim, but this index
    ///         keeps pointing at the earliest anchor, which is the one that
    ///         establishes when the evidence existed.
    mapping(bytes32 => uint256) public claimIdByEvidenceHash;

    /// @dev Ids are 1-based, unlike V1's 0-based ids, so that a zero entry in
    ///      `claimIdByEvidenceHash` unambiguously means "never anchored"
    ///      rather than "claim 0". `timestamp != 0` remains the existence
    ///      check for `claims`.
    uint256 public nextClaimId = 1;

    address public owner;

    event ClaimAnchored(
        uint256 indexed id, address indexed claimant, bytes32 indexed evidenceHash, string storageLocator
    );
    event StorageLocatorSet(uint256 indexed id, string storageLocator);
    event ClaimVerified(uint256 indexed id, address indexed verifier);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotClaimant();
    error ClaimDoesNotExist();
    error AlreadyVerified();
    error EmptyEvidenceHash();
    error EmptyLocator();
    error LocatorAlreadySet();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// @notice Anchor a claim's evidence hash, with an optional storage locator.
    /// @param _evidenceHash keccak256 of the canonical evidence bundle. Required.
    /// @param _storageLocator Where the bundle is archived, or "" if it is not.
    /// @return claimId The id assigned to this claim.
    function anchorClaim(bytes32 _evidenceHash, string calldata _storageLocator)
        external
        returns (uint256 claimId)
    {
        if (_evidenceHash == bytes32(0)) revert EmptyEvidenceHash();

        claimId = nextClaimId++;

        claims[claimId] = Claim({
            id: claimId,
            claimant: msg.sender,
            evidenceHash: _evidenceHash,
            storageLocator: _storageLocator,
            timestamp: block.timestamp,
            isVerified: false
        });

        // First anchor wins; later re-anchors of the same bundle do not
        // rewrite the earliest proof of existence.
        if (claimIdByEvidenceHash[_evidenceHash] == 0) {
            claimIdByEvidenceHash[_evidenceHash] = claimId;
        }

        emit ClaimAnchored(claimId, msg.sender, _evidenceHash, _storageLocator);
    }

    /// @notice Attach a storage locator to a claim anchored without one — the
    ///         case where the hash was proven on-chain while archival was down
    ///         and the upload succeeded later. Write-once: only the claimant
    ///         who anchored the record may set it, and only while it is empty.
    function setStorageLocator(uint256 _claimId, string calldata _storageLocator) external {
        Claim storage claimState = claims[_claimId];
        if (claimState.timestamp == 0) revert ClaimDoesNotExist();
        if (msg.sender != claimState.claimant) revert NotClaimant();
        if (bytes(_storageLocator).length == 0) revert EmptyLocator();
        if (bytes(claimState.storageLocator).length != 0) revert LocatorAlreadySet();

        claimState.storageLocator = _storageLocator;
        emit StorageLocatorSet(_claimId, _storageLocator);
    }

    /// @notice Mark a claim as verified. Owner only.
    function verifyClaim(uint256 _claimId) external onlyOwner {
        Claim storage claimState = claims[_claimId];
        if (claimState.timestamp == 0) revert ClaimDoesNotExist();
        if (claimState.isVerified) revert AlreadyVerified();

        claimState.isVerified = true;
        emit ClaimVerified(_claimId, msg.sender);
    }

    /// @notice Whether a claim id has ever been anchored.
    function exists(uint256 _claimId) external view returns (bool) {
        return claims[_claimId].timestamp != 0;
    }

    /// @notice Whether this exact evidence bundle has ever been anchored.
    ///         This is the question a verifier holding the bundle asks.
    function isAnchored(bytes32 _evidenceHash) external view returns (bool) {
        return claimIdByEvidenceHash[_evidenceHash] != 0;
    }

    /// @notice Whether a claim carries a storage locator. False is a genuine
    ///         answer, not a missing one: the proof stands without it.
    function hasStorageLocator(uint256 _claimId) external view returns (bool) {
        return bytes(claims[_claimId].storageLocator).length != 0;
    }

    /// @notice Hand the registry to a new owner.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }
}
