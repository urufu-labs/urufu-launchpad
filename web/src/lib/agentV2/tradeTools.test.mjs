// Phase 1b trade tools: quote_buy / quote_sell (curve + v4), Fair batch deposit /
// claim, creator fee claims. Valid, invalid, edge amounts, closed or paused states.
// Run: pnpm --filter web test:agent
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { decodeFunctionData, parseEther } from 'viem';

import { bondingCurveAbi, erc20TokenAbi, fairHookHostAbi, multiHookHostAbi, openingBatchAbi, v4SwapRouterAbi } from '../abis.ts';
import { RateLimiter } from './rateLimit.ts';
import { runTool } from './runner.ts';
import { ethPoolKey, poolIdOf } from './tradeTools.ts';
import { TtlCache } from './ttlCache.ts';
import { BATCH, BOOK, CURVE, E18, LAUNCHER, TOKEN, defaultChain, fakeDeps } from './testFixtures.mjs';

const BUYER = '0x7777777777777777777777777777777777777777';
const ctx = (deps) => ({ ip: '203.0.113.5', deps, limiter: new RateLimiter(), cache: new TtlCache(), source: 'rest' });
async function call(tool, input, opts = {}) {
  const { deps, chain } = fakeDeps(opts);
  const res = await runTool(tool, input, ctx(deps));
  return { ...res, chain };
}
const graduated = () => { const c = defaultChain(); c.curve.graduated = true; return c; };
const fairChain = () => { const c = defaultChain(); c.fairCurveFor = CURVE; c.v10CurveFor = '0x0000000000000000000000000000000000000000'; c.batchFor = BATCH; return c; };

describe('quote_buy', () => {
  it('curve: buy(minOut) with value = ethIn, minOut = quote minus slippage', async () => {
    const r = await call('quote_buy', { token: TOKEN, buyer: BUYER, ethIn: '0.5', maxSlippageBps: 100 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.venue, 'bonding curve');
    assert.equal(d.canBroadcast, true);
    const tx = d.transactions[0];
    assert.equal(tx.to, CURVE);
    assert.equal(tx.value, String(parseEther('0.5')));
    const dec = decodeFunctionData({ abi: bondingCurveAbi, data: tx.data });
    assert.equal(dec.functionName, 'buy');
    assert.equal(dec.args[0], (1_000_000n * E18 * 9_900n) / 10_000n);
    assert.equal(d.minTokensOut, String(dec.args[0]));
    assert.equal(d.simulation.ok, true);
  });

  it('graduated: V4SwapRouter.swapExactETHForToken with quoter minOut, recipient = buyer, 5 min deadline', async () => {
    const r = await call('quote_buy', { token: TOKEN, buyer: BUYER, ethIn: '0.1' }, { chain: graduated() });
    const d = r.body.data;
    assert.equal(d.venue, 'Uniswap v4 pool');
    const tx = d.transactions[0];
    assert.equal(tx.to, BOOK.V4SwapRouter);
    const dec = decodeFunctionData({ abi: v4SwapRouterAbi, data: tx.data });
    assert.equal(dec.functionName, 'swapExactETHForToken');
    assert.equal(dec.args[0].hooks, BOOK.MultiHookHost);
    assert.equal(dec.args[0].currency0, '0x0000000000000000000000000000000000000000');
    assert.equal(dec.args[1], (900_000n * E18 * 9_800n) / 10_000n);
    assert.equal(dec.args[2].toLowerCase(), BUYER);
    assert.equal(dec.args[3], 1_800_000_000n + 300n);
    assert.equal(d.poolId, poolIdOf(ethPoolKey(TOKEN, BOOK.MultiHookHost)));
  });

  it('graduated fair token routes through the FairHookHost pool and warns about the sniper tax', async () => {
    const c = fairChain(); c.curve.graduated = true;
    const r = await call('quote_buy', { token: TOKEN, buyer: BUYER, ethIn: '0.1' }, { chain: c });
    const dec = decodeFunctionData({ abi: v4SwapRouterAbi, data: r.body.data.transactions[0].data });
    assert.equal(dec.args[0].hooks, BOOK.FairHookHost);
    assert.ok(r.body.data.warnings.some((w) => /sniper tax/.test(w)));
  });

  it('legacy V10 tokens use the V10 hook', async () => {
    const LUV = '0x985ec2c71ffebf4822b6c877bb87229923813c63';
    const c = graduated(); c.v10CurveFor = CURVE;
    const { deps } = fakeDeps({ chain: c });
    const orig = deps.client.readContract;
    deps.client.readContract = (a) => (a.functionName === 'curveFor' && a.address === BOOK.CurveFactory ? CURVE : orig(a));
    const r = await runTool('quote_buy', { token: LUV, buyer: BUYER, ethIn: '0.1' }, ctx(deps));
    const dec = decodeFunctionData({ abi: v4SwapRouterAbi, data: r.body.data.transactions[0].data });
    assert.equal(dec.args[0].hooks, BOOK.LegacyMultiHookHost);
  });

  it('fair curve during the opening batch points to quote_batch_deposit', async () => {
    const c = fairChain(); c.batchCloseTs = c.timestamp + 30n;
    const r = await call('quote_buy', { token: TOKEN, buyer: BUYER, ethIn: '0.1' }, { chain: c });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'BATCH_OPEN');
    assert.match(r.body.error.message, /quote_batch_deposit/);
  });

  it('quoter revert (too big, gated) is a clear 409', async () => {
    const c = graduated(); c.quoterReverts = 'execution reverted';
    const r = await call('quote_buy', { token: TOKEN, buyer: BUYER, ethIn: '1' }, { chain: c });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'QUOTE_FAILED');
  });

  it('not enough ETH blocks; zero and bad amounts are rejected', async () => {
    const c = defaultChain(); c.ethBalance = 1n;
    const r = await call('quote_buy', { token: TOKEN, buyer: BUYER, ethIn: '0.5' }, { chain: c });
    assert.equal(r.body.data.canBroadcast, false);
    assert.equal(r.body.data.simulation.skipped, 'blocking errors');
    assert.equal((await call('quote_buy', { token: TOKEN, buyer: BUYER, ethIn: '0' })).status, 400);
    for (const v of ['-1', '1e3', 'x', '0.0000000000000000001']) assert.equal((await call('quote_buy', { token: TOKEN, buyer: BUYER, ethIn: v })).status, 400, v);
  });

  it('slippage bounds: 0 allowed, over 20% refused', async () => {
    const r0 = await call('quote_buy', { token: TOKEN, buyer: BUYER, ethIn: '0.5', maxSlippageBps: 0 });
    assert.equal(r0.body.data.minTokensOut, String(1_000_000n * E18));
    assert.equal((await call('quote_buy', { token: TOKEN, buyer: BUYER, ethIn: '0.5', maxSlippageBps: 2001 })).status, 400);
  });

  it('DN404 and unknown tokens are refused', async () => {
    const dn = await call('quote_buy', { token: TOKEN, buyer: BUYER, ethIn: '0.1' }, { indexer: { dn404ForBase: async () => ({ collectionAddress: '0x9' }) } });
    assert.equal(dn.status, 409);
    assert.equal(dn.body.error.code, 'UNSUPPORTED');
    const none = await call('quote_buy', { token: '0x9999999999999999999999999999999999999999', buyer: BUYER, ethIn: '0.1' });
    assert.equal(none.status, 404);
  });

  it('simulation revert becomes an error', async () => {
    const c = defaultChain(); c.callReverts = 'execution reverted: Slippage';
    const r = await call('quote_buy', { token: TOKEN, buyer: BUYER, ethIn: '0.5' }, { chain: c });
    assert.equal(r.body.data.canBroadcast, false);
  });
});

describe('quote_sell', () => {
  it('curve: exact-amount approve then sell(amount, minEthOut)', async () => {
    const r = await call('quote_sell', { token: TOKEN, seller: BUYER, tokenAmount: '1000' });
    const d = r.body.data;
    assert.equal(d.transactions.length, 2);
    const ap = decodeFunctionData({ abi: erc20TokenAbi, data: d.transactions[0].data });
    assert.equal(ap.functionName, 'approve');
    assert.equal(ap.args[0], CURVE);
    assert.equal(ap.args[1], 1000n * E18);
    assert.equal(d.transactions[0].to, TOKEN);
    const sell = decodeFunctionData({ abi: bondingCurveAbi, data: d.transactions[1].data });
    assert.equal(sell.functionName, 'sell');
    assert.equal(sell.args[0], 1000n * E18);
    assert.equal(sell.args[1], (2n * 10n ** 16n * 9_800n) / 10_000n);
    assert.equal(d.simulation.skipped, 'needs the approve first');
  });

  it('no approve when the allowance covers it; simulation runs', async () => {
    const c = defaultChain(); c.tokenAllowance = 10n ** 30n;
    const r = await call('quote_sell', { token: TOKEN, seller: BUYER, tokenAmount: '1000' }, { chain: c });
    assert.equal(r.body.data.transactions.length, 1);
    assert.equal(r.body.data.simulation.ok, true);
  });

  it('graduated: approve the V4SwapRouter, then swapExactTokenForETH', async () => {
    const r = await call('quote_sell', { token: TOKEN, seller: BUYER, tokenAmount: '1000' }, { chain: graduated() });
    const ap = decodeFunctionData({ abi: erc20TokenAbi, data: r.body.data.transactions[0].data });
    assert.equal(ap.args[0], BOOK.V4SwapRouter);
    const sw = decodeFunctionData({ abi: v4SwapRouterAbi, data: r.body.data.transactions[1].data });
    assert.equal(sw.functionName, 'swapExactTokenForETH');
    assert.equal(sw.args[1], 1000n * E18);
    assert.equal(sw.args[3].toLowerCase(), BUYER);
  });

  it('selling more than the balance blocks', async () => {
    const c = defaultChain(); c.tokenBalance = 10n * E18;
    const r = await call('quote_sell', { token: TOKEN, seller: BUYER, tokenAmount: '11' }, { chain: c });
    assert.equal(r.body.data.canBroadcast, false);
  });

  it('fair creator on the curve gets the forfeit rule', async () => {
    const r = await call('quote_sell', { token: TOKEN, seller: LAUNCHER, tokenAmount: '10' }, { chain: fairChain() });
    assert.ok(r.body.data.warnings.some((w) => /creator fee is burned/.test(w)));
  });

  it('fair creator after graduation: a sell below 90% of the baseline says STOP', async () => {
    const c = fairChain(); c.curve.graduated = true;
    c.tokenBalance = 100n * E18;
    c.fairPool = [TOKEN, LAUNCHER, 0n, 300, 3000, 60, true, false, 100n * E18];
    const big = await call('quote_sell', { token: TOKEN, seller: LAUNCHER, tokenAmount: '11' }, { chain: c });
    assert.ok(big.body.data.warnings.some((w) => w.startsWith('STOP')));
    const small = await call('quote_sell', { token: TOKEN, seller: LAUNCHER, tokenAmount: '5' }, { chain: c });
    assert.equal(small.body.data.warnings.some((w) => w.startsWith('STOP')), false);
    const other = await call('quote_sell', { token: TOKEN, seller: BUYER, tokenAmount: '50' }, { chain: c });
    assert.equal(other.body.data.warnings.some((w) => /creator/.test(w)), false);
  });

  it('bad amounts', async () => {
    for (const v of ['0', '-5', '1e9', '1.0000000000000000001']) assert.equal((await call('quote_sell', { token: TOKEN, seller: BUYER, tokenAmount: v })).status, 400, v);
  });
});

describe('Fair batch', () => {
  it('deposit: deposit() with value, share estimate, seconds left', async () => {
    const c = fairChain(); c.batchCloseTs = c.timestamp + 40n;
    const r = await call('quote_batch_deposit', { token: TOKEN, depositor: BUYER, ethIn: '1' }, { chain: c });
    const d = r.body.data;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(d.secondsLeft, 40);
    const tx = d.transactions[0];
    assert.equal(tx.to, BATCH);
    assert.equal(tx.value, String(E18));
    assert.equal(decodeFunctionData({ abi: openingBatchAbi, data: tx.data }).functionName, 'deposit');
    // 200M tokens for 2 ETH total, this wallet put in half.
    assert.equal(d.estimateIfNoMoreDeposits.tokens, String(100_000_000n * E18));
  });

  it('deposit after the window or over the wallet cap is blocked; last seconds warn', async () => {
    const closed = fairChain();
    let r = await call('quote_batch_deposit', { token: TOKEN, depositor: BUYER, ethIn: '1' }, { chain: closed });
    assert.equal(r.body.data.canBroadcast, false);
    const capped = fairChain(); capped.batchCloseTs = capped.timestamp + 40n; capped.walletCap = E18; capped.deposits = E18 / 2n;
    r = await call('quote_batch_deposit', { token: TOKEN, depositor: BUYER, ethIn: '1' }, { chain: capped });
    assert.ok(r.body.data.errors.some((e) => /cap/.test(e)));
    const late = fairChain(); late.batchCloseTs = late.timestamp + 5n;
    r = await call('quote_batch_deposit', { token: TOKEN, depositor: BUYER, ethIn: '0.1' }, { chain: late });
    assert.ok(r.body.data.warnings.some((w) => /Only 5 s/.test(w)));
  });

  it('not a Fair token', async () => {
    const r = await call('quote_batch_deposit', { token: TOKEN, depositor: BUYER, ethIn: '1' });
    assert.equal(r.status, 404);
  });

  it('claim before settle: settle() then claim()', async () => {
    const c = fairChain(); c.deposits = E18;
    const r = await call('build_batch_claim', { token: TOKEN, user: BUYER }, { chain: c });
    const fns = r.body.data.transactions.map((t) => decodeFunctionData({ abi: openingBatchAbi, data: t.data }).functionName);
    assert.deepEqual(fns, ['settle', 'claim']);
  });

  it('claim after settle, plus a parked refund', async () => {
    const c = fairChain(); c.deposits = E18; c.batchSettled = true; c.refundOwed = 10n ** 17n;
    const r = await call('build_batch_claim', { token: TOKEN, user: BUYER }, { chain: c });
    const txs = r.body.data.transactions;
    assert.deepEqual(txs.map((t) => t.purpose), ['claim', 'withdrawRefund']);
    const wr = decodeFunctionData({ abi: openingBatchAbi, data: txs[1].data });
    assert.equal(wr.args[0].toLowerCase(), BUYER);
    assert.equal(r.body.data.pending.tokens, String(100n * E18));
  });

  it('nothing to claim / window still open', async () => {
    let r = await call('build_batch_claim', { token: TOKEN, user: BUYER }, { chain: fairChain() });
    assert.equal(r.body.error.code, 'NOTHING_TO_CLAIM');
    const open = fairChain(); open.deposits = E18; open.batchCloseTs = open.timestamp + 10n;
    r = await call('build_batch_claim', { token: TOKEN, user: BUYER }, { chain: open });
    assert.equal(r.body.error.code, 'BATCH_OPEN');
    const done = fairChain(); done.deposits = E18; done.batchSettled = true; done.claimedUser = true;
    r = await call('build_batch_claim', { token: TOKEN, user: BUYER }, { chain: done });
    assert.equal(r.body.error.code, 'NOTHING_TO_CLAIM');
  });
});

describe('build_claim_creator_fees', () => {
  const launches = [
    { tokenAddress: TOKEN, lane: undefined },
    { tokenAddress: '0x8888888888888888888888888888888888888888', lane: 'fair' },
  ];
  it('MHH claim(ETH) per hook with fees, Fair claimCreatorFees per pool', async () => {
    const c = defaultChain();
    c.mhhOwed[BOOK.MultiHookHost.toLowerCase()] = 5n * 10n ** 16n;
    c.mhhOwed['0xabcabcabcabcabcabcabcabcabcabcabcabcabca'] = 10n ** 16n;
    c.fairFees = [0n, 0n, 3n * 10n ** 16n, 0n];
    const r = await call('build_claim_creator_fees', { wallet: LAUNCHER }, {
      chain: c,
      indexer: { launchesByCreator: async () => launches, graduationForToken: async () => ({ poolId: null, hookAddress: '0xabcabcabcabcabcabcabcabcabcabcabcabcabca' }) },
    });
    const txs = r.body.data.transactions;
    assert.equal(txs.length, 3, JSON.stringify(r.body.data.fees));
    for (const t of txs.slice(0, 2)) {
      const d = decodeFunctionData({ abi: multiHookHostAbi, data: t.data });
      assert.equal(d.functionName, 'claim');
      assert.equal(d.args[0], '0x0000000000000000000000000000000000000000');
    }
    const f = decodeFunctionData({ abi: fairHookHostAbi, data: txs[2].data });
    assert.equal(f.functionName, 'claimCreatorFees');
    assert.equal(f.args[0], poolIdOf(ethPoolKey('0x8888888888888888888888888888888888888888', BOOK.FairHookHost)));
  });

  it('forfeited Fair pools are reported, not claimed; nothing claimable is fine', async () => {
    const c = defaultChain(); c.fairForfeited = true;
    const r = await call('build_claim_creator_fees', { wallet: LAUNCHER }, { chain: c, indexer: { launchesByCreator: async () => launches } });
    assert.equal(r.body.data.transactions.length, 0);
    assert.ok(r.body.data.fees.some((f) => f.forfeited));
    assert.equal(r.body.data.canBroadcast, false);
  });

  it('no launches', async () => {
    const r = await call('build_claim_creator_fees', { wallet: LAUNCHER });
    assert.equal(r.body.data.launches, 0);
  });
});
