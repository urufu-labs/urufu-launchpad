// GH-13 unit tests for the pure launch-card builder + poolId derivation.
//
// Runs under `node --experimental-strip-types --disable-warning=ExperimentalWarning
// --test 'src/**/*.test.ts'` from the indexer/ workspace — same convention as
// the compile-service test suite. No Postgres, no Ponder build, no network.
// The builder takes plain rows so we can exercise every branch here + wire the
// db reads separately in the route handler.

import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, encodeAbiParameters, type Address, type Hex } from 'viem';

import { buildLaunchCard, computeV4PoolId, LP_LOCK_SOURCE } from '../src/api/launch-card.ts';

const TOKEN = '0x1111111111111111111111111111111111111111' as Address;
const LAUNCHER = '0x2222222222222222222222222222222222222222' as Address;
const CURVE = '0x3333333333333333333333333333333333333333' as Address;
const HOOK = '0x4444444444444444444444444444444444444444' as Address;
const CREATOR = '0x5555555555555555555555555555555555555555' as Address;
const TX = ('0x' + 'ab'.repeat(32)) as Hex;

function baseLaunch(overrides: Partial<Parameters<typeof buildLaunchCard>[0]['launch']> = {}) {
  return {
    tokenAddress: TOKEN,
    chainId: 4663,
    launchedBy: LAUNCHER,
    txHash: TX,
    blockNumber: 100n,
    name: 'Test',
    ticker: 'TST',
    installedHook: false,
    installedGovernance: false,
    requestedHook: null,
    requestedGovernance: null,
    curveAddress: null,
    ...overrides,
  };
}

// ============================================================================
// computeV4PoolId — verify the poolId matches the exact PoolKey hash that the
// on-chain PoolManager will emit Swap events for.
// ============================================================================

test('computeV4PoolId matches keccak of the canonical ETH/token PoolKey', () => {
  const expected = keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      ['0x0000000000000000000000000000000000000000', TOKEN, 3000, 60, HOOK],
    ),
  );
  assert.equal(computeV4PoolId(TOKEN, HOOK), expected);
});

test('computeV4PoolId is deterministic + changes when the hook rotates', () => {
  const a = computeV4PoolId(TOKEN, HOOK);
  const b = computeV4PoolId(TOKEN, HOOK);
  assert.equal(a, b);
  const otherHook = '0x9999999999999999999999999999999999999999' as Address;
  assert.notEqual(computeV4PoolId(TOKEN, otherHook), a);
});

// ============================================================================
// buildLaunchCard shape + defaults — pre-graduation launch with no policy.
// ============================================================================

test('pre-graduation launch: hookPolicy null, installedHook false, state=pre', () => {
  const card = buildLaunchCard({
    launch: baseLaunch({ curveAddress: CURVE }),
    curve: {
      curveAddress: CURVE,
      virtualEthReserve: 10n,
      virtualTokenReserve: 20n,
      graduationTargetEth: 17n * 10n ** 18n,
      tradeFeeBps: 100,
      ethReserve: 1n,
      tokenReserve: 2n,
    },
    graduation: null,
    fallbackPoolId: computeV4PoolId(TOKEN, HOOK),
    fallbackHookAddress: HOOK,
    policy: null,
    latestSwap: null,
  });

  assert.equal(card.token, TOKEN);
  assert.equal(card.chainId, 4663);
  assert.equal(card.graduation.state, 'pre');
  assert.equal(card.graduation.tx, null);
  assert.equal(card.graduation.block, null);
  assert.equal(card.hookPolicy, null);
  assert.equal(card.pool.poolId, computeV4PoolId(TOKEN, HOOK));
  assert.equal(card.pool.hookAddress, HOOK);
  assert.equal(card.pool.sqrtPriceX96, null);
  assert.equal(card.pool.liquidity, null);
  assert.equal(card.lpLock.locked, true);
  assert.equal(card.lpLock.source, LP_LOCK_SOURCE);
  assert.equal(card.loyalty.advertised, false);
  assert.equal(card.loyalty.live, false);
  assert.equal(card.meta.installedHook, false); // no policy row → not installed
  assert.equal(card.meta.requestedHook, false);
  assert.equal(card.curve?.address, CURVE);
  assert.equal(card.curve?.virtualEthReserve, '10');
  assert.equal(card.curve?.graduationTargetEth, (17n * 10n ** 18n).toString());
});

// ============================================================================
// Graduated launch with populated policy — the meat of GH-13. Every
// hookPolicy field flows through from the input row exactly, and
// installedHook flips to true because the policy is `immutableAfterLaunch`.
// ============================================================================

test('graduated launch: hookPolicy populated + installedHook derived from policy freeze', () => {
  const poolId = computeV4PoolId(TOKEN, HOOK);
  const card = buildLaunchCard({
    launch: baseLaunch({
      installedHook: true,
      installedGovernance: false,
      requestedHook: true,
      requestedGovernance: false,
      curveAddress: CURVE,
    }),
    curve: {
      curveAddress: CURVE,
      virtualEthReserve: 0n,
      virtualTokenReserve: 0n,
      graduationTargetEth: 17n * 10n ** 18n,
      tradeFeeBps: 100,
      ethReserve: 17n * 10n ** 18n,
      tokenReserve: 0n,
    },
    graduation: {
      poolId,
      hookAddress: HOOK,
      txHash: TX,
      blockNumber: 999n,
    },
    policy: {
      antiSniperBlocks: 5,
      buybackBurnBps: 250,
      platformFeeBps: 100,
      creatorFeeBps: 200,
      creatorRecipient: CREATOR,
      immutableAfterLaunch: true,
    },
    latestSwap: {
      sqrtPriceX96: 79228162514264337593543950336n, // sqrt(1) * 2^96
      liquidity: 42n,
    },
  });

  assert.equal(card.graduation.state, 'graduated');
  assert.equal(card.graduation.block, '999');
  assert.equal(card.graduation.tx, TX);

  assert.deepEqual(card.hookPolicy, {
    antiSniperBlocks: 5,
    buybackBurnBps: 250,
    platformFeeBps: 100,
    creatorFeeBps: 200,
    creatorRecipient: CREATOR,
    immutableAfterLaunch: true,
  });

  assert.equal(card.pool.poolId, poolId);
  assert.equal(card.pool.hookAddress, HOOK);
  assert.equal(card.pool.sqrtPriceX96, '79228162514264337593543950336');
  assert.equal(card.pool.liquidity, '42');

  // GH-13 field cleanup — factual state, not requested.
  assert.equal(card.meta.installedHook, true, 'policy exists + frozen → installed');
  assert.equal(card.meta.requestedHook, true);
  assert.equal(card.meta.installedGovernance, false, 'no on-chain gov, mirror requested');
  assert.equal(card.meta.requestedGovernance, false);
});

// ============================================================================
// Field cleanup discrimination — the load-bearing GH-13 test.
// Requested vs installed must diverge in the two edge cases:
//   1. launcher REQUESTED a hook but pool never graduated (policy=null) →
//      requestedHook=true, installedHook=false
//   2. legacy row (requestedHook column null) → builder falls back to the
//      legacy installedHook column value for the `requested` display
// ============================================================================

test('field cleanup: requestedHook=true + no policy row → installedHook=false', () => {
  const card = buildLaunchCard({
    launch: baseLaunch({
      installedHook: true,
      installedGovernance: true,
      requestedHook: true,
      requestedGovernance: true,
      curveAddress: CURVE,
    }),
    curve: null,
    graduation: null,
    fallbackPoolId: computeV4PoolId(TOKEN, HOOK),
    fallbackHookAddress: HOOK,
    policy: null,
    latestSwap: null,
  });
  assert.equal(card.meta.requestedHook, true, 'launcher asked for hook');
  assert.equal(card.meta.installedHook, false, 'but MHH never opened the pool');
  assert.equal(card.meta.requestedGovernance, true);
  assert.equal(card.meta.installedGovernance, true, 'gov mirrors requested (no on-chain analog)');
});

test('field cleanup: legacy row (requested* null) → requested mirrors legacy installed*', () => {
  // Simulates a row indexed BEFORE the schema migration added requestedHook/
  // requestedGovernance columns. The old `installedHook` column was actually
  // the requested value (the whole point of the cleanup); the builder must
  // treat it as such when the honest column is null.
  const card = buildLaunchCard({
    launch: baseLaunch({
      installedHook: true,
      installedGovernance: false,
      requestedHook: null,
      requestedGovernance: null,
    }),
    curve: null,
    graduation: null,
    policy: null,
    latestSwap: null,
  });
  assert.equal(card.meta.requestedHook, true, 'legacy installedHook read as requested');
  assert.equal(card.meta.requestedGovernance, false);
  assert.equal(card.meta.installedHook, false, 'no policy → installedHook stays false');
});

test('field cleanup: immutableAfterLaunch=false does NOT count as installed', () => {
  // Defence in depth. The on-chain flow only ever emits HookPolicySet WITH
  // immutableAfterLaunch=true (see MHH.beforeInitialize) — so a false here
  // would mean an aggregator fed us a doctored row. Builder must still refuse
  // to call it "installed".
  const card = buildLaunchCard({
    launch: baseLaunch({ installedHook: true, requestedHook: true }),
    curve: null,
    graduation: {
      poolId: computeV4PoolId(TOKEN, HOOK),
      hookAddress: HOOK,
      txHash: TX,
      blockNumber: 1n,
    },
    policy: {
      antiSniperBlocks: 5,
      buybackBurnBps: 250,
      platformFeeBps: 100,
      creatorFeeBps: 200,
      creatorRecipient: CREATOR,
      immutableAfterLaunch: false, // <-- doctored
    },
    latestSwap: null,
  });
  assert.equal(card.meta.installedHook, false, 'unfrozen policy = not installed');
});

// ============================================================================
// bigint serialization — all bigint fields must arrive as decimal strings for
// JSON wire safety (aggregators universally read numeric strings).
// ============================================================================

test('bigints serialize as decimal strings — never JS number, never bigint literal', () => {
  const huge = 2n ** 100n;
  const card = buildLaunchCard({
    launch: baseLaunch({ blockNumber: huge, curveAddress: CURVE }),
    curve: {
      curveAddress: CURVE,
      virtualEthReserve: huge,
      virtualTokenReserve: huge,
      graduationTargetEth: huge,
      tradeFeeBps: 100,
      ethReserve: huge,
      tokenReserve: huge,
    },
    graduation: {
      poolId: computeV4PoolId(TOKEN, HOOK),
      hookAddress: HOOK,
      txHash: TX,
      blockNumber: huge,
    },
    policy: null,
    latestSwap: { sqrtPriceX96: huge, liquidity: huge },
  });
  const expected = huge.toString();
  assert.equal(card.launchBlock, expected);
  assert.equal(card.curve?.virtualEthReserve, expected);
  assert.equal(card.graduation.block, expected);
  assert.equal(card.pool.sqrtPriceX96, expected);
  assert.equal(card.pool.liquidity, expected);

  // Round-trip through JSON to catch any lurking BigInt that would throw.
  const s = JSON.stringify(card);
  assert.ok(s.includes(expected));
});

// ============================================================================
// Curve-less launch (rare, non-bonding-curve Router path). Card must still
// render — curve field is null but everything else survives.
// ============================================================================

test('no-curve launch: card.curve === null, graduation stays pre, policy null', () => {
  const card = buildLaunchCard({
    launch: baseLaunch({ curveAddress: null }),
    curve: null,
    graduation: null,
    policy: null,
    latestSwap: null,
  });
  assert.equal(card.curve, null);
  assert.equal(card.graduation.state, 'pre');
  assert.equal(card.hookPolicy, null);
  assert.equal(card.lpLock.locked, true);
});
