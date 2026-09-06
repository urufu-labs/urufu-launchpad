/**
 * Per-launch sweep pipeline.
 *
 * Given one launch's on-chain state, decide whether to sweep and if so,
 * execute (a) the on-chain sweep + (b) the mode-specific off-chain
 * action. The two are separated so failures in (b) don't leave (a) un-
 * accounted for.
 */

import type { Address, Hex } from 'viem';
import { dn404TaxTemplateAbi } from './abis.ts';
import type { KeeperConfig, LaunchWatch } from './config.ts';
import { TaxMode, taxModeName } from './config.ts';
import type { PublicClient, WalletClient } from './clients.ts';
import { dispatchHandler } from './handlers/index.ts';

export interface LaunchSnapshot {
  readonly base: Address;
  readonly taxMode: number;
  readonly taxTarget: Address;
  readonly uruToken: Address;
  readonly keeper: Address;
  readonly accumulatedTax: bigint;
}

/// Read every state slot the sweeper needs from a single launch. Runs
/// the calls in parallel; the whole snapshot is one round-trip's worth
/// of latency.
export async function snapshotLaunch(
  publicClient: PublicClient,
  base: Address,
): Promise<LaunchSnapshot> {
  const [taxMode, taxTarget, uruToken, keeper, accumulatedTax] = await Promise.all([
    publicClient.readContract({
      address: base,
      abi: dn404TaxTemplateAbi,
      functionName: 'taxMode',
    }),
    publicClient.readContract({
      address: base,
      abi: dn404TaxTemplateAbi,
      functionName: 'taxTarget',
    }),
    publicClient.readContract({
      address: base,
      abi: dn404TaxTemplateAbi,
      functionName: 'uruToken',
    }),
    publicClient.readContract({
      address: base,
      abi: dn404TaxTemplateAbi,
      functionName: 'keeper',
    }),
    publicClient.readContract({
      address: base,
      abi: dn404TaxTemplateAbi,
      functionName: 'accumulatedTax',
    }),
  ]);

  return { base, taxMode, taxTarget, uruToken, keeper, accumulatedTax };
}

export interface SweepDecision {
  readonly shouldSweep: boolean;
  readonly reason: string;
}

/// Evaluate whether a snapshot warrants a sweep this poll. Returns a
/// decision + human-readable reason so the log line is descriptive
/// regardless of the outcome.
export function decideSweep(
  watch: LaunchWatch,
  snapshot: LaunchSnapshot,
  keeperWallet: Address,
  cfg: KeeperConfig,
): SweepDecision {
  if (snapshot.keeper.toLowerCase() !== keeperWallet.toLowerCase()) {
    // Wrong keeper — we won't own this launch's sweep. Log and skip so
    // ops sees the misconfiguration without the keeper crashing.
    return {
      shouldSweep: false,
      reason: `keeper mismatch (on-chain=${snapshot.keeper}, wallet=${keeperWallet})`,
    };
  }
  if (snapshot.taxMode === TaxMode.Off) {
    return { shouldSweep: false, reason: 'taxMode=Off — no accumulation ever happens' };
  }
  if (snapshot.taxMode === TaxMode.BurnDead) {
    // BurnDead burns in-place inside _transfer — no accumulator, so a
    // sweep would revert with InsufficientAccumulated(0). Skip.
    return { shouldSweep: false, reason: 'taxMode=BurnDead — burned in-place, no sweep' };
  }
  if (snapshot.accumulatedTax === 0n) {
    return { shouldSweep: false, reason: 'accumulatedTax=0' };
  }
  if (snapshot.accumulatedTax < watch.threshold) {
    return {
      shouldSweep: false,
      reason: `accumulatedTax=${snapshot.accumulatedTax} < threshold=${watch.threshold}`,
    };
  }
  if (snapshot.accumulatedTax > cfg.maxSweepPerPoll) {
    // Refuse to sweep anomalously large accumulations. Better to alert
    // ops than to submit a sweep that becomes a MEV target.
    return {
      shouldSweep: false,
      reason: `accumulatedTax=${snapshot.accumulatedTax} > maxSweepPerPoll=${cfg.maxSweepPerPoll} — refuse (alert ops)`,
    };
  }
  return { shouldSweep: true, reason: `over threshold (${snapshot.accumulatedTax} >= ${watch.threshold})` };
}

/// Execute a sweep. Submits sweepAccumulated with the FULL accumulated
/// balance, then dispatches the mode-specific handler with the swept
/// funds sitting on the keeper wallet.
///
/// The keeper is always the sweep recipient — handlers move the funds
/// on from there. Keeps every sweep tx uniform: same signer, same
/// recipient, easy to reconcile.
export async function executeSweep(
  publicClient: PublicClient,
  walletClient: WalletClient,
  keeperAddress: Address,
  cfg: KeeperConfig,
  watch: LaunchWatch,
  snapshot: LaunchSnapshot,
): Promise<{ sweepTxHash: Hex; net: bigint; fee: bigint }> {
  // Simulate first — surfaces the revert reason cleanly instead of
  // eating gas on a doomed tx.
  const { request, result } = await publicClient.simulateContract({
    address: snapshot.base,
    abi: dn404TaxTemplateAbi,
    functionName: 'sweepAccumulated',
    args: [keeperAddress, snapshot.accumulatedTax],
    account: keeperAddress,
  });
  const [net, fee] = result as readonly [bigint, bigint];

  const sweepTxHash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash: sweepTxHash });

  console.log(
    `[keeper] swept ${snapshot.accumulatedTax} from ${snapshot.base} mode=${taxModeName(snapshot.taxMode)} net=${net} fee=${fee} tx=${sweepTxHash}`,
  );

  // Dispatch handler AFTER sweep tx is mined so it can rely on the
  // keeper wallet's balance actually reflecting the sweep.
  await dispatchHandler({
    publicClient,
    walletClient,
    keeperAddress,
    cfg,
    watch,
    snapshot,
    sweptNet: net,
  });

  return { sweepTxHash, net, fee };
}
