/// Zero-fee NFT marketplace client (docs/SPEC-marketplace.md).
///
/// Orders are Seaport 1.6 listings built by shared/seaport.ts, signed in the
/// seller's wallet (EIP-712, no gas), stored by compile-service, and filled
/// on-chain by the buyer through Seaport. No fee item, ever.

import { formatEther, type Address, type Hex } from 'viem';

import {
  MARKET_CHAIN_ID,
  SEAPORT_ABI,
  SEAPORT_ADDRESS,
  SEAPORT_ORDER_TYPES,
  buildListingOrder,
  orderFromWire,
  orderParameters,
  orderToWire,
  seaportDomain,
  type OrderComponents,
  type Royalty,
  type WireOrder,
} from '../../../shared/seaport';
import { COMPILE_SERVICE_URL } from './config';

export {
  MARKET_CHAIN_ID,
  SEAPORT_ABI,
  SEAPORT_ADDRESS,
  SEAPORT_ORDER_TYPES,
  buildListingOrder,
  orderFromWire,
  orderParameters,
  orderToWire,
  seaportDomain,
};
export type { OrderComponents, Royalty, WireOrder };

/// Site copy rule from the spec. Shown wherever a price is set or paid.
export const NO_FEE_COPY = 'No marketplace fee. Creator royalty, if set, still goes to the creator.';

/// Listing length choices (spec M4: max 180 days).
export const EXPIRY_CHOICES: ReadonlyArray<{ label: string; seconds: number }> = [
  { label: '1 day', seconds: 86_400 },
  { label: '7 days', seconds: 7 * 86_400 },
  { label: '30 days', seconds: 30 * 86_400 },
  { label: '90 days', seconds: 90 * 86_400 },
  { label: '180 days', seconds: 180 * 86_400 },
];

export const ERC721_MARKET_ABI = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'address' }] },
  {
    type: 'function', name: 'isApprovedForAll', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'operator', type: 'address' }], outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable',
    inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [],
  },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'string' }] },
  {
    type: 'function', name: 'royaltyInfo', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'salePrice', type: 'uint256' }],
    outputs: [{ name: 'receiver', type: 'address' }, { name: 'royaltyAmount', type: 'uint256' }],
  },
] as const;

export const DN404_SKIP_NFT_ABI = [
  { type: 'function', name: 'getSkipNFT', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setSkipNFT', stateMutability: 'nonpayable', inputs: [{ name: 'skipNFT', type: 'bool' }], outputs: [{ type: 'bool' }] },
] as const;

export interface TokenTrait {
  trait_type: string;
  value: string;
}

export interface MarketListing {
  orderHash: Hex;
  chainId: number;
  collection: Address;
  tokenId: string;
  lane: 'nft' | 'dn404';
  seller: Address;
  priceWei: string;
  royaltyWei: string;
  royaltyReceiver: Address | null;
  startTime: string;
  endTime: string;
  order: WireOrder;
  signature: Hex;
  status: 'active' | 'filled' | 'cancelled' | 'expired';
  createdAt: number;
  live?: boolean;
  hiddenReason?: 'not_owner' | 'not_approved' | null;
  meta?: { name: string | null; image: string | null; attributes: TokenTrait[] } | null;
  rarityRank?: number | null;
}

export interface CollectionListings {
  collection: Address;
  lane: 'nft' | 'dn404';
  pairedToken: Address;
  unitWei: string;
  count: number;
  floorWei: string | null;
  rarityReady: boolean;
  rarityScanned: number;
  listings: MarketListing[];
}

export interface TokenListing {
  collection: Address;
  tokenId: string;
  lane: 'nft' | 'dn404';
  pairedToken: Address;
  unitWei: string;
  listing: MarketListing | null;
  meta: { name: string | null; image: string | null; attributes: TokenTrait[] } | null;
  rarityRank: number | null;
  rarityScanned: number;
}

const BASE = COMPILE_SERVICE_URL.replace(/\/$/, '');

async function getJson<T>(path: string): Promise<T | null> {
  if (!BASE) return null;
  try {
    const res = await fetch(`${BASE}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function fetchCollectionListings(collection: Address, opts: { sort?: 'price' | 'rarity'; fresh?: boolean } = {}) {
  const q = new URLSearchParams();
  if (opts.sort === 'rarity') q.set('sort', 'rarity');
  if (opts.fresh) q.set('fresh', '1');
  const qs = q.toString();
  return getJson<CollectionListings>(`/market/collections/${collection}/listings${qs ? `?${qs}` : ''}`);
}

export function fetchTokenListing(collection: Address, tokenId: string, fresh = false) {
  return getJson<TokenListing>(`/market/tokens/${collection}/${tokenId}${fresh ? '?fresh=1' : ''}`);
}

export function fetchWalletListings(wallet: Address, fresh = false) {
  return getJson<{ seller: Address; listings: MarketListing[] }>(`/market/wallet/${wallet}${fresh ? '?fresh=1' : ''}`);
}

/// Plain-language reasons for the server's refusal codes.
const SUBMIT_ERRORS: Record<string, string> = {
  NOT_OWNER: "This wallet doesn't own that NFT anymore.",
  NOT_APPROVED: 'Approve the marketplace for this collection first.',
  STALE_COUNTER: 'Your listings were reset on Seaport. Refresh and try again.',
  ALREADY_LISTED: 'This NFT is already listed. Cancel that listing first to change the price.',
  ROYALTY_MISSING: "The creator royalty changed. Refresh and try again.",
  ROYALTY_MISMATCH: "The creator royalty changed. Refresh and try again.",
  NOT_OUR_COLLECTION: 'Only collections launched on urufu can be listed here.',
  BAD_SIGNATURE: "The signature didn't match this wallet.",
  EXPIRY_TOO_LONG: 'Listings can last 180 days at most.',
  INDEXER_UNAVAILABLE: 'The marketplace is busy. Try again in a minute.',
};

export async function submitListing(order: OrderComponents, signature: Hex): Promise<{ ok: true; listing: MarketListing } | { ok: false; message: string }> {
  if (!BASE) return { ok: false, message: 'Marketplace is not configured.' };
  try {
    const res = await fetch(`${BASE}/market/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: orderToWire(order), signature }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: string; listing?: MarketListing };
    if (res.ok && body.listing) return { ok: true, listing: body.listing };
    const code = body.code ?? `HTTP_${res.status}`;
    return { ok: false, message: SUBMIT_ERRORS[code] ?? `Listing failed (${code}).` };
  } catch {
    return { ok: false, message: "Couldn't reach the marketplace. Try again." };
  }
}

/// Current unix time in seconds (order start/end times).
export function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

/// Random 256-bit salt so two listings of the same token never collide.
export function randomSalt(): bigint {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return BigInt(`0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`);
}

/// "0.0123" style ETH, trimmed to a sensible number of decimals.
export function formatEthShort(wei: bigint | string | null | undefined): string {
  if (wei === null || wei === undefined) return '';
  const v = typeof wei === 'string' ? BigInt(wei) : wei;
  const s = formatEther(v);
  const [i, f = ''] = s.split('.');
  if (!f) return i!;
  const keep = v >= 10n ** 18n ? 4 : 6;
  const trimmed = f.slice(0, keep).replace(/0+$/, '');
  return trimmed ? `${i}.${trimmed}` : i!;
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/// Seaport fulfillOrder args for a stored listing.
export function fulfillArgs(l: MarketListing) {
  const o = orderFromWire(l.order);
  return [{ parameters: orderParameters(o), signature: l.signature }, `0x${'00'.repeat(32)}` as Hex] as const;
}

/// Seaport cancel args for a stored listing (seller only).
export function cancelArgs(l: MarketListing) {
  return [[orderFromWire(l.order)]] as const;
}
