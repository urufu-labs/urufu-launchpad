/**
 * Universal Router swaps for the keeper.
 *
 * The keeper is tax-exempt under Dn404TaxTemplateV2, so the normal v4
 * exact-in order (SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL) settles
 * cleanly; no fee-on-transfer shortfall. ERC-20 input is pulled through
 * Permit2, native ETH input is sent as msg.value.
 *
 * Robinhood's Universal Router is built on a newer v4-periphery whose
 * ExactInputSingleParams carries `uint256 minHopPriceX36` between
 * amountOutMinimum and hookData (same as web/src/lib/v4Erc20Swap.ts).
 *
 * Every swap is priced with the v4 Quoter first: minOut = quote *
 * (1 - maxSlippage); never 0. If the quote is worse than spot by more than
 * maxPriceImpact, the amount is halved (up to 6 times) so a thin pool is
 * drained gradually across ticks instead of dumped in one tx.
 */
import { concatHex, encodeAbiParameters, maxUint160, maxUint256, type Address, type Hex } from 'viem';
import { erc20Abi, permit2Abi, universalRouterAbi, wethAbi } from './abis.ts';
import type { KeeperConfig } from './config.ts';
import { ZERO } from './constants.ts';
import { type PoolKey, quoteExactIn, readSlot0, spotOut } from './pools.ts';
import { type Ctx, gasCost, send } from './tx.ts';

const POOL_KEY = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

/// UR V4_SWAP input: SWAP_EXACT_IN_SINGLE(0x06), SETTLE_ALL(0x0c), TAKE_ALL(0x0f).
export function encodeExactInSingle(key: PoolKey, zeroForOne: boolean, amountIn: bigint, minOut: bigint): { commands: Hex; inputs: Hex[] } {
  if (amountIn <= 0n || amountIn >= 1n << 128n) throw new Error('amountIn out of uint128 range');
  const swap = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'poolKey', type: 'tuple', components: POOL_KEY },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'minHopPriceX36', type: 'uint256' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: '0x' }],
  );
  const cin = zeroForOne ? key.currency0 : key.currency1;
  const cout = zeroForOne ? key.currency1 : key.currency0;
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cin, amountIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cout, minOut]);
  const v4Input = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [concatHex(['0x06', '0x0c', '0x0f']), [swap, settle, take]],
  );
  return { commands: '0x10', inputs: [v4Input] };
}

export const applyBps = (x: bigint, bps: bigint): bigint => (x * (10_000n - bps)) / 10_000n;

/// ERC-20 -> Permit2 -> spender approvals, refreshed only when short/expiring.
export async function ensurePermit2(ctx: Ctx, cfg: KeeperConfig, token: Address, spender: Address, amount: bigint): Promise<void> {
  const erc = await ctx.pc.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [ctx.keeper, cfg.permit2] });
  if (erc < amount) {
    await send(ctx, `approve ${token} -> permit2`, { address: token, abi: erc20Abi, functionName: 'approve', args: [cfg.permit2, maxUint256] });
  }
  const [amt, exp] = await ctx.pc.readContract({ address: cfg.permit2, abi: permit2Abi, functionName: 'allowance', args: [ctx.keeper, token, spender] });
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (amt < amount || BigInt(exp) < now + 3600n) {
    await send(ctx, `permit2 approve ${token} -> ${spender}`, {
      address: cfg.permit2,
      abi: permit2Abi,
      functionName: 'approve',
      args: [token, spender, maxUint160, Number(now + 30n * 86_400n)],
    });
  }
}

export interface SwapResult {
  amountIn: bigint;
  amountOut: bigint;
}

async function balanceOf(ctx: Ctx, currency: Address): Promise<bigint> {
  if (currency === ZERO) return ctx.pc.getBalance({ address: ctx.keeper });
  return ctx.pc.readContract({ address: currency, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.keeper] });
}

/// Pick the largest amount <= `amount` (halving) whose quote is within the
/// price-impact budget of spot. Returns 0n if even the smallest probe fails.
export async function sizeForImpact(ctx: Ctx, cfg: KeeperConfig, key: PoolKey, zeroForOne: boolean, amount: bigint): Promise<{ amountIn: bigint; quote: bigint }> {
  const { sqrtPriceX96 } = await readSlot0(ctx.pc, cfg, key);
  if (sqrtPriceX96 === 0n) throw new Error('pool not initialized');
  let a = amount;
  for (let i = 0; i < 7 && a > 0n; i++) {
    const quote = await quoteExactIn(ctx.pc, key, zeroForOne, a);
    const spot = spotOut(a, sqrtPriceX96, zeroForOne);
    if (spot === 0n) return { amountIn: 0n, quote: 0n };
    if (quote >= applyBps(spot, cfg.maxPriceImpactBps)) return { amountIn: a, quote };
    a /= 2n;
  }
  return { amountIn: 0n, quote: 0n };
}

/// One exact-in single-hop swap of up to `amount` (impact-sized). Returns
/// what was actually spent/received (measured by balance deltas; native
/// output is corrected for the tx's own gas).
export async function swapExactIn(ctx: Ctx, cfg: KeeperConfig, key: PoolKey, zeroForOne: boolean, amount: bigint, label: string): Promise<SwapResult> {
  const { amountIn, quote } = await sizeForImpact(ctx, cfg, key, zeroForOne, amount);
  if (amountIn === 0n || quote === 0n) {
    console.warn(`[keeper:swap] ${label}: no size within price-impact budget (${cfg.maxPriceImpactBps} bps), holding`);
    return { amountIn: 0n, amountOut: 0n };
  }
  const minOut = applyBps(quote, cfg.maxSlippageBps);
  if (minOut === 0n) throw new Error(`${label}: minOut rounded to 0, refusing`);
  const cin = zeroForOne ? key.currency0 : key.currency1;
  const cout = zeroForOne ? key.currency1 : key.currency0;
  if (cin !== ZERO) await ensurePermit2(ctx, cfg, cin, cfg.universalRouter, amountIn);
  const before = await balanceOf(ctx, cout);
  const { commands, inputs } = encodeExactInSingle(key, zeroForOne, amountIn, minOut);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const r = await send(ctx, label, {
    address: cfg.universalRouter,
    abi: universalRouterAbi,
    functionName: 'execute',
    args: [commands, inputs, deadline],
    value: cin === ZERO ? amountIn : 0n,
  });
  let after = await balanceOf(ctx, cout);
  if (cout === ZERO) after += gasCost(r);
  return { amountIn, amountOut: after - before };
}

export async function wrapEth(ctx: Ctx, cfg: KeeperConfig, amount: bigint): Promise<void> {
  if (amount === 0n) return;
  await send(ctx, 'weth.deposit', { address: cfg.weth, abi: wethAbi, functionName: 'deposit', value: amount });
}

export async function unwrapWeth(ctx: Ctx, cfg: KeeperConfig, amount: bigint): Promise<void> {
  if (amount === 0n) return;
  await send(ctx, 'weth.withdraw', { address: cfg.weth, abi: wethAbi, functionName: 'withdraw', args: [amount] });
}
