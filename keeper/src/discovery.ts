/**
 * Launch discovery from Dn404LaunchFactory.Dn404Launched logs.
 *
 * Scans incrementally in <= logChunk windows (RH's RPC only serves
 * unbounded responses for <= 5000-block ranges). Keeps every launch whose
 * taxMode at launch != Off: those are tax-template clones. Off launches are
 * plain Dn404Template clones with no tax surface at all, so they can never
 * accumulate. (A tax clone whose launcher later switches to Off simply has
 * nothing to sweep; it stays watched.)
 */
import { parseAbiItem, type Address } from 'viem';
import type { PublicClient } from './clients.ts';
import type { KeeperConfig } from './config.ts';

export interface DiscoveredLaunch {
  base: Address;
  mirror: Address;
  curve: Address;
  launcher: Address;
  pair: Address;
  taxModeAtLaunch: number;
  unit: bigint;
  totalSupply: bigint;
  launchBlock: bigint;
}

const launchedEvent = parseAbiItem(
  'event Dn404Launched(address indexed base, address indexed mirror, address indexed curve, address launcher, address pairCurrency, uint8 taxMode, uint16 taxBps, bytes32 configHash, uint256 uruPaid, uint256 totalSupply, uint256 unit, uint256 founderPremint, string name, string ticker)',
);

export class LaunchDiscovery {
  private next: bigint;
  readonly launches = new Map<string, DiscoveredLaunch>();

  private readonly cfg: KeeperConfig;
  constructor(cfg: KeeperConfig) {
    this.cfg = cfg;
    this.next = cfg.discoveryStartBlock;
  }

  /// Pull new launches up to the current head. Returns the newly found ones.
  async poll(pc: PublicClient): Promise<DiscoveredLaunch[]> {
    const head = await pc.getBlockNumber();
    const found: DiscoveredLaunch[] = [];
    while (this.next <= head) {
      const to = this.next + this.cfg.logChunk - 1n > head ? head : this.next + this.cfg.logChunk - 1n;
      const logs = await pc.getLogs({ address: this.cfg.launchFactory, event: launchedEvent, fromBlock: this.next, toBlock: to });
      for (const log of logs) {
        const a = log.args;
        if (!a.base || a.taxMode === undefined || a.taxMode === 0) continue;
        const d: DiscoveredLaunch = {
          base: a.base,
          mirror: a.mirror!,
          curve: a.curve!,
          launcher: a.launcher!,
          pair: a.pairCurrency!,
          taxModeAtLaunch: a.taxMode,
          unit: a.unit!,
          totalSupply: a.totalSupply!,
          launchBlock: log.blockNumber!,
        };
        if (!this.launches.has(d.base.toLowerCase())) {
          this.launches.set(d.base.toLowerCase(), d);
          found.push(d);
        }
      }
      this.next = to + 1n;
    }
    return found;
  }
}
