/**
 * BuyAllowedToken handler.
 *
 * Same swap shape as BuybackURU, but the destination token is
 * `snapshot.taxTarget` (validated on-chain against Dn404TaxAllowlist
 * at initializeTax) instead of URU. Post-swap, funds land on the
 * launch's `finalDestination` (per-launch config override) or, if
 * unset, the advanced-destination treasury as a fallback.
 */

import type { HandlerContext } from './index.ts';
import { erc20Abi, v4SwapRouterAbi } from '../abis.ts';

const V4_FEE = 3000;
const V4_TICK_SPACING = 60;

export async function handleBuyAllowedToken(ctx: HandlerContext): Promise<void> {
  const { publicClient, walletClient, keeperAddress, cfg, watch, snapshot, sweptNet } = ctx;

  if (sweptNet === 0n) {
    console.log('[keeper:buyAllowedToken] sweptNet=0, nothing to swap');
    return;
  }

  const target = snapshot.taxTarget;
  if (target === '0x0000000000000000000000000000000000000000') {
    console.warn(
      `[keeper:buyAllowedToken] launch ${snapshot.base} has zero taxTarget — nothing to buy, holding funds`,
    );
    return;
  }

  // Destination for the swapped output. Per-launch override wins; else
  // treasury so funds don't sit unrecoverable on the keeper wallet.
  const recipient = watch.finalDestination ?? cfg.advancedDestinationTreasury;

  const balance = await publicClient.readContract({
    address: snapshot.base,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [keeperAddress],
  });
  if (balance < sweptNet) {
    console.warn(
      `[keeper:buyAllowedToken] balance ${balance} < sweptNet ${sweptNet} — refusing to swap`,
    );
    return;
  }

  const approveHash = await walletClient.writeContract({
    address: snapshot.base,
    abi: erc20Abi,
    functionName: 'approve',
    args: [cfg.v4SwapRouter, sweptNet],
    account: keeperAddress,
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const [c0, c1] =
    snapshot.base.toLowerCase() < target.toLowerCase()
      ? [snapshot.base, target]
      : [target, snapshot.base];

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
          hooks: '0x0000000000000000000000000000000000000000',
        },
        sweptNet,
        0n,
        recipient,
        deadline,
      ],
      account: keeperAddress,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: swapHash });
    console.log(
      `[keeper:buyAllowedToken] swapped ${sweptNet} of ${snapshot.base} to ${target}, delivered to ${recipient}, tx=${swapHash}`,
    );
  } catch (err) {
    console.warn(
      `[keeper:buyAllowedToken] swap failed for launch ${snapshot.base}: ${(err as Error).message} — funds held for retry`,
    );
  }
}
