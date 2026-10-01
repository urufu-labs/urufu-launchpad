/// Pins the ERC-20/ERC-20 v4 swap helper against live Robinhood facts and the
/// on-chain ABIs the trade page calls for URU-paired DN404 tokens.
///
/// Run:
///   node --experimental-strip-types --disable-warning=ExperimentalWarning \
///     --test src/lib/v4Erc20Swap.test.mjs

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { decodeAbiParameters, encodeFunctionData, toFunctionSelector } from 'viem';

import {
  buildErc20PoolKey,
  encodeV4ExactInSingle,
  encodeV4ExactInSingleSettleFirst,
  pairPerTokenFromSqrt,
  poolIdOf,
  sortCurrencies,
} from './v4Erc20Swap.ts';
import { dn404BondingCurveAbi, universalRouterAbi } from './abis.ts';

const REH404 = '0x46377623F4Dd0470f5eA6F6120146F0801a26514';
const URU = '0x9fbe210007dDd8389f98d0253018e65CC48b9D24';
const DN404_HOST = '0x6d8701058E4eecA3bF80D14bD6C13A89575460C4';
/// Live pool seeded by RehearseDn404UruPair.s.sol on 2026-09-23.
const REH404_POOL_ID = '0xe866d28f412e92d9310fce42f927fa5fc85d16777511ac8f52068ce62bb080c7';

describe('sortCurrencies', () => {
  it('orders numerically regardless of argument order or case', () => {
    assert.deepEqual(sortCurrencies(URU, REH404), [REH404, URU]);
    assert.deepEqual(sortCurrencies(REH404, URU), [REH404, URU]);
    const [a, b] = sortCurrencies(URU.toLowerCase(), REH404);
    assert.equal(a, REH404);
    assert.equal(b, URU.toLowerCase());
  });
});

describe('poolIdOf', () => {
  it('reproduces the live REH404/URU pool id on the DN404 host', () => {
    const key = buildErc20PoolKey(REH404, URU, DN404_HOST);
    assert.equal(key.currency0, REH404);
    assert.equal(key.currency1, URU);
    assert.equal(key.fee, 3000);
    assert.equal(key.tickSpacing, 60);
    assert.equal(poolIdOf(key).toLowerCase(), REH404_POOL_ID);
  });
});

describe('pairPerTokenFromSqrt', () => {
  it('matches the graduation price of the live pool (token is currency0)', () => {
    // Opening sqrtPriceX96 of the REH404 pool. price = sq^2 / 2^192 URU per token.
    const sq = 278713285600353317531635121n;
    const p = pairPerTokenFromSqrt(sq, true);
    const expected = (sq * sq * 10n ** 18n) >> 192n;
    assert.equal(p, expected);
    // Inverted branch is the reciprocal (within integer rounding).
    const inv = pairPerTokenFromSqrt(sq, false);
    const product = (p * inv) / 10n ** 18n;
    assert.ok(product > 10n ** 18n - 10n ** 12n && product < 10n ** 18n + 10n ** 12n, `p*inv=${product}`);
  });
});

describe('encodeV4ExactInSingle (chain 4663)', () => {
  const key = buildErc20PoolKey(REH404, URU, DN404_HOST);
  const call = encodeV4ExactInSingle({
    chainId: 4663,
    key,
    zeroForOne: true, // sell REH404 (currency0) for URU
    amountIn: 1_000_000n * 10n ** 18n,
    amountOutMinimum: 0n,
  });

  it('uses the single V4_SWAP command', () => {
    assert.equal(call.commands, '0x10');
    assert.equal(call.inputs.length, 1);
  });

  it('emits SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL', () => {
    const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], call.inputs[0]);
    assert.equal(actions, '0x060c0f');
    assert.equal(params.length, 3);
    const [settleCurrency, settleMax] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[1]);
    assert.equal(settleCurrency, REH404);
    assert.equal(settleMax, 1_000_000n * 10n ** 18n);
    const [takeCurrency] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]);
    assert.equal(takeCurrency, URU);
  });

  it('encodes the RH struct with minHopPriceX36 (6 head fields)', () => {
    const [, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], call.inputs[0]);
    const [decoded] = decodeAbiParameters(
      [{
        type: 'tuple',
        components: [
          { name: 'poolKey', type: 'tuple', components: [
            { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
            { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
          ] },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'minHopPriceX36', type: 'uint256' },
          { name: 'hookData', type: 'bytes' },
        ],
      }],
      params[0],
    );
    assert.equal(decoded.poolKey.hooks, DN404_HOST);
    assert.equal(decoded.zeroForOne, true);
    assert.equal(decoded.minHopPriceX36, 0n);
    assert.equal(decoded.hookData, '0x');
  });

  it('encodes against UniversalRouter.execute(bytes,bytes[],uint256)', () => {
    const data = encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [call.commands, call.inputs, 1n] });
    assert.equal(data.slice(0, 10), toFunctionSelector('execute(bytes,bytes[],uint256)'));
  });
});

describe('dn404BondingCurveAbi', () => {
  it('buy(uint256,uint256) is non-payable, sell(uint256,uint256) matches the curve', () => {
    const buy = dn404BondingCurveAbi.find((x) => x.type === 'function' && x.name === 'buy');
    const sell = dn404BondingCurveAbi.find((x) => x.type === 'function' && x.name === 'sell');
    assert.equal(buy.stateMutability, 'nonpayable');
    assert.equal(buy.inputs.map((i) => i.type).join(','), 'uint256,uint256');
    assert.equal(sell.inputs.map((i) => i.type).join(','), 'uint256,uint256');
    assert.equal(
      encodeFunctionData({ abi: dn404BondingCurveAbi, functionName: 'buy', args: [1n, 2n] }).slice(0, 10),
      toFunctionSelector('buy(uint256,uint256)'),
    );
  });
});

// Fee-on-transfer-safe order for TAXED sells. Must match the fork-proven
// layout in contracts/test/dn404/Dn404TaxTemplateV2Fork.t.sol::_fotSell:
// actions 0x0b 0x06 0x0f, SETTLE(currencyIn, amountIn, payerIsUser=true),
// SWAP_EXACT_IN_SINGLE with amountIn = OPEN_DELTA (0), TAKE_ALL(out, min).
describe('encodeV4ExactInSingleSettleFirst', () => {
  const TOKEN = '0x46377623F4Dd0470f5eA6F6120146F0801a26514';
  const ETH = '0x0000000000000000000000000000000000000000';
  const HOST = '0x83d6fa59BEF503112887b16277CF559fDC93E0C4';
  const ethKey = buildErc20PoolKey(TOKEN, ETH, HOST);
  const amountIn = 1_000n * 10n ** 18n;
  const call = encodeV4ExactInSingleSettleFirst({ chainId: 4663, key: ethKey, zeroForOne: false, amountIn, amountOutMinimum: 7n });
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], call.inputs[0]);

  it('ETH pool sorts native ETH to currency0', () => {
    assert.equal(ethKey.currency0, ETH);
    assert.equal(ethKey.currency1, TOKEN);
  });
  it('uses V4_SWAP with actions SETTLE, SWAP_EXACT_IN_SINGLE, TAKE_ALL', () => {
    assert.equal(call.commands, '0x10');
    assert.equal(actions, '0x0b060f');
  });
  it('SETTLE pays the full amountIn from the user', () => {
    const [cur, amt, payerIsUser] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], params[0]);
    assert.equal(cur, TOKEN);
    assert.equal(amt, amountIn);
    assert.equal(payerIsUser, true);
  });
  it('swap amountIn is OPEN_DELTA (0) with the RH minHopPriceX36 layout', () => {
    const [d] = decodeAbiParameters([{
      type: 'tuple',
      components: [
        { name: 'poolKey', type: 'tuple', components: [
          { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
        ] },
        { name: 'zeroForOne', type: 'bool' },
        { name: 'amountIn', type: 'uint128' },
        { name: 'amountOutMinimum', type: 'uint128' },
        { name: 'minHopPriceX36', type: 'uint256' },
        { name: 'hookData', type: 'bytes' },
      ],
    }], params[1]);
    assert.equal(d.amountIn, 0n);
    assert.equal(d.zeroForOne, false);
    assert.equal(d.amountOutMinimum, 7n);
    assert.equal(d.poolKey.hooks, HOST);
  });
  it('TAKE_ALL takes native ETH with the min', () => {
    const [cur, min] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]);
    assert.equal(cur, ETH);
    assert.equal(min, 7n);
  });
  it('refuses native ETH as the taxed input', () => {
    assert.throws(() => encodeV4ExactInSingleSettleFirst({ chainId: 4663, key: ethKey, zeroForOne: true, amountIn, amountOutMinimum: 0n }));
  });
});
