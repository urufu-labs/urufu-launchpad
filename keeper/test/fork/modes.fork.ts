/**
 * End-to-end keeper proof on an anvil fork of Robinhood mainnet.
 *
 * Real contracts, real keeper code: installs Dn404TaxTemplateV2 on the live
 * launch factory (as the deployer), points new launches at the dedicated
 * keeper wallet, launches one taxed DN404 per mode, generates real tax
 * (wallet transfers + a fee-on-transfer-safe pool sell), runs Keeper.tick()
 * with the keeper's real key against the fork, and asserts each mode's
 * on-chain outcome. Run: npm run test:fork (needs ROBINHOOD_RPC_URL in the
 * repo-root .env; spawns anvil on :8548).
 */
import { test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { concatHex, encodeAbiParameters, maxUint160, maxUint256, parseAbi, parseEventLogs, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig, TaxMode } from '../../src/config.ts';
import { DEAD, RH } from '../../src/constants.ts';
import { Keeper } from '../../src/keeper.ts';
import { ethPerToken } from '../../src/handlers/floor.ts';
import { launchPoolKey } from '../../src/pools.ts';
import { gasLog, type Ctx } from '../../src/tx.ts';
import { abis, bal, curveBuy, DEPLOYER, graduate, installV2, launch, newActor, repoEnv, RPC, setBalance, startFork, tx, walletFor, chain, type Launched } from './harness.ts';
import { ForkSeaportProvider } from './seaportFork.ts';
import { createPublicClient, createWalletClient, http } from 'viem';

const TAX_BPS = 500;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const permit2Abi = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
const urAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const pmAbi = parseAbi(['function nextTokenId() view returns (uint256)', 'function ownerOf(uint256) view returns (address)', 'function getPositionLiquidity(uint256) view returns (uint128)']);

const fork = await startFork();
after(() => fork.stop());
const pc = fork.pc;

/// Taxed user sell, fee-on-transfer-safe order: SETTLE(in, amt, payerIsUser)
/// -> SWAP_EXACT_IN_SINGLE(amountIn = OPEN_DELTA = 0) -> TAKE_ALL(out).
async function fotSell(who: ReturnType<typeof newActor>, l: Launched, amount: bigint) {
  const w = walletFor(who);
  await tx(pc, w, { address: l.base, abi: abis.token, functionName: 'approve', args: [RH.permit2, maxUint256] });
  await tx(pc, w, { address: RH.permit2, abi: permit2Abi, functionName: 'approve', args: [l.base, RH.universalRouter, maxUint160, 4_000_000_000] });
  const key = launchPoolKey(l.base, l.pair, RH);
  const zeroForOne = key.currency0.toLowerCase() === l.base.toLowerCase();
  const cout = zeroForOne ? key.currency1 : key.currency0;
  const PK = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const;
  const swap = encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'k', type: 'tuple', components: PK }, { name: 'z', type: 'bool' }, { name: 'a', type: 'uint128' }, { name: 'm', type: 'uint128' }, { name: 'h', type: 'uint256' }, { name: 'd', type: 'bytes' }] }],
    [{ k: [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], z: zeroForOne, a: 0n, m: 0n, h: 0n, d: '0x' }],
  );
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [l.base, amount, true]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cout, 0n]);
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [concatHex(['0x0b', '0x06', '0x0f']), [settle, swap, take]]);
  await tx(pc, w, { address: RH.universalRouter, abi: urAbi, functionName: 'execute', args: ['0x10', [input], 4_000_000_000n] });
}

async function ownedIds(mirror: Address, owner: Address): Promise<bigint[]> {
  const logs = await pc.getLogs({ address: mirror, event: abis.mirror.find((x) => x.type === 'event')! as any, fromBlock: fork.forkBlock, toBlock: 'latest' });
  const ids = new Set<bigint>();
  for (const l of logs as any[]) if (l.args.to?.toLowerCase() === owner.toLowerCase()) ids.add(l.args.id);
  const out: bigint[] = [];
  for (const id of ids) {
    try {
      const o = await pc.readContract({ address: mirror, abi: abis.mirror, functionName: 'ownerOf', args: [id] });
      if (o.toLowerCase() === owner.toLowerCase()) out.push(id);
    } catch { /* burned */ }
  }
  return out;
}

const results: Array<{ mode: string; pass: boolean; detail: string }> = [];
const record = (mode: string, pass: boolean, detail: string) => { results.push({ mode, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${mode}: ${detail}`); };

test('every DN404 tax mode works end to end on a Robinhood fork', { timeout: 30 * 60_000 }, async () => {
  const keeperAcct = privateKeyToAccount(repoEnv('DN404_KEEPER_PRIVATE_KEY') as `0x${string}`);
  assert.equal(keeperAcct.address, repoEnv('DN404_KEEPER_ADDRESS'));
  await setBalance(pc, keeperAcct.address, 5n * 10n ** 18n);
  const v2 = await installV2(pc, keeperAcct.address);
  console.log(`V2 installed at ${v2}, keeper ${keeperAcct.address}`);

  const A = newActor(); const B = newActor(); const W = newActor(); const S = newActor();
  for (const a of [A, B, W, S]) await setBalance(pc, a.address, 200n * 10n ** 18n);

  const URU = RH.uru;
  const L = {
    ethBuyback: await launch(pc, ZERO, TaxMode.BuybackURU, TAX_BPS),
    uruBuyback: await launch(pc, URU, TaxMode.BuybackURU, TAX_BPS),
    ethAllowed: await launch(pc, ZERO, TaxMode.BuyAllowedToken, TAX_BPS, URU),
    uruAllowed: await launch(pc, URU, TaxMode.BuyAllowedToken, TAX_BPS, URU),
    ethLp: await launch(pc, ZERO, TaxMode.AddToLP, TAX_BPS),
    uruLp: await launch(pc, URU, TaxMode.AddToLP, TAX_BPS),
    ethRefl: await launch(pc, ZERO, TaxMode.HolderReflections, TAX_BPS),
    ethFloor: await launch(pc, ZERO, TaxMode.MirrorFloorSupport, TAX_BPS),
    uruFloor: await launch(pc, URU, TaxMode.MirrorFloorSupport, TAX_BPS),
    ethBurn: await launch(pc, ZERO, TaxMode.BurnDead, TAX_BPS),
    ethOff: await launch(pc, ZERO, TaxMode.Off, 0),
  };
  const isEth = (l: Launched) => BigInt(l.pair) === 0n;

  // Pre-graduation holders.
  for (const l of Object.values(L)) {
    await curveBuy(pc, A, l, isEth(l) ? 5n * 10n ** 16n : 50n * 10n ** 18n);
    if (l === L.ethFloor || l === L.uruFloor) await curveBuy(pc, S, l, isEth(l) ? 5n * 10n ** 16n : 50n * 10n ** 18n);
  }
  // Graduate everything that needs a pool.
  for (const l of [L.ethBuyback, L.uruBuyback, L.ethAllowed, L.uruAllowed, L.ethLp, L.uruLp, L.ethFloor, L.uruFloor]) await graduate(pc, W, l);

  // Taxable activity: A -> B transfer of half (wallet-to-wallet is taxed).
  const transfers = new Map<Launched, bigint>();
  for (const l of Object.values(L)) {
    const half = (await bal(pc, l.base, A.address)) / 2n;
    transfers.set(l, half);
    if (l === L.ethBurn || l === L.ethOff) continue; // checked separately below
    await tx(pc, walletFor(A), { address: l.base, abi: abis.token, functionName: 'transfer', args: [B.address, half] });
  }
  // Exercise the user-side taxed sell path on one ETH and one URU pool.
  await fotSell(B, L.ethBuyback, (await bal(pc, L.ethBuyback.base, B.address)) / 4n);
  await fotSell(B, L.uruBuyback, (await bal(pc, L.uruBuyback.base, B.address)) / 4n);

  // ---- BurnDead (in-token, no keeper) ----
  {
    const x = transfers.get(L.ethBurn)!;
    const dead0 = await bal(pc, L.ethBurn.base, DEAD); const b0 = await bal(pc, L.ethBurn.base, B.address);
    await tx(pc, walletFor(A), { address: L.ethBurn.base, abi: abis.token, functionName: 'transfer', args: [B.address, x] });
    const tax = (x * BigInt(TAX_BPS)) / 10_000n;
    const ok = (await bal(pc, L.ethBurn.base, DEAD)) - dead0 === tax && (await bal(pc, L.ethBurn.base, B.address)) - b0 === x - tax;
    record('BurnDead', ok, `transfer ${x}: 0x…dEaD +${tax} (5%), recipient +${x - tax}`);
  }
  // ---- Off ----
  {
    const x = transfers.get(L.ethOff)!;
    const b0 = await bal(pc, L.ethOff.base, B.address);
    await tx(pc, walletFor(A), { address: L.ethOff.base, abi: abis.token, functionName: 'transfer', args: [B.address, x] });
    record('Off', (await bal(pc, L.ethOff.base, B.address)) - b0 === x, `transfer ${x} arrived in full, no tax surface`);
  }

  // Floor listings: seller S lists one of its NFTs at 30% of implied value.
  const ctx: Ctx = {
    pc: pc as any,
    wc: createWalletClient({ chain, transport: http(RPC), account: keeperAcct }) as any,
    keeper: keeperAcct.address,
  };
  const cfg = loadConfig({
    KEEPER_RPC_URL: RPC, KEEPER_PRIVATE_KEY: repoEnv('DN404_KEEPER_PRIVATE_KEY'),
    KEEPER_DISCOVERY_START_BLOCK: String(fork.forkBlock + 1n), KEEPER_REFLECTION_MIN_PAYOUT_WEI: '1',
  } as NodeJS.ProcessEnv);
  const seaport = new ForkSeaportProvider();
  const floorListings = new Map<Launched, { id: bigint; price: bigint }>();
  for (const l of [L.ethFloor, L.uruFloor]) {
    const ids = await ownedIds(l.mirror, S.address);
    assert.ok(ids.length > 0, 'seller owns no NFT');
    const implied = (l.unitWei * (await ethPerToken(ctx, cfg, { base: l.base, pair: l.pair }))) / 10n ** 18n;
    const price = (implied * 30n) / 100n;
    await seaport.list(pc as any, S, l.mirror, ids[0]!, price);
    floorListings.set(l, { id: ids[0]!, price });
  }

  // ---- snapshot before the keeper tick ----
  const deadUru0 = await bal(pc, URU, DEAD);
  const depUru0 = await bal(pc, URU, DEPLOYER);
  const depTok0 = new Map<Launched, bigint>();
  for (const l of Object.values(L)) depTok0.set(l, await bal(pc, l.base, DEPLOYER));
  const nextId0 = await pc.readContract({ address: RH.positionManager, abi: pmAbi, functionName: 'nextTokenId' });
  const reflA0 = await bal(pc, L.ethRefl.base, A.address); const reflB0 = await bal(pc, L.ethRefl.base, B.address);
  const sellerEth0 = await pc.getBalance({ address: S.address });
  const floorSupply0 = new Map<Launched, bigint>();
  const floorDead0 = new Map<Launched, bigint>();
  for (const l of [L.ethFloor, L.uruFloor]) {
    floorSupply0.set(l, await pc.readContract({ address: l.mirror, abi: abis.mirror, functionName: 'totalSupply' }));
    floorDead0.set(l, await bal(pc, l.base, DEAD));
  }
  const acc0 = new Map<Launched, bigint>();
  for (const l of Object.values(L)) {
    try { acc0.set(l, await pc.readContract({ address: l.base, abi: abis.token, functionName: 'accumulatedTax' })); } catch { acc0.set(l, 0n); }
  }

  // ---- run the REAL keeper ----
  gasLog.length = 0;
  const keeper = new Keeper(ctx, cfg, seaport);
  const reports = await keeper.tick();
  for (const r of reports) if (r.error) console.log(`tick error ${r.base}: ${r.error}`);

  // Discovery: every taxed launch, never the Off launch.
  const watched = new Set([...keeper.discovery.launches.keys()]);
  record('Discovery', !watched.has(L.ethOff.base.toLowerCase()) && Object.values(L).filter((l) => l !== L.ethOff).every((l) => watched.has(l.base.toLowerCase())),
    `${watched.size} taxed launches discovered from Dn404Launched logs; Off launch ignored`);

  // Treasury got exactly 5% of every sweep.
  {
    let ok = true; const parts: string[] = [];
    for (const rec of gasLog.filter((g) => g.label.startsWith('sweepAccumulated'))) {
      const r = await pc.getTransactionReceipt({ hash: rec.hash });
      const ev = parseEventLogs({ abi: abis.token, logs: r.logs, eventName: 'KeeperSwept' })[0]!;
      const gross = ev.args.net + ev.args.keeperFee;
      const base = r.logs.find((x) => parseEventLogs({ abi: abis.token, logs: [x], eventName: 'KeeperSwept' }).length > 0)!.address;
      const l = Object.values(L).find((q) => q.base.toLowerCase() === base.toLowerCase())!;
      const feeOk = ev.args.keeperFee === (gross * 500n) / 10_000n && gross === acc0.get(l);
      const depDelta = (await bal(pc, l.base, DEPLOYER)) - depTok0.get(l)!;
      ok &&= feeOk && depDelta === ev.args.keeperFee;
      parts.push(`${l.base.slice(0, 8)} fee ${ev.args.keeperFee}/${gross}`);
    }
    // 9 sweeps = 8 pool modes + HolderReflections (BurnDead/Off never sweep).
    record('Keeper fee 5%', ok && parts.length === 9, `${parts.length} sweeps; each fee == floor(gross*5%) and == treasury token delta`);
  }

  const keeperLeft = async (l: Launched) => bal(pc, l.base, keeperAcct.address);

  // BuybackURU: URU landed at the 0x…dEaD sink, keeper spent its tokens.
  {
    const deadUru1 = await bal(pc, URU, DEAD);
    const ok = deadUru1 > deadUru0 && (await keeperLeft(L.ethBuyback)) === 0n && (await keeperLeft(L.uruBuyback)) === 0n;
    record('BuybackURU (ETH + URU pairs)', ok, `URU burned at 0x…dEaD +${deadUru1 - deadUru0}; keeper token balance 0 on both launches`);
  }
  // BuyAllowedToken (target URU): launcher (deployer) received URU.
  {
    const depUru1 = await bal(pc, URU, DEPLOYER);
    const ok = depUru1 > depUru0 && (await keeperLeft(L.ethAllowed)) === 0n && (await keeperLeft(L.uruAllowed)) === 0n;
    record('BuyAllowedToken (URU target, ETH + URU pairs)', ok, `launcher URU +${depUru1 - depUru0}; keeper token balance 0`);
  }
  // AddToLP: new positions owned by 0x…dEaD with liquidity, one per LP launch.
  {
    const nextId1 = await pc.readContract({ address: RH.positionManager, abi: pmAbi, functionName: 'nextTokenId' });
    let locked = 0; const ids: string[] = [];
    for (let id = nextId0; id < nextId1; id++) {
      const o = await pc.readContract({ address: RH.positionManager, abi: pmAbi, functionName: 'ownerOf', args: [id] });
      const liq = await pc.readContract({ address: RH.positionManager, abi: pmAbi, functionName: 'getPositionLiquidity', args: [id] });
      if (o.toLowerCase() === DEAD.toLowerCase() && liq > 0n) { locked++; ids.push(`#${id} L=${liq}`); }
    }
    record('AddToLP (ETH + URU pairs)', locked === 2, `${locked} full-range positions locked at 0x…dEaD: ${ids.join(', ')}`);
  }
  // HolderReflections: A and B paid pro-rata to their balances.
  {
    const dA = (await bal(pc, L.ethRefl.base, A.address)) - reflA0;
    const dB = (await bal(pc, L.ethRefl.base, B.address)) - reflB0;
    // pro-rata: dA/dB == balA/balB (floor rounding => cross-products within max(balA,balB)).
    const cross = dA * reflB0 - dB * reflA0;
    const tol = reflA0 > reflB0 ? reflA0 : reflB0;
    const ok = dA > 0n && dB > 0n && (cross < 0n ? -cross : cross) <= tol;
    record('HolderReflections (pre-graduation)', ok, `A +${dA} (bal ${reflA0}), B +${dB} (bal ${reflB0}); pro-rata within rounding`);
  }
  // MirrorFloorSupport: listing bought and burned, seller paid, tokens burned.
  {
    const sellerEth1 = await pc.getBalance({ address: S.address });
    let ok = true; const parts: string[] = [];
    let paid = 0n;
    for (const l of [L.ethFloor, L.uruFloor]) {
      const { id, price } = floorListings.get(l)!;
      let burned = false;
      try { await pc.readContract({ address: l.mirror, abi: abis.mirror, functionName: 'ownerOf', args: [id] }); } catch { burned = true; }
      const supply1 = await pc.readContract({ address: l.mirror, abi: abis.mirror, functionName: 'totalSupply' });
      const dead1 = await bal(pc, l.base, DEAD);
      const kNfts = await pc.readContract({ address: l.mirror, abi: abis.mirror, functionName: 'balanceOf', args: [keeperAcct.address] });
      const thisOk = burned && supply1 < floorSupply0.get(l)! && dead1 > floorDead0.get(l)! && kNfts === 0n && (await keeperLeft(l)) === 0n;
      ok &&= thisOk; paid += price;
      parts.push(`${isEth(l) ? 'ETH' : 'URU'}: NFT #${id} burned=${burned}, mirror supply ${floorSupply0.get(l)}->${supply1}, 0x…dEaD +${dead1 - floorDead0.get(l)!} tokens`);
    }
    ok &&= sellerEth1 - sellerEth0 === paid;
    record('MirrorFloorSupport (ETH + URU pairs)', ok, `${parts.join('; ')}; seller paid exactly ${paid} wei`);
  }

  console.log('\nGas per keeper action:');
  for (const g of gasLog) console.log(`  ${g.gasUsed.toString().padStart(9)}  ${g.label}`);
  console.log('\nRESULTS'); for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.mode}: ${r.detail}`);
  assert.ok(results.every((r) => r.pass), 'some modes failed (see RESULTS)');
});
