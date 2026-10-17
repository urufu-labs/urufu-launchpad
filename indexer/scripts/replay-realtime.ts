/// Measure realtime catch-up speed through Ponder 0.7's OWN request queue.
///
/// Ponder 0.7's realtime sync catches up in rounds: up to 25 missing blocks
/// (MAX_QUEUED_BLOCKS) fetched in parallel, each = eth_getBlockByNumber(full
/// txs) + eth_getLogs({ blockHash }), through createRequestQueue (rate =
/// maxRequestsPerSecond, concurrency = ceil(rate / 4)). This script replays
/// that call pattern over recent blocks with Ponder's real network build and
/// request queue and the production transport (../rpcTransport.ts), and
/// reports blocks/s plus per-RPC HTTP outcomes. It leaves out receipts and DB
/// work, so it is an upper bound on what the indexer can do.
///
/// Run (from indexer/):
///   REPLAY_RPC_URL=<comma list> pnpm run replay:realtime [-- rounds]

import path from 'node:path';

import { createConfig } from '@ponder/core';

// @ts-expect-error -- virtual module provided by scripts/ponder-internals.mjs
import * as ponderInternals from 'ponder-internals';

import { batchedTransport } from '../rpcTransport';

const { buildConfigAndIndexingFunctions, buildOptions, createLogger, createRequestQueue, MetricsService } =
  ponderInternals as Record<string, any>;

const rounds = Number(process.argv[2] ?? 12);
const rpc = process.env.REPLAY_RPC_URL;
if (!rpc) throw new Error('REPLAY_RPC_URL is required (same comma-separated format as ROBINHOOD_RPC_URL)');

// Observe (not modify) fetch: HTTP outcome per host and per JSON-RPC call.
const stats = new Map<string, Map<string, number>>();
const bump = (host: string, k: string, n = 1) => {
  const m = stats.get(host) ?? new Map<string, number>();
  stats.set(host, m);
  m.set(k, (m.get(k) ?? 0) + n);
};
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const host = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).host;
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  const calls = Array.isArray(body) ? body.length : 1;
  try {
    const res = await origFetch(input, init);
    bump(host, `HTTP ${res.status}`);
    bump(host, 'calls', calls);
    return res;
  } catch (e) {
    bump(host, `network ${(e as Error).name}`);
    throw e;
  }
}) as typeof fetch;

const config = createConfig({
  networks: {
    robinhood: {
      chainId: 4663,
      transport: batchedTransport(rpc),
      maxRequestsPerSecond: Number(process.env.PONDER_MAX_RPS_ROBINHOOD ?? 50),
    },
  },
  // Ponder refuses a build with no indexing functions; this source is never synced.
  contracts: {
    Unused: { abi: [{ type: 'event', name: 'Unused', inputs: [] }], network: 'robinhood', startBlock: 0, endBlock: 0 },
  },
});
const options = buildOptions({
  cliOptions: { command: 'start', root: path.resolve('.'), config: 'ponder.config.ts', logLevel: process.env.REPLAY_LOG_LEVEL ?? 'warn', logFormat: 'pretty' },
});
const common = {
  options,
  logger: createLogger({ level: options.logLevel }),
  metrics: new MetricsService(),
  telemetry: { record() {}, async flush() {}, async kill() {} },
};
const build = await buildConfigAndIndexingFunctions({ config, rawIndexingFunctions: [{ name: 'Unused:Unused', fn: () => {} }], options });
const network = build.networks.find((n: { name: string }) => n.name === 'robinhood');
const q = createRequestQueue({ network, common });

const hex = (n: number) => `0x${n.toString(16)}`;
const head = Number(await q.request({ method: 'eth_blockNumber' }));
let next = head - rounds * 25 - 50;

const t0 = performance.now();
let failed = 0;
for (let r = 0; r < rounds; r++) {
  const blocks = Array.from({ length: 25 }, (_, i) => next + i);
  next += 25;
  await Promise.all(
    blocks.map(async (n) => {
      try {
        const block = (await q.request({ method: 'eth_getBlockByNumber', params: [hex(n), true] })) as { hash: string } | null;
        if (!block) throw new Error(`block ${n} null`);
        await q.request({ method: 'eth_getLogs', params: [{ blockHash: block.hash }] });
      } catch {
        failed++;
      }
    }),
  );
}
const secs = (performance.now() - t0) / 1000;
q.kill?.();

console.log(`\n=== realtime pattern: ${rounds * 25} blocks in ${secs.toFixed(1)}s = ${((rounds * 25) / secs).toFixed(1)} blocks/s (failed blocks: ${failed})`);
console.log(`RPCs: ${rpc.split(',').map((u) => new URL(u.trim()).host).join(' > ')}; maxRequestsPerSecond ${network.maxRequestsPerSecond}; RPC_BATCH ${process.env.RPC_BATCH ?? '(batched)'}`);
for (const [host, m] of stats) console.log(`  ${host}: ${[...m].map(([k, v]) => `${k} ${v}`).join(', ')}`);
process.exit(0);
