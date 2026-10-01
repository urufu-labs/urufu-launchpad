/**
 * Mode dispatch. Every handler acts on the keeper's FULL balance of the
 * launch token (fresh sweep + any leftover from earlier partial actions).
 */
import type { KeeperConfig } from '../config.ts';
import { TaxMode, taxModeName } from '../config.ts';
import type { ListingsProvider } from '../opensea.ts';
import type { LaunchSnapshot } from '../sweeper.ts';
import type { Ctx } from '../tx.ts';
import { handleAddToLp } from './addToLp.ts';
import { handleBuyAllowedToken, handleBuybackUru } from './buyback.ts';
import { handleFloor } from './floor.ts';
import type { ReflectionState } from './reflections.ts';

export interface HandlerDeps {
  reflections: ReflectionState;
  listings: ListingsProvider | null;
}

export async function dispatchHandler(ctx: Ctx, cfg: KeeperConfig, s: LaunchSnapshot, balance: bigint, deps: HandlerDeps): Promise<void> {
  if (balance === 0n) return;
  switch (s.taxMode) {
    case TaxMode.BuybackURU:
      return handleBuybackUru(ctx, cfg, s, balance);
    case TaxMode.BuyAllowedToken:
      return handleBuyAllowedToken(ctx, cfg, s, balance);
    case TaxMode.AddToLP:
      await handleAddToLp(ctx, cfg, s, balance);
      return;
    case TaxMode.HolderReflections:
      await deps.reflections.handle(ctx, s, balance);
      return;
    case TaxMode.MirrorFloorSupport:
      await handleFloor(ctx, cfg, s, balance, deps.listings);
      return;
    default:
      console.warn(`[keeper] ${s.launch.base}: nothing to do for ${taxModeName(s.taxMode)}`);
  }
}
