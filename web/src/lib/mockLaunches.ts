import type { Address } from 'viem';
import { parseEther } from 'viem';
import { isHiddenToken } from './hiddenTokens';

/// Static preview data for the pump.fun-style discover feed + trade page. Any address that
/// matches one of these fixtures gets served mock reserves / trades / metadata instead of the
/// live wagmi reads — makes the UI browsable + demo-able before any Phase 1 broadcast lands.
/// Delete this whole file when the Ponder indexer is wired.

export interface MockTrade {
  isBuy: boolean;
  ethAmount: bigint;
  tokenAmount: bigint;
  ethReserve: bigint;
  tokenReserve: bigint;
  trader: Address;
  timestamp: number;
}

/// Launch mechanic:
///  - 'curve'  → bonding curve installed (has graduation target, reserves move on trade)
///  - 'direct' → direct-mint token (no curve; ownership + transfers only)
/// Feeds use this to section curve tokens (tradeable) from direct-mint (mintable). Defaults
/// to 'curve' for legacy mocks (all pre-Phase 1 fixtures assume the bonding-curve UI).
export type LaunchKind = 'curve' | 'direct';

export interface MockLaunch {
  chainId: number;
  address: Address;
  name: string;
  ticker: string;
  description: string;
  logoBg: string;
  logoEmoji: string;
  /// Optional token image URL (typically an IPFS gateway URL). When set, discover/home/trade
  /// render the actual image; when null, we fall back to the emoji + bg color combo.
  imageUrl?: string;
  creator: Address;
  launchedAt: number;
  kind?: LaunchKind;
  website?: string;
  twitter?: string;
  telegram?: string;
  // curve state (same shape the real BondingCurve exposes)
  ethReserve: bigint;
  tokenReserve: bigint;
  virtualEthReserve: bigint;
  virtualTokenReserve: bigint;
  graduationTargetEth: bigint;
  curveSupply: bigint;
  totalSupply: bigint;
  tradeFeeBps: number;
  graduated: boolean;
  trades: MockTrade[]; // most-recent last
  /// Cheap indexer-sourced count so cards can show "N tx" without loading full trade
  /// history per launch. Falls back to `trades.length` when the indexer hasn't supplied it
  /// (legacy mocks, direct-mint tokens that never traded).
  tradeCount?: number;
  /// v4 pool swap count for graduated tokens. `tradeCountOf` adds this on top of
  /// `tradeCount` so discover shows total lifetime activity, not just pre-grad curve.
  v4SwapCount?: number;
  /// Newest v4 pool sqrtPriceX96 for graduated tokens. `mockMarketCapEth` prefers it
  /// over the drained curve reserves so a graduated token still shows a real mcap.
  poolLatestSqrtPriceX96?: bigint;
  /// True when the launch installed a community whitelist — discover shows a badge
  /// + supports a "WL only" filter. Populated by useLaunchFeed from the indexer's
  /// launches.hasWhitelist column (RouterV2 LaunchedWithWhitelist event handler).
  hasWhitelist?: boolean;
  /// Pay-token variant: 'ETH' (default) or 'URU' for RouterV2 URU-paid launches.
  payToken?: 'ETH' | 'URU';
  /// Browser-created record rather than a seeded fixture. Lets compact surfaces such as
  /// Home prioritise the launch a reviewer just made without changing the fixtures.
  isDemo?: boolean;
}

export interface MockLaunchSeed {
  chainId?: number;
  address: Address;
  name: string;
  ticker: string;
  creator: Address;
  description?: string;
  logoBg?: string;
  logoEmoji?: string;
  imageUrl?: string;
  launchedAtHoursAgo?: number;
  website?: string;
  twitter?: string;
  telegram?: string;
  tradeFeeBps?: number;
  targetEthRaised?: string;
  numTrades?: number;
  kind?: LaunchKind;
  graduated?: boolean;
  hasWhitelist?: boolean;
}

/// Prefer indexer-supplied tradeCount, otherwise fall back to the length of the trades
/// array — mocks embed the array directly, the indexer populates the count field. For
/// graduated tokens, add v4 swap count on top so discover reflects total lifetime
/// activity (curve trades + post-grad pool swaps).
export function tradeCountOf(l: MockLaunch): number {
  const base = l.tradeCount ?? l.trades.length;
  return base + (l.v4SwapCount ?? 0);
}

/// Bucket a launch as 'curve' or 'direct' regardless of whether the `kind` field is set —
/// legacy mocks all use curve reserves and predate the enum, so we infer from the shape.
export function launchKind(l: MockLaunch): LaunchKind {
  return l.kind ?? (l.graduationTargetEth > 0n ? 'curve' : 'direct');
}

// Common defaults (match live CurveFactory chunky defaults 2026-07-30).
const CURVE_SUPPLY = parseEther('800000000');
const VIRTUAL_TOKEN = parseEther('800000000');
const VIRTUAL_ETH = parseEther('17');
const GRAD_TARGET = parseEther('4.2');
const TOTAL_SUPPLY = parseEther('1000000000');

const USER_MOCK_STORAGE_KEY = 'uru:mock-launches:v1';
const USER_MOCK_LAUNCH_EVENT = 'urufu-user-mock-launches-change';

type MockLaunchSeedRecord = Omit<MockLaunchSeed, 'address'> & { address: string };
let sessionMockLaunches: MockLaunchSeedRecord[] = [];

function normalizeSeedAddress(input: string): Address {
  return `0x${input.replace(/^0x/i, '').slice(0, 40).toLowerCase().padEnd(40, '0')}` as Address;
}

function readUserMockLaunches(): MockLaunchSeedRecord[] {
  if (typeof window === 'undefined') return [];
  let stored: MockLaunchSeedRecord[] = [];
  try {
    const raw = window.localStorage.getItem(USER_MOCK_STORAGE_KEY);
    if (!raw) return sessionMockLaunches;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return sessionMockLaunches;
    stored = parsed
      .filter((row): row is MockLaunchSeedRecord => {
        if (!row || typeof row !== 'object') return false;
        if (!('address' in row) || typeof row.address !== 'string') return false;
        if (!row.name || typeof row.name !== 'string') return false;
        if (!row.ticker || typeof row.ticker !== 'string') return false;
        if (!row.creator || typeof row.creator !== 'string') return false;
        return true;
      })
      .map((row) => ({ ...row, address: normalizeSeedAddress(row.address) }));
  } catch {
    // Preview mode still works when storage is blocked (for example in a private
    // browsing context); the current tab keeps its session-only launches.
  }
  return Array.from(
    new Map([...stored, ...sessionMockLaunches].map((launch) => [launch.address.toLowerCase(), launch])).values(),
  );
}

function writeUserMockLaunches(next: MockLaunchSeedRecord[]): void {
  if (typeof window === 'undefined') return;
  const cleaned = Array.from(
    new Map(next.map((l) => [l.address.toLowerCase(), l])).values(),
  );
  sessionMockLaunches = cleaned;
  try {
    window.localStorage.setItem(USER_MOCK_STORAGE_KEY, JSON.stringify(cleaned));
  } catch {
    // Storage failures are intentionally non-fatal; sessionMockLaunches keeps the
    // review path usable in this tab.
  }
  window.dispatchEvent(new CustomEvent(USER_MOCK_LAUNCH_EVENT));
}

function buildFromSeed(seed: MockLaunchSeedRecord): MockLaunch {
  const chainId = seed.chainId ?? 11155111;
  const seededAt = seed.launchedAtHoursAgo ?? 1;
  const targetEthRaised = parseEther(seed.targetEthRaised ?? '1');
  const numTrades = Math.max(5, Math.min(260, seed.numTrades ?? 35));
  return {
    ...build({
      chainId,
      address: normalizeSeedAddress(seed.address),
      name: seed.name || 'new token',
      ticker: seed.ticker || 'TOKEN',
      description: seed.description ?? 'mock launch created in preview mode.',
      logoBg: seed.logoBg ?? '#ffb3d1',
      logoEmoji: seed.logoEmoji ?? '✿',
      imageUrl: seed.imageUrl,
      creator: normalizeSeedAddress(seed.creator),
      launchedAtHoursAgo: seededAt,
      website: seed.website,
      twitter: seed.twitter,
      telegram: seed.telegram,
      targetEthRaised,
      seed: buildAddressSeed(seed.address),
      numTrades,
      graduated: seed.graduated,
    }),
    kind: seed.kind ?? 'curve',
    tradeFeeBps: seed.tradeFeeBps ?? 100,
    hasWhitelist: seed.hasWhitelist ?? false,
    isDemo: true,
  };
}

function buildAddressSeed(address: string): number {
  const clean = address.toLowerCase().replace(/^0x/, '');
  if (!clean) return 0;
  let h = 0;
  for (let i = 0; i < clean.length; i += 1) h = ((h << 5) - h) + clean.charCodeAt(i);
  return h >>> 0;
}

/// Build a deterministic trade series from starting reserves up to a target ETH raised.
/// Produces `n` mostly-buys with a few sells so the chart has both green + red candles.
function generateTrades(
  seed: number,
  targetEthRaised: bigint,
  n: number,
  startTimestamp: number,
  intervalSec: number,
): { trades: MockTrade[]; finalEth: bigint; finalToken: bigint } {
  let eth = 0n;
  let token = CURVE_SUPPLY;
  const k = (VIRTUAL_ETH + eth) * (VIRTUAL_TOKEN + token);
  // Simple LCG for repeatable "random" without Date.now()/Math.random().
  let s = seed >>> 0;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const trades: MockTrade[] = [];
  const traders: Address[] = [
    '0x1234567890123456789012345678901234567890',
    '0xabcdef1234567890abcdef1234567890abcdef12',
    '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    '0x1111222233334444555566667777888899990000',
    '0xcafebabecafebabecafebabecafebabecafebabe',
    '0xfacefeed1234facefeed5678facefeed9abcfeed',
  ];
  const perTradeBudget = Number(targetEthRaised) / n / 1e18;

  for (let i = 0; i < n && eth < targetEthRaised; i++) {
    const timestamp = startTimestamp + i * intervalSec;
    const r = rand();
    const isBuy = r > 0.22; // ~78% buys, 22% sells
    const trader = traders[i % traders.length]!;

    if (isBuy) {
      // Buy a randomized fraction of the per-trade budget
      const ethIn = BigInt(Math.floor((perTradeBudget * (0.5 + rand())) * 1e18));
      const effEth = eth + VIRTUAL_ETH;
      const effToken = token + VIRTUAL_TOKEN;
      const newEffEth = effEth + ethIn;
      const newEffToken = k / newEffEth;
      const tokensOut = effToken - newEffToken;
      if (tokensOut > token) break;
      token -= tokensOut;
      eth += ethIn;
      trades.push({
        isBuy: true,
        ethAmount: ethIn,
        tokenAmount: tokensOut,
        ethReserve: eth,
        tokenReserve: token,
        trader,
        timestamp,
      });
    } else if (token < CURVE_SUPPLY) {
      // Sell a fraction of a previous buy's tokens
      const prevBuy = trades[Math.max(0, trades.length - 2)];
      if (!prevBuy) continue;
      const tokensIn = prevBuy.tokenAmount / 2n;
      const effEth = eth + VIRTUAL_ETH;
      const effToken = token + VIRTUAL_TOKEN;
      const newEffToken = effToken + tokensIn;
      const newEffEth = k / newEffToken;
      let ethGross = effEth - newEffEth;
      if (ethGross > eth) ethGross = eth;
      token += tokensIn;
      eth -= ethGross;
      trades.push({
        isBuy: false,
        ethAmount: ethGross,
        tokenAmount: tokensIn,
        ethReserve: eth,
        tokenReserve: token,
        trader,
        timestamp,
      });
    }
  }

  return { trades, finalEth: eth, finalToken: token };
}

function build(opts: {
  chainId?: number;
  address: Address;
  name: string;
  ticker: string;
  description: string;
  logoBg: string;
  logoEmoji: string;
  imageUrl?: string;
  creator: Address;
  launchedAtHoursAgo: number;
  website?: string;
  twitter?: string;
  telegram?: string;
  targetEthRaised: bigint;
  seed: number;
  numTrades: number;
  graduated?: boolean;
}): MockLaunch {
  const now = 1_780_000_000; // Static "now" so builds are deterministic. Tuned to July 2026.
  const launchedAt = now - opts.launchedAtHoursAgo * 3600;
  const spanSec = Math.max(60 * 10, opts.launchedAtHoursAgo * 3600);
  const intervalSec = Math.floor(spanSec / opts.numTrades);
  const { trades, finalEth, finalToken } = generateTrades(
    opts.seed,
    opts.targetEthRaised,
    opts.numTrades,
    launchedAt,
    intervalSec,
  );

  return {
    chainId: opts.chainId ?? 11155111, // Sepolia by default
    address: opts.address,
    name: opts.name,
    ticker: opts.ticker,
    description: opts.description,
    logoBg: opts.logoBg,
    logoEmoji: opts.logoEmoji,
    imageUrl: opts.imageUrl,
    creator: opts.creator,
    launchedAt,
    website: opts.website,
    twitter: opts.twitter,
    telegram: opts.telegram,
    ethReserve: opts.graduated ? GRAD_TARGET : finalEth,
    tokenReserve: opts.graduated ? finalToken : finalToken,
    virtualEthReserve: VIRTUAL_ETH,
    virtualTokenReserve: VIRTUAL_TOKEN,
    graduationTargetEth: GRAD_TARGET,
    curveSupply: CURVE_SUPPLY,
    totalSupply: TOTAL_SUPPLY,
    tradeFeeBps: 100,
    graduated: opts.graduated ?? false,
    trades,
  };
}

/// 10 fixtures across the lifecycle stages: fresh → mid-curve → near-graduation → graduated.
export const MOCK_LAUNCHES: MockLaunch[] = [
  build({
    address: '0xfeedbeef1234567890abcdef1234567890abcdef',
    name: 'kawaii inu',
    ticker: 'KAWAII',
    description: 'the fluffiest doge on the curve ~ ✿ join before graduation (◕‿◕✿)',
    logoBg: '#ffb3d1',
    logoEmoji: '🐕',
    // Local Urufu collection portrait exercises the same imageUrl media path
    // that production cards receive from token metadata.
    imageUrl: '/launch-preview/urufu-gemu-07.png',
    creator: '0x1111222233334444555566667777888899990000',
    launchedAtHoursAgo: 2,
    twitter: 'https://x.com/kawaii_inu',
    telegram: 'https://t.me/kawaiiinu',
    targetEthRaised: parseEther('3.4'),
    seed: 1234,
    numTrades: 60,
  }),
  build({
    chainId: 1, // mainnet
    address: '0xabcdef1111111111111111111111111111111111',
    name: 'urufu core',
    ticker: 'URUFU',
    description: 'the mascot token. governance-enabled. buyback-burns every swap.',
    logoBg: '#3a2c3a',
    logoEmoji: '🐺',
    creator: '0xcafebabecafebabecafebabecafebabecafebabe',
    launchedAtHoursAgo: 6,
    website: 'https://urufulabs.xyz',
    twitter: 'https://x.com/urufulabs',
    targetEthRaised: parseEther('2.8'),
    seed: 5678,
    numTrades: 80,
  }),
  build({
    address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdead0001',
    name: 'mochi',
    ticker: 'MOCHI',
    description: 'squishy vibes. anti-bot gate + fee-on-transfer to holders ✿',
    logoBg: '#fff3b0',
    logoEmoji: '🍡',
    imageUrl: '/launch-preview/urufu-gemu-00.png',
    creator: '0xfacefeed1234facefeed5678facefeed9abcfeed',
    launchedAtHoursAgo: 12,
    twitter: 'https://x.com/mochichain',
    targetEthRaised: parseEther('1.2'),
    seed: 9999,
    numTrades: 45,
  }),
  build({
    chainId: 8453, // base
    address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdead0002',
    name: 'sakura network',
    ticker: 'SAKURA',
    description: 'petal-drop airdrop + vesting for the team. long-form protocol lol.',
    logoBg: '#ffd0e0',
    logoEmoji: '🌸',
    creator: '0x2222333344445555666677778888999900001111',
    launchedAtHoursAgo: 20,
    website: 'https://sakura.network',
    targetEthRaised: parseEther('3.9'),
    seed: 4242,
    numTrades: 120,
  }),
  build({
    address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdead0003',
    name: 'ramen',
    ticker: 'RAMEN',
    description: 'a bowl of hot yield. staking rewards, deflationary buyback ~~',
    logoBg: '#ffb997',
    logoEmoji: '🍜',
    imageUrl: '/launch-preview/urufu-gemu-14.png',
    creator: '0x3333444455556666777788889999000011112222',
    launchedAtHoursAgo: 4,
    targetEthRaised: parseEther('0.6'),
    seed: 1111,
    numTrades: 30,
  }),
  build({
    chainId: 8453, // base
    address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdead0004',
    name: 'pixel wolf',
    ticker: 'PXWOLF',
    description: 'on-chain svg wolf pfp collection. every pfp is a pxwolf holder.',
    logoBg: '#8ee0a0',
    logoEmoji: '🎮',
    creator: '0x4444555566667777888899990000111122223333',
    launchedAtHoursAgo: 1,
    twitter: 'https://x.com/pxwolf',
    targetEthRaised: parseEther('0.18'),
    seed: 3737,
    numTrades: 18,
  }),
  build({
    address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdead0005',
    name: 'yuki',
    ticker: 'YUKI',
    description: 'frozen supply. pausable + permit. cold as ice ❄',
    logoBg: '#c9e6ff',
    logoEmoji: '❄️',
    creator: '0x5555666677778888999900001111222233334444',
    launchedAtHoursAgo: 30,
    targetEthRaised: parseEther('3.99'),
    seed: 2828,
    numTrades: 200,
  }),
  build({
    chainId: 1, // mainnet
    address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdead0006',
    name: 'takoyaki',
    ticker: 'TAKO',
    description: 'octopus balls. octopus votes. octopus governor ~~ many arms',
    logoBg: '#f4a460',
    logoEmoji: '🐙',
    creator: '0x6666777788889999000011112222333344445555',
    launchedAtHoursAgo: 8,
    twitter: 'https://x.com/tako',
    telegram: 'https://t.me/tako',
    targetEthRaised: parseEther('2.1'),
    seed: 6060,
    numTrades: 75,
  }),
  build({
    address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdead0007',
    name: 'catnip',
    ticker: 'CATNIP',
    description: 'nya~ soulbound erc-721a for the cat girls. non-transferable.',
    logoBg: '#e0c9ff',
    logoEmoji: '🐱',
    creator: '0x7777888899990000111122223333444455556666',
    launchedAtHoursAgo: 3,
    targetEthRaised: parseEther('1.9'),
    seed: 8181,
    numTrades: 40,
  }),
  // Graduated example
  build({
    chainId: 1, // mainnet
    address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdead0008',
    name: 'first wolf',
    ticker: 'W1',
    description: 'first token to graduate on urufu labs. lp locked forever now ✿',
    logoBg: '#ff6f9e',
    logoEmoji: '🏆',
    creator: '0x8888999900001111222233334444555566667777',
    launchedAtHoursAgo: 96,
    website: 'https://firstwolf.xyz',
    targetEthRaised: parseEther('4'),
    seed: 9090,
    numTrades: 300,
    graduated: true,
  }),
];

export function allMockLaunches(): MockLaunch[] {
  const user = readUserMockLaunches().map(buildFromSeed);
  return [...user, ...MOCK_LAUNCHES]
    .filter((l) => !isHiddenToken(l.chainId, l.address))
    .sort((a, b) => b.launchedAt - a.launchedAt);
}

export function saveMockLaunch(seed: MockLaunchSeed): MockLaunch {
  const record: MockLaunchSeedRecord = {
    chainId: seed.chainId,
    address: seed.address,
    name: seed.name,
    ticker: seed.ticker,
    creator: seed.creator,
    description: seed.description ?? 'mock launch created in preview mode.',
    logoBg: seed.logoBg ?? '#ffb3d1',
    logoEmoji: seed.logoEmoji ?? '✿',
    imageUrl: seed.imageUrl,
    launchedAtHoursAgo: seed.launchedAtHoursAgo ?? 1,
    website: seed.website,
    twitter: seed.twitter,
    telegram: seed.telegram,
    targetEthRaised: seed.targetEthRaised ?? '1',
    numTrades: seed.numTrades ?? 35,
    tradeFeeBps: seed.tradeFeeBps ?? 100,
    kind: seed.kind,
    graduated: seed.graduated ?? false,
    hasWhitelist: seed.hasWhitelist ?? false,
  };
  const raw = readUserMockLaunches();
  const next = [...raw.filter((r) => r.address.toLowerCase() !== record.address.toLowerCase()), record];
  writeUserMockLaunches(next);
  return buildFromSeed(record as MockLaunchSeedRecord);
}

export function onMockLaunchesChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(USER_MOCK_LAUNCH_EVENT, handler);
  return () => window.removeEventListener(USER_MOCK_LAUNCH_EVENT, handler);
}

export function mockLaunchByAddress(address: string): MockLaunch | null {
  const lower = address.toLowerCase();
  return allMockLaunches().find((l) => l.address.toLowerCase() === lower) ?? null;
}

/// Only return mocks belonging to the given chain. Used by feed pages to filter to the
/// user's active chain.
export function mocksForChain(chainId: number): MockLaunch[] {
  return allMockLaunches().filter((l) => l.chainId === chainId);
}

export function mockProgressPct(l: MockLaunch): number {
  if (l.graduated) return 100;
  // Direct-mint tokens indexed via `indexerLaunchToMock` come through with zeroed curve
  // fields — there's no graduation target, so progress is undefined; render as 0.
  if (l.graduationTargetEth === 0n) return 0;
  return Math.min(100, Number((l.ethReserve * 10_000n) / l.graduationTargetEth) / 100);
}

/// Spot price in wei-per-whole-token. Consistent across discover, trade page, and
/// any future consumer:
///   - graduated + pool sqrt known: derive from v4 pool sqrtPriceX96 (real price)
///   - otherwise: curve virtual-reserves math (what BondingCurve.priceWeiPerToken uses)
/// Previously discover computed its own version straight from curve reserves, which
/// silently returned wrong numbers post-graduation (reserves are drained to 0).
export function mockSpotPriceWei(l: MockLaunch): bigint {
  if (l.graduated && l.poolLatestSqrtPriceX96 && l.poolLatestSqrtPriceX96 > 0n) {
    const sqSq = l.poolLatestSqrtPriceX96 * l.poolLatestSqrtPriceX96;
    if (sqSq === 0n) return 0n;
    return ((10n ** 18n) << 192n) / sqSq;
  }
  const den = l.tokenReserve + l.virtualTokenReserve;
  if (den === 0n) return 0n;
  return ((l.ethReserve + l.virtualEthReserve) * 10n ** 18n) / den;
}

export function mockMarketCapEth(l: MockLaunch): bigint {
  // Graduated tokens: derive spot from the newest v4 pool sqrtPriceX96. The curve
  // reserves were drained to 0 during graduation, so the pre-grad math below would
  // silently return 0 for every graduated token. Same inversion the trade page uses:
  //   weiPerToken = (1e18 << 192) / sqrtPriceX96^2
  if (l.graduated && l.poolLatestSqrtPriceX96 && l.poolLatestSqrtPriceX96 > 0n) {
    const sqSq = l.poolLatestSqrtPriceX96 * l.poolLatestSqrtPriceX96;
    if (sqSq === 0n) return 0n;
    const weiPerToken = ((10n ** 18n) << 192n) / sqSq;
    return (weiPerToken * l.totalSupply) / 10n ** 18n;
  }
  // Same guard as above — a token with no curve reserves has no spot price to derive
  // market cap from. Return 0 so LaunchCard can render the tile with a `—` placeholder.
  const denom = l.tokenReserve + l.virtualTokenReserve;
  if (denom === 0n) return 0n;
  const spot = ((l.ethReserve + l.virtualEthReserve) * 10n ** 18n) / denom;
  return (spot * l.totalSupply) / 10n ** 18n;
}
