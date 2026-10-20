/// Postgres storage for marketplace listings (site db, `app` schema, next to
/// the profile / chat / rewards tables). Tables are created idempotently on
/// boot, same as every other route module.

import type { Hex } from 'viem';

import { sql as defaultSql } from './db.ts';
import type { Lane, ListingStatus, MarketStore, StoredListing } from './market.ts';
import type { WireOrder } from '../../shared/seaport.ts';

type Sql = NonNullable<typeof defaultSql>;

export async function migrateMarket(sql: Sql): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS app`;
  await sql`
    CREATE TABLE IF NOT EXISTS app.market_listings (
      order_hash       text           PRIMARY KEY,
      chain_id         integer        NOT NULL,
      collection       text           NOT NULL,
      token_id         numeric(78, 0) NOT NULL,
      lane             text           NOT NULL,
      seller           text           NOT NULL,
      price_wei        numeric(78, 0) NOT NULL,
      royalty_wei      numeric(78, 0) NOT NULL DEFAULT 0,
      royalty_receiver text,
      start_time       bigint         NOT NULL,
      end_time         bigint         NOT NULL,
      counter          numeric(78, 0) NOT NULL,
      order_json       jsonb          NOT NULL,
      signature        text           NOT NULL,
      status           text           NOT NULL CHECK (status IN ('active', 'filled', 'cancelled', 'expired')),
      created_at       timestamptz    NOT NULL DEFAULT now(),
      updated_at       timestamptz    NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS market_listings_collection_idx ON app.market_listings (collection, status, price_wei)`;
  await sql`CREATE INDEX IF NOT EXISTS market_listings_token_idx ON app.market_listings (collection, token_id, status)`;
  await sql`CREATE INDEX IF NOT EXISTS market_listings_seller_idx ON app.market_listings (seller, created_at DESC)`;

  /// Per-token metadata cache (name, image, traits) for the Listed tab and
  /// rarity. Metadata for a token id doesn't change in practice; rows are
  /// refreshed only when missing.
  await sql`
    CREATE TABLE IF NOT EXISTS app.market_token_meta (
      collection  text           NOT NULL,
      token_id    numeric(78, 0) NOT NULL,
      name        text,
      image       text,
      attributes  jsonb          NOT NULL DEFAULT '[]'::jsonb,
      ok          boolean        NOT NULL,
      fetched_at  timestamptz    NOT NULL DEFAULT now(),
      PRIMARY KEY (collection, token_id)
    )
  `;
}

interface Row {
  order_hash: string;
  chain_id: number;
  collection: string;
  token_id: string;
  lane: string;
  seller: string;
  price_wei: string;
  royalty_wei: string;
  royalty_receiver: string | null;
  start_time: string;
  end_time: string;
  counter: string;
  order_json: WireOrder;
  signature: string;
  status: ListingStatus;
  created_at: Date;
}

function fromRow(r: Row): StoredListing {
  return {
    orderHash: r.order_hash as Hex,
    chainId: r.chain_id,
    collection: r.collection as Hex,
    tokenId: BigInt(r.token_id),
    lane: (r.lane === 'dn404' ? 'dn404' : 'nft') as Lane,
    seller: r.seller as Hex,
    priceWei: BigInt(r.price_wei),
    royaltyWei: BigInt(r.royalty_wei),
    royaltyReceiver: (r.royalty_receiver as Hex | null) ?? null,
    startTime: BigInt(r.start_time),
    endTime: BigInt(r.end_time),
    counter: BigInt(r.counter),
    order: r.order_json,
    signature: r.signature as Hex,
    status: r.status,
    createdAt: Math.floor(new Date(r.created_at).getTime() / 1000),
  };
}

export function postgresMarketStore(sql: Sql): MarketStore {
  return {
    async insert(l: StoredListing): Promise<boolean> {
      const res = await sql`
        INSERT INTO app.market_listings (
          order_hash, chain_id, collection, token_id, lane, seller, price_wei, royalty_wei,
          royalty_receiver, start_time, end_time, counter, order_json, signature, status
        ) VALUES (
          ${l.orderHash}, ${l.chainId}, ${l.collection}, ${l.tokenId.toString()}, ${l.lane}, ${l.seller},
          ${l.priceWei.toString()}, ${l.royaltyWei.toString()}, ${l.royaltyReceiver},
          ${l.startTime.toString()}, ${l.endTime.toString()}, ${l.counter.toString()},
          ${JSON.stringify(l.order)}::jsonb, ${l.signature}, ${l.status}
        )
        ON CONFLICT (order_hash) DO NOTHING
      `;
      return res.count === 1;
    },

    async activeByCollection(collection: Hex, limit: number): Promise<StoredListing[]> {
      const rows = await sql<Row[]>`
        SELECT * FROM app.market_listings
        WHERE collection = ${collection.toLowerCase()} AND status = 'active'
        ORDER BY price_wei ASC, created_at ASC
        LIMIT ${limit}
      `;
      return rows.map(fromRow);
    },

    async activeByToken(collection: Hex, tokenId: bigint): Promise<StoredListing[]> {
      const rows = await sql<Row[]>`
        SELECT * FROM app.market_listings
        WHERE collection = ${collection.toLowerCase()} AND token_id = ${tokenId.toString()} AND status = 'active'
        ORDER BY price_wei ASC
        LIMIT 50
      `;
      return rows.map(fromRow);
    },

    async bySeller(seller: Hex, limit: number): Promise<StoredListing[]> {
      const rows = await sql<Row[]>`
        SELECT * FROM app.market_listings
        WHERE seller = ${seller.toLowerCase()}
        ORDER BY (status = 'active') DESC, created_at DESC
        LIMIT ${limit}
      `;
      return rows.map(fromRow);
    },

    async setStatus(orderHash: Hex, status: ListingStatus): Promise<void> {
      await sql`
        UPDATE app.market_listings SET status = ${status}, updated_at = now()
        WHERE order_hash = ${orderHash} AND status = 'active'
      `;
    },
  };
}

/// In-memory store for tests and for local dev without Postgres.
export function memoryMarketStore(): MarketStore & { all(): StoredListing[] } {
  const rows = new Map<string, StoredListing>();
  return {
    all: () => [...rows.values()],
    async insert(l) {
      if (rows.has(l.orderHash)) return false;
      rows.set(l.orderHash, { ...l });
      return true;
    },
    async activeByCollection(collection, limit) {
      return [...rows.values()]
        .filter((l) => l.collection === collection.toLowerCase() && l.status === 'active')
        .sort((a, b) => (a.priceWei < b.priceWei ? -1 : a.priceWei > b.priceWei ? 1 : a.createdAt - b.createdAt))
        .slice(0, limit);
    },
    async activeByToken(collection, tokenId) {
      return [...rows.values()].filter(
        (l) => l.collection === collection.toLowerCase() && l.tokenId === tokenId && l.status === 'active',
      );
    },
    async bySeller(seller, limit) {
      return [...rows.values()]
        .filter((l) => l.seller === seller.toLowerCase())
        .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.createdAt - a.createdAt)
        .slice(0, limit);
    },
    async setStatus(orderHash, status) {
      const r = rows.get(orderHash);
      if (r && r.status === 'active') r.status = status;
    },
  };
}
