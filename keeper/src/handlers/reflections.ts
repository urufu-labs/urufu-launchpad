/**
 * HolderReflections: pay the keeper's swept tokens back to holders pro-rata
 * to their current balances, by direct transfers from the keeper (the keeper
 * is tax-exempt under V2, so payouts arrive in full).
 *
 * Holder set: every address seen in the token's Transfer logs since launch
 * (incremental, cached per launch). Balances are read live at round start.
 * Infra addresses (curve, graduators, hooks, PoolManager, PositionManager,
 * the token itself, 0x…dEaD, keeper, keeper treasury, launch factory) are
 * excluded so liquidity / burn / fee sinks never receive reflections.
 *
 * A "round" is planned once from a balance snapshot, then paid at most
 * reflectionMaxTxPerTick transfers per tick. Shares below
 * reflectionMinPayout are skipped (they stay in the pool for later rounds).
 * If the keeper restarts mid-round, the remaining keeper balance simply
 * becomes the next round's pool: still pro-rata, just a fresh snapshot.
 */
import { parseAbiItem, type Address } from 'viem';
import { dn404TaxTemplateAbi } from '../abis.ts';
import type { KeeperConfig } from '../config.ts';
import { DEAD } from '../constants.ts';
import type { LaunchSnapshot } from '../sweeper.ts';
import { send, type Ctx } from '../tx.ts';

export interface Payout {
  to: Address;
  amount: bigint;
}

/// Pure pro-rata split. Floor division; remainder (dust) is not assigned.
export function planProRata(pool: bigint, balances: ReadonlyArray<{ holder: Address; balance: bigint }>, minPayout: bigint): Payout[] {
  const eligible = balances.filter((b) => b.balance > 0n);
  const total = eligible.reduce((a, b) => a + b.balance, 0n);
  if (total === 0n || pool === 0n) return [];
  const out: Payout[] = [];
  for (const b of eligible) {
    const amount = (pool * b.balance) / total;
    if (amount >= minPayout && amount > 0n) out.push({ to: b.holder, amount });
  }
  return out;
}

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 amount)');

interface HolderCache {
  next: bigint;
  holders: Set<string>;
}

export class ReflectionState {
  private readonly caches = new Map<string, HolderCache>();
  private readonly queues = new Map<string, Payout[]>();

  private readonly cfg: KeeperConfig;
  constructor(cfg: KeeperConfig) {
    this.cfg = cfg;
  }

  excluded(s: LaunchSnapshot, keeper: Address): Set<string> {
    const c = this.cfg;
    return new Set(
      [s.launch.curve, c.graduatorEth, c.graduatorPair, c.hookEth, c.hookPair, c.poolManager, c.positionManager, s.launch.base, DEAD, keeper, s.keeperTreasury, c.launchFactory, '0x0000000000000000000000000000000000000000'].map((a) =>
        a.toLowerCase(),
      ),
    );
  }

  async refreshHolders(ctx: Ctx, s: LaunchSnapshot): Promise<Set<string>> {
    const key = s.launch.base.toLowerCase();
    let cache = this.caches.get(key);
    if (!cache) {
      cache = { next: s.launch.launchBlock, holders: new Set() };
      this.caches.set(key, cache);
    }
    const head = await ctx.pc.getBlockNumber();
    while (cache.next <= head) {
      const to = cache.next + this.cfg.logChunk - 1n > head ? head : cache.next + this.cfg.logChunk - 1n;
      const logs = await ctx.pc.getLogs({ address: s.launch.base, event: transferEvent, fromBlock: cache.next, toBlock: to });
      for (const l of logs) {
        if (l.args.from) cache.holders.add(l.args.from.toLowerCase());
        if (l.args.to) cache.holders.add(l.args.to.toLowerCase());
      }
      cache.next = to + 1n;
    }
    return cache.holders;
  }

  queued(base: Address): number {
    return this.queues.get(base.toLowerCase())?.length ?? 0;
  }

  async handle(ctx: Ctx, s: LaunchSnapshot, balance: bigint): Promise<Payout[]> {
    const key = s.launch.base.toLowerCase();
    let queue = this.queues.get(key);
    if (!queue || queue.length === 0) {
      const holders = await this.refreshHolders(ctx, s);
      const excl = this.excluded(s, ctx.keeper);
      const candidates = [...holders].filter((h) => !excl.has(h)) as Address[];
      const balances: Array<{ holder: Address; balance: bigint }> = [];
      for (let i = 0; i < candidates.length; i += 50) {
        const batch = candidates.slice(i, i + 50);
        const bals = await Promise.all(
          batch.map((h) => ctx.pc.readContract({ address: s.launch.base, abi: dn404TaxTemplateAbi, functionName: 'balanceOf', args: [h] })),
        );
        batch.forEach((h, j) => balances.push({ holder: h, balance: bals[j]! }));
      }
      queue = planProRata(balance, balances, this.cfg.reflectionMinPayout);
      this.queues.set(key, queue);
      console.log(`[keeper:reflections] ${s.launch.base}: round of ${queue.length} payouts from pool ${balance} across ${candidates.length} candidates`);
    }
    const paid: Payout[] = [];
    while (queue.length > 0 && paid.length < this.cfg.reflectionMaxTxPerTick) {
      const p = queue.shift()!;
      await send(ctx, `reflection ${p.amount} -> ${p.to}`, {
        address: s.launch.base,
        abi: dn404TaxTemplateAbi,
        functionName: 'transfer',
        args: [p.to, p.amount],
      });
      paid.push(p);
    }
    return paid;
  }
}
