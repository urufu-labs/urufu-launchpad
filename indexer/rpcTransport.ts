import { getLogsRetryHelper } from '@ponder/utils';
import { BaseError, fallback, http, LimitExceededRpcError, type RpcError, type Transport } from 'viem';

/// The transport every network in ponder.config.ts uses.
///
/// Ponder 0.7 calls this transport object directly (configAndIndexingFunctions
/// builds `network.transport = transport({ chain })` and the request queue
/// calls `.request()` on it), so anything done here is on Ponder's real path.
///
/// One URL: a plain batched http transport, unchanged from before.
///
/// Several URLs (Robinhood: official, Infura, ordofi, dRPC): a viem fallback,
/// plus a router for ranged eth_getLogs. The free Robinhood RPCs each cap
/// eth_getLogs differently and reject wider ranges with messages Ponder's
/// range parser (@ponder/utils getLogsRetryHelper) doesn't know:
///
///   official -32602 "query spans N blocks ..., but only 30000 are allowed"
///   Infura   -32602 "range N exceeds limit of 10000"
///   ordofi   -32005 "the network is busy" (anything over ~2000 blocks)
///   dRPC         35 "ranges over 10000 blocks are not supported on free plan"
///                   (HTTP 400; on our window even for ~120 blocks, so no
///                   range it serves reliably)
///
/// With a bare fallback, Ponder only ever saw the LAST endpoint's error (and
/// dRPC's in a batch is just "HTTP 400 Bad Request"), couldn't parse it, and
/// treated it as fatal: "Fatal error: Unable to sync 'robinhood'" (2026-10-17).
///
/// The router sends a range only to endpoints whose cap covers it, in the
/// configured order. If none of them answers, it throws an error Ponder CAN act
/// on, so Ponder's own historical sync re-chunks and its request queue keeps
/// pacing the retries:
///   - some endpoint was skipped for being too narrow -> "maximum block range:
///     N" (N = the widest such cap, minus one), which Ponder parses and then
///     requests N-block chunks; a reply over viem's 10 MB body cap halves N;
///   - else an endpoint error Ponder already parses -> that error;
///   - else -32005 (LimitExceeded), which Ponder's request queue retries with
///     backoff instead of giving up.
/// Everything else (blocks, receipts, getLogs by blockHash) goes through the
/// fallback exactly as before.
export function batchedTransport(rpcUrl: string): Transport {
  // Batched HTTP with keepalive: the RPC round-trip is by far the largest cost
  // during historical sync, `wait` lets Ponder's scheduler fill a batch, and
  // keepalive reuses TCP connections. retryCount 5 on a single URL: public
  // RPCs 429 during bursts and the built-in backoff smooths that out.
  // RPC_BATCH=false for rate-limited public RPCs (e.g. Robinhood's public
  // endpoint counts every call inside a batch toward its limit and answers a
  // 25-call batch with 429). Default stays batched for paid providers.
  const batch = process.env.RPC_BATCH === 'false' ? false : { batchSize: 100, wait: 20 };
  const urls = rpcUrl.split(',').map((u) => u.trim()).filter(Boolean);
  const one = (u: string, retryCount: number) =>
    http(u, { batch, fetchOptions: { keepalive: true }, retryCount, timeout: 15_000 });
  if (urls.length <= 1) return one(urls[0] ?? rpcUrl, 5);

  // Comma-separated list = viem fallback across free public endpoints, in
  // order. On Robinhood no single free RPC does everything; any error/429 on
  // one endpoint moves the request to the next.
  // Ranged getLogs goes out unbatched: a batch of several wide getLogs replies
  // overruns viem's 10 MB response-body cap (ResponseBodyTooLargeError, seen
  // in the replay), and the queue already runs them in parallel.
  //
  // Everything else (realtime: blocks, getLogs by blockHash, receipts) is
  // spread round-robin over the keyless RPCs in SPREAD_HOSTS, each turn a
  // fallback starting at that RPC and then the configured order. Official
  // first took ALL realtime traffic at Ponder's 50 req/s, over its ~20-35
  // req/s budget: 661 x 429 in 300 blocks and 11 blocks/s batched (realtime
  // replay 2026-10-17), slower than the chain. Keyed RPCs (Infura) stay
  // fallback-only so realtime doesn't burn their quota.
  const caps = getLogsCaps();
  const spread = urls.filter((u) => SPREAD_HOSTS.includes(new URL(u).host));
  const starts = spread.length > 1 ? spread : [urls[0]!];
  const fallbacks = starts.map((first) =>
    fallback([first, ...urls.filter((u) => u !== first)].map((u) => one(u, 1)), { retryCount: 3 }),
  );
  return withGetLogsRouter(
    fallbacks,
    urls.map((u) => ({
      name: new URL(u).host,
      transport: http(u, { batch: false, fetchOptions: { keepalive: true }, retryCount: 1, timeout: 15_000 }),
      maxBlocks: maxBlocksFor(u, caps),
    })),
  );
}

// ---------------------------------------------------------------- caps

/// Keyless RPCs that share realtime traffic (see batchedTransport). Override:
/// RPC_SPREAD_HOSTS="host1,host2" (one host or empty = plain configured order).
const SPREAD_HOSTS = (process.env.RPC_SPREAD_HOSTS ?? 'rpc.mainnet.chain.robinhood.com,rpc.ordofi.network')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

/// Widest eth_getLogs range (in blocks) each RPC serves; 0 = never send it a
/// ranged eth_getLogs. Matched against the URL host suffix. Measured
/// 2026-10-17 on Robinhood mainnet. Unknown hosts: no cap.
const DEFAULT_GETLOGS_CAPS: Record<string, number> = {
  'rpc.mainnet.chain.robinhood.com': 30_000,
  'infura.io': 10_000,
  'rpc.ordofi.network': 2_000,
  'drpc.org': 0,
};

/// Optional override without a code change:
/// RPC_GETLOGS_MAX_BLOCKS="rpc.ordofi.network=5000,drpc.org=0"
function getLogsCaps(): Record<string, number> {
  const caps = { ...DEFAULT_GETLOGS_CAPS };
  for (const pair of (process.env.RPC_GETLOGS_MAX_BLOCKS ?? '').split(',')) {
    const [host, n] = pair.split('=').map((s) => s.trim());
    if (host && n !== undefined && Number.isFinite(Number(n))) caps[host] = Number(n);
  }
  return caps;
}

export function maxBlocksFor(url: string, caps: Record<string, number> = DEFAULT_GETLOGS_CAPS): number {
  const host = new URL(url).host;
  const match = Object.keys(caps)
    .filter((h) => host === h || host.endsWith(`.${h}`))
    .sort((a, b) => b.length - a.length)[0];
  return match === undefined ? Number.POSITIVE_INFINITY : caps[match]!;
}

// ---------------------------------------------------------------- router

export type GetLogsEndpoint = { name: string; transport: Transport; maxBlocks: number };

type GetLogsParams = [{ fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown }];

/// "maximum block range: N" is the publicnode phrase getLogsRetryHelper knows.
/// Ponder then fetches N-block chunks (getChunks), so N = cap - 1 also stays
/// clear of getLogsRetryHelper's "range unchanged" check when the request is
/// exactly cap + 1 blocks wide.
export class GetLogsRangeHint extends BaseError {
  constructor(maxBlocks: number, cause?: Error) {
    super(`No RPC serves this eth_getLogs range; maximum block range: ${maxBlocks - 1}`, {
      cause,
      name: 'GetLogsRangeHint',
    });
  }
}

function blockSpan(params: unknown): number | null {
  const p = Array.isArray(params) ? (params as GetLogsParams)[0] : undefined;
  if (!p || typeof p.fromBlock !== 'string' || typeof p.toBlock !== 'string') return null;
  if (!p.fromBlock.startsWith('0x') || !p.toBlock.startsWith('0x')) return null;
  return Number(BigInt(p.toBlock) - BigInt(p.fromBlock) + 1n);
}

/// `inner`: the fallback(s) for everything that isn't a ranged getLogs; with
/// several, calls rotate round-robin across them.
export function withGetLogsRouter(inner: Transport | Transport[], endpoints: GetLogsEndpoint[]): Transport {
  const inners = Array.isArray(inner) ? inner : [inner];
  let turn = 0;
  return (opts) => {
    const bases = inners.map((t) => t(opts));
    const base = bases[0]!;
    // Same per-call options viem's fallback passes to its members.
    const eps = endpoints.map((e) => ({ ...e, t: e.transport({ ...opts, retryCount: 0 }) }));

    const request = (async (args: { method: string; params?: unknown }) => {
      const span = args.method === 'eth_getLogs' ? blockSpan(args.params) : null;
      if (span === null) return bases[turn++ % bases.length]!.request(args as never);

      const errors: Error[] = [];
      let widestTooNarrow = 0;
      for (const ep of eps) {
        if (ep.maxBlocks <= 0) continue;
        if (span > ep.maxBlocks) {
          widestTooNarrow = Math.max(widestTooNarrow, ep.maxBlocks);
          continue;
        }
        try {
          return await ep.t.request(args as never);
        } catch (err) {
          errors.push(err as Error);
        }
      }

      const last = errors[errors.length - 1];
      // A reply over viem's 10 MB body cap: same range, fewer logs per call.
      const tooLarge = errors.some(
        (e) => e instanceof BaseError && e.walk((c) => (c as Error).name === 'ResponseBodyTooLargeError') !== null,
      );
      let hint = widestTooNarrow > 0 ? widestTooNarrow : Number.POSITIVE_INFINITY;
      if (tooLarge) hint = Math.min(hint, Math.floor(span / 2));
      if (hint >= 2 && hint < span) throw new GetLogsRangeHint(hint, last);
      const parseable = errors.find(
        (e) =>
          getLogsRetryHelper({ params: args.params as Parameters<typeof getLogsRetryHelper>[0]['params'], error: e as RpcError })
            .shouldRetry,
      );
      if (parseable) throw parseable;
      // Wrapped once more: RpcError copies the code of a raw RpcRequestError
      // cause (e.g. dRPC's 35), which Ponder would not retry.
      throw new LimitExceededRpcError(
        new BaseError('Every RPC failed this eth_getLogs', { cause: last, name: 'GetLogsAllFailed' }),
      );
    }) as typeof base.request;

    return { ...base, request };
  };
}
