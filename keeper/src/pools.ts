/**
 * Pool keys, ids, spot prices and full-range liquidity math. Pure helpers
 * (no I/O) are exported for unit tests; chain reads take a PublicClient.
 */
import { encodeAbiParameters, getAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { stateViewAbi } from './abis.ts';
import type { PublicClient } from './clients.ts';
import type { KeeperConfig } from './config.ts';
import { GRAD_FEE, GRAD_TICK_SPACING, ZERO } from './constants.ts';

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export const sortPair = (a: Address, b: Address): [Address, Address] =>
  BigInt(a) < BigInt(b) ? [a, b] : [b, a];

export function poolIdOf(k: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
}

/// The graduated pool of a DN404 launch. pair = 0x0 => ETH-paired (native
/// currency0, ERC-20 lane host); otherwise sorted token/pair on the DN404 host.
export function launchPoolKey(token: Address, pair: Address, cfg: Pick<KeeperConfig, 'hookEth' | 'hookPair'>): PoolKey {
  if (pair === ZERO || BigInt(pair) === 0n) {
    return { currency0: ZERO, currency1: token, fee: GRAD_FEE, tickSpacing: GRAD_TICK_SPACING, hooks: cfg.hookEth };
  }
  const [c0, c1] = sortPair(token, pair);
  return { currency0: c0, currency1: c1, fee: GRAD_FEE, tickSpacing: GRAD_TICK_SPACING, hooks: cfg.hookPair };
}

export function uruWethPoolKey(cfg: Pick<KeeperConfig, 'weth' | 'uru' | 'uruWethHook'>): PoolKey {
  const [c0, c1] = sortPair(cfg.weth, cfg.uru);
  return { currency0: c0, currency1: c1, fee: GRAD_FEE, tickSpacing: GRAD_TICK_SPACING, hooks: cfg.uruWethHook };
}

/// Native ETH / USDG pool (hookless). ETH is always currency0 (address 0).
export function ethUsdgPoolKey(cfg: Pick<KeeperConfig, 'usdg' | 'ethUsdgFee' | 'ethUsdgTickSpacing'>): PoolKey {
  return { currency0: ZERO, currency1: cfg.usdg, fee: cfg.ethUsdgFee, tickSpacing: cfg.ethUsdgTickSpacing, hooks: ZERO };
}

// ---------------------------------------------------------------- TickMath

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;

/// Port of v4-core TickMath.getSqrtPriceAtTick (bit-exact; pinned by tests
/// against MIN/MAX_SQRT_PRICE).
export function getSqrtPriceAtTick(tick: number): bigint {
  const absTick = BigInt(Math.abs(tick));
  if (absTick > BigInt(MAX_TICK)) throw new Error('tick out of range');
  let price = (absTick & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  const m: Array<[bigint, bigint]> = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, mul] of m) if ((absTick & bit) !== 0n) price = (price * mul) >> 128n;
  if (tick > 0) price = MAX_UINT256 / price;
  return (price >> 32n) + (price % (1n << 32n) === 0n ? 0n : 1n);
}

/// Full-range usable ticks for a spacing.
export function fullRangeTicks(tickSpacing: number): [number, number] {
  const lo = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const hi = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  return [lo, hi];
}

/// v3/v4 LiquidityAmounts.getLiquidityForAmounts (floor).
export function liquidityForAmounts(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, amount0: bigint, amount1: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const l0 = (a: bigint, b: bigint, x: bigint) => (x * ((a * b) / Q96)) / (b - a);
  const l1 = (a: bigint, b: bigint, y: bigint) => (y * Q96) / (b - a);
  if (sqrtP <= sqrtA) return l0(sqrtA, sqrtB, amount0);
  if (sqrtP < sqrtB) {
    const a = l0(sqrtP, sqrtB, amount0);
    const b = l1(sqrtA, sqrtP, amount1);
    return a < b ? a : b;
  }
  return l1(sqrtA, sqrtB, amount1);
}

/// Spot price of `token` in `other` per whole token, 1e18-scaled.
/// sqrtPriceX96^2 / 2^192 = currency1 per currency0.
export function priceOtherPerToken(sqrtPriceX96: bigint, tokenIsCurrency0: boolean): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const sq = sqrtPriceX96 * sqrtPriceX96;
  return tokenIsCurrency0 ? (sq * 10n ** 18n) >> 192n : ((10n ** 18n) << 192n) / sq;
}

export async function readSlot0(pc: PublicClient, cfg: Pick<KeeperConfig, 'stateView'>, key: PoolKey) {
  const [sqrtPriceX96, tick] = await pc.readContract({
    address: cfg.stateView,
    abi: stateViewAbi,
    functionName: 'getSlot0',
    args: [poolIdOf(key)],
  });
  const liquidity = await pc.readContract({
    address: cfg.stateView,
    abi: stateViewAbi,
    functionName: 'getLiquidity',
    args: [poolIdOf(key)],
  });
  return { sqrtPriceX96, tick, liquidity };
}

export const QUOTER: Address = getAddress('0x8dc178efb8111bb0973dd9d722ebeff267c98f94');
const quoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

/// Exact expected output (incl. LP fee, hook fees, price impact) via the v4
/// Quoter, simulated with eth_call. Verified live on RH 2026-10-01.
export async function quoteExactIn(pc: PublicClient, key: PoolKey, zeroForOne: boolean, amountIn: bigint): Promise<bigint> {
  const { result } = await pc.simulateContract({
    address: QUOTER,
    abi: quoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
  });
  return result[0];
}

/// Output at spot with no fees/impact, for the price-impact guard.
export function spotOut(amountIn: bigint, sqrtPriceX96: bigint, zeroForOne: boolean): bigint {
  // price(c1 per c0) = sq^2 / 2^192
  const sq = sqrtPriceX96 * sqrtPriceX96;
  return zeroForOne ? (amountIn * sq) >> 192n : (amountIn << 192n) / sq;
}
