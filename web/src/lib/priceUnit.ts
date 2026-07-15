'use client';

/// Global "price unit" preference — USD (default) or ETH. Backed by localStorage so
/// the choice persists across sessions + tabs. Emits a custom event so any component
/// re-renders when the toggle flips (no context needed; SSR-safe).

import { useEffect, useState } from 'react';

export type PriceUnit = 'usd' | 'eth';

const STORAGE_KEY = 'uru-price-unit';
const EVENT = 'uru:price-unit-changed';

/// Coingecko free tier — polling every 60s stays comfortably under the 10-30 req/min
/// limit even with lots of tabs open. Response is cached in-memory + localStorage so
/// a fresh page load has a stale-but-usable value before the network round-trip.
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';
const ETH_USD_KEY = 'uru-eth-usd';
const ETH_USD_TTL_MS = 60_000;

// ---------- unit preference ----------

function readInitialUnit(): PriceUnit {
  if (typeof window === 'undefined') return 'usd';
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === 'eth' ? 'eth' : 'usd';
}

export function setPriceUnit(unit: PriceUnit): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, unit);
  window.dispatchEvent(new CustomEvent<PriceUnit>(EVENT, { detail: unit }));
}

export function usePriceUnit(): PriceUnit {
  const [unit, setUnit] = useState<PriceUnit>('usd'); // SSR-safe default
  useEffect(() => {
    setUnit(readInitialUnit());
    const handler = (e: Event) => setUnit((e as CustomEvent<PriceUnit>).detail);
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);
  return unit;
}

// ---------- ETH/USD spot ----------

interface CachedPrice {
  usd: number;
  at: number;
}

let inMemoryPrice: CachedPrice | null = null;

function readCachedPrice(): CachedPrice | null {
  if (inMemoryPrice) return inMemoryPrice;
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ETH_USD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPrice;
    if (typeof parsed.usd === 'number' && typeof parsed.at === 'number') {
      inMemoryPrice = parsed;
      return parsed;
    }
  } catch {}
  return null;
}

function writeCachedPrice(usd: number): void {
  const rec = { usd, at: Date.now() };
  inMemoryPrice = rec;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ETH_USD_KEY, JSON.stringify(rec));
  } catch {}
}

/// Returns the current ETH/USD rate, or null while the first fetch is in flight.
/// Uses whatever's in cache immediately (even stale) so a returning user sees dollar
/// figures right away; refreshes from Coingecko in the background.
export function useEthUsd(): number | null {
  const [usd, setUsd] = useState<number | null>(() => readCachedPrice()?.usd ?? null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const cached = readCachedPrice();
      if (cached && Date.now() - cached.at < ETH_USD_TTL_MS) return;
      try {
        const res = await fetch(COINGECKO_URL, { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) return;
        const data = (await res.json()) as { ethereum?: { usd?: number } };
        const next = data.ethereum?.usd;
        if (typeof next !== 'number' || !Number.isFinite(next) || next <= 0) return;
        writeCachedPrice(next);
        if (!cancelled) setUsd(next);
      } catch {
        // network failure — keep whatever's cached; caller shows an ETH fallback.
      }
    };
    load();
    const id = setInterval(load, ETH_USD_TTL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  return usd;
}

// ---------- formatters ----------

/// Format a price (wei-per-whole-token, so 18-decimal fixed point). Chooses ETH gwei
/// or USD-with-adaptive-decimals based on the unit + rate.
export function formatPrice(weiPerToken: bigint, unit: PriceUnit, ethUsd: number | null): string {
  if (weiPerToken <= 0n) return '—';
  if (unit === 'usd' && ethUsd) {
    // wei/token → ETH/token → USD/token
    const ethPerToken = Number(weiPerToken) / 1e18;
    const usdPerToken = ethPerToken * ethUsd;
    return formatUsdSmall(usdPerToken);
  }
  // ETH mode — gwei per token because raw ETH-per-memecoin is like "0.0000000005 ETH"
  const gwei = Number(weiPerToken) / 1e9;
  if (!Number.isFinite(gwei) || gwei <= 0) return '—';
  if (gwei < 10) return `${gwei.toFixed(4)} gw`;
  if (gwei < 1000) return `${gwei.toFixed(2)} gw`;
  return `${gwei.toLocaleString(undefined, { maximumFractionDigits: 0 })} gw`;
}

/// Format a market cap value (wei of ETH). Renders in $ or Ξ based on unit.
export function formatMcap(mcapWei: bigint, unit: PriceUnit, ethUsd: number | null): string {
  if (mcapWei <= 0n) return '—';
  const eth = Number(mcapWei) / 1e18;
  if (unit === 'usd' && ethUsd) {
    return formatUsdLarge(eth * ethUsd);
  }
  if (eth < 0.001) return `${(eth * 1000).toFixed(3)} m${'Ξ'}`;
  if (eth < 10) return `${eth.toFixed(4)} Ξ`;
  if (eth < 10_000) return `${eth.toFixed(2)} Ξ`;
  return `${eth.toLocaleString(undefined, { maximumFractionDigits: 0 })} Ξ`;
}

function formatUsdSmall(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(4)}`;
  if (usd >= 0.01) return `$${usd.toFixed(6)}`;
  if (usd >= 0.0001) return `$${usd.toFixed(8)}`;
  // Sub-cent memecoin — use scientific style so it stays readable.
  return `$${usd.toExponential(2)}`;
}

function formatUsdLarge(usd: number): string {
  if (usd < 1) return `$${usd.toFixed(4)}`;
  if (usd < 1_000) return `$${usd.toFixed(2)}`;
  if (usd < 1_000_000) return `$${(usd / 1_000).toFixed(2)}K`;
  if (usd < 1_000_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  return `$${(usd / 1_000_000_000).toFixed(2)}B`;
}
