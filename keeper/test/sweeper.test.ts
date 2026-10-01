/**
 * Unit tests for the keeper's pure logic. Chain behaviour is covered by the
 * anvil-fork harness (test/fork/).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { decodeAbiParameters, decodeFunctionData, parseAbiItem, type Address } from 'viem';
import { TaxMode } from '../src/config.ts';
import type { DiscoveredLaunch } from '../src/discovery.ts';
import { decideSweep, type LaunchSnapshot } from '../src/sweeper.ts';
import {
  MAX_SQRT_PRICE, MAX_TICK, MIN_SQRT_PRICE, MIN_TICK, fullRangeTicks, getSqrtPriceAtTick,
  launchPoolKey, liquidityForAmounts, poolIdOf, priceOtherPerToken, uruWethPoolKey,
} from '../src/pools.ts';
import { RH } from '../src/constants.ts';
import { encodeExactInSingle, applyBps } from '../src/swap.ts';
import { planProRata } from '../src/handlers/reflections.ts';
import { selectListings } from '../src/handlers/floor.ts';
import { encodeFulfillment } from '../src/opensea.ts';
import { encodeMintFullRange } from '../src/handlers/addToLp.ts';

const KEEPER = '0x192F94cD3191e6561D31940602Dc4925ed233b1a' as Address;
const OTHER = '0x0000000000000000000000000000000000000abc' as Address;
const launch: DiscoveredLaunch = {
  base: '0x1000000000000000000000000000000000000001', mirror: '0x1000000000000000000000000000000000000002',
  curve: '0x1000000000000000000000000000000000000003', launcher: OTHER, pair: '0x0000000000000000000000000000000000000000',
  taxModeAtLaunch: TaxMode.BuybackURU, unit: 100_000n, totalSupply: 800_000_000n * 10n ** 18n, launchBlock: 1n,
};
const snap = (o: Partial<LaunchSnapshot> = {}): LaunchSnapshot => ({
  launch, taxMode: TaxMode.BuybackURU, taxTarget: OTHER, keeper: KEEPER, keeperTreasury: OTHER, owner: OTHER,
  accumulatedTax: 1_000_000n * 10n ** 18n, totalSupply: 800_000_000n * 10n ** 18n, unitWei: 100_000n * 10n ** 18n,
  graduated: true, keeperSkipsNft: true, keeperBalance: 0n, ...o,
});
const cfg = { minSweepBpsOfSupply: 1n, maxSweepBpsOfSupply: 500n };

// ---- decideSweep ----
test('sweeps an accumulator mode over threshold', () => assert.equal(decideSweep(snap(), KEEPER, cfg).shouldSweep, true));
test('skips when on-chain keeper is someone else', () => {
  const d = decideSweep(snap({ keeper: OTHER }), KEEPER, cfg);
  assert.equal(d.shouldSweep, false); assert.equal(d.shouldAct, false);
});
test('keeper match is case-insensitive', () => assert.equal(decideSweep(snap({ keeper: KEEPER.toLowerCase() as Address }), KEEPER, cfg).shouldSweep, true));
test('Off and BurnDead never sweep', () => {
  assert.equal(decideSweep(snap({ taxMode: TaxMode.Off }), KEEPER, cfg).shouldSweep, false);
  assert.equal(decideSweep(snap({ taxMode: TaxMode.BurnDead }), KEEPER, cfg).shouldSweep, false);
});
test('pool-dependent modes wait for graduation; reflections do not', () => {
  for (const m of [TaxMode.BuybackURU, TaxMode.BuyAllowedToken, TaxMode.AddToLP, TaxMode.MirrorFloorSupport]) {
    assert.equal(decideSweep(snap({ taxMode: m, graduated: false }), KEEPER, cfg).shouldSweep, false, `mode ${m}`);
  }
  assert.equal(decideSweep(snap({ taxMode: TaxMode.HolderReflections, graduated: false }), KEEPER, cfg).shouldSweep, true);
});
test('below min threshold: no sweep, but leftover keeper balance still acts', () => {
  const d = decideSweep(snap({ accumulatedTax: 1n, keeperBalance: 5n }), KEEPER, cfg);
  assert.equal(d.shouldSweep, false); assert.equal(d.shouldAct, true);
});
test('above max: refuse entirely', () => {
  const d = decideSweep(snap({ accumulatedTax: 50_000_000n * 10n ** 18n }), KEEPER, cfg);
  assert.equal(d.shouldSweep, false); assert.equal(d.shouldAct, false); assert.match(d.reason, /refuse/);
});

// ---- TickMath / pools ----
test('getSqrtPriceAtTick matches v4-core bounds bit-exactly', () => {
  assert.equal(getSqrtPriceAtTick(MIN_TICK), MIN_SQRT_PRICE);
  assert.equal(getSqrtPriceAtTick(MAX_TICK), MAX_SQRT_PRICE);
  assert.equal(getSqrtPriceAtTick(0), 1n << 96n);
});
test('full range ticks for spacing 60', () => assert.deepEqual(fullRangeTicks(60), [-887220, 887220]));
test('URU/WETH key hashes to the live pool id', () => assert.equal(poolIdOf(uruWethPoolKey(RH)), RH.uruWethPoolId));
test('REH404/URU launch key hashes to the live pool id', () => {
  const k = launchPoolKey('0x46377623F4Dd0470f5eA6F6120146F0801a26514', RH.uru, RH);
  assert.equal(poolIdOf(k), '0xe866d28f412e92d9310fce42f927fa5fc85d16777511ac8f52068ce62bb080c7');
});
test('ETH-paired launch key is native currency0 on the ERC-20 lane host', () => {
  const k = launchPoolKey(launch.base, '0x0000000000000000000000000000000000000000', RH);
  assert.equal(k.currency0, '0x0000000000000000000000000000000000000000'); assert.equal(k.hooks, RH.hookEth);
});
test('liquidityForAmounts at price 1 full range uses the binding side', () => {
  const [lo, hi] = fullRangeTicks(60);
  const L = liquidityForAmounts(1n << 96n, getSqrtPriceAtTick(lo), getSqrtPriceAtTick(hi), 10n ** 18n, 10n ** 18n);
  assert.ok(L > 9n * 10n ** 17n && L <= 10n ** 18n, `L=${L}`);
});
test('priceOtherPerToken inverts by ordering', () => {
  const sq = 2n << 96n; // c1/c0 = 4
  assert.equal(priceOtherPerToken(sq, true), 4n * 10n ** 18n);
  assert.equal(priceOtherPerToken(sq, false), 25n * 10n ** 16n);
});

// ---- encoders ----
test('UR exact-in single: V4_SWAP with 06 0c 0f and the RH minHopPriceX36 slot', () => {
  const k = uruWethPoolKey(RH);
  const { commands, inputs } = encodeExactInSingle(k, true, 1000n, 900n);
  assert.equal(commands, '0x10');
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0]!);
  assert.equal(actions, '0x060c0f');
  const [swap] = decodeAbiParameters([{ type: 'tuple', components: [
    { name: 'k', type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] },
    { name: 'z', type: 'bool' }, { name: 'a', type: 'uint128' }, { name: 'm', type: 'uint128' }, { name: 'h', type: 'uint256' }, { name: 'd', type: 'bytes' }] }], params[0]!);
  assert.equal((swap as any).a, 1000n); assert.equal((swap as any).m, 900n); assert.equal((swap as any).h, 0n);
});
test('applyBps never rounds a positive quote to more than input', () => assert.equal(applyBps(10_000n, 300n), 9_700n));
test('mint encoder: native pool adds SWEEP, ERC-20 pool does not', () => {
  const native = launchPoolKey(launch.base, '0x0000000000000000000000000000000000000000', RH);
  const [a1] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], encodeMintFullRange(native, 1n, 1n, 1n, KEEPER, KEEPER));
  assert.equal(a1, '0x020d14');
  const erc = launchPoolKey(launch.base, RH.uru, RH);
  const [a2] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], encodeMintFullRange(erc, 1n, 1n, 1n, KEEPER, KEEPER));
  assert.equal(a2, '0x020d');
});

// ---- reflections ----
test('pro-rata split by balance, floor division, dust skipped', () => {
  const p = planProRata(1000n, [
    { holder: '0x0000000000000000000000000000000000000001', balance: 600n },
    { holder: '0x0000000000000000000000000000000000000002', balance: 300n },
    { holder: '0x0000000000000000000000000000000000000003', balance: 100n },
    { holder: '0x0000000000000000000000000000000000000004', balance: 0n },
  ], 101n);
  assert.deepEqual(p.map((x) => x.amount), [600n, 300n]); // 100 < min payout 101
});

// ---- floor selection ----
test('floor picks cheapest listings under the margin, within budget and max', () => {
  const L = (id: number, p: bigint) => ({ orderHash: '0x00' as const, protocolAddress: OTHER, tokenId: BigInt(id), currency: '0x0000000000000000000000000000000000000000' as const, amount: p, priceWei: p });
  const picked = selectListings([L(1, 95n), L(2, 50n), L(3, 80n), L(4, 89n)], 100n, 1000n, 2, 1000n);
  assert.deepEqual(picked.map((l) => l.tokenId), [2n, 3n]); // ceiling 90; cheapest two
  assert.deepEqual(selectListings([L(1, 50n), L(2, 60n)], 100n, 1000n, 5, 100n).map((l) => l.tokenId), [1n]); // budget
});

// ---- OpenSea fulfillment encoding ----
test('encodeFulfillment maps nested JSON objects positionally to the ABI', () => {
  const fn = 'fulfillOrder(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),bytes),bytes32)';
  const data = encodeFulfillment({
    to: OTHER, value: 5n, function: fn,
    input_data: {
      order: {
        parameters: {
          offerer: OTHER, zone: '0x0000000000000000000000000000000000000000',
          offer: [{ itemType: 2, token: OTHER, identifierOrCriteria: '7', startAmount: '1', endAmount: '1' }],
          consideration: [{ itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount: '5', endAmount: '5', recipient: OTHER }],
          orderType: 0, startTime: '1', endTime: '2', zoneHash: '0x' + '00'.repeat(32), salt: '9', conduitKey: '0x' + '00'.repeat(32), totalOriginalConsiderationItems: 1,
        },
        signature: '0x1234',
      },
      fulfillerConduitKey: '0x' + '00'.repeat(32),
    },
  });
  const dec = decodeFunctionData({ abi: [parseAbiItem(`function ${fn}`)], data });
  const order = (dec.args as any)[0];
  assert.equal(order[0][2][0][2], 7n); // offer[0].identifierOrCriteria
  assert.equal(order[1], '0x1234');
});
