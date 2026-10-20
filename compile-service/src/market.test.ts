/// Marketplace order validation + routes (docs/SPEC-marketplace.md).
///
/// Orders are signed with real keys (viem signTypedData over Seaport's
/// EIP-712 domain), so the signature path is the production one. The chain
/// and the collection allowlist are faked; the fork tests in
/// contracts/test/market/ cover real Seaport fills.
///
/// Most of the file is fee-item injection: every way a client could try to
/// sneak a payee other than the seller and the ERC-2981 receiver into an
/// order, and the exact refusal code for each.

import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { hashDomain, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  MARKET_ZONE,
  SEAPORT_ORDER_TYPES,
  ZERO_ADDRESS,
  buildListingOrder,
  orderToWire,
  seaportDomain,
  type OrderComponents,
  type Royalty,
  type WireOrder,
} from '../../shared/seaport.ts';
import {
  evaluateListing,
  seaportOrderHash,
  type CollectionInfo,
  type ListingChainState,
  type MarketChain,
  type MarketDeps,
} from './market.ts';
import { memoryMarketStore } from './market-store.ts';
import { fetchMetadataJson, fillMeta, isPrivateAddress, isSafePublicUrl, memoryMetaStore, parseTokenMeta, rarityRanks } from './market-meta.ts';
import { registerMarketRoutes } from './routes/market.ts';

const NOW = 1_800_000_000;
const DAY = 86_400;
const NFT = '0x1000000000000000000000000000000000000001' as Hex;
const DN404_MIRROR = '0x2000000000000000000000000000000000000002' as Hex;
const ROYALTY_NFT = '0x3000000000000000000000000000000000000003' as Hex;
const OUTSIDE = '0x4000000000000000000000000000000000000004' as Hex;
const ROYALTY_RECEIVER = '0x5000000000000000000000000000000000000005' as Hex;
const FEE_TAKER = '0x6000000000000000000000000000000000000006' as Hex;
const USDC = '0x7000000000000000000000000000000000000007' as Hex;

const seller = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const SELLER = seller.address.toLowerCase() as Hex;

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

interface FakeChain extends MarketChain {
  owners: Map<string, Hex | null>;
  approved: Set<string>;
  counters: Map<string, bigint>;
  cancelled: Set<string>;
  filled: Set<string>;
  royaltyBps: Map<string, number>;
  reads: number;
}

function fakeChain(): FakeChain {
  const c: FakeChain = {
    owners: new Map(),
    approved: new Set(),
    counters: new Map(),
    cancelled: new Set(),
    filled: new Set(),
    royaltyBps: new Map([[ROYALTY_NFT, 500]]),
    reads: 0,
    async readStates(refs) {
      c.reads++;
      return refs.map((r): ListingChainState => ({
        owner: c.owners.has(`${r.collection}:${r.tokenId}`) ? c.owners.get(`${r.collection}:${r.tokenId}`)! : null,
        approved: c.approved.has(`${r.collection}:${r.seller}`),
        counter: c.counters.get(r.seller) ?? 0n,
        cancelled: c.cancelled.has(r.orderHash),
        filled: c.filled.has(r.orderHash),
      }));
    },
    async readRoyalty(collection, _tokenId, salePrice) {
      const bps = c.royaltyBps.get(collection);
      if (!bps) return null;
      return { receiver: ROYALTY_RECEIVER, amount: (salePrice * BigInt(bps)) / 10_000n };
    },
    async verifyContractSignature() {
      return false;
    },
  };
  return c;
}

function info(collection: Hex, lane: 'nft' | 'dn404'): CollectionInfo {
  return {
    collection, lane, name: 'x', ticker: 'X',
    pairedToken: lane === 'dn404' ? ('0x9000000000000000000000000000000000000009' as Hex) : ZERO_ADDRESS,
    unitWei: lane === 'dn404' ? 10_000n * 10n ** 18n : 0n,
    maxSupply: 100n,
    launchBlock: 1n,
  };
}

function makeDeps() {
  const chain = fakeChain();
  const store = memoryMarketStore();
  const ours = new Map<string, CollectionInfo>([
    [NFT, info(NFT, 'nft')],
    [DN404_MIRROR, info(DN404_MIRROR, 'dn404')],
    [ROYALTY_NFT, info(ROYALTY_NFT, 'nft')],
  ]);
  const deps: MarketDeps = {
    chain,
    store,
    collections: { lookup: async (a) => ours.get(a.toLowerCase()) ?? null, list: async () => [...ours.values()] },
    now: () => NOW,
  };
  // Seller owns token 7 of each collection and approved Seaport everywhere.
  for (const coll of [NFT, DN404_MIRROR, ROYALTY_NFT, OUTSIDE]) {
    chain.owners.set(`${coll}:7`, SELLER);
    chain.approved.add(`${coll}:${SELLER}`);
  }
  return { deps, chain, store };
}

/// Owned scanner over the fake chain's owner map.
function fakeOwned(chain: FakeChain) {
  return async (wallet: Hex, cols: CollectionInfo[]) => {
    const out: Array<{ collection: Hex; tokenId: bigint }> = [];
    for (const [key, owner] of chain.owners) {
      const [c, id] = key.split(':');
      if (owner === wallet.toLowerCase() && cols.some((x) => x.collection === c)) out.push({ collection: c as Hex, tokenId: BigInt(id!) });
    }
    return out;
  };
}

async function makeApp(deps: MarketDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 10_000, timeWindow: '1 minute' });
  await registerMarketRoutes(app, { deps, meta: memoryMetaStore(), owned: fakeOwned(deps.chain as FakeChain) });
  return app;
}

function baseOrder(over: Partial<{ collection: Hex; price: bigint; royalty: Royalty | null; endTime: bigint; counter: bigint }> = {}): OrderComponents {
  return buildListingOrder({
    seller: SELLER,
    collection: over.collection ?? NFT,
    tokenId: 7n,
    priceWei: over.price ?? 10n ** 18n,
    royalty: over.royalty ?? null,
    startTime: BigInt(NOW - 60),
    endTime: over.endTime ?? BigInt(NOW + 30 * DAY),
    salt: 42n,
    counter: over.counter ?? 0n,
  });
}

async function sign(order: OrderComponents, account = seller): Promise<Hex> {
  return account.signTypedData({
    domain: seaportDomain(),
    types: SEAPORT_ORDER_TYPES,
    primaryType: 'OrderComponents',
    message: order,
  });
}

async function post(app: FastifyInstance, order: OrderComponents | WireOrder, signature: Hex) {
  const wire = 'counter' in order && typeof order.counter === 'bigint' ? orderToWire(order as OrderComponents) : order;
  const res = await app.inject({ method: 'POST', url: '/market/orders', payload: { order: wire, signature } });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

/// Sign `order` honestly, then submit. For injection tests the attacker is
/// the seller themself, so the signature is valid; the server must still
/// refuse the shape.
async function submitSigned(app: FastifyInstance, order: OrderComponents) {
  return post(app, order, await sign(order));
}

// -----------------------------------------------------------------------------
// Hashing matches live Seaport 1.6 on Robinhood
// -----------------------------------------------------------------------------

test('EIP-712 domain separator matches Seaport.information() on RH', () => {
  const sep = hashDomain({
    domain: { ...seaportDomain(), chainId: BigInt(seaportDomain().chainId) },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
  });
  // cast call 0x0000000000000068F116a894984e2DB1123eB395 "information()(string,bytes32,address)" (2026-10-19)
  assert.equal(sep, '0xa6b20d2b6f71c703cd333de0c921d303988fb481ff2982df74a21e19af3730b0');
});

test('order hash matches Seaport.getOrderHash() on RH', () => {
  const o: OrderComponents = {
    offerer: '0x1111111111111111111111111111111111111111',
    zone: MARKET_ZONE,
    offer: [{ itemType: 2, token: '0x375f4d9ce84607dbe0fce6b55b1c5b9335b87ba3', identifierOrCriteria: 7n, startAmount: 1n, endAmount: 1n }],
    consideration: [
      { itemType: 0, token: ZERO_ADDRESS, identifierOrCriteria: 0n, startAmount: 950000000000000000n, endAmount: 950000000000000000n, recipient: '0x1111111111111111111111111111111111111111' },
      { itemType: 0, token: ZERO_ADDRESS, identifierOrCriteria: 0n, startAmount: 50000000000000000n, endAmount: 50000000000000000n, recipient: '0x2222222222222222222222222222222222222222' },
    ],
    orderType: 0,
    startTime: 1760000000n,
    endTime: 1770000000n,
    zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    salt: 123456789n,
    conduitKey: '0x0000000000000000000000000000000000000000000000000000000000000000',
    counter: 3n,
  };
  // Same struct passed to the live contract's getOrderHash via cast (2026-10-19).
  assert.equal(seaportOrderHash(o), '0x937ecdea93c09009185920dda3eb78c046f958d3f15dcbe63f132f583723d85e');
});

// -----------------------------------------------------------------------------
// Happy paths
// -----------------------------------------------------------------------------

test('accepts a plain NFT-lane listing and serves it cheapest first', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const res = await submitSigned(app, baseOrder());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const listing = res.body.listing as Record<string, unknown>;
  assert.equal(listing.priceWei, (10n ** 18n).toString());
  assert.equal(listing.royaltyWei, '0');
  assert.equal(listing.lane, 'nft');

  const got = await app.inject({ method: 'GET', url: `/market/collections/${NFT}/listings` });
  const body = got.json() as { count: number; floorWei: string; listings: Array<{ tokenId: string; live: boolean }> };
  assert.equal(body.count, 1);
  assert.equal(body.floorWei, (10n ** 18n).toString());
  assert.equal(body.listings[0]?.tokenId, '7');
  assert.equal(body.listings[0]?.live, true);

  const one = await app.inject({ method: 'GET', url: `/market/tokens/${NFT}/7` });
  assert.equal((one.json() as { listing: { orderHash: string } }).listing.orderHash, listing.orderHash);
  await app.close();
});

test('accepts a listing with the exact ERC-2981 royalty item', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const price = 2n * 10n ** 18n;
  const res = await submitSigned(app, baseOrder({ collection: ROYALTY_NFT, price, royalty: { receiver: ROYALTY_RECEIVER, amount: price / 20n } }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const l = res.body.listing as Record<string, string>;
  assert.equal(l.priceWei, price.toString());
  assert.equal(l.royaltyWei, (price / 20n).toString());
  assert.equal(l.royaltyReceiver, ROYALTY_RECEIVER);
  await app.close();
});

test('accepts a DN404 mirror listing', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const res = await submitSigned(app, baseOrder({ collection: DN404_MIRROR }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal((res.body.listing as { lane: string }).lane, 'dn404');
  await app.close();
});

// -----------------------------------------------------------------------------
// Fee-item injection
// -----------------------------------------------------------------------------

function ethItem(amount: bigint, recipient: Hex) {
  return { itemType: 0, token: ZERO_ADDRESS, identifierOrCriteria: 0n, startAmount: amount, endAmount: amount, recipient };
}

test('rejects a platform fee item added after the seller item (no royalty collection)', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const o = baseOrder();
  o.consideration.push(ethItem(10n ** 16n, FEE_TAKER));
  const res = await submitSigned(app, o);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'EXTRA_CONSIDERATION_ITEM');
  await app.close();
});

test('rejects a fee item alongside a correct royalty (3 items)', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const price = 10n ** 18n;
  const o = baseOrder({ collection: ROYALTY_NFT, price, royalty: { receiver: ROYALTY_RECEIVER, amount: price / 20n } });
  o.consideration.push(ethItem(10n ** 16n, FEE_TAKER));
  const res = await submitSigned(app, o);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CONSIDERATION_COUNT');
  await app.close();
});

test('rejects a fee item disguised as the royalty (wrong receiver)', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const price = 10n ** 18n;
  const res = await submitSigned(app, baseOrder({ collection: ROYALTY_NFT, price, royalty: { receiver: FEE_TAKER, amount: price / 20n } }));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'ROYALTY_MISMATCH');
  assert.equal(res.body.receiver, ROYALTY_RECEIVER);
  await app.close();
});

test('rejects an inflated royalty amount', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const price = 10n ** 18n;
  const res = await submitSigned(app, baseOrder({ collection: ROYALTY_NFT, price, royalty: { receiver: ROYALTY_RECEIVER, amount: price / 10n } }));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'ROYALTY_MISMATCH');
  await app.close();
});

test('rejects a listing that skips a required royalty', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const res = await submitSigned(app, baseOrder({ collection: ROYALTY_NFT }));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'ROYALTY_MISSING');
  await app.close();
});

test('rejects a fee taker placed first with the seller second', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const o = baseOrder();
  o.consideration = [ethItem(10n ** 16n, FEE_TAKER), ethItem(10n ** 18n, SELLER)];
  const res = await submitSigned(app, o);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'FIRST_ITEM_NOT_SELLER');
  await app.close();
});

test('rejects non-ETH payment items (ERC-20 fee or price)', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const o = baseOrder();
  o.consideration = [{ itemType: 1, token: USDC, identifierOrCriteria: 0n, startAmount: 1_000_000n, endAmount: 1_000_000n, recipient: SELLER }];
  assert.equal((await submitSigned(app, o)).body.code, 'CONSIDERATION_NOT_ETH');

  const o2 = baseOrder();
  // itemType says native but token is set: Seaport would reject at fill,
  // we reject at listing time.
  o2.consideration = [{ ...ethItem(10n ** 18n, SELLER), token: USDC }];
  assert.equal((await submitSigned(app, o2)).body.code, 'CONSIDERATION_NOT_ETH');
  await app.close();
});

test('rejects Dutch-auction amounts, zero items and identifiers on ETH items', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const dutch = baseOrder();
  dutch.consideration = [{ ...ethItem(10n ** 18n, SELLER), endAmount: 1n }];
  assert.equal((await submitSigned(app, dutch)).body.code, 'CONSIDERATION_NOT_FIXED');

  const zero = baseOrder();
  zero.consideration = [ethItem(0n, SELLER)];
  assert.equal((await submitSigned(app, zero)).body.code, 'CONSIDERATION_ZERO');

  const ident = baseOrder();
  ident.consideration = [{ ...ethItem(10n ** 18n, SELLER), identifierOrCriteria: 1n }];
  assert.equal((await submitSigned(app, ident)).body.code, 'CONSIDERATION_IDENTIFIER');
  await app.close();
});

test('rejects conduits, restricted zones, other zones and zone hashes', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const conduit = baseOrder();
  conduit.conduitKey = `0x${'11'.repeat(32)}`;
  assert.equal((await submitSigned(app, conduit)).body.code, 'CONDUIT');

  const restricted = baseOrder();
  restricted.orderType = 2;
  assert.equal((await submitSigned(app, restricted)).body.code, 'ORDER_TYPE');

  const zone = baseOrder();
  zone.zone = FEE_TAKER;
  assert.equal((await submitSigned(app, zone)).body.code, 'ZONE');

  const zh = baseOrder();
  zh.zoneHash = `0x${'22'.repeat(32)}`;
  assert.equal((await submitSigned(app, zh)).body.code, 'ZONE_HASH');
  await app.close();
});

test('rejects offers that are not exactly one ERC-721', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const two = baseOrder();
  two.offer.push({ ...two.offer[0]!, identifierOrCriteria: 8n });
  assert.equal((await submitSigned(app, two)).body.code, 'OFFER_COUNT');

  const erc1155 = baseOrder();
  erc1155.offer = [{ ...erc1155.offer[0]!, itemType: 3 }];
  assert.equal((await submitSigned(app, erc1155)).body.code, 'OFFER_NOT_ERC721');

  const criteria = baseOrder();
  criteria.offer = [{ ...criteria.offer[0]!, itemType: 4 }];
  assert.equal((await submitSigned(app, criteria)).body.code, 'OFFER_NOT_ERC721');
  await app.close();
});

// -----------------------------------------------------------------------------
// Signature, ownership, approval, counter, expiry, allowlist
// -----------------------------------------------------------------------------

test('rejects a signature from someone other than the seller', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const o = baseOrder();
  const res = await post(app, o, await sign(o, stranger));
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'BAD_SIGNATURE');
  await app.close();
});

test('rejects an order changed after signing (price lowered, fee added)', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const o = baseOrder();
  const sig = await sign(o);
  const tampered = baseOrder({ price: 10n ** 15n });
  assert.equal((await post(app, tampered, sig)).body.code, 'BAD_SIGNATURE');
  await app.close();
});

test('rejects malformed signatures and orders', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  assert.equal((await post(app, baseOrder(), '0x1234' as Hex)).body.code, 'BAD_SIGNATURE_FORMAT');
  const wire = orderToWire(baseOrder());
  const bad = { ...wire, salt: '-1' } as WireOrder;
  const r = await post(app, bad, await sign(baseOrder()));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'BAD_ORDER');
  await app.close();
});

test('rejects collections not launched on urufu', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  const res = await submitSigned(app, baseOrder({ collection: OUTSIDE }));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'NOT_OUR_COLLECTION');
  const g = await app.inject({ method: 'GET', url: `/market/collections/${OUTSIDE}/listings` });
  assert.equal(g.statusCode, 404);
  await app.close();
});

test('rejects a seller who does not own the token, or has not approved Seaport', async () => {
  const { deps, chain } = makeDeps();
  const app = await makeApp(deps);
  chain.owners.set(`${NFT}:7`, stranger.address.toLowerCase() as Hex);
  assert.equal((await submitSigned(app, baseOrder())).body.code, 'NOT_OWNER');
  chain.owners.set(`${NFT}:7`, SELLER);
  chain.approved.delete(`${NFT}:${SELLER}`);
  assert.equal((await submitSigned(app, baseOrder())).body.code, 'NOT_APPROVED');
  await app.close();
});

test('rejects an order signed at an old counter', async () => {
  const { deps, chain } = makeDeps();
  const app = await makeApp(deps);
  chain.counters.set(SELLER, 1n);
  const res = await submitSigned(app, baseOrder({ counter: 0n }));
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'STALE_COUNTER');
  await app.close();
});

test('enforces the 180-day max expiry, and refuses expired orders', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  assert.equal((await submitSigned(app, baseOrder({ endTime: BigInt(NOW + 181 * DAY) }))).body.code, 'EXPIRY_TOO_LONG');
  assert.equal((await submitSigned(app, baseOrder({ endTime: BigInt(NOW + 180 * DAY) }))).status, 201);
  const { deps: d2 } = makeDeps();
  const app2 = await makeApp(d2);
  assert.equal((await submitSigned(app2, baseOrder({ endTime: BigInt(NOW - 1) }))).body.code, 'EXPIRED');
  await app.close();
  await app2.close();
});

test('one live listing per token: re-listing needs the old one cancelled on chain', async () => {
  const { deps, chain } = makeDeps();
  const app = await makeApp(deps);
  const first = await submitSigned(app, baseOrder());
  assert.equal(first.status, 201);
  const cheaper = baseOrder({ price: 5n * 10n ** 17n });
  cheaper.salt = 43n;
  const again = await submitSigned(app, cheaper);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'ALREADY_LISTED');

  chain.cancelled.add((first.body.listing as { orderHash: string }).orderHash);
  const after = await submitSigned(app, cheaper);
  assert.equal(after.status, 201, JSON.stringify(after.body));
  await app.close();
});

// -----------------------------------------------------------------------------
// Liveness on read
// -----------------------------------------------------------------------------

test('DN404 burn (ownerOf reverts) hides the listing; wallet view says why', async () => {
  const { deps, chain } = makeDeps();
  const app = await makeApp(deps);
  const res = await submitSigned(app, baseOrder({ collection: DN404_MIRROR }));
  assert.equal(res.status, 201);
  chain.owners.set(`${DN404_MIRROR}:7`, null); // seller sold tokens, NFT burned
  const list = await app.inject({ method: 'GET', url: `/market/collections/${DN404_MIRROR}/listings?fresh=1` });
  assert.equal((list.json() as { count: number }).count, 0);
  const tok = await app.inject({ method: 'GET', url: `/market/tokens/${DN404_MIRROR}/7?fresh=1` });
  assert.equal((tok.json() as { listing: unknown }).listing, null);
  const w = await app.inject({ method: 'GET', url: `/market/wallet/${SELLER}?fresh=1` });
  const wl = (w.json() as { listings: Array<{ live: boolean; hiddenReason: string; status: string }> }).listings;
  assert.equal(wl[0]?.status, 'active');
  assert.equal(wl[0]?.live, false);
  assert.equal(wl[0]?.hiddenReason, 'not_owner');

  // NFT comes back to the seller: Seaport would honor the order again.
  chain.owners.set(`${DN404_MIRROR}:7`, SELLER);
  const back = await app.inject({ method: 'GET', url: `/market/collections/${DN404_MIRROR}/listings?fresh=1` });
  assert.equal((back.json() as { count: number }).count, 1);
  await app.close();
});

test('filled and cancelled orders are marked and drop out for good', async () => {
  const { deps, chain, store } = makeDeps();
  const app = await makeApp(deps);
  const a = await submitSigned(app, baseOrder());
  const hashA = (a.body.listing as { orderHash: string }).orderHash;
  chain.filled.add(hashA);
  const list = await app.inject({ method: 'GET', url: `/market/collections/${NFT}/listings?fresh=1` });
  assert.equal((list.json() as { count: number }).count, 0);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.all().find((l) => l.orderHash === hashA)?.status, 'filled');

  // incrementCounter() cancels everything signed at the old counter.
  const o = baseOrder({ collection: DN404_MIRROR });
  const b = await submitSigned(app, o);
  assert.equal(b.status, 201);
  chain.counters.set(SELLER, 1n);
  const w = await app.inject({ method: 'GET', url: `/market/wallet/${SELLER}?fresh=1` });
  const statuses = (w.json() as { listings: Array<{ status: string }> }).listings.map((l) => l.status).sort();
  assert.deepEqual(statuses, ['cancelled', 'filled']);
  await app.close();
});

test('evaluateListing: expiry is terminal, moved NFT is not', () => {
  const l = {
    orderHash: '0x01' as Hex, chainId: 4663, collection: NFT, tokenId: 7n, lane: 'nft' as const, seller: SELLER,
    priceWei: 1n, royaltyWei: 0n, royaltyReceiver: null, startTime: 0n, endTime: BigInt(NOW), counter: 0n,
    order: orderToWire(baseOrder()), signature: '0x' as Hex, status: 'active' as const, createdAt: 0,
  };
  const s: ListingChainState = { owner: SELLER, approved: true, counter: 0n, cancelled: false, filled: false };
  assert.deepEqual(evaluateListing(l, s, NOW), { kind: 'dead', status: 'expired' });
  assert.deepEqual(evaluateListing({ ...l, endTime: BigInt(NOW + 1) }, { ...s, owner: FEE_TAKER }, NOW), { kind: 'hidden', reason: 'not_owner' });
  assert.deepEqual(evaluateListing({ ...l, endTime: BigInt(NOW + 1) }, { ...s, approved: false }, NOW), { kind: 'hidden', reason: 'not_approved' });
});

test('POST /market/orders is rate limited per IP', async () => {
  const { deps } = makeDeps();
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 10_000, timeWindow: '1 minute' });
  await registerMarketRoutes(app, { deps, meta: memoryMetaStore(), owned: async () => [] });
  let last = 0;
  for (let i = 0; i < 21; i++) {
    const r = await app.inject({ method: 'POST', url: '/market/orders', payload: {} });
    last = r.statusCode;
  }
  assert.equal(last, 429);
  await app.close();
});

// -----------------------------------------------------------------------------
// Traits + rarity
// -----------------------------------------------------------------------------

test('parseTokenMeta keeps only well-formed traits', () => {
  const m = parseTokenMeta(1n, {
    name: 'A #1',
    image: 'ipfs://x/1.png',
    attributes: [{ trait_type: 'Hat', value: 'Red' }, { trait_type: 'Level', value: 3 }, { value: 'orphan' }, 'junk', { trait_type: 'Obj', value: {} }],
  });
  assert.equal(m.name, 'A #1');
  assert.deepEqual(m.attributes, [{ trait_type: 'Hat', value: 'Red' }, { trait_type: 'Level', value: '3' }]);
});

test('rarityRanks puts the token with the rarest traits first', () => {
  const t = (id: bigint, hat: string) => ({ tokenId: id, name: null, image: null, attributes: [{ trait_type: 'Hat', value: hat }] });
  const ranks = rarityRanks([t(1n, 'Red'), t(2n, 'Red'), t(3n, 'Red'), t(4n, 'Gold')]);
  assert.equal(ranks.get('4'), 1);
  assert.equal(ranks.get('1'), 2);
  assert.equal(ranks.get('3'), 2);
});

// -----------------------------------------------------------------------------
// Marketplace index + Sell tab
// -----------------------------------------------------------------------------

test('GET /market/collections lists every urufu collection with live floor + count', async () => {
  const { deps } = makeDeps();
  const app = await makeApp(deps);
  await submitSigned(app, baseOrder({ collection: DN404_MIRROR, price: 3n * 10n ** 17n }));
  const res = await app.inject({ method: 'GET', url: '/market/collections' });
  const cols = (res.json() as { collections: Array<{ collection: string; floorWei: string | null; count: number; lane: string }> }).collections;
  assert.equal(cols.length, 3);
  const dn = cols.find((c) => c.collection === DN404_MIRROR)!;
  assert.equal(dn.lane, 'dn404');
  assert.equal(dn.count, 1);
  assert.equal(dn.floorWei, (3n * 10n ** 17n).toString());
  const nft = cols.find((c) => c.collection === NFT)!;
  assert.equal(nft.count, 0);
  assert.equal(nft.floorWei, null);
  await app.close();
});

test('GET /market/owned lists only urufu NFTs the wallet holds', async () => {
  const { deps } = makeDeps(); // seller owns #7 in NFT, DN404_MIRROR, ROYALTY_NFT and OUTSIDE
  const app = await makeApp(deps);
  const res = await app.inject({ method: 'GET', url: `/market/owned/${SELLER}` });
  const items = (res.json() as { items: Array<{ collection: string; tokenId: string }> }).items;
  assert.deepEqual(items.map((i) => i.collection).sort(), [NFT, DN404_MIRROR, ROYALTY_NFT].sort());
  assert.ok(items.every((i) => i.tokenId === '7'));
  const none = await app.inject({ method: 'GET', url: `/market/owned/${stranger.address}` });
  assert.equal((none.json() as { items: unknown[] }).items.length, 0);
  await app.close();
});

// -----------------------------------------------------------------------------
// Review fixes (2026-10-20)
// -----------------------------------------------------------------------------

test('a lagging RPC node (lower counter) hides a listing but never cancels it', () => {
  const l = {
    orderHash: '0x02' as Hex, chainId: 4663, collection: NFT, tokenId: 7n, lane: 'nft' as const, seller: SELLER,
    priceWei: 1n, royaltyWei: 0n, royaltyReceiver: null, startTime: 0n, endTime: BigInt(NOW + DAY), counter: 5n,
    order: orderToWire(baseOrder()), signature: '0x' as Hex, status: 'active' as const, createdAt: 0,
  };
  const s: ListingChainState = { owner: SELLER, approved: true, counter: 4n, cancelled: false, filled: false };
  assert.deepEqual(evaluateListing(l, s, NOW), { kind: 'hidden', reason: 'not_started' });
  assert.deepEqual(evaluateListing(l, { ...s, counter: 6n }, NOW), { kind: 'dead', status: 'cancelled' });
  assert.deepEqual(evaluateListing(l, { ...s, counter: 5n }, NOW), { kind: 'live' });
});

test('a listing whose start time is still ahead is not shown as buyable', () => {
  const l = {
    orderHash: '0x03' as Hex, chainId: 4663, collection: NFT, tokenId: 7n, lane: 'nft' as const, seller: SELLER,
    priceWei: 1n, royaltyWei: 0n, royaltyReceiver: null, startTime: BigInt(NOW + 300), endTime: BigInt(NOW + DAY), counter: 0n,
    order: orderToWire(baseOrder()), signature: '0x' as Hex, status: 'active' as const, createdAt: 0,
  };
  const s: ListingChainState = { owner: SELLER, approved: true, counter: 0n, cancelled: false, filled: false };
  assert.deepEqual(evaluateListing(l, s, NOW), { kind: 'hidden', reason: 'not_started' });
});

test('store refuses a second active listing for the same token and seller (race)', async () => {
  const store = memoryMarketStore();
  const base = {
    chainId: 4663, collection: NFT, tokenId: 7n, lane: 'nft' as const, seller: SELLER,
    priceWei: 1n, royaltyWei: 0n, royaltyReceiver: null, startTime: 0n, endTime: 1n, counter: 0n,
    order: orderToWire(baseOrder()), signature: '0x' as Hex, status: 'active' as const, createdAt: 0,
  };
  assert.equal(await store.insert({ ...base, orderHash: '0xaa' as Hex }), 'ok');
  assert.equal(await store.insert({ ...base, orderHash: '0xbb' as Hex }), 'duplicate_token');
  assert.equal(await store.insert({ ...base, orderHash: '0xaa' as Hex }), 'duplicate_order');
  await store.setStatus('0xaa' as Hex, 'cancelled');
  assert.equal(await store.insert({ ...base, orderHash: '0xbb' as Hex }), 'ok');
});

test('hidden listings sort after live ones so they cannot crowd the page', async () => {
  const { deps, chain, store } = makeDeps();
  const app = await makeApp(deps);
  // Cheap listing on #7, then the NFT moves away: hidden.
  await submitSigned(app, baseOrder({ price: 1n }));
  chain.owners.set(`${NFT}:7`, stranger.address.toLowerCase() as Hex);
  await app.inject({ method: 'GET', url: `/market/collections/${NFT}/listings?fresh=1` });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.all()[0]?.hidden, true);
  // A pricier live listing on another token now comes first in the query.
  const live = baseOrder({ price: 10n ** 18n });
  live.offer[0]!.identifierOrCriteria = 8n;
  live.salt = 99n;
  chain.owners.set(`${NFT}:8`, SELLER);
  assert.equal((await submitSigned(app, live)).status, 201);
  const firstPage = await deps.store.activeByCollection(NFT, 1);
  assert.equal(firstPage[0]?.tokenId, 8n);
  await app.close();
});

test('token route returns paused listings so the seller can cancel them', async () => {
  const { deps, chain } = makeDeps();
  const app = await makeApp(deps);
  await submitSigned(app, baseOrder());
  chain.approved.delete(`${NFT}:${SELLER}`);
  const res = await app.inject({ method: 'GET', url: `/market/tokens/${NFT}/7?fresh=1` });
  const body = res.json() as { listing: unknown; paused: Array<{ hiddenReason: string; seller: string }> };
  assert.equal(body.listing, null);
  assert.equal(body.paused.length, 1);
  assert.equal(body.paused[0]?.hiddenReason, 'not_approved');
  assert.equal(body.paused[0]?.seller, SELLER);
  await app.close();
});

test('metadata fetch never follows a redirect into a private network', async () => {
  assert.equal(isPrivateAddress('10.1.2.3'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('100.64.0.1'), true);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('fd00::1'), true);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('1.1.1.1'), false);
  assert.equal(await isSafePublicUrl('http://1.1.1.1/x'), false);
  assert.equal(await isSafePublicUrl('https://postgres.railway.internal/x'), false);
  assert.equal(await isSafePublicUrl('https://127.0.0.1/x'), false);
  assert.equal(await isSafePublicUrl('https://1.1.1.1/x'), true);

  const seen: string[] = [];
  const fakeFetch = (async (url: string) => {
    seen.push(url);
    if (url === 'https://1.1.1.1/meta.json') {
      return new Response(null, { status: 302, headers: { location: 'https://10.0.0.5/secret' } });
    }
    return new Response('{"name":"leak"}', { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await fetchMetadataJson('https://1.1.1.1/meta.json', fakeFetch), null);
  assert.deepEqual(seen, ['https://1.1.1.1/meta.json'], 'private redirect target is never requested');
});

test('stale cached metadata is refetched (art revealed after mint)', async () => {
  const store = memoryMetaStore();
  await store.put(NFT, [{ tokenId: 1n, name: 'Unrevealed', image: null, attributes: [], fetchedAt: Date.now() - 2 * 86_400_000 }]);
  const n = await fillMeta(store, NFT, [1n], {
    tokenUris: async () => ['data:application/json,{"name":"Revealed","attributes":[{"trait_type":"Hat","value":"Red"}]}'],
  });
  assert.equal(n, 1);
  const got = (await store.get(NFT, [1n])).get('1');
  assert.equal(got?.name, 'Revealed');
  // Fresh rows are left alone.
  assert.equal(await fillMeta(store, NFT, [1n], { tokenUris: async () => { throw new Error('should not fetch'); } }), 0);
});
