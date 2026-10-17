/// eth_getLogs range errors that Ponder 0.7 can't read.
///
/// Ponder splits a too-wide eth_getLogs request by matching the provider's
/// error text against a fixed list (@ponder/utils getLogsRetryHelper). Three
/// of our Robinhood RPCs reject wide ranges with messages that aren't on that
/// list, so Ponder neither shrinks the range nor moves on, and the historical
/// sync either crawls or dies with "Fatal error: Unable to sync" (seen
/// 2026-10-17, 7 crash-restarts in a few minutes):
///
///   Infura  -32602 "range 10001 exceeds limit of 10000"
///   dRPC        35 "ranges over 10000 blocks are not supported on free plan"
///   ordofi  -32005 "the network is busy, please try again in a moment"
///                  (its answer to any getLogs wider than ~2000 blocks)
///
/// `withRangeHints` wraps a transport and, for eth_getLogs only, appends
/// "maximum block range: N" to the error's `details`, a phrase Ponder already
/// understands. Ponder then retries in N+1-block chunks. Everything else about
/// the error (class, code, URL) is untouched, so viem's fallback still moves
/// to the next RPC exactly as before.

import type { Transport } from 'viem';

/// Ponder's chunk({ range: N }) asks for N+1 blocks, so a provider limit of
/// L blocks becomes a hint of L - 1.
const ORDOFI_MAX_BLOCKS = 2000;

type GetLogsParams = readonly [{ fromBlock?: unknown; toBlock?: unknown }] | readonly unknown[] | undefined;

function requestedBlocks(params: GetLogsParams): bigint | null {
  const p = Array.isArray(params) ? (params[0] as { fromBlock?: unknown; toBlock?: unknown } | undefined) : undefined;
  if (!p || typeof p.fromBlock !== 'string' || typeof p.toBlock !== 'string') return null;
  if (!p.fromBlock.startsWith('0x') || !p.toBlock.startsWith('0x')) return null;
  return BigInt(p.toBlock) - BigInt(p.fromBlock) + 1n;
}

/// The Ponder-style hint ("maximum block range: N") for a getLogs error, or
/// null when the error isn't one of the range rejections we know about.
export function rangeHintFor(errorText: string, params: GetLogsParams): number | null {
  let m = errorText.match(/exceeds limit of (\d+)/);
  if (m) return Math.max(1, Number(m[1]) - 1);

  m = errorText.match(/ranges over (\d+) blocks are not supported/);
  if (m) return Math.max(1, Number(m[1]) - 1);

  // ordofi says "busy" instead of naming a limit. Only treat it as a range
  // error when the request really was wider than what it serves; a genuine
  // "busy" on a narrow request is left alone.
  if (/the network is busy/.test(errorText)) {
    const blocks = requestedBlocks(params);
    if (blocks !== null && blocks > BigInt(ORDOFI_MAX_BLOCKS)) return ORDOFI_MAX_BLOCKS - 1;
  }
  return null;
}

function errorText(err: unknown): string {
  try {
    return JSON.stringify(err) + ' ' + String((err as { message?: unknown })?.message ?? '');
  } catch {
    return String((err as { message?: unknown })?.message ?? err);
  }
}

/// Wrap one RPC transport so its eth_getLogs range errors carry a hint Ponder
/// can act on. Non-getLogs calls and unrecognized errors pass through as-is.
export function withRangeHints(transport: Transport): Transport {
  return (opts) => {
    const inner = transport(opts);
    const request = (async (args: { method: string; params?: unknown }) => {
      try {
        return await inner.request(args as never);
      } catch (err) {
        if (args.method === 'eth_getLogs' && err && typeof err === 'object') {
          const hint = rangeHintFor(errorText(err), args.params as GetLogsParams);
          if (hint !== null) {
            const e = err as { details?: unknown };
            e.details = `maximum block range: ${hint}${typeof e.details === 'string' ? ` (${e.details})` : ''}`;
          }
        }
        throw err;
      }
    }) as typeof inner.request;
    return { ...inner, request };
  };
}
