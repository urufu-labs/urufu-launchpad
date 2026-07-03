// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {NameRegistry} from "src/registry/NameRegistry.sol";
import {Router} from "src/router/Router.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {ERC721AFactory} from "src/factories/ERC721AFactory.sol";
import {ERC721ATemplate} from "src/templates/ERC721ATemplate.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

/// @notice End-to-end integration for the ERC-721A base. Real stack, no mocks.
contract LaunchE2EERC721ATest is Test {
    NameRegistry internal registry;
    Router internal router;
    FeeReceiver internal feeReceiver;
    ERC721AFactory internal factory;
    ERC721ATemplate internal impl;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal registrar = makeAddr("registrar");
    address internal launcher = makeAddr("launcher");
    address internal multisig = makeAddr("multisig");

    bytes32 internal constant BARE_CONFIG = keccak256(abi.encode("ERC721A", uint256(0)));

    uint256 internal constant NFT_FEE = 0.05 ether;

    function setUp() public {
        registry = new NameRegistry(admin, treasury, new string[](0));
        feeReceiver = new FeeReceiver(admin);
        router = new Router(
            admin,
            registry,
            IFeeReceiver(address(feeReceiver)),
            NFT_FEE,
            NFT_FEE,
            NFT_FEE,
            0.01 ether,
            0.1 ether,
            0.1 ether
        );
        factory = new ERC721AFactory(admin, address(router), registrar);
        impl = new ERC721ATemplate();

        vm.startPrank(admin);
        router.setFactory(BaseType.ERC721A, address(factory));
        registry.setRouter(address(router));
        vm.stopPrank();

        vm.prank(registrar);
        factory.registerImpl(BARE_CONFIG, address(impl));

        vm.deal(launcher, 100 ether);
    }

    function _params(
        string memory name,
        string memory ticker,
        OwnershipMode mode
    ) internal view returns (LaunchParams memory) {
        return LaunchParams({
            base: BaseType.ERC721A,
            name: name,
            ticker: ticker,
            configHash: BARE_CONFIG,
            initData: abi.encode(string("ipfs://Qm.../"), uint256(1000), new bytes[](0)),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: false,
            ownership: mode,
            ownerTargetIfMultisig: mode == OwnershipMode.TransferToMultisig ? multisig : address(0)
        });
    }

    // =========================================================
    // Golden path
    // =========================================================

    function test_E2E_LaunchBareERC721A_Renounce() public {
        LaunchParams memory p = _params("Cool NFT", "COOL", OwnershipMode.Renounce);
        address predicted = factory.predictAddress(launcher, p.name, p.ticker, BARE_CONFIG);

        vm.prank(launcher);
        address token = router.launch{value: NFT_FEE}(p);

        assertEq(token, predicted);
        ERC721ATemplate t = ERC721ATemplate(token);
        assertEq(t.name(), "Cool NFT");
        assertEq(t.symbol(), "COOL");
        assertEq(t.baseURI(), "ipfs://Qm.../");
        assertEq(t.maxSupply(), 1000);
        assertEq(t.owner(), address(0)); // renounced

        // Registry populated.
        bytes32 nameHash = keccak256(bytes("cool nft"));
        assertEq(registry.reservationOf(nameHash).token, token);
        assertEq(registry.tickerOwner(keccak256(bytes("COOL"))), token);

        assertEq(address(feeReceiver).balance, NFT_FEE);
    }

    function test_E2E_LaunchBareERC721A_KeepEOA_ThenMint() public {
        LaunchParams memory p = _params("Mintable NFT", "MINT", OwnershipMode.KeepEOA);

        vm.prank(launcher);
        address token = router.launch{value: NFT_FEE}(p);

        ERC721ATemplate t = ERC721ATemplate(token);
        assertEq(t.owner(), launcher);

        // Launcher can immediately mint (subject to max supply).
        vm.prank(launcher);
        t.mintBatch(launcher, 25);
        assertEq(t.balanceOf(launcher), 25);
        assertEq(t.totalMinted(), 25);
    }

    function test_E2E_LaunchBareERC721A_TransferToMultisig() public {
        LaunchParams memory p = _params("Multi NFT", "MULT", OwnershipMode.TransferToMultisig);
        vm.prank(launcher);
        address token = router.launch{value: NFT_FEE}(p);
        assertEq(ERC721ATemplate(token).owner(), multisig);
    }

    // =========================================================
    // Cross-base separation
    // =========================================================

    function test_E2E_ERC721ADeployDoesNotUseERC20FactorySlot() public view {
        // Router should have the 721A factory set, and ERC20 factory should still be unset.
        assertEq(router.factories(BaseType.ERC721A), address(factory));
        assertEq(router.factories(BaseType.ERC20), address(0));
    }

    function test_E2E_LauncherReceivesRefund() public {
        LaunchParams memory p = _params("Refund NFT", "RFND", OwnershipMode.Renounce);
        uint256 before = launcher.balance;

        vm.prank(launcher);
        router.launch{value: NFT_FEE + 1.5 ether}(p);

        assertEq(launcher.balance, before - NFT_FEE);
        assertEq(address(feeReceiver).balance, NFT_FEE);
    }
}
