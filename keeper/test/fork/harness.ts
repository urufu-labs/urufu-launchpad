/**
 * Anvil fork harness for the keeper. Forks Robinhood mainnet, installs
 * Dn404TaxTemplateV2 + the dedicated keeper wallet on the LIVE launch
 * factory (as the real deployer, auto-impersonated), and exposes helpers to
 * launch taxed DN404s, graduate them and create taxable activity using the
 * real contracts. Nothing here touches mainnet: every tx goes to anvil.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, parseEventLogs,
  type Address, type Hex, type PublicClient as ViemPublic,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { RH } from '../../src/constants.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..', '..');

export function repoEnv(key: string): string {
  const env = readFileSync(join(REPO, '.env'), 'utf8');
  const m = env.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!m) throw new Error(`${key} missing from repo .env`);
  return m[1]!.replace(/["\r]/g, '').trim();
}

export const DEPLOYER: Address = '0x6d606cc634F20f5534fba072757F2c2C7B835Bb9';
export const DN404_CURVE_FACTORY: Address = '0xFa8C3E10F81355059343f684f7268F1E7a8Df24a';
export const PORT = 8548;
export const RPC = `http://127.0.0.1:${PORT}`;

export const chain = defineChain({
  id: 4663, name: 'rh-fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

export const abis = {
  lf: parseAbi([
    'struct LaunchParams { string name; string ticker; string baseURI; string contractURI; uint256 collectionSize; uint256 unit; uint16 founderPremintBps; uint32 antiSniperBlocks; uint16 buybackBurnBps; address pairCurrency; uint8 taxMode; uint16 taxBps; address taxTarget; uint256 uruAmount; }',
    'function launch(LaunchParams p) returns (address base, address mirror, address curve)',
    'function minUruFeeFor(address) view returns (uint256)',
    'function setBaseTaxImpl(address impl, bytes32 expectedCodeHash)',
    'function setTaxWiring(address taxKeeper_, address taxKeeperTreasury_, address taxAllowlist_)',
    'function taxAllowlist() view returns (address)',
    'event Dn404Launched(address indexed base, address indexed mirror, address indexed curve, address launcher, address pairCurrency, uint8 taxMode, uint16 taxBps, bytes32 configHash, uint256 uruPaid, uint256 totalSupply, uint256 unit, uint256 founderPremint, string name, string ticker)',
  ]),
  cf: parseAbi([
    'function setDefaults(uint256 curveSupply_, uint256 virtualTokenReserve_, uint256 virtualPairReserve_, uint256 graduationTargetPair_, uint16 tradeFeeBps_)',
    'function defaultCurveSupply() view returns (uint256)',
    'function defaultVirtualTokenReserve() view returns (uint256)',
    'function defaultTradeFeeBps() view returns (uint16)',
  ]),
  ethCurve: parseAbi([
    'function buy(uint256 minTokensOut) payable returns (uint256)',
    'function graduated() view returns (bool)',
    'function graduationTargetEth() view returns (uint256)',
    'function ethReserve() view returns (uint256)',
    'function tradeFeeBps() view returns (uint16)',
  ]),
  pairCurve: parseAbi([
    'function buy(uint256 pairAmountIn, uint256 minTokensOut) returns (uint256)',
    'function graduated() view returns (bool)',
    'function graduationTargetEth() view returns (uint256)',
    'function ethReserve() view returns (uint256)',
    'function tradeFeeBps() view returns (uint16)',
  ]),
  token: parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function setSkipNFT(bool skipNFT) returns (bool)',
    'function accumulatedTax() view returns (uint256)',
    'function taxMode() view returns (uint8)',
    'function keeper() view returns (address)',
    'function totalSupply() view returns (uint256)',
    'event KeeperSwept(address indexed recipient, uint256 net, uint256 keeperFee, uint8 mode)',
  ]),
  mirror: parseAbi([
    'function ownerOf(uint256 id) view returns (address)',
    'function balanceOf(address) view returns (uint256)',
    'function totalSupply() view returns (uint256)',
    'function setApprovalForAll(address operator, bool approved)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed id)',
  ]),
  seaport: parseAbi(['function getCounter(address offerer) view returns (uint256)']),
};

export interface Fork {
  proc: ChildProcess;
  pc: ViemPublic;
  forkBlock: bigint;
  stop(): void;
}

export async function startFork(): Promise<Fork> {
  const anvil = process.platform === 'win32' ? 'C:\\Users\\brand\\.foundry\\bin\\anvil.exe' : 'anvil';
  const proc = spawn(anvil, ['--fork-url', repoEnv('ROBINHOOD_RPC_URL'), '--port', String(PORT), '--auto-impersonate', '--silent', '--chain-id', '4663',
    // RH reports a ~1.1e15 block gas limit; viem's fallbacks would then price a
    // tx beyond any balance. 32M also mirrors RH's real per-tx cap (ArbGasInfo).
    '--gas-limit', '32000000'], { stdio: 'ignore' });
  const pc = createPublicClient({ chain, transport: http(RPC) }) as ViemPublic;
  for (let i = 0; i < 120; i++) {
    try {
      const forkBlock = await pc.getBlockNumber();
      return { proc, pc, forkBlock, stop: () => proc.kill() };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  proc.kill();
  throw new Error('anvil did not start');
}

export async function setBalance(pc: ViemPublic, who: Address, wei: bigint) {
  await pc.request({ method: 'anvil_setBalance' as never, params: [who, `0x${wei.toString(16)}`] as never });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function walletFor(account: PrivateKeyAccount | Address): any {
  return createWalletClient({ chain, transport: http(RPC), account });
}

export async function tx(pc: ViemPublic, w: any, req: any) {
  const hash = await w.writeContract(req);
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`fork tx reverted: ${String(req.functionName)}`);
  return r;
}

export function newActor(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

/// Install V2 on the live factory and point new launches at the keeper.
export async function installV2(pc: ViemPublic, keeper: Address): Promise<Address> {
  await setBalance(pc, DEPLOYER, 100n * 10n ** 18n); // fork-only gas money
  const dep = walletFor(DEPLOYER);
  const art = JSON.parse(readFileSync(join(REPO, 'contracts', 'out', 'Dn404TaxTemplateV2.sol', 'Dn404TaxTemplateV2.json'), 'utf8'));
  const hash = await dep.deployContract({
    abi: art.abi,
    bytecode: art.bytecode.object as Hex,
    args: [RH.graduatorEth, RH.graduatorPair, RH.hookEth, RH.hookPair],
  });
  const r = await pc.waitForTransactionReceipt({ hash });
  const v2 = r.contractAddress!;
  const code = await pc.getCode({ address: v2 });
  await tx(pc, dep, { address: RH.launchFactory, abi: abis.lf, functionName: 'setBaseTaxImpl', args: [v2, keccak256(code!)] });
  const allowlist = await pc.readContract({ address: RH.launchFactory, abi: abis.lf, functionName: 'taxAllowlist' });
  await tx(pc, dep, { address: RH.launchFactory, abi: abis.lf, functionName: 'setTaxWiring', args: [keeper, DEPLOYER, allowlist] });
  // Rehearsal-scale URU curve so the deployer's URU can graduate URU pairs.
  const supply = await pc.readContract({ address: DN404_CURVE_FACTORY, abi: abis.cf, functionName: 'defaultCurveSupply' });
  const virtTok = await pc.readContract({ address: DN404_CURVE_FACTORY, abi: abis.cf, functionName: 'defaultVirtualTokenReserve' });
  const fee = await pc.readContract({ address: DN404_CURVE_FACTORY, abi: abis.cf, functionName: 'defaultTradeFeeBps' });
  await tx(pc, dep, { address: DN404_CURVE_FACTORY, abi: abis.cf, functionName: 'setDefaults', args: [supply, virtTok, 5_000n * 10n ** 18n, 4_000n * 10n ** 18n, fee] });
  return v2;
}

export interface Launched {
  base: Address;
  mirror: Address;
  curve: Address;
  pair: Address;
  unitWei: bigint;
}

let launchSeq = 0;
export async function launch(pc: ViemPublic, pair: Address, taxMode: number, taxBps: number, taxTarget: Address = '0x0000000000000000000000000000000000000000'): Promise<Launched> {
  const dep = walletFor(DEPLOYER);
  const fee = await pc.readContract({ address: RH.launchFactory, abi: abis.lf, functionName: 'minUruFeeFor', args: [DEPLOYER] });
  await tx(pc, dep, { address: RH.uru, abi: abis.token, functionName: 'approve', args: [RH.launchFactory, fee] });
  launchSeq += 1;
  const r = await tx(pc, dep, {
    address: RH.launchFactory,
    abi: abis.lf,
    functionName: 'launch',
    args: [{
      name: `Keeper Fork ${launchSeq} ${Date.now()}`, ticker: `KF${launchSeq}`, baseURI: 'ipfs://kf/', contractURI: 'ipfs://kf/collection.json',
      collectionSize: 8_000n, unit: 100_000n, founderPremintBps: 0, antiSniperBlocks: 0, buybackBurnBps: 0,
      pairCurrency: pair, taxMode, taxBps, taxTarget, uruAmount: fee,
    }],
  });
  const ev = parseEventLogs({ abi: abis.lf, logs: r.logs, eventName: 'Dn404Launched' })[0]!;
  return { base: ev.args.base, mirror: ev.args.mirror, curve: ev.args.curve, pair, unitWei: 100_000n * 10n ** 18n };
}

const isEth = (l: Launched) => BigInt(l.pair) === 0n;

/// Buy on the curve (pre-graduation). ETH pairs: `amount` wei; URU pairs:
/// `amount` URU (funded from the deployer).
export async function curveBuy(pc: ViemPublic, who: PrivateKeyAccount, l: Launched, amount: bigint) {
  const w = walletFor(who);
  if (isEth(l)) {
    await tx(pc, w, { address: l.curve, abi: abis.ethCurve, functionName: 'buy', args: [0n], value: amount } as any);
  } else {
    await tx(pc, walletFor(DEPLOYER), { address: RH.uru, abi: abis.token, functionName: 'transfer', args: [who.address, amount] });
    await tx(pc, w, { address: RH.uru, abi: abis.token, functionName: 'approve', args: [l.curve, amount] });
    await tx(pc, w, { address: l.curve, abi: abis.pairCurve, functionName: 'buy', args: [amount, 0n] });
  }
}

/// Graduate with a whale that skips NFTs (keeps the buy far under the 32M
/// per-tx gas cap that applies on mainnet).
export async function graduate(pc: ViemPublic, whale: PrivateKeyAccount, l: Launched) {
  await tx(pc, walletFor(whale), { address: l.base, abi: abis.token, functionName: 'setSkipNFT', args: [true] });
  const abi = isEth(l) ? abis.ethCurve : abis.pairCurve;
  const target = await pc.readContract({ address: l.curve, abi, functionName: 'graduationTargetEth' });
  const reserve = await pc.readContract({ address: l.curve, abi, functionName: 'ethReserve' });
  const fee = BigInt(await pc.readContract({ address: l.curve, abi, functionName: 'tradeFeeBps' }));
  // Land the reserve exactly on target (gross up for the trade fee, +1 wei),
  // same anti-overshoot sizing as the trade page; an overshoot can ask for
  // more tokens than the curve has left.
  const need = ((target - reserve) * 10_000n) / (10_000n - fee) + 1n;
  await curveBuy(pc, whale, l, need);
  const g = await pc.readContract({ address: l.curve, abi, functionName: 'graduated' });
  if (!g) throw new Error(`launch ${l.base} did not graduate`);
}

export const bal = (pc: ViemPublic, token: Address, who: Address) =>
  pc.readContract({ address: token, abi: abis.token, functionName: 'balanceOf', args: [who] });
