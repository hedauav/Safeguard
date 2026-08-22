// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ClaimRegistry
/// @notice Tamper-evident record of insurance claim evidence.
///         Filing is permissionless — anyone may anchor a CID they are
///         accountable for, and `claimant` records who did. Verification is
///         restricted to the registry owner, because a claim anyone can mark
///         verified carries no attestation value at all.
contract ClaimRegistry {
    struct Claim {
        uint256 id;
        address claimant;
        string filecoinCid;
        uint256 timestamp;
        bool isVerified;
    }

    mapping(uint256 => Claim) public claims;
    uint256 public nextClaimId;

    address public owner;

    /// @dev Set on the first claim so ids remain 0-based while `timestamp != 0`
    ///      stays a reliable existence check.
    bool private _initialized;

    event ClaimFiled(uint256 indexed id, address indexed claimant, string filecoinCid);
    event ClaimVerified(uint256 indexed id, address indexed verifier);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ClaimDoesNotExist();
    error AlreadyVerified();
    error EmptyCid();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// @notice Anchor a Filecoin CID for a claim.
    /// @param _filecoinCid Content identifier of the evidence bundle.
    /// @return claimId The id assigned to this claim.
    function fileClaim(string calldata _filecoinCid) external returns (uint256 claimId) {
        if (bytes(_filecoinCid).length == 0) revert EmptyCid();

        claimId = nextClaimId++;

        claims[claimId] = Claim({
            id: claimId,
            claimant: msg.sender,
            filecoinCid: _filecoinCid,
            timestamp: block.timestamp,
            isVerified: false
        });

        emit ClaimFiled(claimId, msg.sender, _filecoinCid);
    }

    /// @notice Mark a claim as verified. Owner only.
    function verifyClaim(uint256 _claimId) external onlyOwner {
        Claim storage claimState = claims[_claimId];
        if (claimState.timestamp == 0) revert ClaimDoesNotExist();
        if (claimState.isVerified) revert AlreadyVerified();

        claimState.isVerified = true;
        emit ClaimVerified(_claimId, msg.sender);
    }

    /// @notice Whether a claim id has ever been filed.
    function exists(uint256 _claimId) external view returns (bool) {
        return claims[_claimId].timestamp != 0;
    }

    /// @notice Hand the registry to a new owner.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }
}
