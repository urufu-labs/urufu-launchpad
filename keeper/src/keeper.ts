/**
 * Keeper core: one `tick()` = discover new launches, then for each launch
 * snapshot -> decide -> (skipNFT, sweep) -> act. Launch failures are
 * isolated. index.ts runs tick() on an interval; the fork harness calls it
 * directly so tests exercise the production code path.
 */
import type { Address } from 'viem';
import type { KeeperConfig } from './config.ts';
import { taxModeName } from './config.ts';
import { LaunchDiscovery } from './discovery.ts';
import { dispatchHandler } from './handlers/index.ts';
import { ReflectionState } from './handlers/reflections.ts';
import type { ListingsProvider } from './opensea.ts';
import { decideSweep, ensureKeeperSkipsNft, snapshotLaunch, sweep } from './sweeper.ts';
import type { Ctx } from './tx.ts';

export interface TickReport {
  base: Address;
  mode: string;
  decision: string;
  swept: boolean;
  acted: boolean;
  error?: string;
}

export class Keeper {
  readonly discovery: LaunchDiscovery;
  readonly reflections: ReflectionState;

  private readonly ctx: Ctx;
  private readonly cfg: KeeperConfig;
  private readonly listings: ListingsProvider | null;
  constructor(ctx: Ctx, cfg: KeeperConfig, listings: ListingsProvider | null) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.listings = listings;
    this.discovery = new LaunchDiscovery(cfg);
    this.reflections = new ReflectionState(cfg);
  }

  async tick(): Promise<TickReport[]> {
    const found = await this.discovery.poll(this.ctx.pc);
    for (const d of found) console.log(`[keeper] discovered ${d.base} (mode at launch ${taxModeName(d.taxModeAtLaunch)})`);
    const reports: TickReport[] = [];
    for (const launch of this.discovery.launches.values()) {
      const rep: TickReport = { base: launch.base, mode: '?', decision: '', swept: false, acted: false };
      try {
        const s = await snapshotLaunch(this.ctx, launch);
        rep.mode = taxModeName(s.taxMode);
        const d = decideSweep(s, this.ctx.keeper, this.cfg);
        const pendingPayouts = this.reflections.queued(launch.base) > 0;
        rep.decision = d.reason;
        if (!d.shouldSweep && !d.shouldAct && !pendingPayouts) {
          console.log(`[keeper] ${launch.base} skip: ${d.reason}`);
          reports.push(rep);
          continue;
        }
        let balance = s.keeperBalance;
        if (d.shouldSweep) {
          await ensureKeeperSkipsNft(this.ctx, s);
          balance = await sweep(this.ctx, s);
          rep.swept = true;
        }
        await dispatchHandler(this.ctx, this.cfg, s, balance, { reflections: this.reflections, listings: this.listings });
        rep.acted = true;
      } catch (err) {
        rep.error = (err as Error).message;
        console.error(`[keeper] ${launch.base} error: ${rep.error}`);
      }
      reports.push(rep);
    }
    return reports;
  }
}
