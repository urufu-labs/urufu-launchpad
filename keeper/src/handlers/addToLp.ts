/**
 * AddToLP: swap about half the swept tokens to the pair currency, then mint
 * a full-range position in the launch's own graduated pool through the v4
 * PositionManager, minted directly to 0x…dEaD so the liquidity is locked
 * permanently from the first block (no separate transfer step).
 *
 * Actions: MINT_POSITION (0x02), SETTLE_PAIR (0x0d), and for native ETH
 * pools SWEEP (0x14) to refund unused msg.value. Tokens are pulled from the
 * keeper by Permit2 straight into the PoolManager; the keeper is tax-exempt
 * under V2 so the pool receives exactly what it settles.
 *
 * Leftover (rounding / impact-limited half-swap) stays with the keeper and
 * is retried next tick.
 */
import { concatHex, encodeAbiParameters, type Hex } from 'viem';
import { positionManagerAbi } from '../abis.ts';
import type { KeeperConfig } from '../config.ts';
import { DEAD, ZERO } from '../constants.ts';
import { fullRangeTicks, getSqrtPriceAtTick, launchPoolKey, liquidityForAmounts, readSlot0, type PoolKey } from '../pools.ts';
import { tokenToPair, isEthPaired, type LaunchRef } from '../routes.ts';
import { ensurePermit2 } from '../swap.ts';
import type { LaunchSnapshot } from '../sweeper.ts';
import { send, type Ctx } from '../tx.ts';

const POOL_KEY = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

export function encodeMintFullRange(key: PoolKey, liquidity: bigint, amount0Max: bigint, amount1Max: bigint, owner: `0x${string}`, refundTo: `0x${string}`): Hex {
  const [lo, hi] = fullRangeTicks(key.tickSpacing);
  const mint = encodeAbiParameters(
    [
      { type: 'tuple', components: POOL_KEY },
      { type: 'int24' },
      { type: 'int24' },
      { type: 'uint256' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'address' },
      { type: 'bytes' },
    ],
    [key, lo, hi, liquidity, amount0Max, amount1Max, owner, '0x'],
  );
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [key.currency0, key.currency1]);
  const native = key.currency0 === ZERO;
  const actions: Hex = native ? concatHex(['0x02', '0x0d', '0x14']) : concatHex(['0x02', '0x0d']);
  const params: Hex[] = [mint, settle];
  if (native) params.push(encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [ZERO, refundTo]));
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params]);
}

export interface LpResult {
  tokenId: bigint;
  liquidity: bigint;
}

export async function handleAddToLp(ctx: Ctx, cfg: KeeperConfig, s: LaunchSnapshot, balance: bigint): Promise<LpResult | null> {
  const l: LaunchRef = { base: s.launch.base, pair: s.launch.pair };
  const half = balance / 2n;
  const sold = await tokenToPair(ctx, cfg, l, half);
  if (sold.amountOut === 0n) {
    console.warn(`[keeper:addToLp] ${l.base}: half-swap produced nothing, holding`);
    return null;
  }
  const tokenAmt = balance - sold.amountIn;
  const pairAmt = sold.amountOut;

  const key = launchPoolKey(l.base, l.pair, cfg);
  const tokenIs0 = key.currency0.toLowerCase() === l.base.toLowerCase();
  const amount0 = tokenIs0 ? tokenAmt : pairAmt;
  const amount1 = tokenIs0 ? pairAmt : tokenAmt;

  const { sqrtPriceX96 } = await readSlot0(ctx.pc, cfg, key);
  const [lo, hi] = fullRangeTicks(key.tickSpacing);
  // 0.1% haircut so integer rounding inside the PositionManager never asks
  // for more than amount{0,1}Max.
  const liquidity = (liquidityForAmounts(sqrtPriceX96, getSqrtPriceAtTick(lo), getSqrtPriceAtTick(hi), amount0, amount1) * 999n) / 1000n;
  if (liquidity === 0n) {
    console.warn(`[keeper:addToLp] ${l.base}: computed liquidity 0, holding`);
    return null;
  }

  for (const c of [key.currency0, key.currency1]) {
    if (c !== ZERO) await ensurePermit2(ctx, cfg, c, cfg.positionManager, c === key.currency0 ? amount0 : amount1);
  }
  const tokenId = await ctx.pc.readContract({ address: cfg.positionManager, abi: positionManagerAbi, functionName: 'nextTokenId' });
  const unlockData = encodeMintFullRange(key, liquidity, amount0, amount1, DEAD, ctx.keeper);
  await send(ctx, `AddToLP mint full-range to 0x…dEaD (${l.base})`, {
    address: cfg.positionManager,
    abi: positionManagerAbi,
    functionName: 'modifyLiquidities',
    args: [unlockData, BigInt(Math.floor(Date.now() / 1000) + 600)],
    value: isEthPaired(l) ? amount0 : 0n,
  });
  const owner = await ctx.pc.readContract({ address: cfg.positionManager, abi: positionManagerAbi, functionName: 'ownerOf', args: [tokenId] });
  const liq = await ctx.pc.readContract({ address: cfg.positionManager, abi: positionManagerAbi, functionName: 'getPositionLiquidity', args: [tokenId] });
  if (owner.toLowerCase() !== DEAD.toLowerCase() || liq === 0n) {
    throw new Error(`[keeper:addToLp] position ${tokenId} not locked as expected (owner=${owner}, liquidity=${liq})`);
  }
  console.log(`[keeper:addToLp] ${l.base}: position #${tokenId} liquidity=${liq} locked at 0x…dEaD`);
  return { tokenId, liquidity: liq };
}
