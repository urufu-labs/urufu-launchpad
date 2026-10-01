/**
 * Per-launch pipeline: snapshot on-chain state -> decide -> sweep -> act.
 *
 * Pure decision logic (decideSweep) is unit-tested; everything else is
 * exercised by the anvil-fork harness against real contracts.
 */
import type { Address } from 'viem';
import { curveAbi, dn404TaxTemplateAbi } from './abis.ts';
import type { KeeperConfig } from './config.ts';
import { TaxMode, taxModeName } from './config.ts';
import type { DiscoveredLaunch } from './discovery.ts';
import { send, type Ctx } from './tx.ts';

export interface LaunchSnapshot {
  readonly launch: DiscoveredLaunch;
  readonly taxMode: number;
  readonly taxTarget: Address;
  readonly keeper: Address;
  readonly keeperTreasury: Address;
  readonly owner: Address;
  readonly accumulatedTax: bigint;
  readonly totalSupply: bigint;
  readonly unitWei: bigint;
  readonly graduated: boolean;
  readonly keeperSkipsNft: boolean;
  /// Launch tokens already sitting on the keeper (prior partial actions).
  readonly keeperBalance: bigint;
}

export async function snapshotLaunch(ctx: Ctx, launch: DiscoveredLaunch): Promise<LaunchSnapshot> {
  const r = <T>(functionName: string, args: readonly unknown[] = []) =>
    ctx.pc.readContract({ address: launch.base, abi: dn404TaxTemplateAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
  const [taxMode, taxTarget, keeper, keeperTreasury, owner, accumulatedTax, totalSupply, unitWei, keeperSkipsNft, keeperBalance, graduated] =
    await Promise.all([
      r<number>('taxMode'),
      r<Address>('taxTarget'),
      r<Address>('keeper'),
      r<Address>('keeperTreasury'),
      r<Address>('owner'),
      r<bigint>('accumulatedTax'),
      r<bigint>('totalSupply'),
      r<bigint>('unit'),
      r<boolean>('getSkipNFT', [ctx.keeper]),
      r<bigint>('balanceOf', [ctx.keeper]),
      ctx.pc.readContract({ address: launch.curve, abi: curveAbi, functionName: 'graduated' }),
    ]);
  return { launch, taxMode, taxTarget, keeper, keeperTreasury, owner, accumulatedTax, totalSupply, unitWei, graduated, keeperSkipsNft, keeperBalance };
}

export interface SweepDecision {
  readonly shouldSweep: boolean;
  /// Run the mode action even without a sweep (leftover keeper balance from
  /// an earlier partial action, e.g. impact-limited swaps or queued payouts).
  readonly shouldAct: boolean;
  readonly reason: string;
}

/// Modes that need the graduated v4 pool before they can act.
export const NEEDS_POOL: ReadonlySet<number> = new Set([
  TaxMode.BuybackURU,
  TaxMode.BuyAllowedToken,
  TaxMode.AddToLP,
  TaxMode.MirrorFloorSupport,
]);

export function decideSweep(s: LaunchSnapshot, keeperWallet: Address, cfg: Pick<KeeperConfig, 'minSweepBpsOfSupply' | 'maxSweepBpsOfSupply'>): SweepDecision {
  const no = (reason: string, shouldAct = false): SweepDecision => ({ shouldSweep: false, shouldAct, reason });
  if (s.keeper.toLowerCase() !== keeperWallet.toLowerCase()) {
    return no(`keeper mismatch (on-chain=${s.keeper}, wallet=${keeperWallet})`);
  }
  if (s.taxMode === TaxMode.Off) return no('taxMode=Off');
  if (s.taxMode === TaxMode.BurnDead) return no('taxMode=BurnDead: burned in-token, nothing to sweep');
  if (s.taxMode > TaxMode.MirrorFloorSupport) return no(`unknown taxMode ${s.taxMode}`);
  if (NEEDS_POOL.has(s.taxMode) && !s.graduated) {
    return no(`${taxModeName(s.taxMode)} waits for graduation (no pool yet)`);
  }
  const hasLeftover = s.keeperBalance > 0n;
  const min = (s.totalSupply * cfg.minSweepBpsOfSupply) / 10_000n;
  const max = (s.totalSupply * cfg.maxSweepBpsOfSupply) / 10_000n;
  if (s.accumulatedTax === 0n) return no('accumulatedTax=0', hasLeftover);
  if (s.accumulatedTax < min) return no(`accumulatedTax=${s.accumulatedTax} < min=${min}`, hasLeftover);
  if (s.accumulatedTax > max) {
    return no(`accumulatedTax=${s.accumulatedTax} > max=${max}: refuse, alert ops`, false);
  }
  return { shouldSweep: true, shouldAct: true, reason: `sweep ${s.accumulatedTax} (${taxModeName(s.taxMode)})` };
}

/// Make sure sweeps don't mint mirror NFTs to the keeper (gas: ~11.5k per
/// NFT against RH's 32M per-tx cap). Bought floor NFTs still land on the
/// keeper (DN404 transfers NFTs to skipNFT owners) and burn when the keeper
/// sends its tokens to 0x…dEaD.
export async function ensureKeeperSkipsNft(ctx: Ctx, s: LaunchSnapshot): Promise<void> {
  if (s.keeperSkipsNft) return;
  await send(ctx, `setSkipNFT(true) on ${s.launch.base}`, {
    address: s.launch.base,
    abi: dn404TaxTemplateAbi,
    functionName: 'setSkipNFT',
    args: [true],
  });
}

/// sweepAccumulated(keeper, all). The token sends 5% to keeperTreasury and
/// the rest to the keeper in the same tx. Returns the keeper's new balance.
export async function sweep(ctx: Ctx, s: LaunchSnapshot): Promise<bigint> {
  await send(ctx, `sweepAccumulated ${s.launch.base} (${taxModeName(s.taxMode)})`, {
    address: s.launch.base,
    abi: dn404TaxTemplateAbi,
    functionName: 'sweepAccumulated',
    args: [ctx.keeper, s.accumulatedTax],
  });
  return ctx.pc.readContract({ address: s.launch.base, abi: dn404TaxTemplateAbi, functionName: 'balanceOf', args: [ctx.keeper] });
}
