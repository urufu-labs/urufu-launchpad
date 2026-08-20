// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";
import {FeeSplitter} from "src/router/FeeSplitter.sol";
import {UruDepositSink} from "src/router/UruDepositSink.sol";
import {LoyaltyOracle} from "src/flywheel/LoyaltyOracle.sol";
import {NftMintModule} from "src/nft/NftMintModule.sol";
import {NftWhitelistModule} from "src/nft/NftWhitelistModule.sol";
import {NftLaunchFactory, IERC20, ILoyaltyOracleLike} from "src/nft/NftLaunchFactory.sol";

/// Stub URU ERC-20 with public mint for tests.
contract MockUru is ERC20 {
    function name() public pure override returns (string memory) {
        return "URU";
    }

    function symbol() public pure override returns (string memory) {
        return "URU";
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// Reverting-receive contract used to prove the launcher's revert doesn't
/// brick mints (pull pattern) but does brick their withdraw().
contract RevertingReceiver {
    error Rejected();
    receive() external payable {
        revert Rejected();
    }
    // Approve helper to let this contract launch collections.
    function approveUru(address uru, address spender, uint256 amt) external {
        MockUru(uru).approve(spender, amt);
    }
    function callWithdraw(address mintModule) external {
        (bool ok,) = mintModule.call(abi.encodeWithSignature("withdraw()"));
        require(ok, "withdraw ok?");
    }
}

/// Fake FeeSplitter that tries to reenter the mint module on receive.
/// Verifies the reentrancy guard actually stops it.
contract ReentrantSplitter {
    error Reenter();
    NftMintModule public target;
    bytes public payload;

    function arm(NftMintModule target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    receive() external payable {
        // Attempt to reenter mint() via arbitrary payload; if the guard
        // is missing this reverts inside NftMintModule with a different
        // error (e.g. duplicate proof) but the guard should fire first.
        (bool ok,) = address(target).call{value: 0}(payload);
        // If the reentered call returns ok, we've broken the guard.
        // If it reverts, that's the desired outcome — but we don't want
        // the OUTER mint to fail. So we swallow the failure here.
        ok;
    }
}

/// Fake FeeSplitter that just reverts on receive to test stuck-balance path.
contract RevertOnReceiveSplitter {
    error Nope();
    receive() external payable {
        revert Nope();
    }
}

/// Test harness — deploys the whole NFT stack against a real FeeSplitter,
/// LoyaltyOracle, URU token, and UruDepositSink. Everything the audit
/// tests need to run in one place; individual test files inherit.
abstract contract NftHarness is Test {
    address internal owner = makeAddr("owner");
    address internal launcher = makeAddr("launcher");
    address internal buyer1 = makeAddr("buyer1");
    address internal buyer2 = makeAddr("buyer2");
    address internal buyer3 = makeAddr("buyer3");
    address internal treasury = makeAddr("treasury");
    address internal buybackSink = makeAddr("buybackSink");
    address internal nftSink = makeAddr("nftSink");

    // Attestation signer — using a known private key so tests can sign
    // deterministically. NOT the anvil test key; that's a sitewide
    // convention for attestation-signer testing across the suite.
    uint256 internal attSignerPk = 0xA77E57;
    address internal attSigner;

    MockUru internal uru;
    UruDepositSink internal uruSink;
    LoyaltyOracle internal loyalty;
    FeeSplitter internal feeSplitter;

    ERC721ATemplate internal erc721Impl;
    NftMintModule internal mintModuleImpl;
    NftWhitelistModule internal wlModuleImpl;
    NftLaunchFactory internal factory;

    /// Cached bytes32 for the salt keys the factory computes — filled in
    /// on `launchWith(...)`.
    address internal deployedToken;
    address internal deployedMintModule;
    address internal deployedWl;

    function _setupBase() internal {
        attSigner = vm.addr(attSignerPk);

        uru = new MockUru();
        // UruDepositSink: (owner, uru, distributionSink, minConfigDelay)
        uruSink = new UruDepositSink(owner, address(uru), treasury, 0);
        // LoyaltyOracle: (owner, uruToken, gemuNft, uruThreshold)
        loyalty = new LoyaltyOracle(owner, address(uru), address(0), 100_000e18);
        feeSplitter = new FeeSplitter(owner, treasury, 0);

        // Configure feeSplitter split — approximating the live 40/35/25
        // (buyback/nft/treasury). Direct setConfig works because
        // minConfigDelay=0.
        vm.prank(owner);
        feeSplitter.setConfig(buybackSink, nftSink, treasury, 4000, 3500, 2500);

        erc721Impl = new ERC721ATemplate();
        mintModuleImpl = new NftMintModule();
        wlModuleImpl = new NftWhitelistModule();
        factory = new NftLaunchFactory(owner);

        // Pin + register impls
        vm.startPrank(owner);
        factory.setExpectedCodeHashes(
            keccak256(address(erc721Impl).code),
            keccak256(address(mintModuleImpl).code),
            keccak256(address(wlModuleImpl).code)
        );
        factory.setImpls(address(erc721Impl), address(mintModuleImpl), address(wlModuleImpl));
        factory.setUruConfig(IERC20(address(uru)), address(uruSink), 0, ILoyaltyOracleLike(address(0)));
        factory.setFeeSplitter(address(feeSplitter));
        factory.setAttestationSigner(attSigner);
        vm.stopPrank();
    }

    /// Standard launch — fixed price, no WL, no discount tiers.
    /// Individual tests override any field they want to test.
    function _defaultLaunchParams() internal view returns (NftLaunchFactory.LaunchParams memory p) {
        NftMintModule.DiscountTier[] memory tiers = new NftMintModule.DiscountTier[](0);
        p = NftLaunchFactory.LaunchParams({
            name: "chibi",
            ticker: "CHIBI",
            baseURI: "ipfs://cid/",
            maxSupply: 100,
            mintMode: NftMintModule.MintMode.Fixed,
            basePriceWei: 0.01 ether,
            priceStepWei: 0,
            discountFloorBps: 1000, // buyer never pays less than 10% of base
            perWalletMintCap: 0,
            payWithUru: false,
            tiers: tiers,
            wlFlavor: NftWhitelistModule.Flavor.Off,
            wlHoldersTarget: address(0),
            wlHoldersTargetChainId: 0,
            wlHoldersMinCount: 0,
            wlWalletListRoot: bytes32(0),
            wlWindowEnd: 0,
            uruAmount: 0
        });
    }

    function _launch(NftLaunchFactory.LaunchParams memory p) internal {
        vm.prank(launcher);
        (deployedToken, deployedMintModule, deployedWl) = factory.launch(p);
    }

    // --------------------------------------------------------------
    // Signature helpers
    // --------------------------------------------------------------

    function _signAttestation(
        uint256 pk,
        address wallet_,
        address ourCollection_,
        address targetCollection_,
        uint256 targetChainId_,
        uint256 tierId_,
        uint256 count_,
        uint256 expiry_
    ) internal view returns (bytes memory sig) {
        bytes32 hash = keccak256(
            abi.encode(
                "URU_NFT_DISCOUNT_V1",
                block.chainid,
                wallet_,
                ourCollection_,
                targetCollection_,
                targetChainId_,
                tierId_,
                count_,
                expiry_
            )
        );
        bytes32 envelope = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, envelope);
        sig = abi.encodePacked(r, s, v);
    }

    function _signWlAttestation(
        uint256 pk,
        address wlModule_,
        address ourCollection_,
        address holdersTarget_,
        uint256 holdersTargetChainId_,
        address wallet_,
        uint256 count_,
        uint256 expiry_
    ) internal view returns (bytes memory sig) {
        bytes32 hash = keccak256(
            abi.encode(
                "URU_NFT_WL_V1",
                block.chainid,
                wlModule_,
                ourCollection_,
                holdersTarget_,
                holdersTargetChainId_,
                wallet_,
                count_,
                expiry_
            )
        );
        bytes32 envelope = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, envelope);
        sig = abi.encodePacked(r, s, v);
    }

    // --------------------------------------------------------------
    // Merkle helpers — 2-leaf tree (buyer1 + buyer2)
    // --------------------------------------------------------------

    /// @return root  merkle root
    /// @return proof1  proof for buyer1
    /// @return proof2  proof for buyer2
    function _twoLeafMerkle(address a, address b) internal pure returns (bytes32 root, bytes32[] memory proof1, bytes32[] memory proof2) {
        bytes32 leafA = keccak256(bytes.concat(keccak256(abi.encode(a))));
        bytes32 leafB = keccak256(bytes.concat(keccak256(abi.encode(b))));
        // Sorted pair for merkle root
        (bytes32 lo, bytes32 hi) = leafA < leafB ? (leafA, leafB) : (leafB, leafA);
        root = keccak256(abi.encodePacked(lo, hi));
        proof1 = new bytes32[](1);
        proof2 = new bytes32[](1);
        proof1[0] = leafB; // sibling of leafA
        proof2[0] = leafA;
    }
}
