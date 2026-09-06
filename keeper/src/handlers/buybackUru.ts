/**
 * BuybackURU handler.
 *
 * After the sweep, keeper wallet holds `sweptNet` of the launch token.
 * We swap that whole balance for URU through the launch's own v4 pool
 * (or, if the launch's pool hasn't graduated yet, we hold and retry
 * on the next tick), then forward the URU to `KEEPER_URU_BUYBACK_SINK`
 * — typically the URU dead-address or UruBuybackVault so the flywheel
 * counts it.
 *
 * v1 simplification: we assume the token → URU pool exists on the same
 * v4 PoolManager the launchpad uses, keyed with the launchpad's
 * canonical fee (3000) + tickSpacing (60). If the pool isn't reachable
 * (i.e. token hasn't graduated), we log and skip; the swept balance
 * stays on the keeper wallet and is re-attempted on the next tick.
 */

import type { HandlerContext } from './index.ts';
import { erc20Abi, v4SwapRouterAbi } from '../abis.ts';

/// Same fee + tick spacing every launchpad-graduated pool uses.
const V4_FEE = 3000;
const V4_TICK_SPACING = 60;

export async function handleBuybackUru(ctx: HandlerContext): Promise<void> {
  const { publicClient, walletClient, keeperAddress, cfg, snapshot, sweptNet } = ctx;

  if (sweptNet === 0n) {
    console.log('[keeper:buybackUru] sweptNet=0, nothing to swap');
    return;
  }

  // Verify actual balance — the on-chain sweepAccumulated post-condition
  // is that `sweptNet` of the base token now lives on the keeper wallet,
  // but reading balance directly avoids the accounting-vs-reality drift
  // that would surface only under a Solidity bug.
  const balance = await publicClient.readContract({
    address: snapshot.base,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [keeperAddress],
  });
  if (balance < sweptNet) {
    console.warn(
      `[keeper:buybackUru] on-chain balance ${balance} < sweptNet ${sweptNet} — refusing to swap, hold + retry next tick`,
    );
    return;
  }

  // Approve V4SwapRouter for the sweep amount, then swap all of it.
  // Every sweep is a fresh approve — no leftover allowance survives
  // between ticks so replay is bounded.
  const approveHash = await walletClient.writeContract({
    address: snapshot.base,
    abi: erc20Abi,
    functionName: 'approve',
    args: [cfg.v4SwapRouter, sweptNet],
    account: keeperAddress,
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  // v4 canonical sort: currency0 = lower address, currency1 = higher.
  const token = snapshot.base;
  const uru = cfg.uruToken;
  const [c0, c1] = token.toLowerCase() < uru.toLowerCase() ? [token, uru] : [uru, token];

  // Deadline generous: 10 min. If RPC is slow enough for this to expire
  // the keeper has bigger problems than a stale deadline.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  try {
    const swapHash = await walletClient.writeContract({
      address: cfg.v4SwapRouter,
      abi: v4SwapRouterAbi,
      functionName: 'swapExactTokenForToken',
      args: [
        {
          currency0: c0,
          currency1: c1,
          fee: V4_FEE,
          tickSpacing: V4_TICK_SPACING,
          hooks: '0x0000000000000000000000000000000000000000', // resolved by pool; keeper doesn't pin
        },
        sweptNet,
        0n, // slippage acceptance — accumulator is small enough that MEV impact is bounded; can tighten post-launch
        cfg.uruBuybackSink, // forward URU directly to sink
        deadline,
      ],
      account: keeperAddress,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: swapHash });
    console.log(
      `[keeper:buybackUru] swapped ${sweptNet} of ${snapshot.base} to URU, sunk at ${cfg.uruBuybackSink}, tx=${swapHash}`,
    );
  } catch (err) {
    // Swap can fail cleanly (pool not graduated yet, no liquidity, etc.).
    // Log and leave funds on the keeper wallet — next tick retries.
    console.warn(
      `[keeper:buybackUru] swap failed for launch ${snapshot.base}: ${(err as Error).message} — funds held on keeper for retry`,
    );
  }
}
