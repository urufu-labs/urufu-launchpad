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
