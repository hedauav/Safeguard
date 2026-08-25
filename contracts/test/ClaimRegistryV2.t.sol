// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ClaimRegistryV2} from "../src/ClaimRegistryV2.sol";

contract ClaimRegistryV2Test is Test {
    ClaimRegistryV2 internal registry;

    address internal owner = address(this);
    address internal agent = address(0xA1);
    address internal stranger = address(0xB0B);

    /// The real evidence hash of claim CLM-2026-716458, whose Filecoin upload
    /// failed in production — the case this contract exists to keep provable.
    bytes32 internal constant EVIDENCE_HASH =
        0xf17b1f89efa292068287b44a7e74ec5d0bae7252a7da2caa12c1e9e845100671;
    string internal constant LOCATOR = "bafkreiabcdefghijklmnopqrstuvwxyz";

    event ClaimAnchored(
        uint256 indexed id, address indexed claimant, bytes32 indexed evidenceHash, string storageLocator
    );
    event StorageLocatorSet(uint256 indexed id, string storageLocator);
    event ClaimVerified(uint256 indexed id, address indexed verifier);

    function setUp() public {
        registry = new ClaimRegistryV2();
    }

    function test_DeployerIsOwner() public view {
        assertEq(registry.owner(), owner);
    }

    function test_AnchorClaimStoresEvidence() public {
        vm.prank(agent);
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, LOCATOR);

        (
            uint256 storedId,
            address claimant,
            bytes32 evidenceHash,
            string memory locator,
            uint256 timestamp,
            bool isVerified
        ) = registry.claims(id);

        assertEq(storedId, 1);
        assertEq(claimant, agent);
        assertEq(evidenceHash, EVIDENCE_HASH);
        assertEq(locator, LOCATOR);
        assertEq(timestamp, block.timestamp);
        assertFalse(isVerified);
    }

    // --- The whole point: archival can be absent and the proof still stands ---

    function test_AnchorClaimWithEmptyLocator() public {
        vm.prank(agent);
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, "");

        (,, bytes32 evidenceHash, string memory locator,,) = registry.claims(id);

        assertEq(evidenceHash, EVIDENCE_HASH);
        assertEq(locator, "");
        assertTrue(registry.exists(id));
        assertTrue(registry.isAnchored(EVIDENCE_HASH));
        assertFalse(registry.hasStorageLocator(id));
    }

    function test_EmptyLocatorClaimIsStillVerifiable() public {
        vm.prank(agent);
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, "");

        registry.verifyClaim(id);

        (,,,,, bool isVerified) = registry.claims(id);
        assertTrue(isVerified);
    }

    function test_AnchorClaimIsPermissionless() public {
        vm.prank(stranger);
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, LOCATOR);
        assertTrue(registry.exists(id));
    }

    function test_ClaimIdsIncrementFromOne() public {
        assertEq(registry.anchorClaim(EVIDENCE_HASH, LOCATOR), 1);
        assertEq(registry.anchorClaim(keccak256("b"), LOCATOR), 2);
        assertEq(registry.anchorClaim(keccak256("c"), ""), 3);
        assertEq(registry.nextClaimId(), 4);
    }

    function test_AnchorClaimEmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit ClaimAnchored(1, agent, EVIDENCE_HASH, "");
        vm.prank(agent);
        registry.anchorClaim(EVIDENCE_HASH, "");
    }

    function test_RevertWhen_EvidenceHashIsZero() public {
        vm.expectRevert(ClaimRegistryV2.EmptyEvidenceHash.selector);
        registry.anchorClaim(bytes32(0), LOCATOR);
    }

    function test_RevertWhen_EvidenceHashIsZeroEvenWithLocator() public {
        vm.expectRevert(ClaimRegistryV2.EmptyEvidenceHash.selector);
        registry.anchorClaim(bytes32(0), "");
    }

    // --- Reverse index: the question a verifier holding the bundle asks ---

    function test_IsAnchoredIsFalseForUnknownHash() public view {
        assertFalse(registry.isAnchored(EVIDENCE_HASH));
        assertEq(registry.claimIdByEvidenceHash(EVIDENCE_HASH), 0);
    }

    function test_ReanchoringKeepsTheEarliestClaimId() public {
        uint256 first = registry.anchorClaim(EVIDENCE_HASH, "");
        uint256 second = registry.anchorClaim(EVIDENCE_HASH, LOCATOR);

        assertEq(first, 1);
        assertEq(second, 2);
        assertEq(registry.claimIdByEvidenceHash(EVIDENCE_HASH), first);
    }

    // --- Late-arriving locator ---

    function test_ClaimantCanAttachLocatorLater() public {
        vm.prank(agent);
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, "");

        vm.expectEmit(true, false, false, true);
        emit StorageLocatorSet(id, LOCATOR);
        vm.prank(agent);
        registry.setStorageLocator(id, LOCATOR);

        (,,, string memory locator,,) = registry.claims(id);
        assertEq(locator, LOCATOR);
        assertTrue(registry.hasStorageLocator(id));
    }

    function test_AttachingLocatorDoesNotTouchTheEvidenceHash() public {
        vm.startPrank(agent);
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, "");
        registry.setStorageLocator(id, LOCATOR);
        vm.stopPrank();

        (,, bytes32 evidenceHash,,,) = registry.claims(id);
        assertEq(evidenceHash, EVIDENCE_HASH);
    }

    function test_RevertWhen_StrangerAttachesLocator() public {
        vm.prank(agent);
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, "");

        vm.prank(stranger);
        vm.expectRevert(ClaimRegistryV2.NotClaimant.selector);
        registry.setStorageLocator(id, LOCATOR);
    }

    function test_RevertWhen_OwnerAttachesSomeoneElsesLocator() public {
        vm.prank(agent);
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, "");

        vm.expectRevert(ClaimRegistryV2.NotClaimant.selector);
        registry.setStorageLocator(id, LOCATOR);
    }

    function test_RevertWhen_OverwritingAnExistingLocator() public {
        vm.startPrank(agent);
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, LOCATOR);

        vm.expectRevert(ClaimRegistryV2.LocatorAlreadySet.selector);
        registry.setStorageLocator(id, "bafkreisomethingelse");
        vm.stopPrank();
    }

    function test_RevertWhen_AttachingAnEmptyLocator() public {
        vm.startPrank(agent);
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, "");

        vm.expectRevert(ClaimRegistryV2.EmptyLocator.selector);
        registry.setStorageLocator(id, "");
        vm.stopPrank();
    }

    function test_RevertWhen_AttachingLocatorToUnknownClaim() public {
        vm.expectRevert(ClaimRegistryV2.ClaimDoesNotExist.selector);
        registry.setStorageLocator(999, LOCATOR);
    }

    // --- Verification is the security-critical path ---

    function test_OwnerCanVerify() public {
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, LOCATOR);

        vm.expectEmit(true, true, false, false);
        emit ClaimVerified(id, owner);
        registry.verifyClaim(id);

        (,,,,, bool isVerified) = registry.claims(id);
        assertTrue(isVerified);
    }

    function test_RevertWhen_StrangerVerifies() public {
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, LOCATOR);

        vm.prank(stranger);
        vm.expectRevert(ClaimRegistryV2.NotOwner.selector);
        registry.verifyClaim(id);

        (,,,,, bool isVerified) = registry.claims(id);
        assertFalse(isVerified);
    }

    function test_RevertWhen_ClaimantVerifiesOwnClaim() public {
        vm.prank(agent);
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, LOCATOR);

        vm.prank(agent);
        vm.expectRevert(ClaimRegistryV2.NotOwner.selector);
        registry.verifyClaim(id);
    }

    function test_RevertWhen_VerifyingUnknownClaim() public {
        vm.expectRevert(ClaimRegistryV2.ClaimDoesNotExist.selector);
        registry.verifyClaim(999);
    }

    function test_RevertWhen_VerifyingClaimZero() public {
        registry.anchorClaim(EVIDENCE_HASH, LOCATOR);

        // Ids are 1-based, so 0 must never resolve to the first claim.
        vm.expectRevert(ClaimRegistryV2.ClaimDoesNotExist.selector);
        registry.verifyClaim(0);
    }

    function test_RevertWhen_VerifyingTwice() public {
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, LOCATOR);
        registry.verifyClaim(id);

        vm.expectRevert(ClaimRegistryV2.AlreadyVerified.selector);
        registry.verifyClaim(id);
    }

    // --- Ownership ---

    function test_TransferOwnership() public {
        registry.transferOwnership(agent);
        assertEq(registry.owner(), agent);

        uint256 id = registry.anchorClaim(EVIDENCE_HASH, LOCATOR);
        vm.prank(agent);
        registry.verifyClaim(id);

        (,,,,, bool isVerified) = registry.claims(id);
        assertTrue(isVerified);
    }

    function test_RevertWhen_OldOwnerVerifiesAfterTransfer() public {
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, LOCATOR);
        registry.transferOwnership(agent);

        vm.expectRevert(ClaimRegistryV2.NotOwner.selector);
        registry.verifyClaim(id);
    }

    function test_RevertWhen_StrangerTransfersOwnership() public {
        vm.prank(stranger);
        vm.expectRevert(ClaimRegistryV2.NotOwner.selector);
        registry.transferOwnership(stranger);
    }

    function test_RevertWhen_TransferringToZeroAddress() public {
        vm.expectRevert(ClaimRegistryV2.ZeroAddress.selector);
        registry.transferOwnership(address(0));
    }

    // --- Fuzz ---

    function testFuzz_AnyNonZeroHashRoundTrips(bytes32 evidenceHash) public {
        vm.assume(evidenceHash != bytes32(0));
        uint256 id = registry.anchorClaim(evidenceHash, "");
        (,, bytes32 stored,,,) = registry.claims(id);
        assertEq(stored, evidenceHash);
        assertTrue(registry.isAnchored(evidenceHash));
    }

    function testFuzz_AnyLocatorRoundTrips(string calldata locator) public {
        uint256 id = registry.anchorClaim(EVIDENCE_HASH, locator);
        (,,, string memory stored,,) = registry.claims(id);
        assertEq(stored, locator);
    }
}
