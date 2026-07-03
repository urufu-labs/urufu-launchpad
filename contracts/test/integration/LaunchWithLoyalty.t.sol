// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {ERC721} from "solady/tokens/ERC721.sol";

import {NameRegistry} from "src/registry/NameRegistry.sol";
import {Router} from "src/router/Router.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC20Template} from "src/templates/ERC20Template.sol";
import {LoyaltyOracle} from "src/flywheel/LoyaltyOracle.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

contract MockUru is ERC20 {
    function name() public pure override returns (string memory) {
        return "URU";
    }

    function symbol() public pure override returns (string memory) {
        return "URU";
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract MockGemu is ERC721 {
    function name() public pure override returns (string memory) {
        return "GEMU";
    }

    function symbol() public pure override returns (string memory) {
        return "GEMU";
    }

    function tokenURI(
        uint256
    ) public pure override returns (string memory) {
        return "";
    }

    function mint(
        address to,
        uint256 id
    ) external {
        _mint(to, id);
    }
}

/// @notice End-to-end test: launcher with URU + gemu NFTs pays a discounted fee via
///         the Router's LoyaltyOracle path.
contract LaunchWithLoyaltyTest is Test {
    NameRegistry internal registry;
    Router internal router;
    FeeReceiver internal feeReceiver;
    ERC20Factory internal f20;
    ERC20Template internal impl20;
    LoyaltyOracle internal oracle;
    MockUru internal uru;
    MockGemu internal gemu;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal registrar = makeAddr("registrar");
    address internal launcher = makeAddr("launcher");

    uint256 internal constant BASE_FEE = 0.05 ether;
    uint256 internal constant URU_THRESHOLD = 1000e18;
    bytes32 internal BARE_ERC20 = keccak256(abi.encode("ERC20", ""));

    function setUp() public {
        string[] memory reserved = new string[](0);
        registry = new NameRegistry(admin, treasury, reserved);
        feeReceiver = new FeeReceiver(admin);
        router = new Router(
            admin,
            registry,
            IFeeReceiver(address(feeReceiver)),
            BASE_FEE,
            BASE_FEE,
            BASE_FEE,
            0.01 ether,
            0.1 ether,
            0.1 ether
        );

        f20 = new ERC20Factory(admin, address(router), registrar);
        impl20 = new ERC20Template();
        uru = new MockUru();
        gemu = new MockGemu();
        oracle = new LoyaltyOracle(admin, address(uru), address(gemu), URU_THRESHOLD);

        vm.startPrank(admin);
        router.setFactory(BaseType.ERC20, address(f20));
        registry.setRouter(address(router));
        router.setLoyaltyOracle(address(oracle));
        vm.stopPrank();

        vm.prank(registrar);
        f20.registerImpl(BARE_ERC20, address(impl20));

        vm.deal(launcher, 1 ether);
    }

    function _bareParams(
        string memory name,
        string memory ticker
    ) internal view returns (LaunchParams memory) {
        return LaunchParams({
            base: BaseType.ERC20,
            name: name,
            ticker: ticker,
            configHash: BARE_ERC20,
            initData: abi.encode(uint256(1000 ether), launcher, new bytes[](0)),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: false,
            ownership: OwnershipMode.KeepEOA,
            ownerTargetIfMultisig: address(0)
        });
    }

    function test_QuoteFor_NoHoldings_FullFee() public {
        LaunchParams memory p = _bareParams("Full", "FULL");
        assertEq(router.quoteFor(p, launcher), BASE_FEE);
    }

    function test_QuoteFor_NftHolder_20PctOff() public {
        gemu.mint(launcher, 1);
        LaunchParams memory p = _bareParams("Nft", "NFT");
        assertEq(router.quoteFor(p, launcher), BASE_FEE * 8000 / 10_000);
    }

    function test_QuoteFor_UruHolder_40PctOff() public {
        uru.mint(launcher, URU_THRESHOLD);
        LaunchParams memory p = _bareParams("Uru", "URU");
        assertEq(router.quoteFor(p, launcher), BASE_FEE * 6000 / 10_000);
    }

    function test_QuoteFor_Both_50PctOff() public {
        gemu.mint(launcher, 1);
        uru.mint(launcher, URU_THRESHOLD);
        LaunchParams memory p = _bareParams("Both", "BOTH");
        assertEq(router.quoteFor(p, launcher), BASE_FEE * 5000 / 10_000);
    }

    function test_Launch_AppliesDiscount() public {
        gemu.mint(launcher, 1);
        uru.mint(launcher, URU_THRESHOLD);

        LaunchParams memory p = _bareParams("Discounted", "DISC");
        uint256 expected = BASE_FEE * 5000 / 10_000;
        uint256 launcherBalBefore = launcher.balance;

        vm.prank(launcher);
        router.launch{value: expected}(p);
        assertEq(address(feeReceiver).balance, expected, "receiver got discounted fee");
        // Launcher paid exactly the discounted fee; no refund needed.
        assertEq(launcher.balance, launcherBalBefore - expected);
    }

    function test_Launch_OverpayRefundsExcess() public {
        gemu.mint(launcher, 1);
        LaunchParams memory p = _bareParams("Refund", "REF");
        uint256 discounted = BASE_FEE * 8000 / 10_000;

        vm.prank(launcher);
        router.launch{value: BASE_FEE}(p);
        // Launcher paid BASE_FEE gross; fee taken was discounted; refund = BASE_FEE - discounted
        assertEq(address(feeReceiver).balance, discounted);
        assertEq(launcher.balance, 1 ether - discounted, "excess refunded");
    }

    function test_Launch_UnsetOracle_ChargesFull() public {
        vm.prank(admin);
        router.setLoyaltyOracle(address(0));

        gemu.mint(launcher, 1);
        LaunchParams memory p = _bareParams("NoOracle", "NOOR");
        vm.prank(launcher);
        router.launch{value: BASE_FEE}(p);
        assertEq(address(feeReceiver).balance, BASE_FEE, "no discount when oracle unset");
    }
}
