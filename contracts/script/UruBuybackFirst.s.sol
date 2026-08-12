// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {Actions} from "v4-periphery/libraries/Actions.sol";
import {IV4Router} from "v4-periphery/interfaces/IV4Router.sol";

interface IERC20V {
    function balanceOf(
        address
    ) external view returns (uint256);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IUruBuybackVault {
    function executeBuyback(address swapTarget, uint256 ethIn, bytes calldata swapData, uint256 minUruOut) external;
    function distributionSink() external view returns (address);
    function minUruPerEth() external view returns (uint256);
    function isSwapTarget(
        address
    ) external view returns (bool);
    function isKeeper(
        address
    ) external view returns (bool);
}

/// @title  UruBuybackFirst
/// @notice First real URU buyback pre-launch. Reads live pool spot, computes
///         minUruOut with 2% slippage, encodes Universal Router call for
///         wrap(ETH) → v4 swap(WETH→URU) → sweep(URU→UruBuybackVault), calls
///         UruBuybackVault.executeBuyback. Vault forwards received URU to its
///         distributionSink (NftRevenueVault) so it enters the next Merkle
///         epoch to gemu holders.
///
///         Usage:
///           DEV_PRIVATE_KEY=0x... forge script script/UruBuybackFirst.s.sol \
///             --rpc-url $NEXT_PUBLIC_ROBINHOOD_RPC_URL
///           (add --broadcast to send for real; without it does fork sim + prints)
///
///         Two guards:
///           - fork-simulates first via --rpc-url alone (no state committed)
///           - buyback size is ETH_IN below, default 0.048 ETH (~half vault)
///           - script reverts if URU wouldn't land in distributionSink
contract UruBuybackFirst is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // Robinhood-chain live addresses.
    address constant BUYBACK_VAULT = 0x68c5Ec467027fCe56f158eB1ff34cF89d0929354;
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;

    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant URU = 0x9fbe210007dDd8389f98d0253018e65CC48b9D24;
    address constant URU_HOOK = 0x8933d28E68d02FaA02436aeF42E6ba9674698044;
    uint24 constant URU_POOL_FEE = 3000;
    int24 constant URU_POOL_TICK_SPACING = 60;

    // Test size — half of ~0.0974 ETH vault balance.
    uint256 constant ETH_IN = 0.048 ether;

    // Universal Router command bytes (Uniswap Commands library).
    bytes1 constant CMD_WRAP_ETH = 0x0b;
    bytes1 constant CMD_V4_SWAP = 0x10;
    bytes1 constant CMD_SWEEP = 0x04;

    // Special recipient constants understood by UR.
    address constant ADDRESS_THIS = 0x0000000000000000000000000000000000000002;
    address constant MSG_SENDER = 0x0000000000000000000000000000000000000001;

    function run() external {
        uint256 pk = vm.envUint("DEV_PRIVATE_KEY");

        // Sanity — vault pre-state.
        IUruBuybackVault vault = IUruBuybackVault(BUYBACK_VAULT);
        require(vault.isSwapTarget(UNIVERSAL_ROUTER), "UR not allowlisted");
        require(vault.isKeeper(vm.addr(pk)), "signer not keeper");
        address sink = vault.distributionSink();
        console2.log("Distribution sink (NftRevenueVault):", sink);

        // Compute pool spot rate for minUruOut sizing.
        // Off-chain sqrtPriceX96 math needs mulDiv to avoid 2^320 overflow —
        // instead we pass MIN_URU_OUT via env (computed off-chain: sqrtP^2/2^192).
        // Default = 135_000e18 (~135k URU) which is ~98% of naive at spot 2.88M
        // URU/WETH * 0.048 ETH = 138,240 URU. Bump via MIN_URU_OUT if pool moved.
        PoolKey memory poolKey = _uruPoolKey();
        uint256 minUruOut = vm.envOr("MIN_URU_OUT", uint256(135_000 * 1e18));
        console2.log("ETH_IN:                ", ETH_IN);
        console2.log("minUruOut (env-provided):", minUruOut);

        // Vault floor check (should be 0 post our earlier setMinUruPerEth call).
        uint256 floor = vault.minUruPerEth();
        console2.log("Vault minUruPerEth:", floor);
        uint256 floorRequired = (ETH_IN * floor) / 1e18;
        require(minUruOut >= floorRequired, "minUruOut below vault floor");

        // Build Universal Router execute() call. Only 2 commands: WRAP_ETH +
        // V4_SWAP. TAKE_ALL inside V4_SWAP delivers URU directly to MSG_SENDER
        // (= UruBuybackVault). SWEEP is redundant and reverted (router had 0
        // URU left after TAKE_ALL) — so we drop it.
        bytes memory commands = abi.encodePacked(CMD_WRAP_ETH, CMD_V4_SWAP);
        bytes[] memory inputs = new bytes[](2);

        // input 0: WRAP_ETH — wraps ADDRESS_THIS's incoming ETH into WETH held by router.
        inputs[0] = abi.encode(ADDRESS_THIS, ETH_IN);

        // input 1: V4_SWAP — nested (bytes actions, bytes[] params).
        // Use SETTLE (not SETTLE_ALL) with payerIsUser=false so the router pays
        // WETH from its OWN balance (post-WRAP_ETH) rather than trying to Permit2-
        // pull it from the UruBuybackVault (which holds ETH, not WETH, and has
        // no Permit2 approval). SETTLE_ALL defaults to payerIsUser=true which
        // caused the previous UruBuybackVault__SwapFailed.
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE), uint8(Actions.TAKE_ALL));

        bytes[] memory swapParams = new bytes[](3);
        swapParams[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: poolKey,
                zeroForOne: true, // WETH (currency0) → URU (currency1)
                amountIn: uint128(ETH_IN),
                amountOutMinimum: uint128(minUruOut),
                minHopPriceX36: 0, // RH's v4-periphery divergence: no per-hop cap, minUruOut handles slippage
                hookData: bytes("")
            })
        );
        // SETTLE(currency, amount, payerIsUser=false) — pays from router balance.
        swapParams[1] = abi.encode(Currency.wrap(WETH), ETH_IN, false);
        swapParams[2] = abi.encode(Currency.wrap(URU), minUruOut); // TAKE_ALL URU

        inputs[1] = abi.encode(actions, swapParams);

        // Full swapData = UniversalRouter.execute selector + encoded args.
        uint256 deadline = block.timestamp + 300;
        bytes memory swapData = abi.encodeCall(IUniversalRouter.execute, (commands, inputs, deadline));

        console2.log("swapData size:", swapData.length);

        // Snapshot pre-buyback URU balance of sink.
        uint256 sinkUruBefore = IERC20V(URU).balanceOf(sink);

        vm.startBroadcast(pk);
        vault.executeBuyback(UNIVERSAL_ROUTER, ETH_IN, swapData, minUruOut);
        vm.stopBroadcast();

        // Verify URU landed in distributionSink (vault forwards it automatically).
        uint256 sinkUruAfter = IERC20V(URU).balanceOf(sink);
        uint256 delivered = sinkUruAfter - sinkUruBefore;

        console2.log("=================================================");
        console2.log("BUYBACK COMPLETE");
        console2.log("=================================================");
        console2.log("ETH spent:            ", ETH_IN);
        console2.log("URU delivered to sink:", delivered);
        console2.log("Sink URU before:      ", sinkUruBefore);
        console2.log("Sink URU after:       ", sinkUruAfter);
        console2.log("=================================================");
        require(delivered >= minUruOut, "URU delivery below minUruOut");
    }

    function _uruPoolKey() internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(WETH),
            currency1: Currency.wrap(URU),
            fee: URU_POOL_FEE,
            tickSpacing: URU_POOL_TICK_SPACING,
            hooks: IHooks(URU_HOOK)
        });
    }
}
