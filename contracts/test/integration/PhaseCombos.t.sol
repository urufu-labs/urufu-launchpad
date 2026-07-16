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
import {ERC20WithAirdropGen} from "src/templates/composed/ERC20WithAirdropGen.sol";
import {ERC20WithVestingGen} from "src/templates/composed/ERC20WithVestingGen.sol";
import {ERC20WithStakingGen} from "src/templates/composed/ERC20WithStakingGen.sol";
import {ERC20WithVotesGen} from "src/templates/composed/ERC20WithVotesGen.sol";
import {ERC20WithAntiBotAntiWhaleGen} from "src/templates/composed/ERC20WithAntiBotAntiWhaleGen.sol";
import {ERC20WithAntiBotPermitGen} from "src/templates/composed/ERC20WithAntiBotPermitGen.sol";
import {ERC20WithFoTPermitGen} from "src/templates/composed/ERC20WithFoTPermitGen.sol";
import {ERC20WithAntiBotAntiWhalePermitGen} from "src/templates/composed/ERC20WithAntiBotAntiWhalePermitGen.sol";
import {ERC20WithAirdropVestingGen} from "src/templates/composed/ERC20WithAirdropVestingGen.sol";
import {ERC20WithPermitVestingGen} from "src/templates/composed/ERC20WithPermitVestingGen.sol";
import {ERC20WithAirdropPermitGen} from "src/templates/composed/ERC20WithAirdropPermitGen.sol";
import {ERC20WithPermitStakingGen} from "src/templates/composed/ERC20WithPermitStakingGen.sol";
import {ERC20WithAirdropVotesGen} from "src/templates/composed/ERC20WithAirdropVotesGen.sol";
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

    // ---- Config hashes (mirror DeployPhase1)
    bytes32 internal BARE_ERC20 = keccak256(abi.encode("ERC20", ""));
    bytes32 internal ANTIBOT = keccak256(abi.encode("ERC20", "AntiBot"));
    bytes32 internal ANTIWHALE = keccak256(abi.encode("ERC20", "AntiWhale"));
    bytes32 internal FOT = keccak256(abi.encode("ERC20", "FeeOnTransfer"));
    bytes32 internal PAUSABLE = keccak256(abi.encode("ERC20", "Pausable"));
    bytes32 internal PERMIT = keccak256(abi.encode("ERC20", "Permit"));
    bytes32 internal AIRDROP = keccak256(abi.encode("ERC20", "Airdrop"));
    bytes32 internal VESTING = keccak256(abi.encode("ERC20", "Vesting"));
    bytes32 internal STAKING = keccak256(abi.encode("ERC20", "Staking"));
    bytes32 internal VOTES = keccak256(abi.encode("ERC20", "Votes"));
    bytes32 internal AB_AW = keccak256(abi.encode("ERC20", "AntiBot,AntiWhale"));
    bytes32 internal AB_P = keccak256(abi.encode("ERC20", "AntiBot,Permit"));
    bytes32 internal FOT_P = keccak256(abi.encode("ERC20", "FeeOnTransfer,Permit"));
    bytes32 internal AB_AW_P = keccak256(abi.encode("ERC20", "AntiBot,AntiWhale,Permit"));
    bytes32 internal DROP_VEST = keccak256(abi.encode("ERC20", "Airdrop,Vesting"));
    bytes32 internal P_VEST = keccak256(abi.encode("ERC20", "Permit,Vesting"));
    bytes32 internal DROP_P = keccak256(abi.encode("ERC20", "Airdrop,Permit"));
    bytes32 internal P_STK = keccak256(abi.encode("ERC20", "Permit,Staking"));
    bytes32 internal DROP_V = keccak256(abi.encode("ERC20", "Airdrop,Votes"));
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

        vm.startPrank(registrar);
        f20.registerImpl(BARE_ERC20, address(impl20));
        f20.registerImpl(ANTIBOT, address(new ERC20WithAntiBotGen()));
        f20.registerImpl(ANTIWHALE, address(new ERC20WithAntiWhaleGen()));
        f20.registerImpl(FOT, address(new ERC20WithFeeOnTransferGen()));
        f20.registerImpl(PAUSABLE, address(new ERC20WithPausableGen()));
        f20.registerImpl(PERMIT, address(new ERC20WithPermitGen()));
        f20.registerImpl(AIRDROP, address(new ERC20WithAirdropGen()));
        f20.registerImpl(VESTING, address(new ERC20WithVestingGen()));
        f20.registerImpl(STAKING, address(new ERC20WithStakingGen()));
        f20.registerImpl(VOTES, address(new ERC20WithVotesGen()));
        f20.registerImpl(AB_AW, address(new ERC20WithAntiBotAntiWhaleGen()));
        f20.registerImpl(AB_P, address(new ERC20WithAntiBotPermitGen()));
        f20.registerImpl(FOT_P, address(new ERC20WithFoTPermitGen()));
        f20.registerImpl(AB_AW_P, address(new ERC20WithAntiBotAntiWhalePermitGen()));
        f20.registerImpl(DROP_VEST, address(new ERC20WithAirdropVestingGen()));
        f20.registerImpl(P_VEST, address(new ERC20WithPermitVestingGen()));
        f20.registerImpl(DROP_P, address(new ERC20WithAirdropPermitGen()));
        f20.registerImpl(P_STK, address(new ERC20WithPermitStakingGen()));
        f20.registerImpl(DROP_V, address(new ERC20WithAirdropVotesGen()));
        f20.registerImpl(PAUSE_P, address(new ERC20WithPausablePermitGen()));

        f721.registerImpl(BARE_721, address(impl721));
        f721.registerImpl(DELAYED, address(new ERC721AWithDelayedRevealGen()));
        f721.registerImpl(SVG, address(new ERC721AWithOnChainSVGGen()));
        f721.registerImpl(ROYALTY, address(new ERC721AWithRoyaltyGen()));
        f721.registerImpl(SVG_ROYALTY, address(new ERC721AWithSvgAndRoyaltyGen()));
        f721.registerImpl(SOULBOUND, address(new ERC721AWithSoulboundGen()));
        f721.registerImpl(REFUNDABLE, address(new ERC721AWithRefundableGen()));
        f721.registerImpl(ROY_REF, address(new ERC721AWithRoyaltyRefundableGen()));
        f721.registerImpl(DR_REF, address(new ERC721AWithDelayedRevealRefundableGen()));
        f721.registerImpl(SVG_SOUL, address(new ERC721AWithSvgSoulboundGen()));
        f721.registerImpl(ROY_SOUL, address(new ERC721AWithRoyaltySoulboundGen()));

        f1155.registerImpl(BARE_1155, address(impl1155));
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

    function test_Combo_ERC20_Airdrop() public {
        bytes[] memory m = new bytes[](1);
        m[0] = abi.encode(bytes32(uint256(0xdeadbeef)));
        _launch(BaseType.ERC20, "Combo Airdrop", "CDROP", AIRDROP, _erc20InitData(1000 ether, m), 2);
    }

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

    function _dropData() internal pure returns (bytes memory) {
        return abi.encode(bytes32(uint256(0xdeadbeef)));
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

    function test_Combo_ERC20_AirdropVesting() public {
        // Sorted: Airdrop, Vesting
        bytes[] memory m = new bytes[](2);
        m[0] = _dropData();
        m[1] = _vestData();
        _launch(BaseType.ERC20, "Combo DropVest", "CDVEST", DROP_VEST, _erc20InitData(1000 ether, m), 3);
    }

    function test_Combo_ERC20_PermitVesting() public {
        // Sorted: Permit, Vesting
        bytes[] memory m = new bytes[](2);
        m[0] = "";
        m[1] = _vestData();
        _launch(BaseType.ERC20, "Combo PVest", "CPVEST", P_VEST, _erc20InitData(1000 ether, m), 3);
    }

    function test_Combo_ERC20_AirdropPermit() public {
        // Sorted: Airdrop, Permit
        bytes[] memory m = new bytes[](2);
        m[0] = _dropData();
        m[1] = "";
        _launch(BaseType.ERC20, "Combo DropP", "CDP", DROP_P, _erc20InitData(1000 ether, m), 3);
    }

    function test_Combo_ERC20_PermitStaking() public {
        // Sorted: Permit, Staking
        bytes[] memory m = new bytes[](2);
        m[0] = "";
        m[1] = _stakingData();
        _launch(BaseType.ERC20, "Combo PStk", "CPSTK", P_STK, _erc20InitData(1000 ether, m), 3);
    }

    function test_Combo_ERC20_AirdropVotes() public {
        // Sorted: Airdrop, Votes — uses ERC20VotesTemplate base
        bytes[] memory m = new bytes[](2);
        m[0] = _dropData();
        m[1] = "";
        _launch(BaseType.ERC20, "Combo DropV", "CDV", DROP_V, _erc20InitData(1000 ether, m), 3);
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
        LaunchParams memory p = LaunchParams({
            base: BaseType.ERC20,
            name: "Fee 2M",
            ticker: "F2M",
            configHash: AB_AW,
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
