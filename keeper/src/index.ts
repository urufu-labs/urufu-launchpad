/**
 * DN404 tax keeper entry point. Runs Keeper.tick() every
 * KEEPER_POLL_INTERVAL_MS; drains the current tick on SIGINT/SIGTERM.
 */
import { makeClients } from './clients.ts';
import { loadConfig } from './config.ts';
import { Keeper } from './keeper.ts';
import { OpenSeaProvider } from './opensea.ts';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { public: pc, wallet: wc, account } = makeClients(cfg);
  const listings = cfg.openseaApiKey ? new OpenSeaProvider(cfg.openseaApiKey, cfg.openseaChain) : null;
  console.log(
    `[keeper] boot chain=${cfg.chainId} keeper=${account.address} factory=${cfg.launchFactory} from block ${cfg.discoveryStartBlock} opensea=${listings ? 'on' : 'OFF (floor mode burns only)'}`,
  );
  const keeper = new Keeper({ pc, wc, keeper: account.address }, cfg, listings);

  let stopping = false;
  const stop = (sig: string) => {
    console.log(`[keeper] ${sig}: finishing current tick then exiting`);
    stopping = true;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (!stopping) {
    const started = Date.now();
    try {
      await keeper.tick();
    } catch (err) {
      console.error(`[keeper] tick failed: ${(err as Error).message}`);
    }
    const wait = Math.max(0, cfg.pollIntervalMs - (Date.now() - started));
    if (wait > 0 && !stopping) await new Promise((r) => setTimeout(r, wait));
  }
  console.log('[keeper] shutdown complete');
}

main().catch((err) => {
  console.error(`[keeper] fatal: ${(err as Error).message}`);
  process.exit(1);
});
