/**
 * Multi-hop routes built from single-hop keeper swaps.
 *
 * ETH-paired launch pool:  token <-> native ETH (ERC-20 lane host).
 * URU-paired launch pool:  token <-> URU (DN404 host).
 * URU <-> ETH:             URU/WETH canonical pool (WETH-paired, so the
 *                          keeper wraps/unwraps around it).
 */
import type { Address } from 'viem';
import type { KeeperConfig } from './config.ts';
import { ZERO } from './constants.ts';
import { ethUsdgPoolKey, launchPoolKey, uruWethPoolKey } from './pools.ts';
import { swapExactIn, unwrapWeth, wrapEth, type SwapResult } from './swap.ts';
import type { Ctx } from './tx.ts';

export interface LaunchRef {
  base: Address;
  pair: Address; // ZERO for ETH-paired
}

export const isEthPaired = (l: LaunchRef) => BigInt(l.pair) === 0n;

/// Sell launch tokens into the launch pool for its pair currency.
export async function tokenToPair(ctx: Ctx, cfg: KeeperConfig, l: LaunchRef, amount: bigint): Promise<SwapResult> {
  const key = launchPoolKey(l.base, l.pair, cfg);
  const zeroForOne = key.currency0.toLowerCase() === l.base.toLowerCase();
  return swapExactIn(ctx, cfg, key, zeroForOne, amount, `sell ${l.base} -> ${isEthPaired(l) ? 'ETH' : 'pair'}`);
}

/// Buy launch tokens from the launch pool with pair currency.
export async function pairToToken(ctx: Ctx, cfg: KeeperConfig, l: LaunchRef, amount: bigint): Promise<SwapResult> {
  if (isDust(cfg, l.pair, amount)) return { amountIn: 0n, amountOut: 0n };
  const key = launchPoolKey(l.base, l.pair, cfg);
  const zeroForOne = key.currency0.toLowerCase() !== l.base.toLowerCase();
  return swapExactIn(ctx, cfg, key, zeroForOne, amount, `buy ${l.base}`);
}

/// ETH -> URU through the URU/WETH pool (wraps first).
/// Pure: is `amount` of `currency` too small to be worth swapping?
export function isDust(cfg: Pick<KeeperConfig, 'usdg' | 'weth' | 'dustEthWei' | 'dustUsdg'>, currency: Address, amount: bigint): boolean {
  if (amount === 0n) return true;
  const c = currency.toLowerCase();
  if (BigInt(currency) === 0n || c === cfg.weth.toLowerCase()) return amount < cfg.dustEthWei;
  if (c === cfg.usdg.toLowerCase()) return amount < cfg.dustUsdg;
  return false;
}

export async function ethToUru(ctx: Ctx, cfg: KeeperConfig, amountEth: bigint): Promise<SwapResult> {
  if (isDust(cfg, ZERO, amountEth)) return { amountIn: 0n, amountOut: 0n };
  const key = uruWethPoolKey(cfg);
  await wrapEth(ctx, cfg, amountEth);
  const zeroForOne = key.currency0.toLowerCase() === cfg.weth.toLowerCase();
  const r = await swapExactIn(ctx, cfg, key, zeroForOne, amountEth, 'swap WETH -> URU');
  // Unspent WETH (impact-sized partial) is unwrapped back to ETH.
  if (r.amountIn < amountEth) await unwrapWeth(ctx, cfg, amountEth - r.amountIn);
  return r;
}

/// URU -> ETH through the URU/WETH pool (unwraps after).
export async function uruToEth(ctx: Ctx, cfg: KeeperConfig, amountUru: bigint): Promise<SwapResult> {
  if (amountUru === 0n) return { amountIn: 0n, amountOut: 0n };
  const key = uruWethPoolKey(cfg);
  const zeroForOne = key.currency0.toLowerCase() === cfg.uru.toLowerCase();
  const r = await swapExactIn(ctx, cfg, key, zeroForOne, amountUru, 'swap URU -> WETH');
  await unwrapWeth(ctx, cfg, r.amountOut);
  return r;
}

/// Native ETH -> USDG (OpenSea's required listing currency on Robinhood).
export async function ethToUsdg(ctx: Ctx, cfg: KeeperConfig, amountEth: bigint): Promise<SwapResult> {
  if (isDust(cfg, ZERO, amountEth)) return { amountIn: 0n, amountOut: 0n };
  return swapExactIn(ctx, cfg, ethUsdgPoolKey(cfg), true, amountEth, 'swap ETH -> USDG');
}

/// USDG -> native ETH (returns unspent floor-buy USDG to ETH).
export async function usdgToEth(ctx: Ctx, cfg: KeeperConfig, amountUsdg: bigint): Promise<SwapResult> {
  if (isDust(cfg, cfg.usdg, amountUsdg)) return { amountIn: 0n, amountOut: 0n };
  return swapExactIn(ctx, cfg, ethUsdgPoolKey(cfg), false, amountUsdg, 'swap USDG -> ETH');
}

/// Launch token -> URU. Direct for URU pairs, via ETH for ETH pairs.
/// Returns tokens actually spent and URU actually received.
export async function tokenToUru(ctx: Ctx, cfg: KeeperConfig, l: LaunchRef, amount: bigint): Promise<SwapResult> {
  const first = await tokenToPair(ctx, cfg, l, amount);
  if (!isEthPaired(l) || first.amountOut === 0n) return first;
  const second = await ethToUru(ctx, cfg, first.amountOut);
  return { amountIn: first.amountIn, amountOut: second.amountOut };
}

/// Launch token -> native ETH. Direct for ETH pairs, via URU for URU pairs.
export async function tokenToEth(ctx: Ctx, cfg: KeeperConfig, l: LaunchRef, amount: bigint): Promise<SwapResult> {
  const first = await tokenToPair(ctx, cfg, l, amount);
  if (isEthPaired(l) || first.amountOut === 0n) return first;
  if (l.pair.toLowerCase() !== cfg.uru.toLowerCase()) throw new Error(`no ETH route for pair ${l.pair}`);
  const second = await uruToEth(ctx, cfg, first.amountOut);
  return { amountIn: first.amountIn, amountOut: second.amountOut };
}

export { ZERO };
