/// Zero-fee NFT marketplace: listing validation + liveness. See
/// docs/SPEC-marketplace.md and shared/seaport.ts for the order shape.
///
/// Everything chain- or storage-shaped comes in through `MarketDeps`, so the
/// route tests can drive the full validation path (including fee-item
/// injection attempts) without an RPC or a Postgres.

import {
  hashStruct,
  recoverTypedDataAddress,
  type Hex,
} from 'viem';

import {
  MARKET_CHAIN_ID,
  SEAPORT_ORDER_TYPES,
  checkListingShape,
  orderFromWire,
  orderToWire,
  seaportDomain,
  type OrderComponents,
  type Royalty,
  type WireOrder,
} from '../../shared/seaport.ts';

export type Lane = 'nft' | 'dn404';

export interface CollectionInfo {
  collection: Hex;
  lane: Lane;
  name: string;
  ticker: string;
  /// DN404 only: the paired ERC-20 and tokens per NFT (wei). Zero otherwise.
  pairedToken: Hex;
  unitWei: bigint;
  maxSupply: bigint;
  /// Block the collection was launched at (scan start for ownership).
  launchBlock: bigint;
}

/// On-chain state a listing's liveness depends on.
export interface ListingChainState {
  /// ownerOf(tokenId); null when the call reverted (DN404 NFT burned, or
  /// never minted).
  owner: Hex | null;
  /// isApprovedForAll(seller, Seaport) || getApproved(tokenId) == Seaport.
  approved: boolean;
  /// Seaport.getCounter(seller).
  counter: bigint;
  cancelled: boolean;
  filled: boolean;
}

export interface ListingRef {
  orderHash: Hex;
  collection: Hex;
  tokenId: bigint;
  seller: Hex;
}

export interface MarketChain {
  readStates(refs: ListingRef[]): Promise<ListingChainState[]>;
  /// ERC-2981 royaltyInfo(tokenId, salePrice). null when the collection has
  /// no royalty (call reverts, or receiver/amount is zero).
  readRoyalty(collection: Hex, tokenId: bigint, salePrice: bigint): Promise<Royalty | null>;
  /// ERC-1271 / ERC-6492 check for contract wallets. Only called when the
  /// local ECDSA recover didn't match the seller.
  verifyContractSignature(seller: Hex, order: OrderComponents, signature: Hex): Promise<boolean>;
}

export interface MarketCollections {
  lookup(collection: Hex): Promise<CollectionInfo | null>;
  /// Every collection launched through our NFT + DN404 lanes.
  list(): Promise<CollectionInfo[]>;
}

/// Token ids `wallet` holds in each of `collections` (verified owners only).
export type OwnedScanner = (
  wallet: Hex,
  collections: CollectionInfo[],
) => Promise<Array<{ collection: Hex; tokenId: bigint }>>;

export type ListingStatus = 'active' | 'filled' | 'cancelled' | 'expired';

export interface StoredListing {
  orderHash: Hex;
  chainId: number;
  collection: Hex;
  tokenId: bigint;
  lane: Lane;
  seller: Hex;
  priceWei: bigint;
  royaltyWei: bigint;
  royaltyReceiver: Hex | null;
  startTime: bigint;
  endTime: bigint;
  counter: bigint;
  order: WireOrder;
  signature: Hex;
  status: ListingStatus;
  createdAt: number; // unix seconds
  /// Last read found it not fillable (moved, burned, approval gone). Such
  /// rows sort after live-looking ones so they can't crowd out real listings.
  hidden?: boolean;
}

export type InsertResult = 'ok' | 'duplicate_order' | 'duplicate_token';

export interface MarketStore {
  /// Atomic: at most one active listing per (collection, token, seller), so
  /// two racing submits can't both land.
  insert(l: StoredListing): Promise<InsertResult>;
  activeByCollection(collection: Hex, limit: number): Promise<StoredListing[]>;
  activeByToken(collection: Hex, tokenId: bigint): Promise<StoredListing[]>;
  bySeller(seller: Hex, limit: number): Promise<StoredListing[]>;
  setStatus(orderHash: Hex, status: ListingStatus): Promise<void>;
  setHidden(orderHash: Hex, hidden: boolean): Promise<void>;
}

export interface MarketDeps {
  chain: MarketChain;
  collections: MarketCollections;
  store: MarketStore;
  now?: () => number; // unix seconds
}

export function seaportOrderHash(o: OrderComponents): Hex {
  return hashStruct({
    data: o,
    primaryType: 'OrderComponents',
    types: SEAPORT_ORDER_TYPES,
  });
}

/// True when `signature` is the seller's signature over the order. EOAs are
/// checked locally (65-byte or EIP-2098 64-byte); anything else goes to the
/// chain for ERC-1271.
export async function verifyListingSignature(
  chain: MarketChain,
  order: OrderComponents,
  signature: Hex,
): Promise<boolean> {
  try {
    const recovered = await recoverTypedDataAddress({
      domain: seaportDomain(MARKET_CHAIN_ID),
      types: SEAPORT_ORDER_TYPES,
      primaryType: 'OrderComponents',
      message: order,
      signature,
    });
    if (recovered.toLowerCase() === order.offerer.toLowerCase()) return true;
  } catch {
    // Not a plain ECDSA signature; a contract wallet may still accept it.
  }
  try {
    return await chain.verifyContractSignature(order.offerer, order, signature);
  } catch {
    return false;
  }
}

export type Liveness =
  | { kind: 'live' }
  /// Not fillable right now but could be again (NFT moved and may come back,
  /// approval revoked). Hidden from buyers, kept as active.
  /// not_started: start time still ahead, or the RPC node read an older
  /// counter than the one the order was signed at (lagging node).
  | { kind: 'hidden'; reason: 'not_owner' | 'not_approved' | 'not_started' }
  /// Never fillable again.
  | { kind: 'dead'; status: Exclude<ListingStatus, 'active'> };

export function evaluateListing(l: StoredListing, s: ListingChainState, nowS: number): Liveness {
  if (s.filled) return { kind: 'dead', status: 'filled' };
  if (s.cancelled) return { kind: 'dead', status: 'cancelled' };
  // incrementCounter() invalidates every order signed at an older counter.
  // The counter only goes up, so a LOWER chain value is a lagging RPC node,
  // never a cancel: hide for now, don't write a terminal status.
  if (s.counter > l.counter) return { kind: 'dead', status: 'cancelled' };
  if (l.endTime <= BigInt(nowS)) return { kind: 'dead', status: 'expired' };
  if (s.counter < l.counter || l.startTime > BigInt(nowS)) return { kind: 'hidden', reason: 'not_started' };
  if (!s.owner || s.owner.toLowerCase() !== l.seller.toLowerCase()) return { kind: 'hidden', reason: 'not_owner' };
  if (!s.approved) return { kind: 'hidden', reason: 'not_approved' };
  return { kind: 'live' };
}

export type SubmitResult =
  | { ok: true; listing: StoredListing }
  | { ok: false; status: number; code: string; detail?: Record<string, string> };

/// Validate a signed listing and store it. Order of checks: cheap structural
/// ones first, then the collection allowlist, signature, and finally the
/// chain reads.
export async function submitListing(
  deps: MarketDeps,
  body: { order: unknown; signature: unknown },
): Promise<SubmitResult> {
  const fail = (status: number, code: string, detail?: Record<string, string>): SubmitResult =>
    ({ ok: false, status, code, ...(detail ? { detail } : {}) });
  const nowS = deps.now ? deps.now() : Math.floor(Date.now() / 1000);

  let order: OrderComponents;
  try {
    order = orderFromWire(body.order as WireOrder);
  } catch (err) {
    return fail(400, 'BAD_ORDER', { reason: err instanceof Error ? err.message : 'malformed' });
  }
  const sig = body.signature;
  // 64/65-byte ECDSA, or a longer ERC-1271 / ERC-6492 blob (bounded).
  if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]+$/.test(sig) || sig.length < 130 || sig.length > 8_002 || sig.length % 2 !== 0) {
    return fail(400, 'BAD_SIGNATURE_FORMAT');
  }
  const signature = sig.toLowerCase() as Hex;

  const shape = checkListingShape(order, BigInt(nowS));
  if (!shape.ok) return fail(400, shape.code);
  const { seller, collection, tokenId, priceWei, royalty } = shape.shape;

  const info = await deps.collections.lookup(collection);
  if (!info) return fail(403, 'NOT_OUR_COLLECTION');

  if (!(await verifyListingSignature(deps.chain, order, signature))) return fail(401, 'BAD_SIGNATURE');

  const orderHash = seaportOrderHash(order);

  // Royalty: the second consideration item must be exactly what the
  // collection's ERC-2981 says for this token at this total price, and it
  // must be there when the collection asks for one.
  const onChainRoyalty = await deps.chain.readRoyalty(collection, tokenId, priceWei);
  if (onChainRoyalty) {
    if (!royalty) return fail(400, 'ROYALTY_MISSING', { receiver: onChainRoyalty.receiver, amount: onChainRoyalty.amount.toString() });
    if (royalty.receiver.toLowerCase() !== onChainRoyalty.receiver.toLowerCase() || royalty.amount !== onChainRoyalty.amount) {
      return fail(400, 'ROYALTY_MISMATCH', { receiver: onChainRoyalty.receiver, amount: onChainRoyalty.amount.toString() });
    }
  } else if (royalty) {
    // No royalty on chain, so a second payee can only be a fee.
    return fail(400, 'EXTRA_CONSIDERATION_ITEM');
  }

  const [state] = await deps.chain.readStates([{ orderHash, collection, tokenId, seller }]);
  if (!state) return fail(502, 'CHAIN_READ_FAILED');
  if (state.filled || state.cancelled) return fail(409, 'ORDER_DEAD');
  if (state.counter !== order.counter) return fail(409, 'STALE_COUNTER', { counter: state.counter.toString() });
  if (!state.owner || state.owner.toLowerCase() !== seller) return fail(409, 'NOT_OWNER');
  if (!state.approved) return fail(409, 'NOT_APPROVED');

  // One live listing per token per seller. Re-pricing means cancelling the
  // old order on-chain first; otherwise the cheaper signed order would still
  // be fillable by anyone who saved it.
  const existing = (await deps.store.activeByToken(collection, tokenId)).filter((l) => l.seller === seller && l.orderHash !== orderHash);
  if (existing.length > 0) {
    const states = await deps.chain.readStates(existing);
    for (const [i, old] of existing.entries()) {
      const s = states[i];
      if (!s) return fail(409, 'ALREADY_LISTED', { orderHash: old.orderHash });
      const live = evaluateListing(old, s, nowS);
      if (live.kind === 'dead') {
        await deps.store.setStatus(old.orderHash, live.status);
        continue;
      }
      return fail(409, 'ALREADY_LISTED', { orderHash: old.orderHash });
    }
  }

  const listing: StoredListing = {
    orderHash,
    chainId: MARKET_CHAIN_ID,
    collection,
    tokenId,
    lane: info.lane,
    seller,
    priceWei,
    royaltyWei: royalty?.amount ?? 0n,
    royaltyReceiver: royalty?.receiver ?? null,
    startTime: order.startTime,
    endTime: order.endTime,
    counter: order.counter,
    order: orderToWire(order),
    signature,
    status: 'active',
    createdAt: nowS,
  };
  const inserted = await deps.store.insert(listing);
  if (inserted === 'duplicate_order') return fail(409, 'DUPLICATE_ORDER', { orderHash });
  if (inserted === 'duplicate_token') return fail(409, 'ALREADY_LISTED');
  return { ok: true, listing };
}

/// Read chain state for `listings` (bounded cache), persist anything that
/// became dead, and return each listing with its liveness.
export async function withLiveness(
  deps: MarketDeps,
  listings: StoredListing[],
  cache: StateCache,
): Promise<Array<{ listing: StoredListing; live: Liveness }>> {
  if (listings.length === 0) return [];
  const nowS = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const states = await cache.get(deps.chain, listings);
  const out: Array<{ listing: StoredListing; live: Liveness }> = [];
  for (const [i, listing] of listings.entries()) {
    const s = states[i];
    // Chain read failed for this one: show nothing rather than guess.
    if (!s) continue;
    const live = evaluateListing(listing, s, nowS);
    if (live.kind === 'dead') {
      void deps.store.setStatus(listing.orderHash, live.status).catch(() => {});
    } else if ((live.kind === 'hidden') !== !!listing.hidden) {
      void deps.store.setHidden(listing.orderHash, live.kind === 'hidden').catch(() => {});
    }
    out.push({ listing, live });
  }
  return out;
}

/// Short-lived per-order chain state cache, so a busy collection page doesn't
/// turn every view into a multicall.
export class StateCache {
  private map = new Map<string, { at: number; state: ListingChainState }>();
  private ttlMs: number;
  private max: number;
  constructor(ttlMs = 15_000, max = 5_000) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  async get(chain: MarketChain, refs: ListingRef[]): Promise<Array<ListingChainState | null>> {
    const now = Date.now();
    const out: Array<ListingChainState | null> = new Array(refs.length).fill(null);
    const misses: Array<{ i: number; ref: ListingRef }> = [];
    refs.forEach((ref, i) => {
      const hit = this.map.get(ref.orderHash);
      if (hit && now - hit.at < this.ttlMs) out[i] = hit.state;
      else misses.push({ i, ref });
    });
    if (misses.length > 0) {
      let fresh: ListingChainState[] = [];
      try {
        fresh = await chain.readStates(misses.map((m) => m.ref));
      } catch {
        fresh = [];
      }
      misses.forEach(({ i, ref }, k) => {
        const s = fresh[k];
        if (!s) return;
        out[i] = s;
        this.map.set(ref.orderHash, { at: now, state: s });
      });
      if (this.map.size > this.max) {
        for (const [k, v] of this.map) if (now - v.at >= this.ttlMs) this.map.delete(k);
      }
    }
    return out;
  }

  /// Drop cached state for these orders (after a fill/cancel the UI asks again).
  forget(orderHashes: string[]): void {
    for (const h of orderHashes) this.map.delete(h);
  }
}

/// JSON shape the web reads.
export function listingJson(l: StoredListing, live?: Liveness) {
  return {
    orderHash: l.orderHash,
    chainId: l.chainId,
    collection: l.collection,
    tokenId: l.tokenId.toString(),
    lane: l.lane,
    seller: l.seller,
    priceWei: l.priceWei.toString(),
    royaltyWei: l.royaltyWei.toString(),
    royaltyReceiver: l.royaltyReceiver,
    startTime: l.startTime.toString(),
    endTime: l.endTime.toString(),
    order: l.order,
    signature: l.signature,
    status: l.status,
    createdAt: l.createdAt,
    ...(live ? { live: live.kind === 'live', hiddenReason: live.kind === 'hidden' ? live.reason : null } : {}),
  };
}
