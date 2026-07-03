import type { Address } from 'viem';
import { parseEther } from 'viem';

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

export interface MockLaunch {
  chainId: number;
  address: Address;
  name: string;
  ticker: string;
  description: string;
  logoBg: string;
  logoEmoji: string;
  creator: Address;
  launchedAt: number;
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
}

// Common defaults
const CURVE_SUPPLY = parseEther('800000000');
const VIRTUAL_TOKEN = parseEther('800000000');
const VIRTUAL_ETH = parseEther('5');
const GRAD_TARGET = parseEther('4');
const TOTAL_SUPPLY = parseEther('1000000000');

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

export function mockLaunchByAddress(address: string): MockLaunch | null {
  const lower = address.toLowerCase();
  return MOCK_LAUNCHES.find((l) => l.address.toLowerCase() === lower) ?? null;
}

/// Only return mocks belonging to the given chain. Used by feed pages to filter to the
/// user's active chain.
export function mocksForChain(chainId: number): MockLaunch[] {
  return MOCK_LAUNCHES.filter((l) => l.chainId === chainId);
}

export function mockProgressPct(l: MockLaunch): number {
  if (l.graduated) return 100;
  return Math.min(100, Number((l.ethReserve * 10_000n) / l.graduationTargetEth) / 100);
}

export function mockMarketCapEth(l: MockLaunch): bigint {
  // Reconstruct spot price: (ethReserve + virtualEth) * 1e18 / (tokenReserve + virtualToken)
  const spot = ((l.ethReserve + l.virtualEthReserve) * 10n ** 18n) / (l.tokenReserve + l.virtualTokenReserve);
  return (spot * l.totalSupply) / 10n ** 18n;
}
