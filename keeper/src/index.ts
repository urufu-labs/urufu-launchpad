/**
 * DN404 tax-hook keeper — entry point.
 *
 * Poll every `KEEPER_POLL_INTERVAL_MS`. For each watched launch, snapshot
 * on-chain state → decide whether to sweep → execute sweep + handler.
 * One launch's failure never blocks the others (settled independently
 * per iteration; errors log LOUD but don't crash the loop).
 *
 * Health signal: stdout prints one line per launch per tick describing
 * the decision. In prod, hook this up to your log aggregator + alert
 * on any "refuse (alert ops)" or repeated failure line.
 */

import { loadConfig } from './config.ts';
import { makeClients } from './clients.ts';
import { snapshotLaunch, decideSweep, executeSweep } from './sweeper.ts';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { public: publicClient, wallet: walletClient, account } = makeClients(cfg);

  console.log(
    `[keeper] boot — chain=${cfg.chainId} keeper=${account.address} launches=${cfg.launches.length} pollMs=${cfg.pollIntervalMs}`,
  );

  let stopping = false;
  const shutdown = (sig: string) => {
    console.log(`[keeper] ${sig} received, draining current tick then exiting`);
    stopping = true;
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  while (!stopping) {
    const tickStart = Date.now();
    for (const watch of cfg.launches) {
      try {
        const snapshot = await snapshotLaunch(publicClient, watch.base);
        const decision = decideSweep(watch, snapshot, account.address, cfg);
        if (!decision.shouldSweep) {
          console.log(`[keeper] ${watch.base} skip: ${decision.reason}`);
          continue;
        }
        await executeSweep(publicClient, walletClient, account.address, cfg, watch, snapshot);
      } catch (err) {
        // Isolate per-launch failures — one broken launch shouldn't
        // block the others. LOUD log; ops watches the aggregator.
        console.error(
          `[keeper] ${watch.base} error: ${(err as Error).message}\n${(err as Error).stack ?? ''}`,
        );
      }
    }

    const elapsed = Date.now() - tickStart;
    const wait = Math.max(0, cfg.pollIntervalMs - elapsed);
    if (wait > 0 && !stopping) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  console.log('[keeper] shutdown complete');
}

main().catch((err) => {
  console.error(`[keeper] fatal: ${(err as Error).message}`);
  process.exit(1);
});
