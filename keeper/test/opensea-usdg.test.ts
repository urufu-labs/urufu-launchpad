/// USDG floor-buy plumbing, pinned to REAL OpenSea responses captured
/// 2026-10-01 for the live test collection floor-keeper-live-test
/// (mirror 0xd991b601…9310 on Robinhood, chain id `robinhood`):
///   - best listings: one USDG listing (0.01 USDG) of token #1
///   - fulfillment_data for fulfiller = keeper wallet
/// Facts these pin: OpenSea on Robinhood rejects native-ETH listings and
/// requires USDG; it uses its own conduit key 0x61159fef…1d5e; fulfillment
/// is fulfillBasicOrder_efficient_6GL6yc with value 0.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, parseAbiItem, type Address, type AbiFunction } from 'viem';
import { encodeFulfillment, OpenSeaProvider } from '../src/opensea.ts';
import { pricedInEth } from '../src/handlers/floor.ts';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BEST = fx('opensea-robinhood-usdg-best-listings.json');
const FULFILL = fx('opensea-robinhood-usdg-fulfillment.json');
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;
const MIRROR = '0xd991b601a09eb0687d0f53f39ee45a5031e39310' as Address;
const KEEPER = '0x192F94cD3191e6561D31940602Dc4925ed233b1a';

function providerWith(best: unknown, fulfill: unknown): OpenSeaProvider {
  const p = new OpenSeaProvider('test-key', 'robinhood', USDG, 'https://fixture.invalid');
  (globalThis as any).fetch = async (url: string, init?: { method?: string }) => {
    const body = url.includes('/contract/') ? { collection: 'floor-keeper-live-test' } : init?.method === 'POST' ? fulfill : best;
    return { ok: true, status: 200, json: async () => body } as Response;
  };
  return p;
}

test('real Robinhood USDG listing is accepted with currency + raw amount', async () => {
  const p = providerWith(BEST, FULFILL);
  const ls = await p.bestListings(MIRROR, 20);
  assert.equal(ls.length, 1);
  assert.equal(ls[0]!.currency.toLowerCase(), USDG.toLowerCase());
  assert.equal(ls[0]!.amount, 10_000n); // 0.01 USDG, 6 decimals
  assert.equal(ls[0]!.tokenId, 1n);
  assert.equal(ls[0]!.priceWei, 0n); // filled later from the ETH/USDG pool
});

test('USDG listings from another ERC-20 are skipped', async () => {
  const other = JSON.parse(JSON.stringify(BEST));
  other.listings[0].protocol_data.parameters.consideration[0].token = '0x000000000000000000000000000000000000beef';
  const ls = await providerWith(other, FULFILL).bestListings(MIRROR, 20);
  assert.equal(ls.length, 0);
});

test('real fulfillment data encodes to Seaport calldata, value 0, OpenSea conduit key surfaced', async () => {
  const p = providerWith(BEST, FULFILL);
  const [l] = await p.bestListings(MIRROR, 20);
  const f = await p.fulfillment(l!, KEEPER as Address);
  assert.equal(f.value, 0n);
  assert.equal(f.to.toLowerCase(), '0x0000000000000068f116a894984e2db1123eb395');
  assert.equal(f.fulfillerConduitKey, '0x61159fefdfada89302ed55f8b9e89e2d67d8258712b3a3f89aa88525877f1d5e');
  const data = encodeFulfillment(f);
  const fn = parseAbiItem(`function ${f.function}`) as AbiFunction;
  const decoded = decodeFunctionData({ abi: [fn], data });
  // Unnamed tuple in OpenSea's signature, so viem returns it positionally:
  // [considerationToken, considerationIdentifier, considerationAmount, offerer, zone,
  //  offerToken, offerIdentifier, offerAmount, basicOrderType, ..., additionalRecipients(16), signature(17)]
  const t = (decoded.args as any[])[0] as any[];
  assert.equal(String(t[0]).toLowerCase(), USDG.toLowerCase());
  assert.equal(t[2], 9_900n);
  assert.equal(String(t[5]).toLowerCase(), MIRROR);
  assert.equal(t[6], 1n);
  assert.equal(Number(t[8]), 8); // ERC20_TO_ERC721_FULL_OPEN
  assert.equal(t[16][0][0], 100n); // OpenSea 1% fee

});

test('pricedInEth converts USDG raw units with the pool price and leaves native untouched', () => {
  const native = { orderHash: '0x01' as const, protocolAddress: USDG, tokenId: 2n, currency: '0x0000000000000000000000000000000000000000' as Address, amount: 5n, priceWei: 5n };
  const usdg = { ...native, tokenId: 1n, currency: USDG, amount: 10_000n, priceWei: 0n };
  // 1 USDG raw unit = 3.7e8 wei (ETH ~ $2,700) => x1e18 scaling
  const out = pricedInEth([native, usdg], USDG, 370_000_000n * 10n ** 18n);
  assert.equal(out[0]!.priceWei, 5n);
  assert.equal(out[1]!.priceWei, 10_000n * 370_000_000n);
});

// ---- Dust handling, reproducing the 2026-10-01 mainnet floor run ----
// After buying NFT #1 for 10,000 USDG units, the keeper held ~300 USDG units
// (the +3% buffer on its ETH -> USDG swap). Swapping that back reverted the
// UR `execute`, which aborted the handler before its burn. Dust is now held.
import { isDust } from '../src/routes.ts';
import { planCleanup } from '../src/handlers/floor.ts';

const DUST_CFG = {
  usdg: USDG,
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address,
  dustEthWei: 10n ** 12n,
  dustUsdg: 10_000n,
};

test('mainnet leftover of ~300 USDG units is dust: no swap-back', () => {
  assert.equal(isDust(DUST_CFG, USDG, 300n), true);
  assert.deepEqual(planCleanup(DUST_CFG, 300n, 0n), { usdgToEth: false, ethToToken: false });
});

test('zero amounts are always dust for every currency', () => {
  for (const c of [USDG, DUST_CFG.weth, '0x0000000000000000000000000000000000000000' as Address, MIRROR]) {
    assert.equal(isDust(DUST_CFG, c, 0n), true, c);
  }
});

test('real leftovers above the thresholds are still routed', () => {
  assert.equal(isDust(DUST_CFG, USDG, 10_000n), false);
  assert.equal(isDust(DUST_CFG, '0x0000000000000000000000000000000000000000', 10n ** 12n), false);
  assert.equal(isDust(DUST_CFG, DUST_CFG.weth, 10n ** 11n), true);
  assert.deepEqual(planCleanup(DUST_CFG, 50_000n, 5n * 10n ** 12n), { usdgToEth: true, ethToToken: true });
});

test('non-ETH, non-USDG tokens are never treated as dust unless zero', () => {
  assert.equal(isDust(DUST_CFG, MIRROR, 1n), false);
});
