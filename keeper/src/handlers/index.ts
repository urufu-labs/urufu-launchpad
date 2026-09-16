/**
 * Handler dispatch. One function per TaxMode; the sweeper picks the
 * right one after a successful sweepAccumulated tx settles.
 *
 * Handlers assume the swept tokens (net share, post keeper-fee) are
 * sitting on the keeper wallet address. Their job is to move the funds
 * to the destination-specific target.
 */

import type { Address } from 'viem';
import type { KeeperConfig, LaunchWatch } from '../config.ts';
import { TaxMode, taxModeName } from '../config.ts';
import type { LaunchSnapshot } from '../sweeper.ts';
import type { PublicClient, WalletClient } from '../clients.ts';

import { handleBuybackUru } from './buybackUru.ts';
import { handleBuyAllowedToken } from './buyAllowedToken.ts';
import { handleAdvancedStub } from './advancedStub.ts';

export interface HandlerContext {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly keeperAddress: Address;
  readonly cfg: KeeperConfig;
  readonly watch: LaunchWatch;
  readonly snapshot: LaunchSnapshot;
  readonly sweptNet: bigint;
}

export async function dispatchHandler(ctx: HandlerContext): Promise<void> {
  const mode = ctx.snapshot.taxMode;

  switch (mode) {
    case TaxMode.BuybackURU:
      await handleBuybackUru(ctx);
      return;
    case TaxMode.BuyAllowedToken:
      await handleBuyAllowedToken(ctx);
      return;
    case TaxMode.AddToLP:
    case TaxMode.HolderReflections:
    case TaxMode.MirrorFloorSupport:
      // v1: sweep-to-treasury stub for the three advanced destinations.
      // Real on-chain automation lives in slice E (post-launch) — these
      // funds are held by the shared advanced-destination treasury and
      // released manually by ops until the automation ships.
      await handleAdvancedStub(ctx);
      return;
    case TaxMode.Off:
    case TaxMode.BurnDead:
      // Neither should ever reach here — decideSweep filters both out
      // upstream. Guard with a loud log so a future regression in
      // decideSweep is obvious.
      console.warn(
        `[keeper] dispatchHandler called with mode=${taxModeName(mode)} on launch ${ctx.snapshot.base} — decideSweep bug`,
      );
      return;
    default:
      console.warn(`[keeper] unknown taxMode=${mode} on launch ${ctx.snapshot.base} — ignored`);
      return;
  }
}
