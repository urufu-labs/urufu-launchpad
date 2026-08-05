// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {NameRegistry} from "src/registry/NameRegistry.sol";
import {Router} from "src/router/Router.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC20Template} from "src/templates/ERC20Template.sol";
import {ERC721AFactory} from "src/factories/ERC721AFactory.sol";
import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";
import {ERC1155Factory} from "src/factories/ERC1155Factory.sol";
import {ERC1155Template} from "src/templates/ERC1155Template.sol";
import {ERC20WithAntiBotGen} from "src/templates/composed/ERC20WithAntiBotGen.sol";
import {ERC20WithAntiWhaleGen} from "src/templates/composed/ERC20WithAntiWhaleGen.sol";
import {ERC20WithFeeOnTransferGen} from "src/templates/composed/ERC20WithFeeOnTransferGen.sol";
import {ERC20WithPausableGen} from "src/templates/composed/ERC20WithPausableGen.sol";
import {ERC20WithPermitGen} from "src/templates/composed/ERC20WithPermitGen.sol";
import {ERC20WithVestingGen} from "src/templates/composed/ERC20WithVestingGen.sol";
import {ERC20WithStakingGen} from "src/templates/composed/ERC20WithStakingGen.sol";
import {ERC20WithVotesGen} from "src/templates/composed/ERC20WithVotesGen.sol";
import {ERC20WithAntiBotAntiWhaleGen} from "src/templates/composed/ERC20WithAntiBotAntiWhaleGen.sol";
import {ERC20WithAntiBotPermitGen} from "src/templates/composed/ERC20WithAntiBotPermitGen.sol";
import {ERC20WithFoTPermitGen} from "src/templates/composed/ERC20WithFoTPermitGen.sol";
import {ERC20WithAntiBotAntiWhalePermitGen} from "src/templates/composed/ERC20WithAntiBotAntiWhalePermitGen.sol";
import {ERC20WithPermitVestingGen} from "src/templates/composed/ERC20WithPermitVestingGen.sol";
import {ERC20WithPermitStakingGen} from "src/templates/composed/ERC20WithPermitStakingGen.sol";
import {ERC20WithPausablePermitGen} from "src/templates/composed/ERC20WithPausablePermitGen.sol";
import {ERC721AWithDelayedRevealGen} from "src/templates/composed/ERC721AWithDelayedRevealGen.sol";
import {ERC721AWithOnChainSVGGen} from "src/templates/composed/ERC721AWithOnChainSVGGen.sol";
import {ERC721AWithRoyaltyGen} from "src/templates/composed/ERC721AWithRoyaltyGen.sol";
import {ERC721AWithSvgAndRoyaltyGen} from "src/templates/composed/ERC721AWithSvgAndRoyaltyGen.sol";
import {ERC721AWithSoulboundGen} from "src/templates/composed/ERC721AWithSoulboundGen.sol";
import {ERC721AWithRefundableGen} from "src/templates/composed/ERC721AWithRefundableGen.sol";
import {ERC721AWithRoyaltyRefundableGen} from "src/templates/composed/ERC721AWithRoyaltyRefundableGen.sol";
import {ERC721AWithDelayedRevealRefundableGen} from "src/templates/composed/ERC721AWithDelayedRevealRefundableGen.sol";
import {ERC721AWithSvgSoulboundGen} from "src/templates/composed/ERC721AWithSvgSoulboundGen.sol";
import {ERC721AWithRoyaltySoulboundGen} from "src/templates/composed/ERC721AWithRoyaltySoulboundGen.sol";

import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

/// @notice End-to-end: deploys the full Phase 1 stack in setUp, then launches EVERY registered
///         impl through the Router. Proves the go-live menu is deploy-safe and Router-wired.
///         Run identically in `forge test` or against a real fork:
///           forge test --match-contract PhaseCombosTest
///           forge test --match-contract PhaseCombosTest --fork-url $SEPOLIA_RPC_URL
contract PhaseCombosTest is Test {
    // ---- Phase 1 topology
    NameRegistry internal registry;
    Router internal router;
    FeeReceiver internal feeReceiver;
    ERC20Factory internal f20;
    ERC721AFactory internal f721;
    ERC1155Factory internal f1155;

    // Impl addresses (only the ones we assert against post-launch — the rest are just
    // registered and immediately exercised via Router.launch).
    ERC20Template internal impl20;
    ERC721ATemplate internal impl721;
    ERC1155Template internal impl1155;

    // ---- Actors
    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal registrar = makeAddr("registrar");
    address internal launcher = makeAddr("launcher");

    // ---- Fees (must match Phase1 defaults)
    uint256 internal constant BASE_FEE = 0.05 ether;
    uint256 internal constant MODULE_ADD = 0.01 ether;

    // ---- Config hashes (mirror Router deploy)
    bytes32 internal BARE_ERC20 = keccak256(abi.encode("ERC20", ""));
    bytes32 internal ANTIBOT = keccak256(abi.encode("ERC20", "AntiBot"));
    bytes32 internal ANTIWHALE = keccak256(abi.encode("ERC20", "AntiWhale"));
    bytes32 internal FOT = keccak256(abi.encode("ERC20", "FeeOnTransfer"));
    bytes32 internal PAUSABLE = keccak256(abi.encode("ERC20", "Pausable"));
    bytes32 internal PERMIT = keccak256(abi.encode("ERC20", "Permit"));
    bytes32 internal VESTING = keccak256(abi.encode("ERC20", "Vesting"));
    bytes32 internal STAKING = keccak256(abi.encode("ERC20", "Staking"));
    bytes32 internal VOTES = keccak256(abi.encode("ERC20", "Votes"));
    bytes32 internal AB_AW = keccak256(abi.encode("ERC20", "AntiBot,AntiWhale"));
    bytes32 internal AB_P = keccak256(abi.encode("ERC20", "AntiBot,Permit"));
    bytes32 internal FOT_P = keccak256(abi.encode("ERC20", "FeeOnTransfer,Permit"));
    bytes32 internal AB_AW_P = keccak256(abi.encode("ERC20", "AntiBot,AntiWhale,Permit"));
    bytes32 internal P_VEST = keccak256(abi.encode("ERC20", "Permit,Vesting"));
    bytes32 internal P_STK = keccak256(abi.encode("ERC20", "Permit,Staking"));
    bytes32 internal PAUSE_P = keccak256(abi.encode("ERC20", "Pausable,Permit"));
    bytes32 internal BARE_721 = keccak256(abi.encode("ERC721A", ""));
    bytes32 internal DELAYED = keccak256(abi.encode("ERC721A", "DelayedReveal"));
    bytes32 internal ROYALTY = keccak256(abi.encode("ERC721A", "ERC2981Royalty"));
    bytes32 internal SVG = keccak256(abi.encode("ERC721A", "OnChainSVG"));
    bytes32 internal SVG_ROYALTY = keccak256(abi.encode("ERC721A", "ERC2981Royalty,OnChainSVG"));
    bytes32 internal SOULBOUND = keccak256(abi.encode("ERC721A", "Soulbound"));
    bytes32 internal REFUNDABLE = keccak256(abi.encode("ERC721A", "Refundable"));
    bytes32 internal ROY_REF = keccak256(abi.encode("ERC721A", "ERC2981Royalty,Refundable"));
    bytes32 internal DR_REF = keccak256(abi.encode("ERC721A", "DelayedReveal,Refundable"));
    bytes32 internal SVG_SOUL = keccak256(abi.encode("ERC721A", "OnChainSVG,Soulbound"));
    bytes32 internal ROY_SOUL = keccak256(abi.encode("ERC721A", "ERC2981Royalty,Soulbound"));
    bytes32 internal BARE_1155 = keccak256(abi.encode("ERC1155", ""));

    function setUp() public {
        string[] memory reserved = new string[](2);
        reserved[0] = "ETH";
        reserved[1] = "USDC";

        registry = new NameRegistry(admin, treasury, reserved);
        feeReceiver = new FeeReceiver(admin);
        router = new Router(
            admin,
            registry,
            IFeeReceiver(address(feeReceiver)),
            BASE_FEE,
            BASE_FEE,
            BASE_FEE,
            MODULE_ADD,
            0.1 ether,
            0.1 ether
        );

        f20 = new ERC20Factory(admin, address(router), registrar);
        f721 = new ERC721AFactory(admin, address(router), registrar);
        f1155 = new ERC1155Factory(admin, address(router), registrar);

        vm.startPrank(admin);
        router.setFactory(BaseType.ERC20, address(f20));
        router.setFactory(BaseType.ERC721A, address(f721));
        router.setFactory(BaseType.ERC1155, address(f1155));
        registry.setRouter(address(router));
        vm.stopPrank();

        // Deploy + register every impl on the go-live menu.
        impl20 = new ERC20Template();
        impl721 = new ERC721ATemplate();
        impl1155 = new ERC1155Template();

        // URU-A08 (round 3): pin the audited codehash for every configHash
        // BEFORE the registrar can bind the impl. Capture each impl first so
        // we can hash it, pin under admin, then bind under registrar. The
        // large table is broken into three passes (deploy → pin → register)
        // to keep the prank swap minimal.
        address a20_bare = address(impl20);
        address a20_antibot = address(new ERC20WithAntiBotGen());
        address a20_antiwhale = address(new ERC20WithAntiWhaleGen());
        address a20_fot = address(new ERC20WithFeeOnTransferGen());
        address a20_pausable = address(new ERC20WithPausableGen());
        address a20_permit = address(new ERC20WithPermitGen());
        address a20_vesting = address(new ERC20WithVestingGen());
        address a20_staking = address(new ERC20WithStakingGen());
        address a20_votes = address(new ERC20WithVotesGen());
        address a20_abaw = address(new ERC20WithAntiBotAntiWhaleGen());
        address a20_abp = address(new ERC20WithAntiBotPermitGen());
        address a20_fotp = address(new ERC20WithFoTPermitGen());
        address a20_abawp = address(new ERC20WithAntiBotAntiWhalePermitGen());
        address a20_pvest = address(new ERC20WithPermitVestingGen());
        address a20_pstk = address(new ERC20WithPermitStakingGen());
        address a20_pausep = address(new ERC20WithPausablePermitGen());

        address a721_bare = address(impl721);
        address a721_delayed = address(new ERC721AWithDelayedRevealGen());
        address a721_svg = address(new ERC721AWithOnChainSVGGen());
        address a721_royalty = address(new ERC721AWithRoyaltyGen());
        address a721_svgroy = address(new ERC721AWithSvgAndRoyaltyGen());
        address a721_soul = address(new ERC721AWithSoulboundGen());
        address a721_ref = address(new ERC721AWithRefundableGen());
        address a721_royref = address(new ERC721AWithRoyaltyRefundableGen());
        address a721_drref = address(new ERC721AWithDelayedRevealRefundableGen());
        address a721_svgsoul = address(new ERC721AWithSvgSoulboundGen());
        address a721_roysoul = address(new ERC721AWithRoyaltySoulboundGen());

        address a1155_bare = address(impl1155);

        // Pin every configHash to its audited codehash (owner-only).
        vm.startPrank(admin);
        f20.setExpectedCodeHash(BARE_ERC20, keccak256(a20_bare.code));
        f20.setExpectedCodeHash(ANTIBOT, keccak256(a20_antibot.code));
        f20.setExpectedCodeHash(ANTIWHALE, keccak256(a20_antiwhale.code));
        f20.setExpectedCodeHash(FOT, keccak256(a20_fot.code));
        f20.setExpectedCodeHash(PAUSABLE, keccak256(a20_pausable.code));
        f20.setExpectedCodeHash(PERMIT, keccak256(a20_permit.code));
        f20.setExpectedCodeHash(VESTING, keccak256(a20_vesting.code));
        f20.setExpectedCodeHash(STAKING, keccak256(a20_staking.code));
        f20.setExpectedCodeHash(VOTES, keccak256(a20_votes.code));
        f20.setExpectedCodeHash(AB_AW, keccak256(a20_abaw.code));
        f20.setExpectedCodeHash(AB_P, keccak256(a20_abp.code));
        f20.setExpectedCodeHash(FOT_P, keccak256(a20_fotp.code));
        f20.setExpectedCodeHash(AB_AW_P, keccak256(a20_abawp.code));
        f20.setExpectedCodeHash(P_VEST, keccak256(a20_pvest.code));
        f20.setExpectedCodeHash(P_STK, keccak256(a20_pstk.code));
        f20.setExpectedCodeHash(PAUSE_P, keccak256(a20_pausep.code));

        f721.setExpectedCodeHash(BARE_721, keccak256(a721_bare.code));
        f721.setExpectedCodeHash(DELAYED, keccak256(a721_delayed.code));
        f721.setExpectedCodeHash(SVG, keccak256(a721_svg.code));
        f721.setExpectedCodeHash(ROYALTY, keccak256(a721_royalty.code));
        f721.setExpectedCodeHash(SVG_ROYALTY, keccak256(a721_svgroy.code));
        f721.setExpectedCodeHash(SOULBOUND, keccak256(a721_soul.code));
        f721.setExpectedCodeHash(REFUNDABLE, keccak256(a721_ref.code));
        f721.setExpectedCodeHash(ROY_REF, keccak256(a721_royref.code));
        f721.setExpectedCodeHash(DR_REF, keccak256(a721_drref.code));
        f721.setExpectedCodeHash(SVG_SOUL, keccak256(a721_svgsoul.code));
        f721.setExpectedCodeHash(ROY_SOUL, keccak256(a721_roysoul.code));

        f1155.setExpectedCodeHash(BARE_1155, keccak256(a1155_bare.code));
        vm.stopPrank();

        // Bind every impl under the registrar role.
        vm.startPrank(registrar);
        f20.registerImpl(BARE_ERC20, a20_bare);
        f20.registerImpl(ANTIBOT, a20_antibot);
        f20.registerImpl(ANTIWHALE, a20_antiwhale);
        f20.registerImpl(FOT, a20_fot);
        f20.registerImpl(PAUSABLE, a20_pausable);
        f20.registerImpl(PERMIT, a20_permit);
        f20.registerImpl(VESTING, a20_vesting);
        f20.registerImpl(STAKING, a20_staking);
        f20.registerImpl(VOTES, a20_votes);
        f20.registerImpl(AB_AW, a20_abaw);
        f20.registerImpl(AB_P, a20_abp);
        f20.registerImpl(FOT_P, a20_fotp);
        f20.registerImpl(AB_AW_P, a20_abawp);
        f20.registerImpl(P_VEST, a20_pvest);
        f20.registerImpl(P_STK, a20_pstk);
        f20.registerImpl(PAUSE_P, a20_pausep);

        f721.registerImpl(BARE_721, a721_bare);
        f721.registerImpl(DELAYED, a721_delayed);
        f721.registerImpl(SVG, a721_svg);
        f721.registerImpl(ROYALTY, a721_royalty);
        f721.registerImpl(SVG_ROYALTY, a721_svgroy);
        f721.registerImpl(SOULBOUND, a721_soul);
        f721.registerImpl(REFUNDABLE, a721_ref);
        f721.registerImpl(ROY_REF, a721_royref);
        f721.registerImpl(DR_REF, a721_drref);
        f721.registerImpl(SVG_SOUL, a721_svgsoul);
        f721.registerImpl(ROY_SOUL, a721_roysoul);

        f1155.registerImpl(BARE_1155, a1155_bare);
        vm.stopPrank();

        // Audit remediation #3: fail-closed sentinels on Router. Every hash
        // that any test in this suite launches through needs EXPLICIT
        // moduleCount + flags records — else Router.launch/quote reverts
        // with ModuleCountMissing/FlagsMissing. Batch-set all counts here
        // (flags=0 for every hash — none carry FoT/rebasing behavior in
        // this suite; FoT+curve is tested separately in AuditFixV6.t.sol).
        // 4 Airdrop entries (AIRDROP, DROP_VEST, DROP_P, DROP_V) dropped
        // 2026-07-31 alongside the composed impl deletions.
        bytes32[] memory allHashes = new bytes32[](28);
        uint256[] memory allCounts = new uint256[](28);
        uint256[] memory allFlags = new uint256[](28);
        allHashes[0] = BARE_ERC20;
        allCounts[0] = 0;
        allHashes[1] = ANTIBOT;
        allCounts[1] = 1;
        allHashes[2] = ANTIWHALE;
        allCounts[2] = 1;
        allHashes[3] = FOT;
        allCounts[3] = 1;
        allHashes[4] = PAUSABLE;
        allCounts[4] = 1;
        allHashes[5] = PERMIT;
        allCounts[5] = 1;
        allHashes[6] = VESTING;
        allCounts[6] = 1;
        allHashes[7] = STAKING;
        allCounts[7] = 1;
        allHashes[8] = VOTES;
        allCounts[8] = 1;
        allHashes[9] = AB_AW;
        allCounts[9] = 2;
        allHashes[10] = AB_P;
        allCounts[10] = 2;
        allHashes[11] = FOT_P;
        allCounts[11] = 2;
        allHashes[12] = AB_AW_P;
        allCounts[12] = 3;
        allHashes[13] = P_VEST;
        allCounts[13] = 2;
        allHashes[14] = P_STK;
        allCounts[14] = 2;
        allHashes[15] = PAUSE_P;
        allCounts[15] = 2;
        allHashes[16] = BARE_721;
        allCounts[16] = 0;
        allHashes[17] = DELAYED;
        allCounts[17] = 1;
        allHashes[18] = SVG;
        allCounts[18] = 1;
        allHashes[19] = ROYALTY;
        allCounts[19] = 1;
        allHashes[20] = SVG_ROYALTY;
        allCounts[20] = 2;
        allHashes[21] = SOULBOUND;
        allCounts[21] = 1;
        allHashes[22] = REFUNDABLE;
        allCounts[22] = 1;
        allHashes[23] = ROY_REF;
        allCounts[23] = 2;
        allHashes[24] = DR_REF;
        allCounts[24] = 2;
        allHashes[25] = BARE_1155;
        allCounts[25] = 0;
        allHashes[26] = SVG_SOUL;
        allCounts[26] = 2;
        allHashes[27] = ROY_SOUL;
        allCounts[27] = 2;
        // allFlags left at default 0 for all — no FoT+curve in this suite.
        vm.startPrank(admin);
        router.setModuleCountForConfigBatch(allHashes, allCounts);
        router.setFlagsForConfigBatch(allHashes, allFlags);
        vm.stopPrank();

        vm.deal(launcher, 500 ether);
    }

    // ============================================================================
    // Helpers — build initData per composed impl
    // ============================================================================

    function _erc20InitData(
        uint256 supply,
        bytes[] memory modules
    ) internal view returns (bytes memory) {
        return abi.encode(supply, launcher, modules);
    }

    function _erc721InitData(
        string memory baseURI,
        uint256 maxSupply,
        bytes[] memory modules
    ) internal pure returns (bytes memory) {
        return abi.encode(baseURI, maxSupply, modules);
    }

    function _erc1155InitData(
        string memory uri,
        bytes[] memory modules
    ) internal pure returns (bytes memory) {
        return abi.encode(uri, modules);
    }

    function _launch(
        BaseType b,
        string memory name,
        string memory ticker,
        bytes32 cfg,
        bytes memory initData,
        uint256 moduleCount
    ) internal returns (address token) {
        LaunchParams memory p = LaunchParams({
            base: b,
            name: name,
            ticker: ticker,
            configHash: cfg,
            initData: initData,
            moduleCount: moduleCount,
            installHook: false,
            installGovernance: false,
            installBondingCurve: false,
            ownership: OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
        uint256 fee = router.quote(p);
        vm.prank(launcher);
        token = router.launch{value: fee}(p);
        assertTrue(token != address(0), "launch returned zero");
    }

    // ============================================================================
    // ERC-20 combo launches — one test per impl
    // ============================================================================

    function test_Combo_ERC20_Bare() public {
        _launch(BaseType.ERC20, "Combo Bare", "CBARE", BARE_ERC20, _erc20InitData(1000 ether, new bytes[](0)), 1);
    }

    function test_Combo_ERC20_AntiBot() public {
        bytes[] memory m = new bytes[](1);
        m[0] = abi.encode(uint16(5));
        _launch(BaseType.ERC20, "Combo AntiBot", "CAB", ANTIBOT, _erc20InitData(1000 ether, m), 2);
    }

    function test_Combo_ERC20_AntiWhale() public {
        bytes[] memory m = new bytes[](1);
        m[0] = abi.encode(uint128(100 ether), uint128(10 ether), uint32(1000));
        _launch(BaseType.ERC20, "Combo AntiWhale", "CAW", ANTIWHALE, _erc20InitData(1000 ether, m), 2);
    }

    function test_Combo_ERC20_FoT() public {
        bytes[] memory m = new bytes[](1);
        m[0] = abi.encode(uint16(500), uint16(5000), uint16(5000), treasury);
        _launch(BaseType.ERC20, "Combo FoT", "CFOT", FOT, _erc20InitData(1000 ether, m), 2);
    }

    function test_Combo_ERC20_Pausable() public {
        bytes[] memory m = new bytes[](1);
        m[0] = "";
        _launch(BaseType.ERC20, "Combo Pausable", "CPAUSE", PAUSABLE, _erc20InitData(1000 ether, m), 2);
    }

    /// End-to-end proof of the profile-page owner-controls widget's assumption:
    /// launching an owner-gated module (Pausable) with KeepEOA leaves the launcher
    /// as the sole owner, and only they can call the owner-gated function. This is
    /// the exact flow the widget exercises — read `owner()` to gate rendering, then
    /// submit `pause()` from the same wallet.
    function test_Widget_Pausable_LauncherOwnsAndCanPause() public {
        bytes[] memory m = new bytes[](1);
        m[0] = "";
        address token = _launch(BaseType.ERC20, "Widget Pause", "WPAUSE", PAUSABLE, _erc20InitData(1000 ether, m), 2);
        ERC20WithPausableGen p = ERC20WithPausableGen(token);

        // Widget precondition #1: launcher is owner.
        assertEq(p.owner(), launcher, "launcher must be owner after KeepEOA launch");

        // Widget precondition #2: current pause state readable, defaults false.
        assertFalse(p.pausablePaused(), "should start unpaused");

        // Widget action: owner calls pause() — succeeds.
        vm.prank(launcher);
        p.pause();
        assertTrue(p.pausablePaused(), "launcher pause() should succeed");

        // Widget guarantee: a stranger cannot pause (would revert with Unauthorized).
        address stranger = makeAddr("widgetStranger");
        vm.prank(stranger);
        vm.expectRevert(bytes4(keccak256("Unauthorized()")));
        p.pause();

        // Widget action: owner calls unpause() — succeeds and returns to live.
        vm.prank(launcher);
        p.unpause();
        assertFalse(p.pausablePaused(), "launcher unpause() should succeed");
    }

    function test_Combo_ERC20_Permit() public {
        bytes[] memory m = new bytes[](1);
        m[0] = "";
        _launch(BaseType.ERC20, "Combo Permit", "CPERM", PERMIT, _erc20InitData(1000 ether, m), 2);
    }

    // Airdrop module retired 2026-07-31 — deployed V1 composed impl had an
    // inflation rug. Single + composed Airdrop tests removed alongside the
    // template files. Vesting / Staking below cover the reserve-backed carve
    // invariant equivalently for the remaining audit surface.

    function test_Combo_ERC20_Vesting() public {
        bytes[] memory m = new bytes[](1);
        m[0] = abi.encode(
            makeAddr("vestBeneficiary"),
            uint256(500 ether),
            uint64(block.timestamp + 1 days),
            uint64(block.timestamp + 400 days)
        );
        _launch(BaseType.ERC20, "Combo Vesting", "CVEST", VESTING, _erc20InitData(1000 ether, m), 2);
    }

    function test_Combo_ERC20_Staking() public {
        bytes[] memory m = new bytes[](1);
        m[0] = abi.encode(uint256(1000 ether), uint32(30 days));
        _launch(BaseType.ERC20, "Combo Staking", "CSTK", STAKING, _erc20InitData(1000 ether, m), 2);
    }

    function test_Combo_ERC20_Votes() public {
        bytes[] memory m = new bytes[](1);
        m[0] = "";
        _launch(BaseType.ERC20, "Combo Votes", "CVOTE", VOTES, _erc20InitData(1000 ether, m), 2);
    }

    // ============================================================================
    // ERC-721A combo launches
    // ============================================================================

    function test_Combo_ERC721A_Bare() public {
        _launch(
            BaseType.ERC721A, "Combo NFT", "NBARE", BARE_721, _erc721InitData("ipfs://bare/", 10_000, new bytes[](0)), 1
        );
    }

    function test_Combo_ERC721A_DelayedReveal() public {
        bytes[] memory m = new bytes[](1);
        m[0] = abi.encode(string("ipfs://hidden/"));
        _launch(BaseType.ERC721A, "Combo Reveal", "NREV", DELAYED, _erc721InitData("ipfs://real/", 10_000, m), 2);
    }

    function test_Combo_ERC721A_Royalty() public {
        bytes[] memory m = new bytes[](1);
        m[0] = abi.encode(makeAddr("royaltyReceiver"), uint96(500));
        _launch(BaseType.ERC721A, "Combo Royalty", "NROY", ROYALTY, _erc721InitData("ipfs://roy/", 10_000, m), 2);
    }

    function test_Combo_ERC721A_SVG() public {
        bytes[] memory m = new bytes[](1);
        m[0] = "";
        _launch(BaseType.ERC721A, "Combo SVG", "NSVG", SVG, _erc721InitData("", 10_000, m), 2);
    }

    function test_Combo_ERC721A_SVG_Royalty() public {
        // Sorted: ERC2981Royalty → OnChainSVG.
        bytes[] memory m = new bytes[](2);
        m[0] = abi.encode(makeAddr("royaltyReceiver"), uint96(500));
        m[1] = "";
        _launch(BaseType.ERC721A, "Combo SvgRoyalty", "NSVGR", SVG_ROYALTY, _erc721InitData("", 10_000, m), 3);
    }

    function test_Combo_ERC721A_Soulbound() public {
        bytes[] memory m = new bytes[](1);
        m[0] = "";
        _launch(BaseType.ERC721A, "Combo Soulbound", "NSOUL", SOULBOUND, _erc721InitData("ipfs://soul/", 10_000, m), 2);
    }

    function test_Combo_ERC721A_Refundable() public {
        bytes[] memory m = new bytes[](1);
        m[0] = abi.encode(uint256(0.01 ether), uint32(43_200));
        _launch(BaseType.ERC721A, "Combo Refund", "NREF", REFUNDABLE, _erc721InitData("ipfs://ref/", 10_000, m), 2);
    }

    // ============================================================================
    // ERC-1155
    // ============================================================================

    function test_Combo_ERC1155_Bare() public {
        _launch(
            BaseType.ERC1155,
            "Combo Multi",
            "MMULTI",
            BARE_1155,
            _erc1155InitData("ipfs://multi/{id}.json", new bytes[](0)),
            1
        );
    }

    // ============================================================================
    // Multi-module ERC-20 bundles
    // ============================================================================

    function _abData() internal pure returns (bytes memory) {
        return abi.encode(uint16(5));
    }

    function _awData() internal pure returns (bytes memory) {
        return abi.encode(uint128(100 ether), uint128(10 ether), uint32(1000));
    }

    function _fotData() internal view returns (bytes memory) {
        return abi.encode(uint16(500), uint16(5000), uint16(5000), treasury);
    }

    function _vestData() internal returns (bytes memory) {
        return abi.encode(
            makeAddr("vestBeneficiary"),
            uint256(500 ether),
            uint64(block.timestamp + 1 days),
            uint64(block.timestamp + 400 days)
        );
    }

    function _stakingData() internal pure returns (bytes memory) {
        return abi.encode(uint256(1000 ether), uint32(30 days));
    }

    function test_Combo_ERC20_AntiBotAntiWhale() public {
        bytes[] memory m = new bytes[](2);
        m[0] = _abData();
        m[1] = _awData();
        _launch(BaseType.ERC20, "Combo AbAw", "CABAW", AB_AW, _erc20InitData(1000 ether, m), 3);
    }

    function test_Combo_ERC20_AntiBotPermit() public {
        bytes[] memory m = new bytes[](2);
        m[0] = _abData();
        m[1] = "";
        _launch(BaseType.ERC20, "Combo AbP", "CABP", AB_P, _erc20InitData(1000 ether, m), 3);
    }

    function test_Combo_ERC20_FoTPermit() public {
        bytes[] memory m = new bytes[](2);
        m[0] = _fotData();
        m[1] = "";
        _launch(BaseType.ERC20, "Combo FoTP", "CFOTP", FOT_P, _erc20InitData(1000 ether, m), 3);
    }

    function test_Combo_ERC20_AntiBotAntiWhalePermit() public {
        // Sorted: AntiBot, AntiWhale, Permit
        bytes[] memory m = new bytes[](3);
        m[0] = _abData();
        m[1] = _awData();
        m[2] = "";
        _launch(BaseType.ERC20, "Combo AbAwP", "CABAWP", AB_AW_P, _erc20InitData(1000 ether, m), 4);
    }

    function test_Combo_ERC20_PermitVesting() public {
        // Sorted: Permit, Vesting
        bytes[] memory m = new bytes[](2);
        m[0] = "";
        m[1] = _vestData();
        _launch(BaseType.ERC20, "Combo PVest", "CPVEST", P_VEST, _erc20InitData(1000 ether, m), 3);
    }

    function test_Combo_ERC20_PermitStaking() public {
        // Sorted: Permit, Staking
        bytes[] memory m = new bytes[](2);
        m[0] = "";
        m[1] = _stakingData();
        _launch(BaseType.ERC20, "Combo PStk", "CPSTK", P_STK, _erc20InitData(1000 ether, m), 3);
    }

    function test_Combo_ERC20_PausablePermit() public {
        // Sorted: Pausable, Permit
        bytes[] memory m = new bytes[](2);
        m[0] = "";
        m[1] = "";
        _launch(BaseType.ERC20, "Combo PauseP", "CPAUSEP", PAUSE_P, _erc20InitData(1000 ether, m), 3);
    }

    // ============================================================================
    // Multi-module ERC-721A bundles
    // ============================================================================

    function _royaltyData() internal returns (bytes memory) {
        return abi.encode(makeAddr("royaltyReceiver"), uint96(500));
    }

    function _refundableData() internal pure returns (bytes memory) {
        return abi.encode(uint256(0.01 ether), uint32(43_200));
    }

    function test_Combo_ERC721A_RoyaltyRefundable() public {
        // Sorted: ERC2981Royalty, Refundable
        bytes[] memory m = new bytes[](2);
        m[0] = _royaltyData();
        m[1] = _refundableData();
        _launch(BaseType.ERC721A, "Combo RoyRef", "NRR", ROY_REF, _erc721InitData("ipfs://rr/", 10_000, m), 3);
    }

    function test_Combo_ERC721A_DelayedRevealRefundable() public {
        // Sorted: DelayedReveal, Refundable
        bytes[] memory m = new bytes[](2);
        m[0] = abi.encode(string("ipfs://hidden/"));
        m[1] = _refundableData();
        _launch(BaseType.ERC721A, "Combo DrRef", "NDR", DR_REF, _erc721InitData("ipfs://real/", 10_000, m), 3);
    }

    function test_Combo_ERC721A_SVGSoulbound() public {
        // Sorted: OnChainSVG, Soulbound
        bytes[] memory m = new bytes[](2);
        m[0] = "";
        m[1] = "";
        _launch(BaseType.ERC721A, "Combo SvgSoul", "NSS", SVG_SOUL, _erc721InitData("", 10_000, m), 3);
    }

    function test_Combo_ERC721A_RoyaltySoulbound() public {
        // Sorted: ERC2981Royalty, Soulbound
        bytes[] memory m = new bytes[](2);
        m[0] = _royaltyData();
        m[1] = "";
        _launch(BaseType.ERC721A, "Combo RoySoul", "NRS", ROY_SOUL, _erc721InitData("ipfs://rs/", 10_000, m), 3);
    }

    // ============================================================================
    // Fee sanity — Router charges base + module add-ons; refund on overpay
    // ============================================================================

    function test_Combo_FeeMatchesQuote_Bare() public {
        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC20,
            name: "Fee Bare",
            ticker: "FBARE",
            configHash: BARE_ERC20,
            initData: _erc20InitData(1 ether, new bytes[](0)),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: false,
            ownership: OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
        assertEq(router.quote(p), BASE_FEE);
    }

    function test_Combo_FeeMatchesQuote_TwoModules() public {
        // Audit fix #3: Router derives moduleCount from moduleCountForConfig,
        // not from params. Use a fresh configHash for the assertion so we can
        // register it exactly once — setModuleCountForConfig is now one-shot
        // (ConfigMetadataAlreadySet if the same hash is set twice), so we
        // cannot re-set AB_AW after the batch registration in setUp.
        bytes32 freshHash = keccak256(abi.encode("QUOTE_3M_FRESH"));
        vm.prank(admin);
        router.setModuleCountForConfig(freshHash, 3);
        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC20,
            name: "Fee 2M",
            ticker: "F2M",
            configHash: freshHash,
            initData: _erc20InitData(1 ether, new bytes[](2)),
            moduleCount: 3,
            installHook: false,
            installGovernance: false,
            installBondingCurve: false,
            ownership: OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
        // 3 modules → 2 extra add-ons.
        assertEq(router.quote(p), BASE_FEE + 2 * MODULE_ADD);
    }
}
