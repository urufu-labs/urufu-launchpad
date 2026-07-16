// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {CurveFactory} from "src/curve/CurveFactory.sol";
import {BondingCurve} from "src/curve/BondingCurve.sol";
import {ERC20Factory} from "src/factories/ERC20Factory.sol";
import {ERC20WithAirdropGen} from "src/templates/composed/ERC20WithAirdropGen.sol";
import {ERC20WithVestingGen} from "src/templates/composed/ERC20WithVestingGen.sol";
import {ERC20WithStakingGen} from "src/templates/composed/ERC20WithStakingGen.sol";
import {ERC20WithAirdropVestingGen} from "src/templates/composed/ERC20WithAirdropVestingGen.sol";
import {ERC20WithAirdropPermitGen} from "src/templates/composed/ERC20WithAirdropPermitGen.sol";
import {ERC20WithAirdropVotesGen} from "src/templates/composed/ERC20WithAirdropVotesGen.sol";
import {ERC20WithPermitVestingGen} from "src/templates/composed/ERC20WithPermitVestingGen.sol";
import {ERC20WithPermitStakingGen} from "src/templates/composed/ERC20WithPermitStakingGen.sol";

interface IRouter {
    function setCurveFactory(
        address factory
    ) external;
    function curveFactory() external view returns (address);
}

/// @title  MigrateToV2Templates
/// @notice One-shot V2 template migration per chain. Broadcasts:
///
///   1. New CurveFactory (with `pull actual balance` logic) — copies defaults
///      + feeReceiver + graduator from the old factory so behavior stays
///      identical for non-reserve launches. Old CurveFactory keeps working
///      forever for existing tokens (frontend reads curves from indexer, so
///      no dangling reads).
///
///   2. Router.setCurveFactory(new CF) — new launches route through V2.
///
///   3. Deploys 8 fresh V2 template impls and registers them on the EXISTING
///      ERC20Factory under NEW configHashes (frontend uses `at-version` suffix
///      for tuples containing V2 modules — see `web/src/lib/modules.ts`).
///      Old configHashes still resolve to their old (v1) impls. Old tokens
///      unaffected.
///
///   4. Idempotent: if an impl is already registered under its computed hash,
///      the registerImpl call reverts (AlreadyRegistered) which halts the
///      script cleanly — re-runs are safe as long as prior V2 deploys landed.
///
/// Env vars:
///   EXISTING_ROUTER          — Router address on this chain (required)
///   EXISTING_ERC20_FACTORY   — ERC20Factory address (required)
///   EXISTING_CURVE_FACTORY   — old CurveFactory address to read defaults from
///   EXISTING_FEE_RECEIVER    — FeeReceiver address (needed for new CF ctor)
///   EXISTING_CURVE_IMPL      — BondingCurve impl (same across CF versions)
///   EXISTING_GRADUATOR       — V3 Graduator to wire into new CF
///   WIRE_INTO_ROUTER         — "1" to also call router.setCurveFactory
///
/// Broadcast:
///   bash contracts/deploy.sh MigrateToV2Templates base
contract MigrateToV2Templates is Script {
    // The 8 configHashes the frontend will emit for V2 tuples. Kept as constants
    // so the broadcast has a clear inventory + operators can grep-verify against
    // frontend `configHashFor` output before signing.
    //
    // Formula (must match `web/src/lib/modules.ts:configHashFor`):
    //   keccak256(abi.encode("ERC20", sortedTaggedModuleIds.join(',')))
    //     where each id → "id at version"
    //     versions: Airdrop=2, Vesting=2, Staking=2, Permit=1, Votes=1
    bytes32 internal AIRDROP_V2 = keccak256(abi.encode("ERC20", "Airdrop@2"));
    bytes32 internal VESTING_V2 = keccak256(abi.encode("ERC20", "Vesting@2"));
    bytes32 internal STAKING_V2 = keccak256(abi.encode("ERC20", "Staking@2"));
    bytes32 internal AIRDROP_VESTING_V2 = keccak256(abi.encode("ERC20", "Airdrop@2,Vesting@2"));
    bytes32 internal AIRDROP_PERMIT_V2 = keccak256(abi.encode("ERC20", "Airdrop@2,Permit@1"));
    bytes32 internal AIRDROP_VOTES_V2 = keccak256(abi.encode("ERC20", "Airdrop@2,Votes@1"));
    bytes32 internal PERMIT_VESTING_V2 = keccak256(abi.encode("ERC20", "Permit@1,Vesting@2"));
    bytes32 internal PERMIT_STAKING_V2 = keccak256(abi.encode("ERC20", "Permit@1,Staking@2"));

    struct Deployed {
        address newCurveFactory;
        address airdropImpl;
        address vestingImpl;
        address stakingImpl;
        address airdropVestingImpl;
        address airdropPermitImpl;
        address airdropVotesImpl;
        address permitVestingImpl;
        address permitStakingImpl;
    }

    function run() external returns (Deployed memory d) {
        address existingRouter = vm.envAddress("EXISTING_ROUTER");
        address erc20Factory = vm.envAddress("EXISTING_ERC20_FACTORY");
        address existingCf = vm.envAddress("EXISTING_CURVE_FACTORY");
        address feeReceiver = vm.envAddress("EXISTING_FEE_RECEIVER");
        address curveImpl = vm.envAddress("EXISTING_CURVE_IMPL");
        address graduator = vm.envAddress("EXISTING_GRADUATOR");

        // 1. Read old CurveFactory defaults so the new one is behavior-identical
        //    for launches that don't use reserve modules.
        CurveFactory oldCf = CurveFactory(existingCf);
        uint256 curveSupply = oldCf.defaultCurveSupply();
        uint256 virtualToken = oldCf.defaultVirtualTokenReserve();
        uint256 virtualEth = oldCf.defaultVirtualEthReserve();
        uint256 gradTarget = oldCf.defaultGraduationTargetEth();
        uint16 tradeFeeBps = oldCf.defaultTradeFeeBps();

        vm.startBroadcast();

        // 2. Deploy new CurveFactory with V2 pull-actual-balance logic.
        d.newCurveFactory = address(new CurveFactory(msg.sender, feeReceiver, curveImpl));
        CurveFactory newCf = CurveFactory(d.newCurveFactory);
        newCf.setDefaults(curveSupply, virtualToken, virtualEth, gradTarget, tradeFeeBps);
        newCf.setGraduator(graduator);

        // 3. Deploy the 8 V2 template impls.
        d.airdropImpl = address(new ERC20WithAirdropGen());
        d.vestingImpl = address(new ERC20WithVestingGen());
        d.stakingImpl = address(new ERC20WithStakingGen());
        d.airdropVestingImpl = address(new ERC20WithAirdropVestingGen());
        d.airdropPermitImpl = address(new ERC20WithAirdropPermitGen());
        d.airdropVotesImpl = address(new ERC20WithAirdropVotesGen());
        d.permitVestingImpl = address(new ERC20WithPermitVestingGen());
        d.permitStakingImpl = address(new ERC20WithPermitStakingGen());

        // 4. Register each impl under its V2 configHash on the existing factory.
        //    Uses registerImpl (not updateImpl) because these are NEW hashes — the
        //    v1 hashes still exist for backward compat with existing tokens.
        ERC20Factory f20 = ERC20Factory(erc20Factory);
        f20.registerImpl(AIRDROP_V2, d.airdropImpl);
        f20.registerImpl(VESTING_V2, d.vestingImpl);
        f20.registerImpl(STAKING_V2, d.stakingImpl);
        f20.registerImpl(AIRDROP_VESTING_V2, d.airdropVestingImpl);
        f20.registerImpl(AIRDROP_PERMIT_V2, d.airdropPermitImpl);
        f20.registerImpl(AIRDROP_VOTES_V2, d.airdropVotesImpl);
        f20.registerImpl(PERMIT_VESTING_V2, d.permitVestingImpl);
        f20.registerImpl(PERMIT_STAKING_V2, d.permitStakingImpl);

        // 5. Router wire — flips new launches onto the V2 CurveFactory. Guarded
        //    behind an env flag so a broadcast can be reviewed pre-flip when the
        //    operator wants to inspect the new CF before committing.
        if (vm.envOr("WIRE_INTO_ROUTER", uint256(0)) == 1) {
            IRouter(existingRouter).setCurveFactory(d.newCurveFactory);
            console2.log("  [done] Router.setCurveFactory ->", d.newCurveFactory);
        } else {
            console2.log("  [pending] Router.setCurveFactory NOT called (WIRE_INTO_ROUTER=0).");
            console2.log("  Next: owner runs router.setCurveFactory(", d.newCurveFactory, ")");
        }

        vm.stopBroadcast();

        _logSummary(d);
        _writeBook(d);
    }

    function _logSummary(
        Deployed memory d
    ) internal view {
        console2.log("=========================================================");
        console2.log("V2 templates migration");
        console2.log("=========================================================");
        console2.log("  chainid:                     ", block.chainid);
        console2.log("  new CurveFactory:            ", d.newCurveFactory);
        console2.log("  V2 impls registered under new configHashes:");
        console2.log("    Airdrop@2:                 ", d.airdropImpl);
        console2.log("    Vesting@2:                 ", d.vestingImpl);
        console2.log("    Staking@2:                 ", d.stakingImpl);
        console2.log("    Airdrop@2,Vesting@2:       ", d.airdropVestingImpl);
        console2.log("    Airdrop@2,Permit@1:        ", d.airdropPermitImpl);
        console2.log("    Airdrop@2,Votes@1:         ", d.airdropVotesImpl);
        console2.log("    Permit@1,Vesting@2:        ", d.permitVestingImpl);
        console2.log("    Permit@1,Staking@2:        ", d.permitStakingImpl);
        console2.log("---------------------------------------------------------");
        console2.log("Old CurveFactory keeps working for existing tokens (frontend");
        console2.log("reads curves from indexer, so no dangling reads on legacy");
        console2.log("tokens). Old v1 configHashes still resolve to old impls on");
        console2.log("the ERC20Factory -- no breakage for existing launches.");
    }

    function _writeBook(
        Deployed memory d
    ) internal {
        string memory obj = "v2Templates";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "CurveFactoryV2", d.newCurveFactory);
        vm.serializeAddress(obj, "ERC20WithAirdropImpl", d.airdropImpl);
        vm.serializeAddress(obj, "ERC20WithVestingImpl", d.vestingImpl);
        vm.serializeAddress(obj, "ERC20WithStakingImpl", d.stakingImpl);
        vm.serializeAddress(obj, "ERC20WithAirdropVestingImpl", d.airdropVestingImpl);
        vm.serializeAddress(obj, "ERC20WithAirdropPermitImpl", d.airdropPermitImpl);
        vm.serializeAddress(obj, "ERC20WithAirdropVotesImpl", d.airdropVotesImpl);
        vm.serializeAddress(obj, "ERC20WithPermitVestingImpl", d.permitVestingImpl);
        string memory json = vm.serializeAddress(obj, "ERC20WithPermitStakingImpl", d.permitStakingImpl);
        string memory path = string.concat("deployment-v2templates.", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("Address book written:", path);
    }
}
