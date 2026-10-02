// node --experimental-strip-types --disable-warning=ExperimentalWarning --test src/lib/dn404Feed.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ZERO_ADDRESS,
  collectionVisible,
  dn404RowToLaunch,
  ethPerPairFromSqrt,
  filterAndSortLaunches,
  formatCurveAmount,
  isPairLaunch,
  mergeDn404Launches,
  pairMarketCapEth,
  progressPct,
} from './dn404Feed.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pairSpotWeiPerToken } from './dn404Feed.ts';

// mockLaunches.ts can't load under plain node (extensionless relative imports
// that Next resolves). Mirror its ETH-curve formulas here and pin, by source
// text, that it routes pair launches to the dn404Feed helpers tested below.
const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_SRC = readFileSync(join(HERE, 'mockLaunches.ts'), 'utf8');
function ethSpot(l) {
  const den = l.tokenReserve + l.virtualTokenReserve;
  return den === 0n ? 0n : ((l.ethReserve + l.virtualEthReserve) * 10n ** 18n) / den;
}
const mockSpotPriceWei = (l) => (isPairLaunch(l) ? pairSpotWeiPerToken(l) : ethSpot(l));
const mockMarketCapEth = (l) => (isPairLaunch(l) ? pairMarketCapEth(l) : (ethSpot(l) * l.totalSupply) / 10n ** 18n);
const mockProgressPct = progressPct;
const tradeCountOf = (l) => (l.tradeCount ?? l.trades.length) + (l.v4SwapCount ?? 0);

test('mockLaunches routes pair launches through the ETH-normalised helpers', () => {
  assert.match(MOCK_SRC, /export function mockSpotPriceWei[\s\S]{0,200}if \(isPairLaunch\(l\)\) return pairSpotWeiPerToken\(l\);/);
  assert.match(MOCK_SRC, /export function mockMarketCapEth[\s\S]{0,80}if \(isPairLaunch\(l\)\) return pairMarketCapEth\(l\);/);
});
import { isHiddenToken } from './hiddenTokens.ts';

const E18 = 10n ** 18n;
const URU = '0x9fbe210007dDd8389f98d0253018e65CC48b9D24';

function isqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

function row(over = {}) {
  return {
    chainId: 4663,
    collectionAddress: '0x00000000000000000000000000000000000000c1',
    pairedToken: '0x00000000000000000000000000000000000000a1',
    pairCurrency: ZERO_ADDRESS,
    unitWei: (10_000n * E18).toString(),
    launchedBy: '0x00000000000000000000000000000000000000f1',
    name: 'Test Pair',
    ticker: 'TP',
    blockTimestamp: '1000',
    ...over,
  };
}

function curve(over = {}) {
  return {
    ethReserve: 0n,
    tokenReserve: 800_000_000n * E18,
    virtualEthReserve: 17n * E18,
    virtualTokenReserve: 800_000_000n * E18,
    graduationTargetEth: 10n * E18,
    curveSupply: 800_000_000n * E18,
    tradeFeeBps: 100,
    tradeCount: 0,
    graduated: false,
    ...over,
  };
}

// 30,000,000 URU per ETH, URU = currency1 (as on Robinhood).
const URU_PER_ETH = 30_000_000n;
const SQRT_URU_PER_ETH = isqrt(URU_PER_ETH << 192n);
const ETH_PER_URU = ethPerPairFromSqrt(SQRT_URU_PER_ETH, true);

test('ethPerPairFromSqrt inverts URU-per-WETH into ETH per URU', () => {
  const expected = E18 / URU_PER_ETH; // 3.33e10 wei
  const diff = ETH_PER_URU > expected ? ETH_PER_URU - expected : expected - ETH_PER_URU;
  assert.ok(diff * 1_000_000n <= expected, `got ${ETH_PER_URU}, want ~${expected}`);
  // Non-inverted orientation: sqrt encodes ETH per URU directly.
  const sqrtEthPerUru = isqrt((E18 << 192n) / URU_PER_ETH / E18);
  assert.ok(ethPerPairFromSqrt(sqrtEthPerUru, false) > 0n);
  assert.equal(ethPerPairFromSqrt(0n, true), 0n);
});

test('dn404RowToLaunch: needs a paired token and a curve', () => {
  assert.equal(dn404RowToLaunch(row({ pairedToken: undefined }), curve()), null);
  assert.equal(dn404RowToLaunch(row({ pairedToken: ZERO_ADDRESS }), curve()), null);
  assert.equal(dn404RowToLaunch(row(), null), null);
  const l = dn404RowToLaunch(row(), curve());
  assert.equal(l.lane, 'dn404');
  assert.equal(l.kind, 'curve');
  assert.equal(l.address, row().pairedToken);
  assert.equal(l.mirror, row().collectionAddress);
  assert.equal(isPairLaunch(l), false, 'ETH-paired DN404 is not a pair launch');
  assert.equal(l.pairSymbol, undefined);
});

test('URU-paired launch: market cap and spot come out in ETH, not URU', () => {
  // A URU curve whose virtual+real reserves equal the ETH curve's, scaled by price.
  const ethCurve = curve({ ethReserve: 2n * E18 });
  const uruCurve = curve({
    ethReserve: 2n * E18 * URU_PER_ETH,
    virtualEthReserve: 17n * E18 * URU_PER_ETH,
    graduationTargetEth: 10n * E18 * URU_PER_ETH,
  });
  const ethL = dn404RowToLaunch(row(), ethCurve);
  const uruL = dn404RowToLaunch(
    row({ pairedToken: '0x00000000000000000000000000000000000000a2', pairCurrency: URU }),
    uruCurve,
    { ethPerPairX18: ETH_PER_URU, pairSymbol: 'URU' },
  );
  assert.equal(isPairLaunch(uruL), true);
  // Through the real shared helpers every surface uses:
  const a = mockMarketCapEth(ethL);
  const b = mockMarketCapEth(uruL);
  const diff = a > b ? a - b : b - a;
  assert.ok(diff * 10_000n <= a, `ETH mcap ${a} vs URU-normalised ${b}`);
  assert.equal(b, pairMarketCapEth(uruL));
  const sa = mockSpotPriceWei(ethL);
  const sb = mockSpotPriceWei(uruL);
  const sd = sa > sb ? sa - sb : sb - sa;
  assert.ok(sd * 10_000n <= sa, `ETH spot ${sa} vs URU-normalised ${sb}`);
  // Unknown URU price: never show a URU number dressed as ETH.
  const noPrice = { ...uruL, ethPerPairX18: undefined };
  assert.equal(mockMarketCapEth(noPrice), 0n);
});

test('graduated URU launch uses the newest pool price', () => {
  const l = dn404RowToLaunch(
    row({ pairCurrency: URU }),
    curve({ graduated: true }),
    { ethPerPairX18: ETH_PER_URU, poolSpotPairPerTokenX18: 2n * E18 },
  );
  // spot = 2 URU per token -> 2 * ETH_PER_URU wei
  assert.equal(mockSpotPriceWei(l), (2n * E18 * ETH_PER_URU) / E18);
});

test('progress is a unit-free ratio and matches mockProgressPct', () => {
  const uruHalf = dn404RowToLaunch(row({ pairCurrency: URU }), curve({ ethReserve: 2_500_000n * E18, graduationTargetEth: 5_000_000n * E18 }), { ethPerPairX18: ETH_PER_URU });
  const ethForty = dn404RowToLaunch(row({ pairedToken: '0x00000000000000000000000000000000000000a3' }), curve({ ethReserve: 4n * E18 }));
  assert.equal(progressPct(uruHalf), 50);
  assert.equal(progressPct(ethForty), 40);
  assert.equal(mockProgressPct(uruHalf), 50);
  assert.equal(progressPct({ ...uruHalf, graduated: true }), 100);
  assert.equal(progressPct({ ...uruHalf, graduationTargetEth: 0n }), 0);
});

function deps(lastTrades = new Map()) {
  return {
    marketCapEth: mockMarketCapEth,
    progress: mockProgressPct,
    tradeCount: tradeCountOf,
    lastTrade: (a) => lastTrades.get(a) ?? 0,
  };
}

test('near-graduation ranks by ratio across ETH and URU curves', () => {
  const uru = dn404RowToLaunch(row({ pairedToken: '0x00000000000000000000000000000000000000b1', pairCurrency: URU }), curve({ ethReserve: 3_000_000n * E18, graduationTargetEth: 5_000_000n * E18 }), { ethPerPairX18: ETH_PER_URU });
  const eth = dn404RowToLaunch(row({ pairedToken: '0x00000000000000000000000000000000000000b2' }), curve({ ethReserve: 5n * E18 }));
  const done = dn404RowToLaunch(row({ pairedToken: '0x00000000000000000000000000000000000000b3' }), curve({ graduated: true }));
  const out = filterAndSortLaunches([eth, done, uru], 'near-graduation', '', deps());
  assert.deepEqual(out.map((l) => l.address), [uru.address, eth.address], 'graduated dropped, 60% before 50%');
});

test('mcap tab compares URU launches in ETH', () => {
  const small = dn404RowToLaunch(row({ pairedToken: '0x00000000000000000000000000000000000000c2' }), curve({ ethReserve: 1n * E18 }));
  // Huge URU numbers but worth more ETH only if price says so: 5 ETH-equivalent.
  const uru = dn404RowToLaunch(
    row({ pairedToken: '0x00000000000000000000000000000000000000c3', pairCurrency: URU }),
    curve({ ethReserve: 5n * E18 * URU_PER_ETH, virtualEthReserve: 17n * E18 * URU_PER_ETH }),
    { ethPerPairX18: ETH_PER_URU },
  );
  // Same URU reserves but price unknown: must sort last (0), not first.
  const uruNoPrice = { ...uru, address: '0x00000000000000000000000000000000000000c4', ethPerPairX18: undefined };
  const out = filterAndSortLaunches([uruNoPrice, small, uru], 'mcap', '', deps());
  assert.deepEqual(out.map((l) => l.address), [uru.address, small.address, uruNoPrice.address]);
});

test("'new' sorts by launch time, newest first; 'dn404' keeps only DN404 tokens", () => {
  const a = { ...dn404RowToLaunch(row({ pairedToken: '0x00000000000000000000000000000000000000d1' }), curve()), launchedAt: 10 };
  const b = { ...dn404RowToLaunch(row({ pairedToken: '0x00000000000000000000000000000000000000d2' }), curve()), launchedAt: 30 };
  const router = { ...a, address: '0x00000000000000000000000000000000000000d3', lane: undefined, launchedAt: 20 };
  assert.deepEqual(filterAndSortLaunches([a, router, b], 'new', '', deps()).map((l) => l.launchedAt), [30, 20, 10]);
  assert.deepEqual(filterAndSortLaunches([a, router, b], 'dn404', '', deps()).map((l) => l.address), [b.address, a.address]);
});

test('trending counts curve trades plus pool swaps', () => {
  const quiet = dn404RowToLaunch(row({ pairedToken: '0x00000000000000000000000000000000000000e1' }), curve({ tradeCount: 3 }));
  const busy = dn404RowToLaunch(row({ pairedToken: '0x00000000000000000000000000000000000000e2', pairCurrency: URU }), curve({ tradeCount: 2, graduated: true }), { v4SwapCount: 5, ethPerPairX18: ETH_PER_URU });
  assert.deepEqual(filterAndSortLaunches([quiet, busy], 'trending', '', deps()).map((l) => l.address), [busy.address, quiet.address]);
});

test('merge: flag off drops DN404 rows; hidden test tokens never get through; no duplicates', () => {
  const routerLaunch = { ...dn404RowToLaunch(row({ pairedToken: '0x00000000000000000000000000000000000000f1' }), curve()), lane: undefined };
  const dn = dn404RowToLaunch(row({ pairedToken: '0x00000000000000000000000000000000000000f2' }), curve());
  const dupe = { ...dn, address: routerLaunch.address };
  // The four DN404 test tokens that must stay out of feeds.
  const hiddenTokens = [
    '0x26903cc300c81d056051e50c6cdec16054427122', // $SMOKE
    '0x46377623f4dd0470f5ea6f6120146f0801a26514', // REH404
    '0x1e3100abfdceba1de7b51b1ad9713177b177b7c1', // $UPT
    '0x6afbe2c60fe1745ed9ff592302df005575e1a172', // $FLT
  ];
  for (const h of hiddenTokens) assert.equal(isHiddenToken(4663, h), true, `${h} should be hidden`);
  const hidden = hiddenTokens.map((h) => ({ ...dn, address: h }));

  const off = mergeDn404Launches([routerLaunch], [dn, ...hidden], { dn404Enabled: false, isHidden: isHiddenToken });
  assert.deepEqual(off.map((l) => l.address), [routerLaunch.address]);

  const on = mergeDn404Launches([routerLaunch], [dn, dupe, ...hidden], { dn404Enabled: true, isHidden: isHiddenToken });
  assert.deepEqual(on.map((l) => l.address), [routerLaunch.address, dn.address]);
});

test('collectionVisible gates by lane', () => {
  const nft = { lane: 'nft' }, legacy = {}, dn = { lane: 'dn404' };
  assert.equal(collectionVisible(nft, { nftEnabled: true, dn404Enabled: false }), true);
  assert.equal(collectionVisible(legacy, { nftEnabled: true, dn404Enabled: false }), true);
  assert.equal(collectionVisible(dn, { nftEnabled: true, dn404Enabled: false }), false);
  assert.equal(collectionVisible(dn, { nftEnabled: false, dn404Enabled: true }), true);
  assert.equal(collectionVisible(nft, { nftEnabled: false, dn404Enabled: true }), false);
});

test('formatCurveAmount labels the curve currency', () => {
  const eth = dn404RowToLaunch(row(), curve());
  const uru = dn404RowToLaunch(row({ pairCurrency: URU }), curve(), { pairSymbol: 'URU' });
  assert.equal(formatCurveAmount(eth, 1_500_000_000_000_000_000n), '1.50 Ξ');
  assert.match(formatCurveAmount(uru, 4_000_000n * E18), /^4,000,000 URU$/);
  assert.doesNotMatch(formatCurveAmount(uru, 4n * E18), /Ξ/);
});
