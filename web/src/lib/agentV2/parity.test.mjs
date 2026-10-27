// Calldata parity: a launch built by quote_launch must be the exact tx the website
// builds for the same inputs. The "website" side below re-encodes each create page's
// writeContract call independently (src/app/create/page.tsx quick mode and
// src/app/create/fair/page.tsx), using the page's own configHashFor().
//
// With AGENT_LIVE=1 it also reads live Robinhood mainnet and eth_calls the API-built
// ETH-fee launches from a funded (state-overridden) wallet: they must not revert.
//
// Run: pnpm --filter web test:agent            (offline)
//      AGENT_LIVE=1 pnpm --filter web test:agent
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createPublicClient, encodeAbiParameters, encodeFunctionData, http, parseEther, zeroAddress } from 'viem';

import { fairLaunchFactoryAbi, routerAbi, erc20TokenAbi } from '../abis.ts';
import { configHashFor } from '../modules.ts';
import { QUICK_CONFIG_HASH, uruAmountForEthFee } from '../launchTx.ts';
import { RateLimiter } from './rateLimit.ts';
import { runTool } from './runner.ts';
import { TtlCache } from './ttlCache.ts';
import { BOOK, E18, LAUNCHER, defaultChain, fakeDeps } from './testFixtures.mjs';

// ---- the website's encoding, transcribed from the create pages ----

function websiteQuickParams({ name, ticker, router, curveSupplyWei }) {
  // create/page.tsx: base ERC20, quick mechanic, no template modules, curve on.
  const templateModuleIds = [];
  const initData = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes[]' }],
    [curveSupplyWei, router, []],
  );
  return {
    base: 0,
    name,
    ticker,
    configHash: configHashFor('ERC20', templateModuleIds),
    initData,
    moduleCount: BigInt(Math.max(1, templateModuleIds.length)),
    installHook: false,
    installGovernance: false,
    installBondingCurve: true,
    ownership: 0,
    ownerTargetIfMultisig: zeroAddress,
    antiSniperBlocks: 5,
    buybackBurnBps: 0,
  };
}

function websiteTokenTx({ params, payToken, quote, initialBuyEthWei, uruAmount, address }) {
  const fn = payToken === 'URU' ? 'launchWithURU' : initialBuyEthWei > 0n ? 'launchAndBuy' : 'launch';
  const args = payToken === 'URU' ? [params, uruAmount] : initialBuyEthWei > 0n ? [params, initialBuyEthWei, 0n, address] : [params];
  return { data: encodeFunctionData({ abi: routerAbi, functionName: fn, args }), value: payToken === 'URU' ? 0n : quote + initialBuyEthWei };
}

function websiteFairTx({ name, ticker, deposit, payIn, fee }) {
  const cleanName = name.trim();
  const cleanTicker = ticker.trim().toUpperCase();
  const depositWei = deposit ? parseEther(deposit) : 0n;
  if (payIn === 'URU') {
    return { data: encodeFunctionData({ abi: fairLaunchFactoryAbi, functionName: 'launchWithURU', args: [cleanName, cleanTicker, fee] }), value: depositWei };
  }
  return { data: encodeFunctionData({ abi: fairLaunchFactoryAbi, functionName: 'launch', args: [cleanName, cleanTicker] }), value: depositWei + fee };
}

async function quote(deps, input) {
  const r = await runTool('quote_launch', input, { ip: 't', deps, limiter: new RateLimiter(), cache: new TtlCache(), source: 'rest' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data;
}

const last = (d) => d.transactions[d.transactions.length - 1];

describe('calldata parity (offline)', () => {
  it('quick configHash matches the create page', () => {
    assert.equal(QUICK_CONFIG_HASH, configHashFor('ERC20', []));
  });

  for (const initialBuy of ['0', '0.05']) {
    it(`token lane ETH, initial buy ${initialBuy}`, async () => {
      const { deps, chain } = fakeDeps();
      const d = await quote(deps, { name: 'Parity Coin', ticker: 'PAR', launcher: LAUNCHER, initialBuyEth: initialBuy });
      const params = websiteQuickParams({ name: 'Parity Coin', ticker: 'PAR', router: BOOK.Router, curveSupplyWei: chain.curveSupply });
      const web = websiteTokenTx({ params, payToken: 'ETH', quote: chain.quoteFor, initialBuyEthWei: parseEther(initialBuy), address: LAUNCHER });
      assert.equal(last(d).data, web.data);
      assert.equal(last(d).value, web.value.toString());
      assert.equal(last(d).to, BOOK.Router);
    });
  }

  it('token lane URU (spot and floor)', async () => {
    for (const floor of [1n, 9000n * E18]) {
      const chain = defaultChain();
      chain.minUruFeeFor = floor;
      const { deps } = fakeDeps({ chain });
      const d = await quote(deps, { name: 'Parity Coin', ticker: 'PAR', launcher: LAUNCHER, payWith: 'URU' });
      const uruAmount = uruAmountForEthFee({ ethFee: chain.quoteFor, sqrtPriceX96: chain.sqrtPriceX96, uruIsCurrency1: true, floor });
      const params = websiteQuickParams({ name: 'Parity Coin', ticker: 'PAR', router: BOOK.Router, curveSupplyWei: chain.curveSupply });
      const web = websiteTokenTx({ params, payToken: 'URU', uruAmount });
      assert.equal(last(d).data, web.data);
      assert.equal(last(d).value, '0');
      // approve(Router, uruAmount) as the create page sends it
      assert.equal(d.transactions[0].data, encodeFunctionData({ abi: erc20TokenAbi, functionName: 'approve', args: [BOOK.Router, uruAmount] }));
    }
  });

  for (const [payIn, deposit] of [['ETH', ''], ['ETH', '0.3'], ['URU', '0.3'], ['URU', '']]) {
    it(`fair lane ${payIn}, deposit "${deposit}"`, async () => {
      const { deps, chain } = fakeDeps();
      const d = await quote(deps, { lane: 'fair', name: '  Fair Parity ', ticker: 'fpar', launcher: LAUNCHER, payWith: payIn, depositEth: deposit || '0' });
      const fee = payIn === 'URU' ? chain.fairMinUru : chain.fairEthFee;
      const web = websiteFairTx({ name: '  Fair Parity ', ticker: 'fpar', deposit, payIn, fee });
      assert.equal(last(d).data, web.data);
      assert.equal(last(d).value, web.value.toString());
      if (payIn === 'URU') {
        assert.equal(d.transactions[0].data, encodeFunctionData({ abi: erc20TokenAbi, functionName: 'approve', args: [BOOK.FairLaunchFactory, fee] }));
      }
    });
  }
});

const LIVE = process.env.AGENT_LIVE === '1';
const RPC = 'https://rpc.mainnet.chain.robinhood.com';

describe('calldata parity against Robinhood mainnet', { skip: !LIVE && 'set AGENT_LIVE=1 to run against mainnet' }, () => {
  const client = createPublicClient({ transport: http(RPC) });
  // Fresh random wallet, funded only inside eth_call via a state override.
  const launcher = `0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const stateOverride = [{ address: launcher, balance: 100n * E18 }];
  const liveDeps = () => {
    const { deps } = fakeDeps();
    return { ...deps, client };
  };
  const name = `Parity ${Date.now().toString(36)}`;

  it('token lane: API tx equals website tx and eth_call succeeds', async () => {
    const deps = liveDeps();
    const d = await quote(deps, { name, ticker: 'PRTY', launcher, initialBuyEth: '0.001' });
    const curveSupplyWei = BigInt(d.params.curveSupply);
    const fee = BigInt(d.fee.amount);
    const web = websiteTokenTx({ params: websiteQuickParams({ name, ticker: 'PRTY', router: BOOK.Router, curveSupplyWei }), payToken: 'ETH', quote: fee, initialBuyEthWei: parseEther('0.001'), address: launcher });
    assert.equal(last(d).data, web.data);
    assert.equal(last(d).value, web.value.toString());
    const paused = await client.readContract({ address: BOOK.Router, abi: routerAbi, functionName: 'paused' });
    if (paused) return assert.ok(d.errors.some((e) => /paused/.test(e)));
    await client.call({ account: launcher, to: last(d).to, data: last(d).data, value: BigInt(last(d).value), stateOverride });
  });

  it('fair lane: API tx equals website tx and eth_call succeeds', async () => {
    const deps = liveDeps();
    const d = await quote(deps, { lane: 'fair', name, ticker: 'prty', launcher, depositEth: '0.01' });
    const web = websiteFairTx({ name, ticker: 'prty', deposit: '0.01', payIn: 'ETH', fee: BigInt(d.fee.amount) });
    assert.equal(last(d).data, web.data);
    assert.equal(last(d).value, web.value.toString());
    const open = await client.readContract({ address: BOOK.FairLaunchFactory, abi: fairLaunchFactoryAbi, functionName: 'launchesOpen' });
    if (!open) return assert.ok(d.errors.some((e) => /closed/.test(e)));
    await client.call({ account: launcher, to: last(d).to, data: last(d).data, value: BigInt(last(d).value), stateOverride });
  });

  it('URU fee quotes resolve on mainnet (calldata only; approve needs real URU)', async () => {
    const deps = liveDeps();
    const t = await quote(deps, { name, ticker: 'PRTY', launcher, payWith: 'URU' });
    assert.ok(BigInt(t.fee.amount) > 0n);
    assert.equal(t.transactions[0].purpose, 'approve');
    const f = await quote(deps, { lane: 'fair', name, ticker: 'PRTY', launcher, payWith: 'URU' }).catch((e) => e);
    if (!(f instanceof Error)) assert.ok(BigInt(f.fee.amount) > 0n);
  });
});
