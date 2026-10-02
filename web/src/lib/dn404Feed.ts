/// DN404 discovery: pure helpers that put DN404 launches into the token feed,
/// gate them behind DN404_LAUNCHES_ENABLED, and keep every tab's sort honest
/// when some launches are priced in URU instead of ETH.
///
/// No React, no network, no path aliases: the node tests import this file
/// directly (dn404Feed.test.mjs). Callers pass in already-fetched rows.
///
/// Units, so nobody has to re-derive them:
///   - ETH-paired DN404 curves live in the indexer `curves` table, in wei-ETH,
///     exactly like Router launches. They need no conversion.
///   - URU-paired DN404 curves live in `pairCurves`, in URU wei. Their
///     "ethReserve"/"graduationTargetEth" fields on MockLaunch therefore hold
///     URU amounts; `ethPerPairX18` (ETH wei per 1 whole URU) converts them.
///     Price and market cap helpers below always return ETH wei so every
///     surface (formatPrice, formatMcap, the mcap sort) compares like with like.
///   - Progress (reserve / target) is a ratio, so it is unit-free.

import type { Address } from 'viem';
import type { MockLaunch } from './mockLaunches';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const E18 = 10n ** 18n;

// ----------------------------------------------------------------- pair math

/// True when the launch's curve prices in an ERC-20 (URU today) rather than ETH.
export function isPairLaunch(l: Pick<MockLaunch, 'pairCurrency'>): boolean {
  return !!l.pairCurrency && l.pairCurrency.toLowerCase() !== ZERO_ADDRESS;
}

/// ETH wei per 1 whole URU (1e18-scaled) from the URU/WETH pool's sqrtPriceX96.
/// v4 encodes sqrt(currency1 / currency0) * 2^96. On Robinhood WETH sorts lower,
/// so URU is currency1 and price = URU per WETH; invert for ETH per URU.
export function ethPerPairFromSqrt(sqrtPriceX96: bigint, pairIsCurrency1: boolean): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  const sq = sqrtPriceX96 * sqrtPriceX96;
  if (sq === 0n) return 0n;
  // pairIsCurrency1: pair per ETH = sq / 2^192  ->  ETH per pair = 2^192 / sq
  // otherwise:       ETH per pair = sq / 2^192
  return pairIsCurrency1 ? (E18 << 192n) / sq : (sq * E18) >> 192n;
}

/// Spot price in PAIR units per whole token (1e18-scaled). After graduation the
/// newest pool swap price wins; otherwise the curve's marginal price (the same
/// virtual-reserve math BondingCurve uses, which also equals the pool's opening
/// price for a freshly graduated curve with no swaps yet).
export function pairSpotPerToken(
  l: Pick<MockLaunch, 'graduated' | 'poolSpotPairPerTokenX18' | 'ethReserve' | 'virtualEthReserve' | 'tokenReserve' | 'virtualTokenReserve'>,
): bigint {
  if (l.graduated && l.poolSpotPairPerTokenX18 && l.poolSpotPairPerTokenX18 > 0n) {
    return l.poolSpotPairPerTokenX18;
  }
  const den = l.tokenReserve + l.virtualTokenReserve;
  if (den === 0n) return 0n;
  return ((l.ethReserve + l.virtualEthReserve) * E18) / den;
}

/// Spot price in ETH wei per whole token for a pair launch. 0 when the URU/ETH
/// price is unknown, so callers show a placeholder instead of a wrong number.
export function pairSpotWeiPerToken(l: MockLaunch): bigint {
  if (!l.ethPerPairX18 || l.ethPerPairX18 === 0n) return 0n;
  return (pairSpotPerToken(l) * l.ethPerPairX18) / E18;
}

/// Market cap in ETH wei for a pair launch (spot in ETH * total supply).
export function pairMarketCapEth(l: MockLaunch): bigint {
  return (pairSpotWeiPerToken(l) * l.totalSupply) / E18;
}

/// Progress toward graduation in percent. A ratio, so it works the same for
/// ETH and URU curves.
export function progressPct(
  l: Pick<MockLaunch, 'graduated' | 'graduationTargetEth' | 'ethReserve'>,
): number {
  if (l.graduated) return 100;
  if (l.graduationTargetEth === 0n) return 0;
  return Math.min(100, Number((l.ethReserve * 10_000n) / l.graduationTargetEth) / 100);
}

/// "12.34 Ξ" for ETH curves, "12,345 URU" for URU curves. `digits` applies to ETH.
export function formatCurveAmount(l: MockLaunch, wei: bigint, digits = 2): string {
  const n = Number(wei) / 1e18;
  if (isPairLaunch(l)) {
    const sym = l.pairSymbol ?? 'URU';
    return `${n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 0 : 2 })} ${sym}`;
  }
  return `${n.toFixed(digits)} Ξ`;
}

// ----------------------------------------------------------------- rows -> launches

/// The indexer `nftCollections` row fields this module needs (lane='dn404').
export interface Dn404CollectionRow {
  chainId: number;
  collectionAddress: Address;
  pairedToken?: Address;
  pairCurrency?: Address;
  unitWei?: string;
  launchedBy: Address;
  name: string;
  ticker: string;
  coverImageUrl?: string;
  description?: string;
  blockTimestamp: string;
}

/// Curve state, already normalised to one shape for both tables. For URU curves
/// the caller maps pairReserve -> ethReserve, virtualPairReserve ->
/// virtualEthReserve, graduationTargetPair -> graduationTargetEth.
export interface Dn404CurveState {
  ethReserve: bigint;
  tokenReserve: bigint;
  virtualEthReserve: bigint;
  virtualTokenReserve: bigint;
  graduationTargetEth: bigint;
  curveSupply: bigint;
  tradeFeeBps: number;
  tradeCount: number;
  graduated: boolean;
}

export interface Dn404Extras {
  /// Graduated ETH pool: newest v4 sqrtPriceX96 + swap count (v4_swaps).
  poolLatestSqrtPriceX96?: bigint;
  /// Graduated URU pool: newest swap price (pair_v4_swaps.pricePairPerToken).
  poolSpotPairPerTokenX18?: bigint;
  v4SwapCount?: number;
  /// ETH wei per 1 whole pair token; required for URU launches' price + mcap.
  ethPerPairX18?: bigint;
  pairSymbol?: string;
  /// Social metadata (same source Router launches use), optional.
  imageUrl?: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

/// Turn a DN404 collection row + its curve into a feed launch. Returns null when
/// the row has no paired token or no curve yet (nothing tradeable to show).
export function dn404RowToLaunch(
  row: Dn404CollectionRow,
  curve: Dn404CurveState | null,
  extras: Dn404Extras = {},
): MockLaunch | null {
  if (!row.pairedToken || row.pairedToken.toLowerCase() === ZERO_ADDRESS) return null;
  if (!curve) return null;
  const pair = (row.pairCurrency ?? ZERO_ADDRESS) as Address;
  const isPair = pair.toLowerCase() !== ZERO_ADDRESS;
  return {
    chainId: row.chainId,
    address: row.pairedToken,
    name: row.name || row.ticker || row.pairedToken.slice(0, 8),
    ticker: row.ticker,
    description: extras.description || row.description || '',
    logoBg: '#e7dcff',
    logoEmoji: '✧',
    imageUrl: extras.imageUrl || row.coverImageUrl || undefined,
    website: extras.website,
    twitter: extras.twitter,
    telegram: extras.telegram,
    creator: row.launchedBy,
    launchedAt: Number(row.blockTimestamp),
    kind: 'curve',
    ethReserve: curve.ethReserve,
    tokenReserve: curve.tokenReserve,
    virtualEthReserve: curve.virtualEthReserve,
    virtualTokenReserve: curve.virtualTokenReserve,
    graduationTargetEth: curve.graduationTargetEth,
    curveSupply: curve.curveSupply,
    // DN404 total supply = collectionSize * unit, all minted at launch; the curve
    // holds curveSupply of it. Use curveSupply like Router launches do (founder
    // premint is the only gap and it is capped at 20%).
    totalSupply: curve.curveSupply,
    tradeFeeBps: curve.tradeFeeBps,
    graduated: curve.graduated,
    trades: [],
    tradeCount: curve.tradeCount,
    v4SwapCount: extras.v4SwapCount ?? 0,
    poolLatestSqrtPriceX96: isPair ? 0n : (extras.poolLatestSqrtPriceX96 ?? 0n),
    lane: 'dn404',
    mirror: row.collectionAddress,
    pairCurrency: pair,
    pairSymbol: isPair ? (extras.pairSymbol ?? 'URU') : undefined,
    ethPerPairX18: isPair ? extras.ethPerPairX18 : undefined,
    poolSpotPairPerTokenX18: isPair ? extras.poolSpotPairPerTokenX18 : undefined,
  };
}

// ----------------------------------------------------------------- gating + merge

export interface FeedFlags {
  nftEnabled: boolean;
  dn404Enabled: boolean;
}

/// Whether an nftCollections row may be shown. DN404 mirrors follow the DN404
/// flag; plain NFT collections follow the NFT flag. Rows indexed before the
/// lane column existed have no lane and count as plain NFTs.
export function collectionVisible(row: { lane?: string }, flags: FeedFlags): boolean {
  return row.lane === 'dn404' ? flags.dn404Enabled : flags.nftEnabled;
}

/// Merge DN404 launches into the Router launch feed. DN404 rows are dropped
/// entirely when the DN404 flag is off, hidden tokens never get through, and a
/// token present in both lists is kept once (the Router row wins).
export function mergeDn404Launches(
  base: MockLaunch[],
  dn404: MockLaunch[],
  opts: { dn404Enabled: boolean; isHidden: (chainId: number, address: string) => boolean },
): MockLaunch[] {
  const keep = base.filter((l) => !opts.isHidden(l.chainId, l.address));
  if (!opts.dn404Enabled) return keep;
  const seen = new Set(keep.map((l) => `${l.chainId}:${l.address.toLowerCase()}`));
  for (const l of dn404) {
    const key = `${l.chainId}:${l.address.toLowerCase()}`;
    if (seen.has(key) || opts.isHidden(l.chainId, l.address)) continue;
    seen.add(key);
    keep.push(l);
  }
  return keep;
}

// ----------------------------------------------------------------- tab sort

export type FeedFilter =
  | 'trending' | 'new' | 'mcap' | 'near-graduation' | 'graduated' | 'whitelist' | 'dn404' | 'all' | 'nft';

export interface SortDeps {
  marketCapEth: (l: MockLaunch) => bigint;
  progress: (l: MockLaunch) => number;
  tradeCount: (l: MockLaunch) => number;
  /// Last-trade timestamp per lowercase token address (live flash bus).
  lastTrade: (address: string) => number;
}

/// Narrow + sort the feed for one discover tab. Same rules discover has always
/// used, plus the 'dn404' tab, and an mcap sort that compares ETH to ETH.
export function filterAndSortLaunches(
  list: MockLaunch[],
  filter: FeedFilter,
  query: string,
  deps: SortDeps,
): MockLaunch[] {
  let out = list.filter((l) => (l.kind ?? (l.graduationTargetEth > 0n ? 'curve' : 'direct')) === 'curve');
  const q = query.trim().toLowerCase();
  if (q) {
    out = out.filter(
      (l) => l.name.toLowerCase().includes(q) || l.ticker.toLowerCase().includes(q) || l.address.toLowerCase().includes(q),
    );
  }
  if (filter === 'near-graduation') out = out.filter((l) => !l.graduated);
  else if (filter === 'graduated') out = out.filter((l) => l.graduated);
  else if (filter === 'whitelist') out = out.filter((l) => l.hasWhitelist === true);
  else if (filter === 'dn404') out = out.filter((l) => l.lane === 'dn404');

  const primary = (a: MockLaunch, b: MockLaunch): number => {
    switch (filter) {
      case 'trending':
        return deps.tradeCount(b) - deps.tradeCount(a);
      case 'mcap': {
        const d = deps.marketCapEth(b) - deps.marketCapEth(a);
        return d > 0n ? 1 : d < 0n ? -1 : 0;
      }
      case 'near-graduation':
        return deps.progress(b) - deps.progress(a);
      default:
        return b.launchedAt - a.launchedAt;
    }
  };
  // Only trending/all bubble the most recently traded tokens up.
  const useTradeBump = filter === 'trending' || filter === 'all';
  return [...out].sort((a, b) => {
    if (useTradeBump) {
      const aTs = deps.lastTrade(a.address.toLowerCase());
      const bTs = deps.lastTrade(b.address.toLowerCase());
      if (aTs !== bTs) return bTs - aTs;
    }
    const p = primary(a, b);
    if (p !== 0) return p;
    return b.launchedAt - a.launchedAt;
  });
}
