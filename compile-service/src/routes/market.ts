/// Zero-fee NFT marketplace routes (docs/SPEC-marketplace.md).
///
///   POST /market/orders                       signed Seaport listing -> stored
///   GET  /market/collections/:addr/listings   live listings, cheapest first, with traits
///   GET  /market/tokens/:addr/:id             live listing for one NFT, if any
///   GET  /market/wallet/:addr                 a wallet's listings (incl. hidden / ended)
///   GET  /market/collections                  every urufu collection with floor + listed count
///   GET  /market/owned/:addr                  NFTs a wallet holds in urufu collections (Sell tab)
///
/// Listings are only accepted for collections launched through our NFT and
/// DN404 lanes, priced in ETH, with no platform fee item. Cancels happen on
/// chain (Seaport cancel / incrementCounter); every read re-checks Seaport
/// order status, the seller's counter, ownerOf and the Seaport approval, so a
/// filled, cancelled, moved or burned (DN404) listing drops out on the next
/// read even before the indexer has seen the event.
///
/// Rate limits match the NFT whitelist routes: 20/min for writes, 120/min for
/// reads, per IP.

import type { FastifyInstance } from 'fastify';
import { isAddress, type Hex } from 'viem';

import { sql as defaultSql } from '../db.ts';
import {
  StateCache,
  listingJson,
  submitListing,
  withLiveness,
  type MarketDeps,
  type OwnedScanner,
  type StoredListing,
} from '../market.ts';
import { holdersOwnedScanner, indexerMarketCollections, viemMarketChain } from '../market-chain.ts';
import { memoryMarketStore, migrateMarket, postgresMarketStore } from '../market-store.ts';
import {
  RarityIndex,
  fillMeta,
  memoryMetaStore,
  postgresMetaStore,
  type MetaStore,
  type TokenMeta,
} from '../market-meta.ts';

const ORDER_BODY_LIMIT_BYTES = 16 * 1024;
const MAX_COLLECTION_LISTINGS = 500;
/// Metadata fetched in the background per listings request (the rest comes
/// on later requests or from the rarity scan).
const META_FILL_PER_REQUEST = 60;

export async function registerMarketRoutes(
  app: FastifyInstance,
  opts: { deps?: MarketDeps; meta?: MetaStore; owned?: OwnedScanner } = {},
): Promise<void> {
  const owned = opts.owned ?? holdersOwnedScanner();
  let deps = opts.deps;
  let meta = opts.meta;
  if (!deps || !meta) {
    const sql = defaultSql;
    if (!sql) {
      // Local demo only: listings live in process memory and vanish on restart.
      if (process.env.MARKET_DEV_MEMORY === '1' && process.env.NODE_ENV !== 'production') {
        app.log.warn('market: no DATABASE_URL, using in-memory listings (MARKET_DEV_MEMORY=1)');
        deps ??= { chain: viemMarketChain(), collections: indexerMarketCollections(), store: memoryMarketStore() };
        meta ??= memoryMetaStore();
      } else {
        app.log.warn('market: DATABASE_URL not set, /market/* disabled');
        return;
      }
    } else {
      await migrateMarket(sql);
      deps ??= {
        chain: viemMarketChain(),
        collections: indexerMarketCollections(),
        store: postgresMarketStore(sql),
      };
      meta ??= postgresMetaStore(sql);
    }
  }
  const d = deps;
  const metaStore = meta;
  const states = new StateCache();
  const rarity = new RarityIndex(metaStore, (msg, extra) => app.log.info(extra ?? {}, msg));
  const filling = new Set<string>();

  /// Kick off a bounded background metadata fetch for tokens we don't have.
  const backgroundFill = (collection: Hex, ids: bigint[]) => {
    const key = collection.toLowerCase();
    if (ids.length === 0 || filling.has(key)) return;
    filling.add(key);
    void fillMeta(metaStore, collection, ids.slice(0, META_FILL_PER_REQUEST))
      .catch((err) => app.log.warn({ err: err instanceof Error ? err.message : String(err), collection }, 'market: meta fill failed'))
      .finally(() => filling.delete(key));
  };

  const metaJson = (m: TokenMeta | undefined) =>
    m ? { name: m.name, image: m.image, attributes: m.attributes } : null;

  app.post(
    '/market/orders',
    { bodyLimit: ORDER_BODY_LIMIT_BYTES, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = (req.body ?? {}) as { order?: unknown; signature?: unknown };
      try {
        const res = await submitListing(d, { order: body.order, signature: body.signature });
        if (!res.ok) return reply.code(res.status).send({ code: res.code, ...(res.detail ?? {}) });
        states.forget([res.listing.orderHash]);
        return reply.code(201).send({ listing: listingJson(res.listing) });
      } catch (err) {
        if ((err as { code?: string }).code === 'INDEXER_UNAVAILABLE') {
          return reply.header('retry-after', '30').code(503).send({ code: 'INDEXER_UNAVAILABLE' });
        }
        req.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'market: submit failed');
        return reply.code(502).send({ code: 'CHAIN_READ_FAILED' });
      }
    },
  );

  app.get<{ Params: { addr: string }; Querystring: { sort?: string; fresh?: string } }>(
    '/market/collections/:addr/listings',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!isAddress(req.params.addr)) return reply.code(400).send({ code: 'BAD_ADDRESS' });
      const collection = req.params.addr.toLowerCase() as Hex;
      let info;
      try {
        info = await d.collections.lookup(collection);
      } catch {
        return reply.header('retry-after', '30').code(503).send({ code: 'INDEXER_UNAVAILABLE' });
      }
      if (!info) return reply.code(404).send({ code: 'NOT_OUR_COLLECTION' });

      const active = await d.store.activeByCollection(collection, MAX_COLLECTION_LISTINGS);
      if (req.query.fresh === '1') states.forget(active.map((l) => l.orderHash));
      const evaluated = await withLiveness(d, active, states);
      const live = evaluated.filter((e) => e.live.kind === 'live').map((e) => e.listing);

      const ids = live.map((l) => l.tokenId);
      const metas = await metaStore.get(collection, ids);
      backgroundFill(collection, ids.filter((id) => !metas.has(id.toString())));
      const r = rarity.ranksFor(collection, info.maxSupply);

      let rows = live.map((l) => ({
        ...listingJson(l, { kind: 'live' }),
        meta: metaJson(metas.get(l.tokenId.toString())),
        rarityRank: r?.ranks.get(l.tokenId.toString()) ?? null,
      }));
      if (req.query.sort === 'rarity' && r) {
        rows = rows.sort((a, b) => (a.rarityRank ?? Number.MAX_SAFE_INTEGER) - (b.rarityRank ?? Number.MAX_SAFE_INTEGER));
      }
      // One NFT can only sell once: if two sellers somehow both hold a live
      // listing for the same token (shouldn't happen; ownerOf gates both),
      // keep the cheapest.
      const seen = new Set<string>();
      rows = rows.filter((x) => (seen.has(x.tokenId) ? false : (seen.add(x.tokenId), true)));

      return reply.send({
        collection,
        lane: info.lane,
        pairedToken: info.pairedToken,
        unitWei: info.unitWei.toString(),
        count: rows.length,
        floorWei: live[0] ? live[0].priceWei.toString() : null,
        rarityReady: r !== null,
        rarityScanned: r?.scanned ?? 0,
        listings: rows,
      });
    },
  );

  app.get<{ Params: { addr: string; id: string }; Querystring: { fresh?: string } }>(
    '/market/tokens/:addr/:id',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!isAddress(req.params.addr) || !/^\d{1,78}$/.test(req.params.id)) return reply.code(400).send({ code: 'BAD_PARAMS' });
      const collection = req.params.addr.toLowerCase() as Hex;
      const tokenId = BigInt(req.params.id);
      let info;
      try {
        info = await d.collections.lookup(collection);
      } catch {
        return reply.header('retry-after', '30').code(503).send({ code: 'INDEXER_UNAVAILABLE' });
      }
      if (!info) return reply.code(404).send({ code: 'NOT_OUR_COLLECTION' });
      const active = await d.store.activeByToken(collection, tokenId);
      if (req.query.fresh === '1') states.forget(active.map((l) => l.orderHash));
      const evaluated = await withLiveness(d, active, states);
      const live = evaluated.filter((e) => e.live.kind === 'live').map((e) => e.listing);
      // Active but not fillable right now. Still signed and public, and fillable
      // again if the NFT comes back or approval is restored, so the seller
      // needs to see them to cancel.
      const paused = evaluated.filter((e) => e.live.kind === 'hidden').map((e) => listingJson(e.listing, e.live));
      const metas = await metaStore.get(collection, [tokenId]);
      if (!metas.has(tokenId.toString())) backgroundFill(collection, [tokenId]);
      const r = rarity.ranksFor(collection, info.maxSupply);
      return reply.send({
        collection,
        tokenId: tokenId.toString(),
        lane: info.lane,
        pairedToken: info.pairedToken,
        unitWei: info.unitWei.toString(),
        listing: live[0] ? listingJson(live[0], { kind: 'live' }) : null,
        paused,
        meta: metaJson(metas.get(tokenId.toString())),
        rarityRank: r?.ranks.get(tokenId.toString()) ?? null,
        rarityScanned: r?.scanned ?? 0,
      });
    },
  );

  /// Collection index for the /market page. Floor + count come from live
  /// listings only (same liveness check as the per-collection route).
  let summaryCache: { at: number; body: unknown } | null = null;
  app.get(
    '/market/collections',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      if (summaryCache && Date.now() - summaryCache.at < 15_000) return reply.send(summaryCache.body);
      let cols;
      try {
        cols = await d.collections.list();
      } catch {
        return reply.header('retry-after', '30').code(503).send({ code: 'INDEXER_UNAVAILABLE' });
      }
      const out = [];
      for (const c of cols) {
        const active = await d.store.activeByCollection(c.collection, MAX_COLLECTION_LISTINGS);
        const live = (await withLiveness(d, active, states)).filter((e) => e.live.kind === 'live');
        const tokens = new Set(live.map((e) => e.listing.tokenId.toString()));
        out.push({
          collection: c.collection,
          lane: c.lane,
          name: c.name,
          ticker: c.ticker,
          pairedToken: c.pairedToken,
          unitWei: c.unitWei.toString(),
          maxSupply: c.maxSupply.toString(),
          floorWei: live[0] ? live[0].listing.priceWei.toString() : null,
          count: tokens.size,
        });
      }
      const body = { collections: out };
      summaryCache = { at: Date.now(), body };
      return reply.send(body);
    },
  );

  /// The Sell tab: what a wallet can list. Scans each collection's transfer
  /// logs (cached, incremental) and confirms with ownerOf.
  const ownedCache = new Map<string, { at: number; body: unknown }>();
  app.get<{ Params: { addr: string }; Querystring: { fresh?: string } }>(
    '/market/owned/:addr',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!isAddress(req.params.addr)) return reply.code(400).send({ code: 'BAD_ADDRESS' });
      const wallet = req.params.addr.toLowerCase() as Hex;
      const hit = ownedCache.get(wallet);
      if (hit && req.query.fresh !== '1' && Date.now() - hit.at < 20_000) return reply.send(hit.body);
      let cols;
      try {
        cols = await d.collections.list();
      } catch {
        return reply.header('retry-after', '30').code(503).send({ code: 'INDEXER_UNAVAILABLE' });
      }
      let tokens;
      try {
        tokens = await owned(wallet, cols);
      } catch (err) {
        req.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'market: owned scan failed');
        return reply.code(502).send({ code: 'SCAN_FAILED' });
      }
      const byAddr = new Map(cols.map((c) => [c.collection, c]));
      const items = [];
      for (const t of tokens.slice(0, 500)) {
        const c = byAddr.get(t.collection);
        if (!c) continue;
        items.push({ collection: t.collection, tokenId: t.tokenId.toString(), lane: c.lane, name: c.name, ticker: c.ticker });
      }
      const body = { wallet, items };
      ownedCache.set(wallet, { at: Date.now(), body });
      if (ownedCache.size > 2_000) ownedCache.clear();
      return reply.send(body);
    },
  );

  app.get<{ Params: { addr: string }; Querystring: { fresh?: string } }>(
    '/market/wallet/:addr',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!isAddress(req.params.addr)) return reply.code(400).send({ code: 'BAD_ADDRESS' });
      const seller = req.params.addr.toLowerCase() as Hex;
      const rows = await d.store.bySeller(seller, 200);
      const active = rows.filter((l) => l.status === 'active');
      if (req.query.fresh === '1') states.forget(active.map((l) => l.orderHash));
      const evaluated = await withLiveness(d, active, states);
      const byHash = new Map(evaluated.map((e) => [e.listing.orderHash, e.live]));
      const out = rows.map((l: StoredListing) => {
        const live = byHash.get(l.orderHash);
        if (live?.kind === 'dead') return listingJson({ ...l, status: live.status });
        return listingJson(l, live);
      });
      return reply.send({ seller, listings: out });
    },
  );
}
