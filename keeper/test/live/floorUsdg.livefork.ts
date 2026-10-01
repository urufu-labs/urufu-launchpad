/**
 * MirrorFloorSupport against the REAL OpenSea API and a REAL signed listing,
 * executed on an anvil fork of current Robinhood mainnet.
 *
 * Mainnet state this relies on (created 2026-10-01 by the live test run):
 *   - "Floor Keeper Live Test" (FLT): taxed V2 DN404, MirrorFloorSupport 5%,
 *     URU-paired, graduated. base 0x6afbe2c6…a172, mirror 0xd991b601…9310.
 *   - wallet B (LIVE_TEST_B_ADDRESS) owns NFT #1 and listed it on OpenSea for
 *     0.01 USDG (order 0x91638d44…08d1), approved to OpenSea's Robinhood
 *     conduit. OpenSea on Robinhood only accepts USDG listings.
 *
 * On the fork only (nothing here touches mainnet):
 *   1. raise the FLT pool price (deployer buys with URU) until one NFT's token
 *      value clears the keeper's ceiling for a 0.01 USDG listing;
 *   2. wallet A sends B tokens so 5% tax accumulates past the sweep threshold;
 *   3. run ONE real Keeper.tick() with the real keeper key and the real
 *      OpenSeaProvider (live API: best listings + fulfillment_data).
 * Asserts the listing NFT is burned, B got 0.0099 USDG, OpenSea's fee
 * recipient got 0.0001 USDG, and the 5% keeper fee went to the treasury.
 *
 * Run: node --experimental-strip-types --disable-warning=ExperimentalWarning test/live/floorUsdg.livefork.ts
 */
import { strict as assert } from 'node:assert';
import { createWalletClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../../src/config.ts';
import { Keeper } from '../../src/keeper.ts';
import { OpenSeaProvider } from '../../src/opensea.ts';
import { ethPerToken, ethPerUsdgRaw } from '../../src/handlers/floor.ts';
import { pairToToken } from '../../src/routes.ts';
import type { Ctx } from '../../src/tx.ts';
import { chain, DEPLOYER, repoEnv, RPC, startFork, walletFor, abis } from '../fork/harness.ts';

const BASE: Address = '0x6afbe2c60fe1745ed9ff592302df005575e1a172';
const MIRROR: Address = '0xd991b601a09eb0687d0f53f39ee45a5031e39310';
const URU: Address = '0x9fbe210007dDd8389f98d0253018e65CC48b9D24';
const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const OS_FEE: Address = '0x0000a26b00c1f0df003000390027140000faa719';
const DEAD: Address = '0x000000000000000000000000000000000000dEaD';
const LAUNCH_BLOCK = 77755514n;
const LISTED_ID = 1n;
const LISTING_USDG = 10_000n;
const UNIT = 100_000n * 10n ** 18n;

const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

async function main() {
  const fork = await startFork();
  const pc = fork.pc;
  try {
    // Fresh anvil forks sometimes fail the first eth_call ("Excess blob gas not set"); warm up.
    await pc.request({ method: 'evm_mine' as never, params: [] as never });
    for (let i = 0; i < 5; i++) {
      try { await pc.readContract({ address: MIRROR, abi: abis.mirror, functionName: 'totalSupply' }); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    const A = repoEnv('LIVE_TEST_A_ADDRESS') as Address;
    const B = repoEnv('LIVE_TEST_B_ADDRESS') as Address;
    const keeperAcct = privateKeyToAccount(repoEnv('DN404_KEEPER_PRIVATE_KEY') as `0x${string}`);
    const bal = (t: Address, w: Address) => pc.readContract({ address: t, abi: erc20, functionName: 'balanceOf', args: [w] });
    const ownerOf = async (id: bigint) => {
      try { return await pc.readContract({ address: MIRROR, abi: abis.mirror, functionName: 'ownerOf', args: [id] }); } catch (e) { if (process.env.DEBUG_OWNER) console.log('ownerOf err:', String((e as Error).message).slice(0, 300)); return null; }
    };
    console.log(`fork block ${fork.forkBlock}; NFT #${LISTED_ID} owner ${await ownerOf(LISTED_ID)} (B=${B})`);
    assert.equal(String(await ownerOf(LISTED_ID)).toLowerCase(), B.toLowerCase(), 'B must own the listed NFT on the fork');

    // ---- 1. raise the pool price until a 0.01 USDG listing is under the ceiling
    const pumpCfg = loadConfig({ KEEPER_RPC_URL: RPC, KEEPER_PRIVATE_KEY: repoEnv('DN404_KEEPER_PRIVATE_KEY'), KEEPER_MAX_PRICE_IMPACT_BPS: '9900', KEEPER_MAX_SLIPPAGE_BPS: '9000' } as NodeJS.ProcessEnv);
    const dep: Ctx = { pc: pc as any, wc: walletFor(DEPLOYER), keeper: DEPLOYER };
    const kctx: Ctx = { pc: pc as any, wc: createWalletClient({ chain, transport: http(RPC), account: keeperAcct }) as any, keeper: keeperAcct.address };
    const listingWei = async () => (LISTING_USDG * (await ethPerUsdgRaw(kctx, pumpCfg))) / 10n ** 18n;
    const impliedWei = async () => (UNIT * (await ethPerToken(kctx, pumpCfg, { base: BASE, pair: URU }))) / 10n ** 18n;
    // Fork-only: the deployer pumps without minting NFTs (avoids huge mint gas + slow fork state fetches).
    { const h = await walletFor(DEPLOYER).writeContract({ address: BASE, abi: [{ type: 'function', name: 'setSkipNFT', stateMutability: 'nonpayable', inputs: [{ type: 'bool' }], outputs: [{ type: 'bool' }] }], functionName: 'setSkipNFT', args: [true] }); await pc.waitForTransactionReceipt({ hash: h }); }
    for (let i = 0; i < 12; i++) {
      const [imp, lst] = [await impliedWei(), await listingWei()];
      console.log(`pump ${i}: implied NFT ${imp} wei vs listing ${lst} wei`);
      if ((imp * 90n) / 100n > (lst * 120n) / 100n) break;
      await pairToToken(dep, pumpCfg, { base: BASE, pair: URU }, 15_000n * 10n ** 18n);
    }
    assert.ok(((await impliedWei()) * 90n) / 100n > await listingWei(), 'could not raise price enough');

    // ---- 2. A -> B taxed transfer to cross the sweep threshold (1 bps of supply)
    const acc0 = await pc.readContract({ address: BASE, abi: abis.token, functionName: 'accumulatedTax' });
    { const h = await walletFor(A).writeContract({ address: BASE, abi: erc20, functionName: 'transfer', args: [B, 3_000_000n * 10n ** 18n] }); await pc.waitForTransactionReceipt({ hash: h }); }
    const acc1 = await pc.readContract({ address: BASE, abi: abis.token, functionName: 'accumulatedTax' });
    console.log(`accumulatedTax ${acc0} -> ${acc1}`);

    // ---- snapshot
    const supply0 = await pc.readContract({ address: MIRROR, abi: abis.mirror, functionName: 'totalSupply' });
    const bUsdg0 = await bal(USDG, B);
    const feeUsdg0 = await bal(USDG, OS_FEE);
    const dead0 = await bal(BASE, DEAD);
    const treas0 = await bal(BASE, DEPLOYER);

    // ---- 3. the REAL keeper with the REAL OpenSea API
    const cfg = loadConfig({
      KEEPER_RPC_URL: RPC, KEEPER_PRIVATE_KEY: repoEnv('DN404_KEEPER_PRIVATE_KEY'),
      KEEPER_DISCOVERY_START_BLOCK: String(LAUNCH_BLOCK - 1n), OPENSEA_API_KEY: repoEnv('OPENSEA_API_KEY'),
    } as NodeJS.ProcessEnv);
    const provider = new OpenSeaProvider(cfg.openseaApiKey!, 'robinhood', cfg.usdg);
    const keeper = new Keeper(kctx, cfg, provider);
    const reports = await keeper.tick();
    for (const r of reports) console.log('report', JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

    // ---- assertions
    const owner1 = await ownerOf(LISTED_ID);
    const supply1 = await pc.readContract({ address: MIRROR, abi: abis.mirror, functionName: 'totalSupply' });
    const bUsdg1 = await bal(USDG, B);
    const feeUsdg1 = await bal(USDG, OS_FEE);
    const dead1 = await bal(BASE, DEAD);
    const treas1 = await bal(BASE, DEPLOYER);
    console.log(`NFT #1 owner after: ${owner1}; mirror supply ${supply0} -> ${supply1}`);
    console.log(`B USDG +${bUsdg1 - bUsdg0}; OpenSea fee USDG +${feeUsdg1 - feeUsdg0}; dead tokens +${dead1 - dead0}; treasury tokens +${treas1 - treas0}`);
    assert.equal(owner1, null, 'NFT #1 must be burned (ownerOf reverts)');
    assert.ok(supply1 < supply0, 'mirror supply must drop');
    assert.equal(bUsdg1 - bUsdg0, 9_900n, 'seller gets 0.0099 USDG');
    assert.equal(feeUsdg1 - feeUsdg0, 100n, 'OpenSea fee recipient gets 0.0001 USDG');
    assert.ok(dead1 > dead0, 'tokens burned to dead');
    assert.equal(treas1 - treas0, acc1 / 20n, 'treasury gets exactly 5% of the full sweep');
    console.log('PASS MirrorFloorSupport via real OpenSea USDG listing on a mainnet fork');
  } finally {
    fork.stop();
  }
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
