// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

import {Router, BaseType} from "src/router/Router.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {Graduator} from "src/curve/Graduator.sol";
import {MultiHookHost} from "src/hooks/MultiHookHost.sol";
import {BaseHook} from "src/hooks/BaseHook.sol";

/// @notice Read-only script that verifies a deployed launchpad stack on the target chain
///         is wired end-to-end. Meant to run BEFORE a mainnet handoff — every assertion
///         that fails would surface as an outage later.
///
///         What it checks:
///           1. Every address in `deployment.<chainid>.json` + hooks + graduator books has
///              non-empty runtime bytecode (contract exists + isn't self-destructed).
///           2. Router.factories[ERC20/721A/1155] point at the factory addresses in the book.
///           3. Router.curveFactory == deployment.CurveFactory.
///           4. CurveFactory.graduator == deployment-graduator.Graduator (the wire we set
///              via `WIRE_INTO_FACTORY=1` at deploy time).
///           5. Graduator.poolManager + .defaultHook match the hooks book's PoolManager +
///              MultiHookHost, at the fee + tickSpacing this chain deployed with.
///           6. MultiHookHost.getHookPermissions() has the exact flag mask we need
///              (BEFORE_REMOVE_LIQUIDITY | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA), and the
///              hook's address low bits encode that same mask (v4 gates on this).
///           7. Router.owner() + CurveFactory.owner() prints — you must eyeball whether
///              that owner is the multisig you expected (script prints, doesn't assert,
///              because "the right multisig" is per-deploy).
///
/// Usage:
///   forge script script/VerifyWiring.s.sol:VerifyWiring --rpc-url $BASE_SEPOLIA_RPC_URL --sig 'run()'
///   pnpm contracts:verify:wiring base-sepolia
contract VerifyWiring is Script {
    using stdJson for string;

    function run() external {
        uint256 chainId = block.chainid;
        console2.log("======================================================");
        console2.log("VerifyWiring @ chain", chainId);
        console2.log("======================================================");

        // 1. Load the three address books this chain should have.
        string memory core = _readBook(string.concat("deployment.", vm.toString(chainId), ".json"), "phase1");
        string memory hooksBook = _readBook(string.concat("deployment-hooks.", vm.toString(chainId), ".json"), "hooks");
        string memory gradBook =
            _readBook(string.concat("deployment-graduator.", vm.toString(chainId), ".json"), "graduator");

        address router = core.readAddress(".Router");
        address curveFactory = core.readAddress(".CurveFactory");
        address erc20F = core.readAddress(".ERC20Factory");
        address erc721aF = core.readAddress(".ERC721AFactory");
        address erc1155F = core.readAddress(".ERC1155Factory");
        address nameReg = core.readAddress(".NameRegistry");

        address poolManager = hooksBook.readAddress(".PoolManager");
        address multiHook = hooksBook.readAddress(".MultiHookHost");
        address lpLocked = hooksBook.readAddress(".LPLockedHook");
        address feeRedir = hooksBook.readAddress(".FeeRedirectHook");
        address antiSnipe = hooksBook.readAddress(".AntiSniperHook");
        address bbBurn = hooksBook.readAddress(".BuybackBurnHook");

        address graduator = gradBook.readAddress(".Graduator");

        console2.log("\n[1/6] All contracts have runtime code:");
        _assertHasCode("Router          ", router);
        _assertHasCode("CurveFactory    ", curveFactory);
        _assertHasCode("ERC20Factory    ", erc20F);
        _assertHasCode("ERC721AFactory  ", erc721aF);
        _assertHasCode("ERC1155Factory  ", erc1155F);
        _assertHasCode("NameRegistry    ", nameReg);
        _assertHasCode("PoolManager     ", poolManager);
        _assertHasCode("MultiHookHost   ", multiHook);
        _assertHasCode("LPLockedHook    ", lpLocked);
        _assertHasCode("FeeRedirectHook ", feeRedir);
        _assertHasCode("AntiSniperHook  ", antiSnipe);
        _assertHasCode("BuybackBurnHook ", bbBurn);
        _assertHasCode("Graduator       ", graduator);

        console2.log("\n[2/6] Router.factories[base] wiring:");
        Router r = Router(payable(router));
        _assertEq("factories[ERC20]  ", address(r.factories(BaseType.ERC20)), erc20F);
        _assertEq("factories[ERC721A]", address(r.factories(BaseType.ERC721A)), erc721aF);
        _assertEq("factories[ERC1155]", address(r.factories(BaseType.ERC1155)), erc1155F);

        console2.log("\n[3/6] Router.curveFactory wiring:");
        _assertEq("Router.curveFactory", r.curveFactory(), curveFactory);

        console2.log("\n[4/6] CurveFactory.graduator wiring:");
        CurveFactory cf = CurveFactory(curveFactory);
        _assertEq("CurveFactory.graduator", cf.graduator(), graduator);

        console2.log("\n[5/6] Graduator wiring:");
        Graduator g = Graduator(payable(graduator));
        _assertEq("Graduator.poolManager ", address(g.poolManager()), poolManager);
        _assertEq("Graduator.defaultHook ", address(g.defaultHook()), multiHook);
        console2.log("Graduator.fee         :", g.fee());
        console2.log("Graduator.tickSpacing :", vm.toString(g.tickSpacing()));

        console2.log("\n[6/6] MultiHookHost permissions + address flag mask:");
        MultiHookHost h = MultiHookHost(payable(multiHook));
        BaseHook.Permissions memory perms = h.getHookPermissions();
        require(perms.beforeRemoveLiquidity, "MultiHookHost: missing beforeRemoveLiquidity");
        require(perms.afterSwap, "MultiHookHost: missing afterSwap");
        require(perms.afterSwapReturnDelta, "MultiHookHost: missing afterSwapReturnDelta");
        console2.log("  permissions OK  (beforeRemove + afterSwap + afterSwapReturnDelta)");

        uint160 wantMask =
            Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        uint160 addrLowBits = uint160(multiHook) & uint160(0x3FFF); // v4 uses low 14 bits
        require(addrLowBits & wantMask == wantMask, "MultiHookHost: addr flag mask missing bits");
        console2.log("  addr flag mask OK (encodes 0x", vm.toString(bytes32(uint256(wantMask))));

        console2.log("\n[Ownership -- eyeball these]:");
        console2.log("  Router.owner()       :", r.owner());
        console2.log("  CurveFactory.owner() :", cf.owner());
        console2.log("  (if either equals your deploy key, HandoffOwnership hasn't run yet)");

        console2.log("\n======================================================");
        console2.log("All wiring checks PASSED for chain", chainId);
        console2.log("======================================================");
    }

    function _readBook(
        string memory path,
        string memory label
    ) internal view returns (string memory) {
        try vm.readFile(path) returns (string memory data) {
            return data;
        } catch {
            revert(string.concat("VerifyWiring: missing ", label, " book at ", path));
        }
    }

    function _assertHasCode(
        string memory label,
        address a
    ) internal view {
        require(a != address(0), string.concat(label, " address is zero"));
        require(a.code.length > 0, string.concat(label, " has no runtime code at ", vm.toString(a)));
        console2.log("  ", label, vm.toString(a));
    }

    function _assertEq(
        string memory label,
        address got,
        address want
    ) internal pure {
        require(got == want, string.concat(label, ": mismatch"));
        // Log to give a trail even on success — cheap for a read-only script.
        console2.log("  ", label, vm.toString(got));
    }
}
