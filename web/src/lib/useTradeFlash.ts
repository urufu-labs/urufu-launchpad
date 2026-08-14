'use client';

/// Buy/sell flash bus — polls the indexer's recent trades and dispatches
/// a `trade-flash` CustomEvent whenever a new trade lands for any token.
/// Card components subscribe via `useTradeFlash(address)` and receive a
/// 'buy' | 'sell' | null state that auto-clears after `durationMs`.
///
/// Design notes:
///   - Singleton poller keyed by chainId. Multiple pages calling
///     `startTradeFlashPolling(chainId)` reuse the same interval.
///   - First poll seeds `lastSeenPerToken` without dispatching so the UI
///     doesn't flash historical trades on mount.
///   - Uses the same `fetchRecentTrades` + `fetchRecentV4Swaps` calls the
///     home rail already uses; adding this poller adds one extra 5s tick
///     shared across every subscriber.

import { useEffect, useRef, useState } from 'react';

import {
  fetchRecentTrades,
  fetchRecentV4Swaps,
} from './indexer';

type FlashSide = 'buy' | 'sell';

const FLASH_EVENT = 'trade-flash';
/// Separate event that fires on every poll cycle where the last-seen map
/// changed — including the initial seed pass, which intentionally does NOT
/// dispatch trade-flash events. Consumers that want the map to stay in sync
/// (useLastTradeMap → discover / trade-lookup sorts) must listen on both.
const MAP_UPDATE_EVENT = 'trade-map-updated';
const POLL_INTERVAL_MS = 5_000;

interface FlashDetail {
  address: string;
  side: FlashSide;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollChainId: number | null = null;
let seeded = false;
const lastSeenPerToken = new Map<string, number>();

function emit(address: string, side: FlashSide): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<FlashDetail>(FLASH_EVENT, {
      detail: { address: address.toLowerCase(), side },
    }),
  );
}

async function pollOnce(chainId: number): Promise<void> {
  const [curve, v4] = await Promise.all([
    fetchRecentTrades(30).catch(() => null),
    fetchRecentV4Swaps(30).catch(() => null),
  ]);
  const rows: Array<{ addr: string; ts: number; isBuy: boolean }> = [];
  for (const r of curve ?? []) {
    if (r.chainId !== chainId) continue;
    rows.push({
      addr: r.tokenAddress.toLowerCase(),
      ts: Number(r.blockTimestamp),
      isBuy: r.isBuy,
    });
  }
  for (const r of v4 ?? []) {
    if (r.chainId !== chainId) continue;
    if (!r.tokenAddress) continue;
    // v4 direction: currency0 is ETH; amount0 < 0 means pool paid out ETH → user bought.
    const isBuy = BigInt(r.amount0) < 0n;
    rows.push({
      addr: r.tokenAddress.toLowerCase(),
      ts: Number(r.blockTimestamp),
      isBuy,
    });
  }
  // Oldest → newest so if two ticks land in the same poll for one token,
  // the most recent one wins (setting lastSeen to the largest ts).
  rows.sort((a, b) => a.ts - b.ts);
  let changed = false;
  for (const r of rows) {
    const last = lastSeenPerToken.get(r.addr) ?? 0;
    if (r.ts <= last) continue;
    lastSeenPerToken.set(r.addr, r.ts);
    changed = true;
    // First seed pass: register timestamps silently so we only flash on trades
    // that land AFTER the poller started.
    if (!seeded) continue;
    emit(r.addr, r.isBuy ? 'buy' : 'sell');
  }
  if (!seeded) seeded = true;
  // Notify map subscribers on ANY change — seed pass included. useLastTradeMap
  // relies on this to pick up historical timestamps that the trade-flash event
  // intentionally skips.
  if (changed && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(MAP_UPDATE_EVENT));
  }
}

/// Start the shared poller. Safe to call from multiple components — later
/// calls with the same chainId are no-ops. Calls with a new chainId
/// restart the poller (and clear the seen-set so we don't cross-contaminate
/// per-chain state).
export function startTradeFlashPolling(chainId: number): void {
  if (typeof window === 'undefined') return;
  if (pollTimer && pollChainId === chainId) return;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    lastSeenPerToken.clear();
    seeded = false;
  }
  pollChainId = chainId;
  void pollOnce(chainId);
  pollTimer = setInterval(() => {
    void pollOnce(chainId);
  }, POLL_INTERVAL_MS);
}

export function stopTradeFlashPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollChainId = null;
  lastSeenPerToken.clear();
  seeded = false;
}

/// Subscribe to `trade-flash` events scoped to one token address. Returns
/// the current flash state, which auto-clears to null after `durationMs`.
/// Consumers usually toggle a className based on this value.
export function useTradeFlash(
  address: string | undefined,
  durationMs = 800,
): FlashSide | null {
  const [state, setState] = useState<FlashSide | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!address) return;
    const key = address.toLowerCase();
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<FlashDetail>).detail;
      if (!detail || detail.address !== key) return;
      setState(detail.side);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setState(null), durationMs);
    };
    window.addEventListener(FLASH_EVENT, listener);
    return () => {
      window.removeEventListener(FLASH_EVENT, listener);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [address, durationMs]);
  return state;
}

/// Convenience: map the flash state to the two shared CSS classes so a
/// consumer just concatenates the returned string into its className.
export function tradeFlashClass(state: FlashSide | null): string {
  if (state === 'buy') return 'uru-flash-buy';
  if (state === 'sell') return 'uru-flash-sell';
  return '';
}

/// Live-updating snapshot of the "last trade timestamp per token" map that
/// the flash poller already maintains. Components use this to sort feeds
/// so tokens with recent trades bubble to the top:
///
///   const lastMap = useLastTradeMap();
///   list.sort((a, b) => {
///     const aTs = lastMap.get(a.address.toLowerCase()) ?? 0;
///     const bTs = lastMap.get(b.address.toLowerCase()) ?? 0;
///     if (aTs !== bTs) return bTs - aTs;
///     return b.launchedAt - a.launchedAt;
///   });
///
/// State updates on every `trade-flash` dispatch, which fires on every
/// polled trade — so the sort re-runs the moment a new trade lands.
export function useLastTradeMap(): Map<string, number> {
  const [map, setMap] = useState<Map<string, number>>(
    () => new Map(lastSeenPerToken),
  );
  useEffect(() => {
    const listener = (): void => setMap(new Map(lastSeenPerToken));
    // Sync on both events so:
    //   - trade-flash (post-seed trades) triggers a re-sort
    //   - trade-map-updated (seed pass + subsequent) picks up historical
    //     timestamps that trade-flash intentionally skips
    window.addEventListener(FLASH_EVENT, listener);
    window.addEventListener(MAP_UPDATE_EVENT, listener);
    // Also do an immediate read in case the poller already seeded before
    // this component mounted (common when navigating between pages).
    if (lastSeenPerToken.size > 0) setMap(new Map(lastSeenPerToken));
    return () => {
      window.removeEventListener(FLASH_EVENT, listener);
      window.removeEventListener(MAP_UPDATE_EVENT, listener);
    };
  }, []);
  return map;
}
