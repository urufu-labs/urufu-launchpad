/// Replays the trade page's TAXED DN404 post-graduation swaps on an anvil fork
/// of Robinhood, using the exact calldata builders the page uses
/// (web/src/lib/v4Erc20Swap.ts). Proves:
///   - ETH pool (BurnDead tax): settle-first SELL succeeds and is taxed;
///     normal-order UR BUY with native ETH succeeds; the old V4SwapRouter
///     sell AND buy revert for a taxed token.
///   - URU pool (BuybackURU tax): settle-first SELL succeeds and is taxed;
///     normal-order UR SELL reverts; normal-order UR BUY succeeds.
///
/// Prereqs (see the report for exact commands):
///   anvil --fork-url $ROBINHOOD_RPC_URL --auto-impersonate --port 8549
///   forge script contracts/script/DeployDn404TaxTemplateV2.s.sol \
///     --rpc-url http://127.0.0.1:8549 --unlocked --sender <deployer> --broadcast
/// Run from web/:
///   ANVIL_RPC=http://127.0.0.1:8549 node --experimental-strip-types \
///     --disable-warning=ExperimentalWarning scripts/taxed-sell-fork-check.mjs
///
/// Fork only. Uses anvil impersonation; never point it at a real RPC.

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  parseAbi,
  parseEther,
} from 'viem';
import {
  buildErc20PoolKey,
  encodeV4ExactInSingle,
  encodeV4ExactInSingleSettleFirst,
} from '../src/lib/v4Erc20Swap.ts';
import { taxOn } from '../src/lib/dn404Tax.ts';

const RPC = process.env.ANVIL_RPC;
if (!RPC || !/127\.0\.0\.1|localhost/.test(RPC)) throw new Error('ANVIL_RPC must point at a local anvil fork');

const DEPLOYER = '0x6d606cc634F20f5534fba072757F2c2C7B835Bb9';
const LF = '0x3026C71eB13C599BAd0e7a687689D20F8c37A64B';
const DN404_CF = '0xFa8C3E10F81355059343f684f7268F1E7a8Df24a';
const URU = '0x9fbe210007dDd8389f98d0253018e65CC48b9D24';
const ETH = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const HOST_ETH = '0x83d6fa59BEF503112887b16277CF559fDC93E0C4';
const HOST_DN404 = '0x6d8701058E4eecA3bF80D14bD6C13A89575460C4';
const UR = '0x8876789976dEcBfCbBbe364623C63652db8C0904';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const V4_SWAP_ROUTER = '0xDb3D1C43225faEe04551b663E5aA0969937beEa4';
const WHALE = '0x00000000000000000000000000000000000ba1e1';
const TRADER = '0x0000000000000000000000000000000000007ade';

const erc20 = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const tax = parseAbi([
  'function taxMode() view returns (uint8)',
  'function taxBps() view returns (uint16)',
  'function accumulatedTax() view returns (uint256)',
  'function setSkipNFT(bool) returns (bool)',
  'function GRADUATOR_ETH() view returns (address)',
]);
const lfAbi = parseAbi([
  'function minUruFeeFor(address) view returns (uint256)',
  'function baseTaxImpl() view returns (address)',
  'struct LaunchParams { string name; string ticker; string baseURI; string contractURI; uint256 collectionSize; uint256 unit; uint16 founderPremintBps; uint32 antiSniperBlocks; uint16 buybackBurnBps; address pairCurrency; uint8 taxMode; uint16 taxBps; address taxTarget; uint256 uruAmount; }',
  'function launch(LaunchParams p) returns (address base, address mirror, address curve)',
  'event Dn404Launched(address indexed base, address indexed mirror, address indexed curve, address launcher, address pairCurrency, uint8 taxMode, uint16 taxBps, bytes32 configHash, uint256 uruPaid, uint256 totalSupply, uint256 unit, uint256 founderPremint, string name, string ticker)',
]);
const cfAbi = parseAbi([
  'function defaultCurveSupply() view returns (uint256)',
  'function defaultVirtualTokenReserve() view returns (uint256)',
  'function defaultTradeFeeBps() view returns (uint16)',
  'function setDefaults(uint256,uint256,uint256,uint256,uint16)',
]);
const v10Curve = parseAbi([
  'function buy(uint256) payable returns (uint256)',
  'function graduated() view returns (bool)',
  'function graduationTargetEth() view returns (uint256)',
]);
const pairCurve = parseAbi([
  'function buy(uint256,uint256) returns (uint256)',
  'function graduated() view returns (bool)',
  'function graduationTargetEth() view returns (uint256)',
]);
const permit2Abi = parseAbi(['function approve(address,address,uint160,uint48)']);
const urAbi = parseAbi(['function execute(bytes,bytes[],uint256) payable']);
const v4RouterAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'function swapExactTokenForETH(PoolKey key, uint256 amountIn, uint256 minOut, address recipient, uint256 deadline) returns (uint256)',
  'function swapExactETHForToken(PoolKey key, uint256 minOut, address recipient, uint256 deadline) payable returns (uint256)',
]);

const pub = createPublicClient({ transport: http(RPC) });
const wal = createWalletClient({ transport: http(RPC) });
const results = [];

async function send(from, to, abi, functionName, args, value) {
  const hash = await wal.writeContract({ account: from, chain: null, address: to, abi, functionName, args, value, gas: 30_000_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted (tx ${hash})`);
  return r;
}
async function sendRaw(from, to, data, value) {
  const hash = await wal.sendTransaction({ account: from, chain: null, to, data, value, gas: 30_000_000n });
  return pub.waitForTransactionReceipt({ hash });
}
async function expectRevert(label, fn) {
  try {
    await fn();
    results.push({ check: label, ok: false, note: 'expected revert, but it succeeded' });
  } catch (e) {
    const msg = (e.shortMessage || e.message || '').split('\n')[0];
    results.push({ check: label, ok: true, note: `reverted as expected: ${msg.slice(0, 110)}` });
  }
}
const bal = (token, who) => pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [who] });
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 3600);

async function setEth(who, wei) {
  await pub.request({ method: 'anvil_setBalance', params: [who, `0x${wei.toString(16)}`] });
}

async function launch(name, pairCurrency, taxMode) {
  const fee = await pub.readContract({ address: LF, abi: lfAbi, functionName: 'minUruFeeFor', args: [DEPLOYER] });
  await send(DEPLOYER, URU, erc20, 'approve', [LF, fee]);
  const p = {
    name, ticker: 'TXS', baseURI: 'ipfs://txs/', contractURI: 'ipfs://txs/collection.json',
    collectionSize: 8000n, unit: 100_000n, founderPremintBps: 0, antiSniperBlocks: 0, buybackBurnBps: 0,
    pairCurrency, taxMode, taxBps: 100, taxTarget: ETH, uruAmount: fee,
  };
  const r = await send(DEPLOYER, LF, lfAbi, 'launch', [p]);
  for (const log of r.logs) {
    try {
      const ev = decodeEventLog({ abi: lfAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'Dn404Launched') return { base: ev.args.base, curve: ev.args.curve };
    } catch {}
  }
  throw new Error('Dn404Launched not found');
}

async function approveUr(who, token) {
  await send(who, token, erc20, 'approve', [PERMIT2, 2n ** 256n - 1n]);
  await send(who, PERMIT2, permit2Abi, 'approve', [token, UR, 2n ** 160n - 1n, 4_000_000_000]);
}

async function urExecute(who, call, value) {
  const data = encodeFunctionData({ abi: urAbi, functionName: 'execute', args: [call.commands, call.inputs, deadline()] });
  return sendRaw(who, UR, data, value);
}

// --------------------------------------------------------------- ETH pool
async function ethCase() {
  const { base, curve } = await launch(`Taxed ETH Sell ${Date.now()}`, ETH, 1 /* BurnDead */);
  const target = await pub.readContract({ address: curve, abi: v10Curve, functionName: 'graduationTargetEth' });
  await setEth(WHALE, target * 3n);
  await setEth(TRADER, parseEther('5'));
  await send(WHALE, base, tax, 'setSkipNFT', [true]);
  await send(WHALE, curve, v10Curve, 'buy', [0n], (target * 125n) / 100n);
  const grad = await pub.readContract({ address: curve, abi: v10Curve, functionName: 'graduated' });
  results.push({ check: 'ETH: taxed curve graduates (V2 template)', ok: grad, note: `base ${base}` });

  // Whale -> trader transfer (taxed, both non-exempt) gives the trader inventory.
  await send(WHALE, base, erc20, 'transfer', [TRADER, 1_000_000n * 10n ** 18n]);
  const key = buildErc20PoolKey(base, ETH, HOST_ETH);

  // Old V4SwapRouter paths must revert for a taxed token.
  await send(TRADER, base, erc20, 'approve', [V4_SWAP_ROUTER, 2n ** 256n - 1n]);
  await expectRevert('ETH: old V4SwapRouter SELL of taxed token reverts', () =>
    pub.simulateContract({ account: TRADER, address: V4_SWAP_ROUTER, abi: v4RouterAbi, functionName: 'swapExactTokenForETH', args: [key, 100_000n * 10n ** 18n, 1n, TRADER, deadline()] }));
  await expectRevert('ETH: old V4SwapRouter BUY of taxed token reverts', () =>
    pub.simulateContract({ account: TRADER, address: V4_SWAP_ROUTER, abi: v4RouterAbi, functionName: 'swapExactETHForToken', args: [key, 1n, TRADER, deadline()], value: parseEther('0.01') }));

  // Settle-first SELL via the web helper.
  await approveUr(TRADER, base);
  const sellAmt = 100_000n * 10n ** 18n;
  const deadBefore = await bal(base, DEAD);
  const ethBefore = await pub.getBalance({ address: TRADER });
  const sellCall = encodeV4ExactInSingleSettleFirst({ chainId: 4663, key, zeroForOne: false, amountIn: sellAmt, amountOutMinimum: 1n });
  const sr = await urExecute(TRADER, sellCall, 0n);
  const ethAfter = await pub.getBalance({ address: TRADER });
  const deadDelta = (await bal(base, DEAD)) - deadBefore;
  results.push({
    check: 'ETH: settle-first UR SELL (web helper calldata)',
    ok: sr.status === 'success' && ethAfter + sr.gasUsed * sr.effectiveGasPrice > ethBefore && deadDelta >= taxOn(sellAmt, 100),
    note: `status ${sr.status}, gas ${sr.gasUsed}, tx ${sr.transactionHash}, burned tax ${deadDelta} (expected >= ${taxOn(sellAmt, 100)})`,
  });

  // Normal-order UR BUY with native ETH (what the panel sends for buys).
  const tokBefore = await bal(base, TRADER);
  const buyCall = encodeV4ExactInSingle({ chainId: 4663, key, zeroForOne: true, amountIn: parseEther('0.01'), amountOutMinimum: 1n });
  const br = await urExecute(TRADER, buyCall, parseEther('0.01'));
  const got = (await bal(base, TRADER)) - tokBefore;
  results.push({ check: 'ETH: normal-order UR BUY with native ETH', ok: br.status === 'success' && got > 0n, note: `status ${br.status}, gas ${br.gasUsed}, tokens net ${got}, tx ${br.transactionHash}` });
}

// --------------------------------------------------------------- URU pool
async function uruCase() {
  const supply = await pub.readContract({ address: DN404_CF, abi: cfAbi, functionName: 'defaultCurveSupply' });
  const virtTok = await pub.readContract({ address: DN404_CF, abi: cfAbi, functionName: 'defaultVirtualTokenReserve' });
  const feeBps = await pub.readContract({ address: DN404_CF, abi: cfAbi, functionName: 'defaultTradeFeeBps' });
  await send(DEPLOYER, DN404_CF, cfAbi, 'setDefaults', [supply, virtTok, 5_000n * 10n ** 18n, 4_000n * 10n ** 18n, feeBps]);
  const { base, curve } = await launch(`Taxed URU Sell ${Date.now()}`, URU, 2 /* BuybackURU */);
  const amt = ((await pub.readContract({ address: curve, abi: pairCurve, functionName: 'graduationTargetEth' })) * 125n) / 100n;
  await setEth(WHALE, parseEther('1'));
  await setEth(TRADER, parseEther('1'));
  await send(DEPLOYER, URU, erc20, 'transfer', [WHALE, amt]);
  await send(DEPLOYER, URU, erc20, 'transfer', [TRADER, 500n * 10n ** 18n]);
  await send(WHALE, base, tax, 'setSkipNFT', [true]);
  await send(WHALE, URU, erc20, 'approve', [curve, amt]);
  await send(WHALE, curve, pairCurve, 'buy', [amt, 0n]);
  const grad = await pub.readContract({ address: curve, abi: pairCurve, functionName: 'graduated' });
  results.push({ check: 'URU: taxed curve graduates (V2 template)', ok: grad, note: `base ${base}` });

  await send(WHALE, base, erc20, 'transfer', [TRADER, 1_000_000n * 10n ** 18n]);
  const key = buildErc20PoolKey(base, URU, HOST_DN404);
  const tokenIsC0 = key.currency0.toLowerCase() === base.toLowerCase();
  await approveUr(TRADER, base);
  await approveUr(TRADER, URU);
  const sellAmt = 100_000n * 10n ** 18n;

  await expectRevert('URU: normal-order UR SELL of taxed token reverts', async () => {
    const call = encodeV4ExactInSingle({ chainId: 4663, key, zeroForOne: tokenIsC0, amountIn: sellAmt, amountOutMinimum: 1n });
    await pub.call({ account: TRADER, to: UR, data: encodeFunctionData({ abi: urAbi, functionName: 'execute', args: [call.commands, call.inputs, deadline()] }) });
  });

  const accBefore = await pub.readContract({ address: base, abi: tax, functionName: 'accumulatedTax' });
  const uruBefore = await bal(URU, TRADER);
  const sellCall = encodeV4ExactInSingleSettleFirst({ chainId: 4663, key, zeroForOne: tokenIsC0, amountIn: sellAmt, amountOutMinimum: 1n });
  const sr = await urExecute(TRADER, sellCall, 0n);
  const accDelta = (await pub.readContract({ address: base, abi: tax, functionName: 'accumulatedTax' })) - accBefore;
  const uruGot = (await bal(URU, TRADER)) - uruBefore;
  results.push({
    check: 'URU: settle-first UR SELL (web helper calldata)',
    ok: sr.status === 'success' && uruGot > 0n && accDelta >= taxOn(sellAmt, 100),
    note: `status ${sr.status}, gas ${sr.gasUsed}, URU out ${uruGot}, accumulatedTax +${accDelta} (expected >= ${taxOn(sellAmt, 100)}), tx ${sr.transactionHash}`,
  });

  const tokBefore = await bal(base, TRADER);
  const buyCall = encodeV4ExactInSingle({ chainId: 4663, key, zeroForOne: !tokenIsC0, amountIn: 50n * 10n ** 18n, amountOutMinimum: 1n });
  const br = await urExecute(TRADER, buyCall, 0n);
  const got = (await bal(base, TRADER)) - tokBefore;
  results.push({ check: 'URU: normal-order UR BUY with URU', ok: br.status === 'success' && got > 0n, note: `status ${br.status}, gas ${br.gasUsed}, tokens net ${got}, tx ${br.transactionHash}` });
}

// Fork-only: give the impersonated deployer gas money (30M gas limit per tx).
await setEth(DEPLOYER, parseEther('100'));
const impl = await pub.readContract({ address: LF, abi: lfAbi, functionName: 'baseTaxImpl' });
console.log('LF.baseTaxImpl on fork:', impl);
await ethCase();
await uruCase();
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}\n      ${r.note}`);
if (results.some((r) => !r.ok)) process.exit(1);
