// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ClaimRegistry} from "../src/ClaimRegistry.sol";

contract ClaimRegistryTest is Test {
    ClaimRegistry internal registry;

    address internal owner = address(this);
    address internal agent = address(0xA1);
    address internal stranger = address(0xB0B);

    string internal constant CID = "bafkreiabcdefghijklmnopqrstuvwxyz";

    event ClaimFiled(uint256 indexed id, address indexed claimant, string filecoinCid);
    event ClaimVerified(uint256 indexed id, address indexed verifier);

    function setUp() public {
        registry = new ClaimRegistry();
    }

    function test_DeployerIsOwner() public view {
        assertEq(registry.owner(), owner);
    }

    function test_FileClaimStoresEvidence() public {
        vm.prank(agent);
        uint256 id = registry.fileClaim(CID);

        (uint256 storedId, address claimant, string memory cid, uint256 timestamp, bool isVerified) =
            registry.claims(id);

        assertEq(storedId, 0);
        assertEq(claimant, agent);
        assertEq(cid, CID);
        assertEq(timestamp, block.timestamp);
        assertFalse(isVerified);
    }

    function test_FileClaimIsPermissionless() public {
        vm.prank(stranger);
        registry.fileClaim(CID);
        assertTrue(registry.exists(0));
    }

    function test_ClaimIdsIncrement() public {
        assertEq(registry.fileClaim(CID), 0);
        assertEq(registry.fileClaim(CID), 1);
        assertEq(registry.fileClaim(CID), 2);
        assertEq(registry.nextClaimId(), 3);
    }

    function test_FileClaimEmitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit ClaimFiled(0, agent, CID);
        vm.prank(agent);
        registry.fileClaim(CID);
    }

    function test_RevertWhen_CidIsEmpty() public {
        vm.expectRevert(ClaimRegistry.EmptyCid.selector);
        registry.fileClaim("");
    }

    // --- Verification is the security-critical path ---

    function test_OwnerCanVerify() public {
        uint256 id = registry.fileClaim(CID);

        vm.expectEmit(true, true, false, false);
        emit ClaimVerified(id, owner);
        registry.verifyClaim(id);

        (,,,, bool isVerified) = registry.claims(id);
        assertTrue(isVerified);
    }

    function test_RevertWhen_StrangerVerifies() public {
        uint256 id = registry.fileClaim(CID);

        vm.prank(stranger);
        vm.expectRevert(ClaimRegistry.NotOwner.selector);
        registry.verifyClaim(id);

        (,,,, bool isVerified) = registry.claims(id);
        assertFalse(isVerified);
    }

    function test_RevertWhen_ClaimantVerifiesOwnClaim() public {
        vm.prank(agent);
        uint256 id = registry.fileClaim(CID);

        vm.prank(agent);
        vm.expectRevert(ClaimRegistry.NotOwner.selector);
        registry.verifyClaim(id);
    }

    function test_RevertWhen_VerifyingUnknownClaim() public {
        vm.expectRevert(ClaimRegistry.ClaimDoesNotExist.selector);
        registry.verifyClaim(999);
    }

    function test_RevertWhen_VerifyingTwice() public {
        uint256 id = registry.fileClaim(CID);
        registry.verifyClaim(id);

        vm.expectRevert(ClaimRegistry.AlreadyVerified.selector);
        registry.verifyClaim(id);
    }

    // --- Ownership ---

    function test_TransferOwnership() public {
        registry.transferOwnership(agent);
        assertEq(registry.owner(), agent);

        uint256 id = registry.fileClaim(CID);
        vm.prank(agent);
        registry.verifyClaim(id);

        (,,,, bool isVerified) = registry.claims(id);
        assertTrue(isVerified);
    }

    function test_RevertWhen_OldOwnerVerifiesAfterTransfer() public {
        uint256 id = registry.fileClaim(CID);
        registry.transferOwnership(agent);

        vm.expectRevert(ClaimRegistry.NotOwner.selector);
        registry.verifyClaim(id);
    }

    function test_RevertWhen_StrangerTransfersOwnership() public {
        vm.prank(stranger);
        vm.expectRevert(ClaimRegistry.NotOwner.selector);
        registry.transferOwnership(stranger);
    }

    function test_RevertWhen_TransferringToZeroAddress() public {
        vm.expectRevert(ClaimRegistry.ZeroAddress.selector);
        registry.transferOwnership(address(0));
    }

    function testFuzz_AnyCidRoundTrips(string calldata cid) public {
        vm.assume(bytes(cid).length > 0);
        uint256 id = registry.fileClaim(cid);
        (,, string memory stored,,) = registry.claims(id);
        assertEq(stored, cid);
    }
}
