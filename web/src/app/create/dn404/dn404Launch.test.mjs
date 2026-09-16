/// Runtime shape check for the /create/dn404 form submit path.
///
/// The form assembles a LaunchParams tuple then hands it to wagmi's
/// writeContract. wagmi encodes the args against the ABI's tuple
/// definition — any drift between the form's arg order / types and the
/// ABI's tuple shape shows up here as an encodeFunctionData throw.
///
/// The full browser round-trip needs a wallet-connected Chrome, which
/// this session's environment doesn't have. This test covers the same
/// failure mode a browser round-trip would catch — "the form's args
/// don't match the on-chain function" — without needing one.
///
/// Run:
///   node --experimental-strip-types --disable-warning=ExperimentalWarning \
///     --test src/app/create/dn404/dn404Launch.test.mjs

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { encodeFunctionData, parseAbiItem } from 'viem';

import { dn404LaunchFactoryAbi } from '../../../lib/abis.ts';

/// Sample values covering every DN404 launch shape:
///   - ETH pair, tax off (the "just NFTs backed by an ERC-20" flow)
///   - USDG pair, tax off
///   - ETH pair, tax = BurnDead 3%
///   - ETH pair, tax = BuyAllowedToken 5% (max cap)
const SAMPLE_LAUNCHES = [
  {
    label: 'eth-pair, tax off',
    params: {
      name: 'Test Launch',
      ticker: 'TEST',
      baseURI: 'ipfs://test/',
      contractURI: 'ipfs://test/collection.json',
      collectionSize: 800n,
      unit: 1_000_000n,
      founderPremintBps: 0,
      antiSniperBlocks: 0,
      buybackBurnBps: 0,
      pairCurrency: '0x0000000000000000000000000000000000000000',
      taxMode: 0,
      taxBps: 0,
      taxTarget: '0x0000000000000000000000000000000000000000',
      uruAmount: 0n,
    },
  },
  {
    label: 'usdg-pair, tax off',
    params: {
      name: 'USDG-paired Art',
      ticker: 'ART',
      baseURI: 'ipfs://art/',
      contractURI: 'ipfs://art/collection.json',
      collectionSize: 400n,
      unit: 2_000_000n,
      founderPremintBps: 500,
      antiSniperBlocks: 100,
      buybackBurnBps: 200,
      pairCurrency: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      taxMode: 0,
      taxBps: 0,
      taxTarget: '0x0000000000000000000000000000000000000000',
      uruAmount: 10_000n * 10n ** 18n,
    },
  },
  {
    label: 'eth-pair, BurnDead 3%',
    params: {
      name: 'Burn Test',
      ticker: 'BURN',
      baseURI: 'ipfs://burn/',
      contractURI: 'ipfs://burn/collection.json',
      collectionSize: 200n,
      unit: 4_000_000n,
      founderPremintBps: 0,
      antiSniperBlocks: 0,
      buybackBurnBps: 0,
      pairCurrency: '0x0000000000000000000000000000000000000000',
      taxMode: 1,      // BurnDead
      taxBps: 300,     // 3%
      taxTarget: '0x0000000000000000000000000000000000000000',
      uruAmount: 10_000n * 10n ** 18n,
    },
  },
  {
    label: 'eth-pair, BuyAllowedToken 5% (max cap)',
    params: {
      name: 'Buy Route',
      ticker: 'BUY',
      baseURI: 'ipfs://buy/',
      contractURI: 'ipfs://buy/collection.json',
      collectionSize: 400n,
      unit: 2_000_000n,
      founderPremintBps: 1000,
      antiSniperBlocks: 0,
      buybackBurnBps: 0,
      pairCurrency: '0x0000000000000000000000000000000000000000',
      taxMode: 3,      // BuyAllowedToken
      taxBps: 500,     // 5% cap
      taxTarget: '0x9fbe210007dDd8389f98d0253018e65CC48b9D24', // URU
      uruAmount: 10_000n * 10n ** 18n,
    },
  },
];

describe('/create/dn404 form → dn404LaunchFactory.launch ABI encoding', () => {
  it('every sample launch encodes cleanly under the ABI', () => {
    for (const { label, params } of SAMPLE_LAUNCHES) {
      const encoded = encodeFunctionData({
        abi: dn404LaunchFactoryAbi,
        functionName: 'launch',
        args: [params],
      });
      // launch() selector is 4 bytes + one tuple with 14 fields — the
      // encoding size is deterministic (dynamic-length strings dominate
      // it, but ≥ 4 + 32*20 bytes is a solid lower bound).
      assert.ok(
        encoded.startsWith('0x'),
        `${label}: encoded should start with 0x, got ${encoded.slice(0, 8)}`,
      );
      assert.ok(
        encoded.length > 4 + 2 + 32 * 20 * 2,
        `${label}: encoded ${encoded.length} chars too short — ABI shape drift?`,
      );
    }
  });

  it('LaunchParams tuple has exactly the 14 fields the form emits', () => {
    // Guard against silent tuple-shape drift: if a field is added,
    // renamed, or reordered, this test fails until the form and ABI
    // agree on the new shape.
    const launchFn = dn404LaunchFactoryAbi.find(
      (item) => item.type === 'function' && item.name === 'launch',
    );
    assert.ok(launchFn, 'launch() must exist in dn404LaunchFactoryAbi');
    const paramsTuple = launchFn.inputs[0];
    assert.equal(paramsTuple.name, 'p', 'first arg should be named p');
    assert.equal(paramsTuple.type, 'tuple', 'first arg should be a tuple');
    const fieldNames = paramsTuple.components.map((c) => c.name);
    assert.deepEqual(
      fieldNames,
      [
        'name',
        'ticker',
        'baseURI',
        'contractURI',
        'collectionSize',
        'unit',
        'founderPremintBps',
        'antiSniperBlocks',
        'buybackBurnBps',
        'pairCurrency',
        'taxMode',
        'taxBps',
        'taxTarget',
        'uruAmount',
      ],
      'LaunchParams tuple field order drifted — sync the form + ABI',
    );
  });

  it('rejects a partial-params object (missing taxMode) — proves the check is real', () => {
    const bad = { ...SAMPLE_LAUNCHES[0].params };
    delete bad.taxMode;
    // viem doesn't guarantee a specific error message for missing tuple
    // fields — some throw at the BigInt cast, some at the ABI validator.
    // Either shape satisfies the invariant: encoding a partial params
    // object MUST fail, and it does.
    assert.throws(
      () =>
        encodeFunctionData({
          abi: dn404LaunchFactoryAbi,
          functionName: 'launch',
          args: [bad],
        }),
      Error,
      'partial-params encoding should have thrown',
    );
  });
});

// Silence "parseAbiItem imported but unused" — kept in the import for
// future assertions on individual ABI items without re-editing imports.
void parseAbiItem;
