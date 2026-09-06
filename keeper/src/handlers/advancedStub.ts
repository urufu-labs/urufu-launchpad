/**
 * Sweep-to-treasury stub for AddToLP / HolderReflections /
 * MirrorFloorSupport.
 *
 * v1 posture: these three destinations accumulate on-chain and get
 * swept to a single shared treasury the launchpad's ops team drains
 * manually. The real on-chain automation for each is a slice E follow-
 * up:
 *
 *   AddToLP              — modifyLiquidity on the launch's own v4 pool
 *   HolderReflections    — snapshot holders, generate merkle root, publish
 *   MirrorFloorSupport   — sweep a marketplace floor listing, burn NFT
 *
 * Each has enough surface area to be its own slice; shipping v1 with a
 * treasury sweep + LOUD LOG unblocks the launch without silently
 * dropping tax on the floor. Ops watches the logs, ships the manual
 * action, and once patterns stabilize the automation gets written.
 */

import type { HandlerContext } from './index.ts';
import { erc20Abi } from '../abis.ts';
import { taxModeName } from '../config.ts';

export async function handleAdvancedStub(ctx: HandlerContext): Promise<void> {
  const { publicClient, walletClient, keeperAddress, cfg, snapshot, sweptNet } = ctx;

  if (sweptNet === 0n) {
    console.log(`[keeper:advancedStub:${taxModeName(snapshot.taxMode)}] sweptNet=0, nothing to move`);
    return;
  }

  const balance = await publicClient.readContract({
    address: snapshot.base,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [keeperAddress],
  });
  if (balance < sweptNet) {
    console.warn(
      `[keeper:advancedStub] balance ${balance} < sweptNet ${sweptNet} on launch ${snapshot.base} — refusing to forward`,
    );
    return;
  }

  const treasury = cfg.advancedDestinationTreasury;
  const forwardHash = await walletClient.writeContract({
    address: snapshot.base,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [treasury, sweptNet],
    account: keeperAddress,
    chain: null,
  });
  await publicClient.waitForTransactionReceipt({ hash: forwardHash });

  console.log(
    `[keeper:advancedStub:${taxModeName(snapshot.taxMode)}] forwarded ${sweptNet} of ${snapshot.base} to treasury ${treasury} tx=${forwardHash} — ops action required for ${taxModeName(snapshot.taxMode)}`,
  );
}
