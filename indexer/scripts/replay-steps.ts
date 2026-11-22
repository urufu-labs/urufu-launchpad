/// Time Ponder 0.7's historical sync at different step sizes, with the REAL
/// production config (../ponder.config.ts).
///
/// Ponder 0.7 (sync/index.ts) sizes each historical step so it takes about one
/// second: next range = max(25, blocks/second of the last step). When a step
/// has a fixed cost of several seconds (one eth_getLogs per filter, one
/// insertInterval per filter), the range never grows past 25 blocks and the
/// indexer crawls at about chain speed. This replays consecutive steps of
/// REPLAY_STEP blocks through Ponder's own createHistoricalSync().sync() and
/// reports blocks/second.
///
/// Sync store: in memory, except getChildAddresses, which reads the factory
/// logs from the production sync cache (read-only) so factory-child filters
/// make the same getLogs calls as prod. insertInterval sleeps
/// REPLAY_INSERT_MS (32 ms measured on prod 2026-11-22) to charge its cost.
///
/// Run (from indexer/), with the production contract env vars set:
///   REPLAY_DB=<read-only postgres url> ROBINHOOD_RPC_URL=... \
///     pnpm run replay:steps -- <fromBlock> <totalBlocks> <stepBlocks>

import path from 'node:path';

// @ts-expect-error -- virtual module provided by scripts/ponder-internals.mjs
import * as ponderInternals from 'ponder-internals';

import config from '../ponder.config';

const { buildConfigAndIndexingFunctions, buildOptions, createHistoricalSync, createLogger, createRequestQueue, MetricsService } =
  ponderInternals as Record<string, any>;

const from = Number(process.argv[2]);
const total = Number(process.argv[3] ?? 2_000);
const step = Number(process.argv[4] ?? 25);
const insertMs = Number(process.env.REPLAY_INSERT_MS ?? 32);
if (!Number.isFinite(from)) throw new Error('usage: replay-steps <fromBlock> <totalBlocks> <stepBlocks>');

// The same handlers production registers (every `ponder.on('X:Y'` in src/),
// as no-ops, so Ponder builds exactly the production sources.
const { readFileSync, readdirSync } = await import('node:fs');
const srcFiles = (readdirSync('src', { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
const handlerNames = new Set(
  srcFiles.flatMap((f) => [...readFileSync(path.join('src', f), 'utf8').matchAll(/ponder\.on\(\s*['"]([\w]+:[\w()., ]+)['"]/g)].map((m) => m[1]!)),
);
const rawIndexingFunctions = [...handlerNames].map((name) => ({ name, fn: () => {} }));

const options = buildOptions({
  cliOptions: { command: 'start', root: path.resolve('.'), config: 'ponder.config.ts', logLevel: process.env.REPLAY_LOG_LEVEL ?? 'warn', logFormat: 'pretty' },
});
const common = {
  options,
  logger: createLogger({ level: options.logLevel }),
  metrics: new MetricsService(),
  telemetry: { record() {}, async flush() {}, async kill() {} },
};
const build = await buildConfigAndIndexingFunctions({ config, rawIndexingFunctions, options });
const network = build.networks.find((n: { name: string }) => n.name === 'robinhood');
const sources = build.sources.filter((s: { filter: { chainId: number } }) => s.filter.chainId === network.chainId);

// ---------------------------------------------------------------- child addresses from the prod cache

type Factory = { address: string | string[]; eventSelector: string; childAddressLocation: string };
// pg isn't an indexer dependency; borrow the copy @ponder/core ships with.
const { realpathSync } = await import('node:fs');
const { pathToFileURL } = await import('node:url');
const core = realpathSync(new URL('../node_modules/@ponder/core', import.meta.url));
const pg = (await import(pathToFileURL(path.join(core, '..', '..', 'pg', 'esm', 'index.mjs')).href)).default;
const db = new pg.Client({ connectionString: process.env.REPLAY_DB });
await db.connect();
await db.query('SET default_transaction_read_only = on');
const childCache = new Map<string, string[]>();
async function children(f: Factory): Promise<string[]> {
  const addrs = (Array.isArray(f.address) ? f.address : [f.address]).map((a) => a.toLowerCase());
  const key = `${addrs.join(',')}|${f.eventSelector}|${f.childAddressLocation}`;
  if (childCache.has(key)) return childCache.get(key)!;
  const { rows } = await db.query(
    'select topic1, topic2, topic3, data from ponder_sync.logs where "chainId" = 4663 and address = any($1) and topic0 = $2 order by id',
    [addrs, f.eventSelector],
  );
  const out = rows.map((r: { topic1: string; topic2: string; topic3: string; data: string }) => {
    if (f.childAddressLocation.startsWith('offset')) {
      const start = 2 + 24 + Number(f.childAddressLocation.slice(6)) * 2;
      return `0x${r.data.slice(start, start + 40)}`;
    }
    const t = f.childAddressLocation === 'topic1' ? r.topic1 : f.childAddressLocation === 'topic2' ? r.topic2 : r.topic3;
    return `0x${t.slice(26, 66)}`;
  });
  childCache.set(key, out);
  return out;
}

let intervals = 0;
const syncStore = {
  insertInterval: async () => {
    intervals++;
    await new Promise((r) => setTimeout(r, insertMs));
  },
  getIntervals: async () => [],
  getChildAddresses: async ({ filter }: { filter: Factory }) => children(filter),
  filterChildAddresses: async ({ filter, addresses }: { filter: Factory; addresses: string[] }) => {
    const all = new Set((await children(filter)).map((a) => a.toLowerCase()));
    return new Set(addresses.filter((a) => all.has(a.toLowerCase())));
  },
  insertLogs: async () => {},
  insertBlocks: async () => {},
  hasBlock: async () => false,
  insertTransactions: async () => {},
  hasTransaction: async () => false,
  insertTransactionReceipts: async () => {},
  hasTransactionReceipt: async () => false,
  insertCallTraces: async () => {},
};

// ---------------------------------------------------------------- run

const requestQueue = createRequestQueue({ network, common });
const historicalSync = await createHistoricalSync({
  common,
  sources,
  syncStore,
  network,
  requestQueue,
  onFatalError: (e: Error) => {
    throw e;
  },
});

let getLogs = 0;
const origRequest = network.transport.request;
network.transport.request = (args: { method: string }) => {
  if (args.method === 'eth_getLogs') getLogs++;
  return origRequest(args);
};

const t0 = performance.now();
let steps = 0;
for (let a = from; a < from + total; a += step) {
  await historicalSync.sync([a, Math.min(a + step - 1, from + total - 1)]);
  steps++;
}
const secs = (performance.now() - t0) / 1000;
requestQueue.kill?.();
await db.end();

console.log(
  `=== ${total} blocks from ${from} in ${steps} steps of ${step}: ${secs.toFixed(1)}s = ${(total / secs).toFixed(1)} blocks/s, ` +
    `${(secs / steps).toFixed(2)}s/step; ${sources.length} sources, ${getLogs} eth_getLogs, ${intervals} insertInterval`,
);
process.exit(0);
