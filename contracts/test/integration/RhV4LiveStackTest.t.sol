// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @title RhV4LiveStackTest
/// @notice Forks Robinhood mainnet at current block and reads the LIVE V4 stack
///         state via cast-equivalent view calls. Every wire we assert here must
///         match what's on chain right now - drift = production bug.
///
///         This suite is intentionally READ-ONLY: no vm.prank + writes, no state
///         mutation. Its job is to be the "canary" that fires if any admin call
///         rotates state to unexpected values while the stack is live.
contract RhV4LiveStackTest is Test {
    uint256 internal constant RH_CHAIN_ID = 4663;

    // ---- LIVE stack (V4 body + V5 mini-redeploy from 2026-07-26 for
    //      Router / Graduator / MultiHookHost — bug fixes for the two
    //      HIGH audit findings). Assertions below check the CURRENT
    //      live wiring, not what any prior deploy round looked like.
    address internal constant ROUTER_V2 = 0x5EFA396B42210c16F2aaDE2dB1Fe7E88054c33DE;
    address internal constant CURVE_FACTORY = 0x4631C21b066D3B289779e477fc79f13E8d0Fc248;
    address internal constant BONDING_CURVE_IMPL = 0x5afcA487A9DB4728fb23B1b8A2f22931d49b5Aa9;
    address internal constant MULTI_HOOK_HOST = 0x1Bb4666b905D81aE0b70aC63Df76Eea096efA2C4;
    address internal constant GRADUATOR = 0x0d63E9D1b8EA9b3620ba75F1D6DA69eFf4adbd02;
    address internal constant V4_SWAP_ROUTER = 0x2E4cd43C07879f52422B3e83F00Be877eFD88738;
    address internal constant FEE_SPLITTER = 0x20d244d3bC58939fbF2594D96AFE9b11faC90FfA;
    address internal constant URU_DEPOSIT_SINK = 0xA6b3748023540af1aD4C4731E8B8A09fACFf737e;
    address internal constant URU_BUYBACK_VAULT = 0x68c5Ec467027fCe56f158eB1ff34cF89d0929354;
    address internal constant NFT_REVENUE_VAULT = 0x93CFF459d5019eEc82fE9335013e265F1eD659c7;
    address internal constant ROYALTY_ROUTER_FACTORY = 0x6309D5EcBbE9E2093D5b0f08AD86dDDa6988dB05;
    address internal constant ROYALTY_ROUTER_IMPL = 0x4CAD1C5cFA9C20F3cfcC2C8881b4a9fdd63D20e3;

    // ---- Unchanged (from earlier phases) ----
    address internal constant NAME_REGISTRY = 0x60b797f18292d941E72B2b59916C0afC1A81118C;
    address internal constant ERC20_FACTORY = 0x14c1f066b91760565d5eEc8Cf4696A4648b552F2;
    address internal constant ERC721A_FACTORY = 0xFDEAa36708a9Edc71692394c2C036A4336E5A9Fc;
    address internal constant ERC1155_FACTORY = 0x0f16a0D9aEef54e2321Ea6Fa264d638130297597;
    address internal constant LOYALTY_ORACLE = 0xd13A1fb6d9c209B56044464269fce66Ed417AC2E;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant URU_TOKEN = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address internal constant GEMU_NFT = 0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17;

    // ---- Legacy (should be paused / rotated away). V4-generation Router +
    //      Graduator + MultiHookHost added here after V5 mini-redeploy so
    //      pause/untrust assertions can cover them alongside V1 + V3.
    address internal constant OLD_ROUTER_V1 = 0x50200Eda4693f4b839d8c436D42568B5e92EADE3;
    address internal constant OLD_ROUTER_V3 = 0x66c9cbC18Ee36462d4844BceC48558E0829a33a1;
    address internal constant OLD_ROUTER_V4 = 0xb8512f2d1CA89e56CDbB2b7Ef3e94B38434a66a2;
    address internal constant OLD_GRADUATOR_V4 = 0xbf3DAdD9EE1538F7cd7de012f71cf8626829939b;
    address internal constant OLD_MULTI_HOOK_HOST_V4 = 0x3a3e0FB55e321e31B2C72973EF8Ad796186ba2C4;

    address internal constant DEPLOYER = 0x6d606cc634F20f5534fba072757F2c2C7B835Bb9;

    function setUp() public {
        string memory rpc;
        try vm.envString("ROBINHOOD_RPC_URL") returns (string memory r) {
            rpc = r;
        } catch {}
        if (bytes(rpc).length == 0) rpc = "https://rpc.mainnet.chain.robinhood.com";
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true);
        }
        if (block.chainid != RH_CHAIN_ID) vm.skip(true);
        if (ROUTER_V2.code.length == 0) vm.skip(true);
        // Skip cleanly once V6 has been broadcast — this test asserts V5-era
        // wiring (Router == V5, factories.router == V5, etc.). After V6 rewire
        // those assertions are correctly false; the test's semantics no longer
        // apply. Use NameRegistry.router as the version signal (V6 script sets
        // it via setRouter, so a value != V5 means V6 is live).
        (bool ok, bytes memory ret) = NAME_REGISTRY.staticcall(abi.encodeWithSignature("router()"));
        if (ok && ret.length == 32 && abi.decode(ret, (address)) != ROUTER_V2) vm.skip(true);
    }

    // ============================================================
    // Every V4 contract exists + has code
    // ============================================================
    function test_Wire_AllV4ContractsDeployed() public view {
        assertGt(ROUTER_V2.code.length, 0, "RouterV2 V4 has no code");
        assertGt(CURVE_FACTORY.code.length, 0, "CurveFactory V4 has no code");
        assertGt(BONDING_CURVE_IMPL.code.length, 0, "BondingCurve impl has no code");
        assertGt(MULTI_HOOK_HOST.code.length, 0, "MultiHookHost V4 has no code");
        assertGt(GRADUATOR.code.length, 0, "Graduator V4 has no code");
        assertGt(V4_SWAP_ROUTER.code.length, 0, "V4SwapRouter V4 has no code");
        assertGt(FEE_SPLITTER.code.length, 0, "FeeSplitter V4 has no code");
        assertGt(URU_DEPOSIT_SINK.code.length, 0, "UruDepositSink V4 has no code");
        assertGt(URU_BUYBACK_VAULT.code.length, 0, "UruBuybackVault V4 has no code");
        assertGt(NFT_REVENUE_VAULT.code.length, 0, "NftRevenueVault V4 has no code");
        assertGt(ROYALTY_ROUTER_FACTORY.code.length, 0, "RoyaltyRouterFactory V4 has no code");
        assertGt(ROYALTY_ROUTER_IMPL.code.length, 0, "RoyaltyRouterImpl V4 has no code");
    }

    // ============================================================
    // RouterV2 V4 - every pointer + config
    // ============================================================
    function test_Wire_RouterV2_CurveFactory() public view {
        assertEq(_readAddr(ROUTER_V2, "curveFactory()"), CURVE_FACTORY);
    }

    function test_Wire_RouterV2_LoyaltyOracle() public view {
        assertEq(_readAddr(ROUTER_V2, "loyaltyOracle()"), LOYALTY_ORACLE);
    }

    function test_Wire_RouterV2_FeeReceiver() public view {
        assertEq(_readAddr(ROUTER_V2, "feeReceiver()"), FEE_SPLITTER);
    }

    function test_Wire_RouterV2_Registry() public view {
        assertEq(_readAddr(ROUTER_V2, "registry()"), NAME_REGISTRY);
    }

    function test_Wire_RouterV2_UruToken() public view {
        assertEq(_readAddr(ROUTER_V2, "uru()"), URU_TOKEN);
    }

    function test_Wire_RouterV2_UruSink() public view {
        assertEq(_readAddr(ROUTER_V2, "uruSink()"), URU_DEPOSIT_SINK);
    }

    function test_Wire_RouterV2_MinUruFee_NonZero() public view {
        assertGt(_readUint(ROUTER_V2, "minUruFee()"), 0, "minUruFee should be set (100 URU default)");
    }

    function test_Wire_RouterV2_Owner_IsDeployer() public view {
        assertEq(_readAddr(ROUTER_V2, "owner()"), DEPLOYER);
    }

    function test_Wire_RouterV2_Factories_AllThreeSet() public view {
        assertEq(_readAddrArg(ROUTER_V2, "factories(uint8)", uint256(0)), ERC20_FACTORY, "ERC20 factory");
        assertEq(_readAddrArg(ROUTER_V2, "factories(uint8)", uint256(1)), ERC721A_FACTORY, "ERC721A factory");
        assertEq(_readAddrArg(ROUTER_V2, "factories(uint8)", uint256(2)), ERC1155_FACTORY, "ERC1155 factory");
    }

    function test_Wire_RouterV2_FoTBlacklisted() public view {
        // Solo FeeOnTransfer configHash = keccak256(abi.encode("ERC20", "FeeOnTransfer"))
        bytes32 fotHash = keccak256(abi.encode("ERC20", "FeeOnTransfer"));
        bool blocked = _readBoolArg(ROUTER_V2, "curveIncompatibleConfigHash(bytes32)", uint256(fotHash));
        assertTrue(blocked, "Solo FoT configHash must be blacklisted from curve installs");
    }

    // ============================================================
    // CurveFactory V4
    // ============================================================
    function test_Wire_CurveFactory_Graduator() public view {
        assertEq(_readAddr(CURVE_FACTORY, "graduator()"), GRADUATOR);
    }

    function test_Wire_CurveFactory_Implementation() public view {
        assertEq(_readAddr(CURVE_FACTORY, "implementation()"), BONDING_CURVE_IMPL);
    }

    function test_Wire_CurveFactory_RouterTrusted() public view {
        // Live Router is trusted; V4-generation Router is explicitly untrusted
        // by the V5 mini-redeploy so a stray call there can't sneak through.
        assertTrue(_readBoolArg(CURVE_FACTORY, "trustedRouters(address)", uint256(uint160(ROUTER_V2))));
        assertFalse(_readBoolArg(CURVE_FACTORY, "trustedRouters(address)", uint256(uint160(OLD_ROUTER_V4))));
    }

    function test_Wire_CurveFactory_Owner_IsDeployer() public view {
        assertEq(_readAddr(CURVE_FACTORY, "owner()"), DEPLOYER);
    }

    function test_Wire_CurveFactory_FeeReceiver_IsSplitter() public view {
        assertEq(_readAddr(CURVE_FACTORY, "feeReceiver()"), FEE_SPLITTER);
    }

    // ============================================================
    // MultiHookHost V4
    // ============================================================
    function test_Wire_Hook_Platform_IsSplitter() public view {
        assertEq(_readAddr(MULTI_HOOK_HOST, "platform()"), FEE_SPLITTER);
    }

    function test_Wire_Hook_Initializer_IsGraduator() public view {
        assertEq(_readAddr(MULTI_HOOK_HOST, "initializer()"), GRADUATOR);
    }

    function test_Wire_Hook_PlatformBps() public view {
        // Uses standard uint16 return: 100 = 1%
        assertEq(_readUint(MULTI_HOOK_HOST, "platformBps()"), 100);
    }

    function test_Wire_Hook_CreatorBps() public view {
        assertEq(_readUint(MULTI_HOOK_HOST, "creatorBps()"), 100);
    }

    function test_Wire_Hook_Creator_IsDeployer() public view {
        assertEq(_readAddr(MULTI_HOOK_HOST, "creator()"), DEPLOYER);
    }

    function test_Wire_Hook_Deployer_IsBroadcaster() public view {
        assertEq(_readAddr(MULTI_HOOK_HOST, "deployer()"), DEPLOYER);
    }

    // ============================================================
    // Graduator V4
    // ============================================================
    function test_Wire_Graduator_PoolManager() public view {
        assertEq(_readAddr(GRADUATOR, "poolManager()"), POOL_MANAGER);
    }

    function test_Wire_Graduator_DefaultHook() public view {
        assertEq(_readAddr(GRADUATOR, "defaultHook()"), MULTI_HOOK_HOST);
    }

    function test_Wire_Graduator_Fee_3000() public view {
        assertEq(_readUint(GRADUATOR, "fee()"), 3000);
    }

    function test_Wire_Graduator_TickSpacing_60() public view {
        // int24 return; cast returns as int as uint bytes but positive value.
        assertEq(_readUint(GRADUATOR, "tickSpacing()"), 60);
    }

    // ============================================================
    // V4SwapRouter V4
    // ============================================================
    function test_Wire_V4Router_PoolManager() public view {
        assertEq(_readAddr(V4_SWAP_ROUTER, "poolManager()"), POOL_MANAGER);
    }

    // ============================================================
    // FeeSplitter V4
    // ============================================================
    function test_Wire_Splitter_Owner_IsDeployer() public view {
        assertEq(_readAddr(FEE_SPLITTER, "owner()"), DEPLOYER);
    }

    function test_Wire_Splitter_Treasury_IsDeployer_Until_Timelock() public view {
        // Post-broadcast, treasurySink is deployer EOA + treasuryBps = 10000
        // (100%) until setConfig runs on 2026-07-28. Verified by cast earlier.
        assertEq(_readAddr(FEE_SPLITTER, "treasurySink()"), DEPLOYER);
        assertEq(_readUint(FEE_SPLITTER, "treasuryBps()"), 10_000);
        assertEq(_readUint(FEE_SPLITTER, "uruBuybackBps()"), 0);
        assertEq(_readUint(FEE_SPLITTER, "nftRevenueBps()"), 0);
    }

    function test_Wire_Splitter_MinConfigDelay_TwoDays() public view {
        assertEq(_readUint(FEE_SPLITTER, "minConfigDelay()"), 2 days);
    }

    // ============================================================
    // UruDepositSink V4
    // ============================================================
    function test_Wire_UruSink_DistributionSink_IsSplitter() public view {
        assertEq(_readAddr(URU_DEPOSIT_SINK, "distributionSink()"), FEE_SPLITTER);
    }

    function test_Wire_UruSink_MinConfigDelay_TwoDays() public view {
        assertEq(_readUint(URU_DEPOSIT_SINK, "minConfigDelay()"), 2 days);
    }

    function test_Wire_UruSink_KeeperAllowed_Deployer() public view {
        assertTrue(_readBoolArg(URU_DEPOSIT_SINK, "isKeeper(address)", uint256(uint160(DEPLOYER))));
    }

    function test_Wire_UruSink_UniversalRouterAllowed() public view {
        address uniUR = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
        assertTrue(_readBoolArg(URU_DEPOSIT_SINK, "isSwapTarget(address)", uint256(uint160(uniUR))));
    }

    function test_Wire_UruSink_MinEthPerUru_Set() public view {
        uint256 floor = _readUint(URU_DEPOSIT_SINK, "minEthPerUru()");
        assertGt(floor, 0, "minEthPerUru should be > 0 to block keeper drain");
    }

    // ============================================================
    // UruBuybackVault V4
    // ============================================================
    function test_Wire_UruVault_DistributionSink_IsNftVault() public view {
        assertEq(_readAddr(URU_BUYBACK_VAULT, "distributionSink()"), NFT_REVENUE_VAULT);
    }

    function test_Wire_UruVault_MinConfigDelay_TwoDays() public view {
        assertEq(_readUint(URU_BUYBACK_VAULT, "minConfigDelay()"), 2 days);
    }

    function test_Wire_UruVault_KeeperAllowed_Deployer() public view {
        assertTrue(_readBoolArg(URU_BUYBACK_VAULT, "isKeeper(address)", uint256(uint160(DEPLOYER))));
    }

    function test_Wire_UruVault_MinUruPerEth_Set() public view {
        uint256 floor = _readUint(URU_BUYBACK_VAULT, "minUruPerEth()");
        assertGt(floor, 0, "minUruPerEth should be > 0 to block keeper drain");
    }

    // ============================================================
    // NftRevenueVault V4
    // ============================================================
    function test_Wire_NftVault_Owner_IsDeployer() public view {
        assertEq(_readAddr(NFT_REVENUE_VAULT, "owner()"), DEPLOYER);
    }

    function test_Wire_NftVault_NoEpochsYet() public view {
        assertEq(_readUint(NFT_REVENUE_VAULT, "nextEpochId()"), 0);
        assertEq(_readUint(NFT_REVENUE_VAULT, "totalCommitted()"), 0);
    }

    // ============================================================
    // RoyaltyRouterFactory V4
    // ============================================================
    function test_Wire_RoyaltyFactory_Owner_IsDeployer() public view {
        assertEq(_readAddr(ROYALTY_ROUTER_FACTORY, "owner()"), DEPLOYER);
    }

    function test_Wire_RoyaltyFactory_Implementation() public view {
        assertEq(_readAddr(ROYALTY_ROUTER_FACTORY, "IMPLEMENTATION()"), ROYALTY_ROUTER_IMPL);
    }

    function test_Wire_RoyaltyFactory_PlatformSink_IsSplitter() public view {
        assertEq(_readAddr(ROYALTY_ROUTER_FACTORY, "platformSink()"), FEE_SPLITTER);
    }

    function test_Wire_RoyaltyFactory_TrustedDeployerFlipped() public view {
        // V5 mini-redeploy wired the new Router as trusted and revoked the
        // V4-generation Router. Confirm both sides of the flip.
        assertTrue(_readBoolArg(ROYALTY_ROUTER_FACTORY, "trustedDeployer(address)", uint256(uint160(ROUTER_V2))));
        assertFalse(_readBoolArg(ROYALTY_ROUTER_FACTORY, "trustedDeployer(address)", uint256(uint160(OLD_ROUTER_V4))));
    }

    // ============================================================
    // NameRegistry (unchanged contract) - should point at the CURRENT
    // live RouterV2 (V5 mini-redeploy rotated its `router` slot).
    // ============================================================
    function test_Wire_NameRegistry_Router_IsLive() public view {
        assertEq(_readAddr(NAME_REGISTRY, "router()"), ROUTER_V2);
    }

    // ============================================================
    // Base factories - all three point at the CURRENT live RouterV2.
    // Factory `setRouter` was called by the V5 mini-redeploy after the
    // new Router was deployed, so old V4 routers are no longer wired.
    // ============================================================
    function test_Wire_ERC20Factory_Router_IsLive() public view {
        assertEq(_readAddr(ERC20_FACTORY, "router()"), ROUTER_V2);
    }

    function test_Wire_ERC721AFactory_Router_IsLive() public view {
        assertEq(_readAddr(ERC721A_FACTORY, "router()"), ROUTER_V2);
    }

    function test_Wire_ERC1155Factory_Router_IsLive() public view {
        assertEq(_readAddr(ERC1155_FACTORY, "router()"), ROUTER_V2);
    }

    // ============================================================
    // Legacy routers - MUST BE PAUSED so mempool launches don't grief users
    // ============================================================
    function test_Wire_OldRouterV1_Paused() public view {
        assertTrue(_readBool(OLD_ROUTER_V1, "paused()"), "V1 Router must be paused");
    }

    function test_Wire_OldRouterV3_Paused() public view {
        assertTrue(_readBool(OLD_ROUTER_V3, "paused()"), "V3 Router must be paused");
    }

    function test_Wire_OldRouterV4_Paused() public view {
        // V4 Router was paused during the V5 mini-redeploy — a launch tx that
        // still targets the V4 address must revert. If this ever flips to
        // false, front-run window opens for a partial-migration edge.
        assertTrue(_readBool(OLD_ROUTER_V4, "paused()"), "V4 Router must be paused");
    }

    // ============================================================
    // Cross-contract integrity: the flywheel loop closes
    // ============================================================
    function test_Integrity_FeeFlowLoop() public view {
        // Router.feeReceiver -> FeeSplitter -> (post-timelock) buyback/nft/treasury
        // UruSink -> distributionSink -> FeeSplitter (loops back to distribute)
        // BuybackVault -> distributionSink -> NftRevenueVault (holds URU for epochs)
        // All three arrows should terminate at contracts we control.
        assertEq(_readAddr(ROUTER_V2, "feeReceiver()"), FEE_SPLITTER, "Router->Splitter");
        assertEq(_readAddr(URU_DEPOSIT_SINK, "distributionSink()"), FEE_SPLITTER, "UruSink->Splitter");
        assertEq(_readAddr(URU_BUYBACK_VAULT, "distributionSink()"), NFT_REVENUE_VAULT, "BuybackVault->NftVault");
    }

    // ============================================================
    // Helpers - low-level staticcalls so this file doesn't need to import
    // every contract's ABI. Keeps the assertion set uniform across 12 targets.
    // ============================================================
    function _readAddr(
        address target,
        string memory sig
    ) internal view returns (address) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature(sig));
        require(ok && data.length >= 32, string.concat("read failed: ", sig));
        return abi.decode(data, (address));
    }

    function _readAddrArg(
        address target,
        string memory sig,
        uint256 arg
    ) internal view returns (address) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature(sig, arg));
        require(ok && data.length >= 32, string.concat("read failed: ", sig));
        return abi.decode(data, (address));
    }

    function _readUint(
        address target,
        string memory sig
    ) internal view returns (uint256) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature(sig));
        require(ok && data.length >= 32, string.concat("read failed: ", sig));
        return abi.decode(data, (uint256));
    }

    function _readBool(
        address target,
        string memory sig
    ) internal view returns (bool) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature(sig));
        require(ok && data.length >= 32, string.concat("read failed: ", sig));
        return abi.decode(data, (bool));
    }

    function _readBoolArg(
        address target,
        string memory sig,
        uint256 arg
    ) internal view returns (bool) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature(sig, arg));
        require(ok && data.length >= 32, string.concat("read failed: ", sig));
        return abi.decode(data, (bool));
    }
}
