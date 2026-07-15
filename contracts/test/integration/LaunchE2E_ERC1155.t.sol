// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {NameRegistry} from "src/registry/NameRegistry.sol";
import {Router} from "src/router/Router.sol";
import {FeeReceiver, IFeeReceiver} from "src/router/FeeReceiver.sol";
import {ERC1155Factory} from "src/factories/ERC1155Factory.sol";
import {ERC1155Template} from "src/templates/ERC1155Template.sol";
import {BaseType, OwnershipMode, LaunchParams} from "src/types/VMTypes.sol";

/// @notice End-to-end integration for the ERC-1155 base. Real stack, no mocks.
contract LaunchE2EERC1155Test is Test {
    NameRegistry internal registry;
    Router internal router;
    FeeReceiver internal feeReceiver;
    ERC1155Factory internal factory;
    ERC1155Template internal impl;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal registrar = makeAddr("registrar");
    address internal launcher = makeAddr("launcher");
    address internal multisig = makeAddr("multisig");

    bytes32 internal constant BARE_CONFIG = keccak256(abi.encode("ERC1155", uint256(0)));
    uint256 internal constant FEE = 0.05 ether;

    function setUp() public {
        registry = new NameRegistry(admin, treasury, new string[](0));
        feeReceiver = new FeeReceiver(admin);
        router = new Router(
            admin, registry, IFeeReceiver(address(feeReceiver)), FEE, FEE, FEE, 0.01 ether, 0.1 ether, 0.1 ether
        );
        factory = new ERC1155Factory(admin, address(router), registrar);
        impl = new ERC1155Template();

        vm.startPrank(admin);
        router.setFactory(BaseType.ERC1155, address(factory));
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
            base: BaseType.ERC1155,
            name: name,
            ticker: ticker,
            configHash: BARE_CONFIG,
            initData: abi.encode(string("ipfs://Qm.../{id}.json"), new bytes[](0)),
            moduleCount: 1,
            installHook: false,
            installGovernance: false,
            installBondingCurve: false,
            ownership: mode,
            ownerTargetIfMultisig: mode == OwnershipMode.TransferToMultisig ? multisig : address(0),
            antiSniperBlocks: 0,
            buybackBurnBps: 0
        });
    }

    function test_E2E_LaunchBareERC1155_Renounce() public {
        LaunchParams memory p = _params("Multi Items", "MULT", OwnershipMode.Renounce);
        address predicted = factory.predictAddress(launcher, p.name, p.ticker, BARE_CONFIG);

        vm.prank(launcher);
        address token = router.launch{value: FEE}(p);

        assertEq(token, predicted);
        ERC1155Template t = ERC1155Template(token);
        assertEq(t.name(), "Multi Items");
        assertEq(t.symbol(), "MULT");
        assertEq(t.uri(0), "ipfs://Qm.../{id}.json");
        assertEq(t.owner(), address(0)); // renounced

        bytes32 nameHash = keccak256(bytes("multi items"));
        assertEq(registry.reservationOf(nameHash).token, token);
        assertEq(address(feeReceiver).balance, FEE);
    }

    function test_E2E_LaunchBareERC1155_KeepEOA_ThenMint() public {
        LaunchParams memory p = _params("Mintable", "MTBL", OwnershipMode.KeepEOA);

        vm.prank(launcher);
        address token = router.launch{value: FEE}(p);

        ERC1155Template t = ERC1155Template(token);
        assertEq(t.owner(), launcher);

        // Launcher mints single + batch.
        vm.prank(launcher);
        t.mint(launcher, 1, 100, "");
        assertEq(t.balanceOf(launcher, 1), 100);

        uint256[] memory ids = new uint256[](2);
        ids[0] = 2;
        ids[1] = 3;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 50;
        amounts[1] = 25;
        vm.prank(launcher);
        t.mintBatch(launcher, ids, amounts, "");
        assertEq(t.balanceOf(launcher, 2), 50);
        assertEq(t.balanceOf(launcher, 3), 25);
    }

    function test_E2E_LaunchBareERC1155_TransferToMultisig() public {
        LaunchParams memory p = _params("Multi", "MLT", OwnershipMode.TransferToMultisig);
        vm.prank(launcher);
        address token = router.launch{value: FEE}(p);
        assertEq(ERC1155Template(token).owner(), multisig);
    }
}
