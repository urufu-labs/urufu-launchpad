// Trade calldata parity + live mainnet checks for the phase 1b tools.
//
// Offline: the tx each tool builds must equal what the website sends for the same
// call (trade page curve buy/sell, V4SwapRouter swaps, FairLaunchPanels batch and
// fee claims, CreatorEarnings MHH claim). The website side is re-encoded here from
// those components' writeContract calls. Known, intended differences: the agent
// API approves the exact sell amount (the site approves max uint) and sets a real
// minOut on v4 swaps (the site sends 1).
//
// With AGENT_LIVE=1: real quotes on Robinhood mainnet for a token-lane curve, a
// token-lane v4 pool (current and legacy V10 hook), a Fair curve and a Fair v4
// pool, and the built buy txs must pass eth_call from a state-override-funded
// wallet, which proves minOut (quote minus slippage) is reachable on chain.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createPublicClient, encodeFunctionData, http, parseEther } from 'viem';

import { bondingCurveAbi, fairHookHostAbi, multiHookHostAbi, openingBatchAbi, v4SwapRouterAbi } from '../abis.ts';
import { RateLimiter } from './rateLimit.ts';
import { runTool } from './runner.ts';
import { applySlippage, ethPoolKey, poolIdOf } from './tradeTools.ts';
import { TtlCache } from './ttlCache.ts';
import { BATCH, BOOK, CURVE, E18, LAUNCHER, TOKEN, defaultChain, fakeDeps } from './testFixtures.mjs';

const W = '0x7777777777777777777777777777777777777777';
const ctx = (deps) => ({ ip: 'p', deps, limiter: new RateLimiter(), cache: new TtlCache(), source: 'rest' });
const last = (d) => d.transactions[d.transactions.length - 1];

describe('trade calldata parity (offline)', () => {
  it('curve buy == trade page buy(slippage) with value', async () => {
    const { deps, chain } = fakeDeps();
    const r = await runTool('quote_buy', { token: TOKEN, buyer: W, ethIn: '0.25', maxSlippageBps: 200 }, ctx(deps));
    // useTradeTerminal: slippage = quoteOut - quoteOut * pct*100 / 10000
    const quoteOut = chain.quoteBuyOut[0];
    const site = encodeFunctionData({ abi: bondingCurveAbi, functionName: 'buy', args: [quoteOut - (quoteOut * 200n) / 10_000n] });
    assert.equal(last(r.body.data).data, site);
    assert.equal(last(r.body.data).value, String(parseEther('0.25')));
  });

  it('curve sell == trade page sell(inputWei, slippage)', async () => {
    const c = defaultChain(); c.tokenAllowance = 10n ** 30n;
    const { deps } = fakeDeps({ chain: c });
    const r = await runTool('quote_sell', { token: TOKEN, seller: W, tokenAmount: '1234.5', maxSlippageBps: 200 }, ctx(deps));
    const q = c.quoteSellOut[0];
    const site = encodeFunctionData({ abi: bondingCurveAbi, functionName: 'sell', args: [12345n * 10n ** 17n, q - (q * 200n) / 10_000n] });
    assert.equal(last(r.body.data).data, site);
  });

  it('v4 swaps use the trade page pool key and V4SwapRouter signatures (with a real minOut)', async () => {
    const c = defaultChain(); c.curve.graduated = true; c.tokenAllowance = 10n ** 30n;
    const { deps } = fakeDeps({ chain: c });
    const key = { currency0: '0x0000000000000000000000000000000000000000', currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: BOOK.MultiHookHost };
    const dl = 1_800_000_000n + 300n;
    const buy = await runTool('quote_buy', { token: TOKEN, buyer: W, ethIn: '0.1' }, ctx(deps));
    assert.equal(last(buy.body.data).data, encodeFunctionData({ abi: v4SwapRouterAbi, functionName: 'swapExactETHForToken', args: [key, applySlippage(c.quoterOut, 200), W, dl] }));
    const sell = await runTool('quote_sell', { token: TOKEN, seller: W, tokenAmount: '10' }, ctx(deps));
    assert.equal(last(sell.body.data).data, encodeFunctionData({ abi: v4SwapRouterAbi, functionName: 'swapExactTokenForETH', args: [key, 10n * E18, applySlippage(c.quoterOut, 200), W, dl] }));
  });

  it('Fair batch deposit / claim / refund == FairLaunchPanels', async () => {
    const c = defaultChain(); c.fairCurveFor = CURVE; c.batchFor = BATCH; c.batchCloseTs = c.timestamp + 30n;
    const { deps } = fakeDeps({ chain: c });
    const dep = await runTool('quote_batch_deposit', { token: TOKEN, depositor: W, ethIn: '0.3' }, ctx(deps));
    assert.equal(last(dep.body.data).data, encodeFunctionData({ abi: openingBatchAbi, functionName: 'deposit' }));
    assert.equal(last(dep.body.data).value, String(parseEther('0.3')));
    c.batchCloseTs = 0n; c.batchSettled = true; c.deposits = E18; c.refundOwed = 1n;
    const cl = await runTool('build_batch_claim', { token: TOKEN, user: W }, ctx(deps));
    assert.deepEqual(cl.body.data.transactions.map((t) => t.data), [
      encodeFunctionData({ abi: openingBatchAbi, functionName: 'claim' }),
      encodeFunctionData({ abi: openingBatchAbi, functionName: 'withdrawRefund', args: [W] }),
    ]);
  });

  it('creator fee claims == CreatorEarnings (MHH claim(ETH)) and FairLaunchPanels (claimCreatorFees(poolId))', async () => {
    const c = defaultChain();
    c.mhhOwed[BOOK.MultiHookHost.toLowerCase()] = 1n;
    c.fairFees = [0n, 0n, 1n, 0n];
    const FAIR = '0x8888888888888888888888888888888888888888';
    const { deps } = fakeDeps({ chain: c, indexer: { launchesByCreator: async () => [{ tokenAddress: TOKEN }, { tokenAddress: FAIR, lane: 'fair' }] } });
    const r = await runTool('build_claim_creator_fees', { wallet: LAUNCHER }, ctx(deps));
    const datas = r.body.data.transactions.map((t) => t.data);
    assert.ok(datas.includes(encodeFunctionData({ abi: multiHookHostAbi, functionName: 'claim', args: ['0x0000000000000000000000000000000000000000'] })));
    // FairLaunchPanels.fairPoolId(token, hook): ETH/token 3000/60 at the hook.
    assert.ok(datas.includes(encodeFunctionData({ abi: fairHookHostAbi, functionName: 'claimCreatorFees', args: [poolIdOf(ethPoolKey(FAIR, BOOK.FairHookHost))] })));
  });
});

const LIVE = process.env.AGENT_LIVE === '1';

describe('trade tools against Robinhood mainnet', { skip: !LIVE && 'set AGENT_LIVE=1 to run against mainnet' }, () => {
  const client = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });
  const wallet = `0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const stateOverride = [{ address: wallet, balance: 10n * E18 }];
  const liveDeps = () => {
    const { deps } = fakeDeps();
    // Real chain and clock; the indexer stays faked (hooks come from chain + legacy list).
    return { ...deps, client, now: () => Date.now() };
  };

  const cases = [
    ['token-lane curve', '0x286ee43fdeb6f2a8ee06823a7f3b0d11aebf4223', 'bonding curve'],
    ['token-lane v4 pool (V11 hook)', '0x2c0a57ef2698a881cda6f5106fa6748fa4713a81', 'Uniswap v4 pool'],
    ['legacy V10 pool (LUV)', '0x985ec2c71ffebf4822b6c877bb87229923813c63', 'Uniswap v4 pool'],
    ['Fair curve', '0x35c4bb5cf971bd9029d11788f5cd58e6eb1cc91e', 'bonding curve'],
    ['Fair v4 pool', '0x8b470575309a3c2dada29ce34e050a0b0a276c9f', 'Uniswap v4 pool'],
  ];
  for (const [label, token, venue] of cases) {
    it(`${label}: quote_buy passes eth_call at minOut`, async () => {
      const r = await runTool('quote_buy', { token, buyer: wallet, ethIn: '0.001' }, ctx(liveDeps()));
      if (r.status !== 200) return assert.fail(`${label}: ${JSON.stringify(r.body.error)}`);
      const d = r.body.data;
      assert.equal(d.venue, venue);
      assert.ok(BigInt(d.expectedTokens) > 0n);
      const tx = last(d);
      await client.call({ account: wallet, to: tx.to, data: tx.data, value: BigInt(tx.value), stateOverride });
      // Sell side quotes too (the sell tx itself needs real tokens + an approve).
      const s = await runTool('quote_sell', { token, seller: wallet, tokenAmount: '1000' }, ctx(liveDeps()));
      assert.equal(s.status, 200, JSON.stringify(s.body));
      assert.ok(BigInt(s.body.data.expectedEth) > 0n);
      assert.equal(s.body.data.transactions[0].purpose, 'approve');
    });
  }

  it('ERC-8004 registry: register() simulates from a fresh wallet and predicts an id', async () => {
    const owner = wallet;
    const r = await runTool('register_agent', { step: 'register', owner, agentWallet: '0x7777777777777777777777777777777777777777' }, ctx(liveDeps()));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(String(r.body.data.predictedAgentId), /^\d+$/);
  });
});
