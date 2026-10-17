/// Replay a Robinhood block window through Ponder 0.7's OWN historical sync.
///
/// Builds the network with Ponder's buildConfigAndIndexingFunctions (the same
/// call `ponder start` makes), then runs createRequestQueue +
/// createHistoricalSync().sync([from, to]) exactly as Ponder's sync service
/// does. Only the sync store is in memory (no database needed); every RPC call,
/// retry, getLogs range split and fallback is Ponder + viem production code.
///
/// The transport under test is `batchedTransport` from ../rpcTransport.ts, the
/// one ponder.config.ts uses in production.
///
/// Run (from indexer/):
///   REPLAY_RPC_URL=https://rpc.ordofi.network,https://robinhood.drpc.org \
///     pnpm run replay:getlogs [-- fromBlock toBlock]
///
/// The filter is every ERC-20 Transfer (Transfer topic, no address), which is
/// the shape of the production factory-child Transfer filter and is heavy
/// enough to trip the providers' range limits.
///
/// global fetch is observed (not modified) to print which URL served each
/// eth_getLogs and with what range, as evidence.

import path from 'node:path';

import { createConfig } from '@ponder/core';
import { parseAbi } from 'viem';

// Ponder internals from the compiled CLI file (see scripts/ponder-internals.mjs).
// @ts-expect-error -- virtual module provided by the loader hook
import * as ponderInternals from 'ponder-internals';

import { batchedTransport } from '../rpcTransport';

const {
  buildConfigAndIndexingFunctions,
  buildOptions,
  createHistoricalSync,
  createLogger,
  createRequestQueue,
  MetricsService,
} = ponderInternals as Record<string, any>;

const from = Number(process.argv[2] ?? process.env.REPLAY_FROM ?? 90446315);
const to = Number(process.argv[3] ?? process.env.REPLAY_TO ?? 90456827);
const rpc = process.env.REPLAY_RPC_URL;
if (!rpc) throw new Error('REPLAY_RPC_URL is required (same comma-separated format as ROBINHOOD_RPC_URL)');

// ---------------------------------------------------------------- observe fetch

type Rpc = { method?: string; params?: [{ fromBlock?: string; toBlock?: string }] };
const stats = new Map<string, { ok: number; err: number; blocks: number[]; errors: Map<string, number> }>();
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).host;
  let body: Rpc | Rpc[] | undefined;
  try {
    body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  } catch {}
  const calls = (Array.isArray(body) ? body : body ? [body] : []).filter((c) => c.method === 'eth_getLogs');
  const record = (c: Rpc, outcome: string | null) => {
    const s = stats.get(url) ?? { ok: 0, err: 0, blocks: [], errors: new Map() };
    stats.set(url, s);
    const p = c.params?.[0];
    const width = p?.fromBlock && p?.toBlock ? Number(BigInt(p.toBlock) - BigInt(p.fromBlock) + 1n) : -1;
    if (outcome === null) {
      s.ok++;
      s.blocks.push(width);
    } else {
      s.err++;
      s.errors.set(outcome, (s.errors.get(outcome) ?? 0) + 1);
    }
  };
  let res: Response;
  try {
    res = await origFetch(input, init);
  } catch (e) {
    calls.forEach((c) => record(c, `network: ${(e as Error).name}`));
    throw e;
  }
  if (calls.length === 0) return res;
  const text = await res.clone().text().catch(() => '');
  // viem (2.54) rejects any HTTP body over 10 MB (ResponseBodyTooLargeError).
  const tooLarge = text.length > 10 * 1024 * 1024;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {}
  const replies = (Array.isArray(json) ? json : [json]) as ({ result?: unknown; error?: { code: number; message: string } } | undefined)[];
  calls.forEach((c, i) => {
    const r = replies[i] ?? replies[0];
    if (tooLarge) record(c, 'body over 10 MB (viem rejects it)');
    else if (res.ok && r && 'result' in r) record(c, null);
    else record(c, r?.error ? `${r.error.code} ${String(r.error.message).slice(0, 70)}` : `HTTP ${res.status}`);
  });
  return res;
}) as typeof fetch;

// ---------------------------------------------------------------- Ponder build

const config = createConfig({
  networks: {
    robinhood: {
      chainId: 4663,
      transport: batchedTransport(rpc),
      maxRequestsPerSecond: Number(process.env.PONDER_MAX_RPS_ROBINHOOD ?? 50),
    },
  },
  contracts: {
    Transfers: {
      abi: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']),
      network: 'robinhood',
      startBlock: from,
      endBlock: to,
    },
  },
});

const options = buildOptions({
  cliOptions: { command: 'start', root: path.resolve('.'), config: 'ponder.config.ts', logLevel: process.env.REPLAY_LOG_LEVEL ?? 'debug', logFormat: 'pretty' } as never,
});
const common = {
  options,
  logger: createLogger({ level: options.logLevel }),
  metrics: new MetricsService(),
  telemetry: { record() {}, async flush() {}, async kill() {} },
};

const build = await buildConfigAndIndexingFunctions({
  config: config as never,
  rawIndexingFunctions: [{ name: 'Transfers:Transfer', fn: () => {} }],
  options,
});
const network = build.networks.find((n: { name: string }) => n.name === 'robinhood');

// ---------------------------------------------------------------- in-memory sync store

let logs = 0;
let txs = 0;
const syncStore = {
  insertInterval: async () => {},
  getIntervals: async () => [],
  getChildAddresses: async () => [],
  filterChildAddresses: async () => new Set(),
  insertLogs: async ({ logs: l }: { logs: unknown[] }) => void (logs += l.length),
  insertBlocks: async () => {},
  hasBlock: async () => false,
  insertTransactions: async ({ transactions }: { transactions: unknown[] }) => void (txs += transactions.length),
  hasTransaction: async () => false,
  insertTransactionReceipts: async () => {},
  hasTransactionReceipt: async () => false,
  insertCallTraces: async () => {},
};

// ---------------------------------------------------------------- run

const requestQueue = createRequestQueue({ network, common });
let fatal: Error | undefined;
const historicalSync = await createHistoricalSync({
  common,
  sources: build.sources.filter((s: { filter: { chainId: number } }) => s.filter.chainId === network.chainId),
  syncStore,
  network,
  requestQueue,
  onFatalError: (e: Error) => {
    fatal = e;
  },
});

const t0 = Date.now();
let ok = true;
try {
  await historicalSync.sync([from, to]);
} catch (e) {
  ok = false;
  fatal ??= e as Error;
}
requestQueue.kill?.();

console.log(`\n=== replay ${from}-${to} (${to - from + 1} blocks) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`RPCs: ${rpc.split(',').map((u) => new URL(u.trim()).host).join(' > ')}`);
for (const [url, s] of stats) {
  const widths = s.blocks.length ? `widths min ${Math.min(...s.blocks)} max ${Math.max(...s.blocks)}` : '';
  console.log(`  ${url}: getLogs ok ${s.ok}, failed ${s.err} ${widths}`);
  for (const [m, n] of s.errors) console.log(`      ${n}x ${m}`);
}
console.log(`logs synced: ${logs}, transactions: ${txs}`);
console.log(ok && !fatal ? 'RESULT: OK' : `RESULT: FAILED: ${fatal?.message?.split('\n')[0]}`);
process.exit(ok && !fatal ? 0 : 1);
