/**
 * Zero-fee NFT marketplace: Seaport 1.6 listing orders, shared by web +
 * compile-service. See docs/SPEC-marketplace.md.
 *
 * Deliberately import-free (like config-id.ts): hashing and signature checks
 * use each package's own viem with the types exported here, so the two sides
 * can never disagree on the order shape.
 *
 * A urufu listing is exactly:
 *   offer         = [ one ERC-721, amount 1 ]
 *   consideration = [ ETH to the seller, (ETH to the ERC-2981 receiver) ]
 *   orderType     = FULL_OPEN, zone = MARKET_ZONE, zoneHash = 0, conduitKey = 0
 * There is never a platform fee item. Anything else is rejected.
 */

export const MARKET_CHAIN_ID = 4663;
export const SEAPORT_ADDRESS = '0x0000000000000068F116a894984e2DB1123eB395' as const;
export const CONDUIT_CONTROLLER_ADDRESS = '0x00000000F9490004C11Cef243f5400493c00Ad63' as const;

/// Marker zone. Seaport never calls the zone of a FULL_OPEN order, but it does
/// emit it (indexed) in OrderFulfilled / OrderCancelled. Tagging our orders
/// with a fixed zone lets the indexer ask the RPC for only our marketplace's
/// events instead of every Seaport event on the chain (~1-2k per hour on RH).
/// keccak256("urufu.market.zone.v1")[12:], so nobody holds a key for it.
export const MARKET_ZONE = '0xcbaadd982f0770cf24fbd39f598edd3f8c5e6693' as const;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

export const MAX_LISTING_SECONDS = 180 * 24 * 60 * 60;
/// Wallet clocks drift; accept a start time a little in the future.
export const START_TIME_SLACK_SECONDS = 10 * 60;

export const ITEM_NATIVE = 0;
export const ITEM_ERC721 = 2;
export const ORDER_FULL_OPEN = 0;

export const ERC2981_INTERFACE_ID = '0x2a55205a' as const;

export function seaportDomain(chainId: number = MARKET_CHAIN_ID) {
  return {
    name: 'Seaport',
    version: '1.6',
    chainId,
    verifyingContract: SEAPORT_ADDRESS,
  } as const;
}

/// EIP-712 types for Seaport's OrderComponents (what the seller signs).
export const SEAPORT_ORDER_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' },
    { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' },
    { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
    { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' },
    { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' },
  ],
  OfferItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
} as const;

type Hex = `0x${string}`;

export interface OfferItem {
  itemType: number;
  token: Hex;
  identifierOrCriteria: bigint;
  startAmount: bigint;
  endAmount: bigint;
}

export interface ConsiderationItem extends OfferItem {
  recipient: Hex;
}

/// The signed struct. `counter` is Seaport's per-offerer counter at signing.
export interface OrderComponents {
  offerer: Hex;
  zone: Hex;
  offer: OfferItem[];
  consideration: ConsiderationItem[];
  orderType: number;
  startTime: bigint;
  endTime: bigint;
  zoneHash: Hex;
  salt: bigint;
  conduitKey: Hex;
  counter: bigint;
}

/// JSON form (bigints as decimal strings) for HTTP + jsonb.
export interface WireOfferItem {
  itemType: number;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
}
export interface WireConsiderationItem extends WireOfferItem {
  recipient: string;
}
export interface WireOrder {
  offerer: string;
  zone: string;
  offer: WireOfferItem[];
  consideration: WireConsiderationItem[];
  orderType: number;
  startTime: string;
  endTime: string;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  counter: string;
}

export function orderToWire(o: OrderComponents): WireOrder {
  const item = (i: OfferItem): WireOfferItem => ({
    itemType: i.itemType,
    token: i.token,
    identifierOrCriteria: i.identifierOrCriteria.toString(),
    startAmount: i.startAmount.toString(),
    endAmount: i.endAmount.toString(),
  });
  return {
    offerer: o.offerer,
    zone: o.zone,
    offer: o.offer.map(item),
    consideration: o.consideration.map((c) => ({ ...item(c), recipient: c.recipient })),
    orderType: o.orderType,
    startTime: o.startTime.toString(),
    endTime: o.endTime.toString(),
    zoneHash: o.zoneHash,
    salt: o.salt.toString(),
    conduitKey: o.conduitKey,
    counter: o.counter.toString(),
  };
}

const DEC_RE = /^\d{1,78}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const B32_RE = /^0x[0-9a-fA-F]{64}$/;

/// Parse the wire form. Throws on anything malformed (caller maps to 400).
export function orderFromWire(w: WireOrder): OrderComponents {
  const big = (s: unknown, field: string): bigint => {
    if (typeof s !== 'string' || !DEC_RE.test(s)) throw new Error(`BAD_FIELD:${field}`);
    const v = BigInt(s);
    if (v >= 2n ** 256n) throw new Error(`BAD_FIELD:${field}`);
    return v;
  };
  const addr = (s: unknown, field: string): Hex => {
    if (typeof s !== 'string' || !ADDR_RE.test(s)) throw new Error(`BAD_FIELD:${field}`);
    return s.toLowerCase() as Hex;
  };
  const b32 = (s: unknown, field: string): Hex => {
    if (typeof s !== 'string' || !B32_RE.test(s)) throw new Error(`BAD_FIELD:${field}`);
    return s.toLowerCase() as Hex;
  };
  const u8 = (n: unknown, field: string): number => {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) throw new Error(`BAD_FIELD:${field}`);
    return n;
  };
  if (!w || typeof w !== 'object') throw new Error('BAD_FIELD:order');
  if (!Array.isArray(w.offer) || !Array.isArray(w.consideration)) throw new Error('BAD_FIELD:items');
  if (w.offer.length > 8 || w.consideration.length > 8) throw new Error('BAD_FIELD:items');
  const item = (i: WireOfferItem, f: string): OfferItem => ({
    itemType: u8(i?.itemType, `${f}.itemType`),
    token: addr(i?.token, `${f}.token`),
    identifierOrCriteria: big(i?.identifierOrCriteria, `${f}.identifierOrCriteria`),
    startAmount: big(i?.startAmount, `${f}.startAmount`),
    endAmount: big(i?.endAmount, `${f}.endAmount`),
  });
  return {
    offerer: addr(w.offerer, 'offerer'),
    zone: addr(w.zone, 'zone'),
    offer: w.offer.map((i, n) => item(i, `offer[${n}]`)),
    consideration: w.consideration.map((c, n) => ({
      ...item(c, `consideration[${n}]`),
      recipient: addr(c?.recipient, `consideration[${n}].recipient`),
    })),
    orderType: u8(w.orderType, 'orderType'),
    startTime: big(w.startTime, 'startTime'),
    endTime: big(w.endTime, 'endTime'),
    zoneHash: b32(w.zoneHash, 'zoneHash'),
    salt: big(w.salt, 'salt'),
    conduitKey: b32(w.conduitKey, 'conduitKey'),
    counter: big(w.counter, 'counter'),
  };
}

export interface Royalty {
  receiver: Hex;
  amount: bigint;
}

/// The one order shape we build. `priceWei` is what the buyer pays in total;
/// the royalty (if any) comes out of it, the rest goes to the seller.
export function buildListingOrder(p: {
  seller: Hex;
  collection: Hex;
  tokenId: bigint;
  priceWei: bigint;
  royalty: Royalty | null;
  startTime: bigint;
  endTime: bigint;
  salt: bigint;
  counter: bigint;
}): OrderComponents {
  if (p.priceWei <= 0n) throw new Error('PRICE_ZERO');
  const royalty = p.royalty && p.royalty.amount > 0n ? p.royalty : null;
  if (royalty && royalty.amount >= p.priceWei) throw new Error('ROYALTY_TOO_HIGH');
  const sellerAmount = p.priceWei - (royalty?.amount ?? 0n);
  const eth = (amount: bigint, recipient: Hex): ConsiderationItem => ({
    itemType: ITEM_NATIVE,
    token: ZERO_ADDRESS,
    identifierOrCriteria: 0n,
    startAmount: amount,
    endAmount: amount,
    recipient: recipient.toLowerCase() as Hex,
  });
  return {
    offerer: p.seller.toLowerCase() as Hex,
    zone: MARKET_ZONE,
    offer: [{
      itemType: ITEM_ERC721,
      token: p.collection.toLowerCase() as Hex,
      identifierOrCriteria: p.tokenId,
      startAmount: 1n,
      endAmount: 1n,
    }],
    consideration: royalty
      ? [eth(sellerAmount, p.seller), eth(royalty.amount, royalty.receiver)]
      : [eth(sellerAmount, p.seller)],
    orderType: ORDER_FULL_OPEN,
    startTime: p.startTime,
    endTime: p.endTime,
    zoneHash: ZERO_BYTES32,
    salt: p.salt,
    conduitKey: ZERO_BYTES32,
    counter: p.counter,
  };
}

export interface ListingShape {
  seller: Hex;
  collection: Hex;
  tokenId: bigint;
  priceWei: bigint;
  sellerWei: bigint;
  /// The second consideration item, if present. The caller MUST check it
  /// against the collection's ERC-2981 royaltyInfo(tokenId, priceWei).
  royalty: Royalty | null;
}

export type ShapeResult = { ok: true; shape: ListingShape } | { ok: false; code: string };

/// Pure structural checks: everything that doesn't need the chain. Rejects
/// any order that isn't exactly the shape buildListingOrder produces (other
/// than price, times, salt, counter), so a client can't slip in a fee item,
/// a non-ETH payment, a Dutch auction, a restricted zone or a conduit.
export function checkListingShape(o: OrderComponents, nowS: bigint): ShapeResult {
  const no = (code: string): ShapeResult => ({ ok: false, code });
  if (o.orderType !== ORDER_FULL_OPEN) return no('ORDER_TYPE');
  if (o.zone.toLowerCase() !== MARKET_ZONE) return no('ZONE');
  if (o.zoneHash.toLowerCase() !== ZERO_BYTES32) return no('ZONE_HASH');
  if (o.conduitKey.toLowerCase() !== ZERO_BYTES32) return no('CONDUIT');
  if (o.offerer.toLowerCase() === ZERO_ADDRESS) return no('OFFERER');

  const nft = o.offer[0];
  if (o.offer.length !== 1 || !nft) return no('OFFER_COUNT');
  if (nft.itemType !== ITEM_ERC721) return no('OFFER_NOT_ERC721');
  if (nft.startAmount !== 1n || nft.endAmount !== 1n) return no('OFFER_AMOUNT');
  if (nft.token.toLowerCase() === ZERO_ADDRESS) return no('OFFER_TOKEN');

  const c = o.consideration;
  const first = c[0];
  const second = c[1];
  if (!first || c.length > 2) return no('CONSIDERATION_COUNT');
  for (const item of c) {
    if (item.itemType !== ITEM_NATIVE) return no('CONSIDERATION_NOT_ETH');
    if (item.token.toLowerCase() !== ZERO_ADDRESS) return no('CONSIDERATION_NOT_ETH');
    if (item.identifierOrCriteria !== 0n) return no('CONSIDERATION_IDENTIFIER');
    if (item.startAmount !== item.endAmount) return no('CONSIDERATION_NOT_FIXED');
    if (item.startAmount === 0n) return no('CONSIDERATION_ZERO');
  }
  if (first.recipient.toLowerCase() !== o.offerer.toLowerCase()) return no('FIRST_ITEM_NOT_SELLER');
  const royalty = second ? { receiver: second.recipient.toLowerCase() as Hex, amount: second.startAmount } : null;
  const priceWei = c.reduce((s, i) => s + i.startAmount, 0n);
  if (priceWei <= 0n) return no('PRICE_ZERO');

  if (o.endTime <= o.startTime) return no('TIME_RANGE');
  if (o.startTime > nowS + BigInt(START_TIME_SLACK_SECONDS)) return no('START_IN_FUTURE');
  if (o.endTime <= nowS) return no('EXPIRED');
  if (o.endTime > nowS + BigInt(MAX_LISTING_SECONDS)) return no('EXPIRY_TOO_LONG');

  return {
    ok: true,
    shape: {
      seller: o.offerer.toLowerCase() as Hex,
      collection: nft.token.toLowerCase() as Hex,
      tokenId: nft.identifierOrCriteria,
      priceWei,
      sellerWei: first.startAmount,
      royalty,
    },
  };
}

/// Seaport `fulfillOrder` takes OrderParameters (the signed components with
/// `counter` swapped for `totalOriginalConsiderationItems`).
export function orderParameters(o: OrderComponents) {
  return {
    offerer: o.offerer,
    zone: o.zone,
    offer: o.offer,
    consideration: o.consideration,
    orderType: o.orderType,
    startTime: o.startTime,
    endTime: o.endTime,
    zoneHash: o.zoneHash,
    salt: o.salt,
    conduitKey: o.conduitKey,
    totalOriginalConsiderationItems: BigInt(o.consideration.length),
  };
}

/// Minimal Seaport 1.6 ABI: what web + compile-service call.
export const SEAPORT_ABI = [
  {
    type: 'function', name: 'getCounter', stateMutability: 'view',
    inputs: [{ name: 'offerer', type: 'address' }], outputs: [{ name: 'counter', type: 'uint256' }],
  },
  {
    type: 'function', name: 'getOrderStatus', stateMutability: 'view',
    inputs: [{ name: 'orderHash', type: 'bytes32' }],
    outputs: [
      { name: 'isValidated', type: 'bool' },
      { name: 'isCancelled', type: 'bool' },
      { name: 'totalFilled', type: 'uint256' },
      { name: 'totalSize', type: 'uint256' },
    ],
  },
  {
    type: 'function', name: 'incrementCounter', stateMutability: 'nonpayable',
    inputs: [], outputs: [{ name: 'newCounter', type: 'uint256' }],
  },
  {
    type: 'function', name: 'cancel', stateMutability: 'nonpayable',
    inputs: [{
      name: 'orders', type: 'tuple[]',
      components: [
        { name: 'offerer', type: 'address' },
        { name: 'zone', type: 'address' },
        {
          name: 'offer', type: 'tuple[]',
          components: [
            { name: 'itemType', type: 'uint8' },
            { name: 'token', type: 'address' },
            { name: 'identifierOrCriteria', type: 'uint256' },
            { name: 'startAmount', type: 'uint256' },
            { name: 'endAmount', type: 'uint256' },
          ],
        },
        {
          name: 'consideration', type: 'tuple[]',
          components: [
            { name: 'itemType', type: 'uint8' },
            { name: 'token', type: 'address' },
            { name: 'identifierOrCriteria', type: 'uint256' },
            { name: 'startAmount', type: 'uint256' },
            { name: 'endAmount', type: 'uint256' },
            { name: 'recipient', type: 'address' },
          ],
        },
        { name: 'orderType', type: 'uint8' },
        { name: 'startTime', type: 'uint256' },
        { name: 'endTime', type: 'uint256' },
        { name: 'zoneHash', type: 'bytes32' },
        { name: 'salt', type: 'uint256' },
        { name: 'conduitKey', type: 'bytes32' },
        { name: 'counter', type: 'uint256' },
      ],
    }],
    outputs: [{ name: 'cancelled', type: 'bool' }],
  },
  {
    type: 'function', name: 'fulfillOrder', stateMutability: 'payable',
    inputs: [
      {
        name: 'order', type: 'tuple',
        components: [
          {
            name: 'parameters', type: 'tuple',
            components: [
              { name: 'offerer', type: 'address' },
              { name: 'zone', type: 'address' },
              {
                name: 'offer', type: 'tuple[]',
                components: [
                  { name: 'itemType', type: 'uint8' },
                  { name: 'token', type: 'address' },
                  { name: 'identifierOrCriteria', type: 'uint256' },
                  { name: 'startAmount', type: 'uint256' },
                  { name: 'endAmount', type: 'uint256' },
                ],
              },
              {
                name: 'consideration', type: 'tuple[]',
                components: [
                  { name: 'itemType', type: 'uint8' },
                  { name: 'token', type: 'address' },
                  { name: 'identifierOrCriteria', type: 'uint256' },
                  { name: 'startAmount', type: 'uint256' },
                  { name: 'endAmount', type: 'uint256' },
                  { name: 'recipient', type: 'address' },
                ],
              },
              { name: 'orderType', type: 'uint8' },
              { name: 'startTime', type: 'uint256' },
              { name: 'endTime', type: 'uint256' },
              { name: 'zoneHash', type: 'bytes32' },
              { name: 'salt', type: 'uint256' },
              { name: 'conduitKey', type: 'bytes32' },
              { name: 'totalOriginalConsiderationItems', type: 'uint256' },
            ],
          },
          { name: 'signature', type: 'bytes' },
        ],
      },
      { name: 'fulfillerConduitKey', type: 'bytes32' },
    ],
    outputs: [{ name: 'fulfilled', type: 'bool' }],
  },
] as const;
