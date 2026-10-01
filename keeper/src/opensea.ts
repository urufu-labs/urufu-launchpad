/**
 * OpenSea listings + Seaport fulfillment for MirrorFloorSupport.
 *
 * ListingsProvider is the seam: production uses OpenSeaProvider (real API,
 * key only ever sent to api.opensea.io); the fork harness injects a
 * provider that returns a real Seaport order signed on the fork. Both hand
 * the keeper the SAME shape of fulfillment data (`function` signature +
 * nested `input_data`), which encodeFulfillment turns into calldata, so the
 * fork test exercises the production encode path.
 *
 * OpenSea API v2 (docs.opensea.io):
 *   GET  /api/v2/chain/{chain}/contract/{address}           -> { collection: slug }
 *   GET  /api/v2/listings/collection/{slug}/best?limit=N    -> { listings: [...] }
 *   POST /api/v2/listings/fulfillment_data                  -> { fulfillment_data: { transaction } }
 */
import { encodeFunctionData, parseAbiItem, type AbiFunction, type AbiParameter, type Address, type Hex } from 'viem';

export interface Listing {
  orderHash: Hex;
  protocolAddress: Address;
  tokenId: bigint;
  /// Total price in wei. Only native-ETH listings are returned.
  priceWei: bigint;
}

export interface FulfillmentTx {
  to: Address;
  value: bigint;
  /// Solidity signature, e.g. `fulfillOrder(((address,...),bytes),bytes32)`.
  function: string;
  /// Nested args; objects are positional in declaration order (OpenSea's
  /// serializer emits struct fields in order).
  input_data: Record<string, unknown>;
}

export interface ListingsProvider {
  bestListings(mirror: Address, limit: number): Promise<Listing[]>;
  fulfillment(listing: Listing, fulfiller: Address): Promise<FulfillmentTx>;
}

/// Convert API JSON into viem args, guided by the ABI param types.
function coerce(param: AbiParameter, value: unknown): unknown {
  const t = param.type;
  if (t.endsWith(']')) {
    const inner = { ...param, type: t.slice(0, t.lastIndexOf('[')) } as AbiParameter;
    return (value as unknown[]).map((v) => coerce(inner, v));
  }
  if (t === 'tuple') {
    const comps = (param as { components: readonly AbiParameter[] }).components;
    const vals = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    if (vals.length !== comps.length) throw new Error(`tuple arity mismatch: got ${vals.length}, want ${comps.length}`);
    return comps.map((c, i) => coerce(c, vals[i]));
  }
  if (t.startsWith('uint') || t.startsWith('int')) return BigInt(value as string | number | bigint);
  if (t === 'bool') return Boolean(value);
  return value;
}

export function encodeFulfillment(tx: FulfillmentTx): Hex {
  const fn = parseAbiItem(`function ${tx.function}`) as AbiFunction;
  const vals = Object.values(tx.input_data);
  if (vals.length !== fn.inputs.length) throw new Error(`fulfillment arg count mismatch for ${tx.function}`);
  const args = fn.inputs.map((p, i) => coerce(p, vals[i]));
  return encodeFunctionData({ abi: [fn], functionName: fn.name, args });
}

export class OpenSeaProvider implements ListingsProvider {
  private readonly slugs = new Map<string, string>();
  private readonly apiKey: string;
  private readonly chain: string;
  private readonly base: string;
  constructor(apiKey: string, chain: string, base = 'https://api.opensea.io') {
    this.apiKey = apiKey;
    this.chain = chain;
    this.base = base;
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, { headers: { 'x-api-key': this.apiKey, accept: 'application/json' } });
    if (!res.ok) throw new Error(`OpenSea GET ${path} -> ${res.status}`);
    return res.json();
  }

  async slugFor(mirror: Address): Promise<string> {
    const k = mirror.toLowerCase();
    const cached = this.slugs.get(k);
    if (cached) return cached;
    const j = (await this.get(`/api/v2/chain/${this.chain}/contract/${mirror}`)) as { collection?: string };
    if (!j.collection) throw new Error(`OpenSea has no collection for ${mirror} on ${this.chain}`);
    this.slugs.set(k, j.collection);
    return j.collection;
  }

  async bestListings(mirror: Address, limit: number): Promise<Listing[]> {
    const slug = await this.slugFor(mirror);
    const j = (await this.get(`/api/v2/listings/collection/${slug}/best?limit=${limit}`)) as { listings?: Array<Record<string, any>> };
    const out: Listing[] = [];
    for (const l of j.listings ?? []) {
      const price = l.price?.current;
      // Native ETH only (OpenSea reports currency "ETH" with 18 decimals).
      if (!price || price.currency !== 'ETH' || Number(price.decimals) !== 18) continue;
      const offer = l.protocol_data?.parameters?.offer?.[0];
      if (!offer || String(offer.token).toLowerCase() !== mirror.toLowerCase()) continue;
      out.push({
        orderHash: l.order_hash as Hex,
        protocolAddress: l.protocol_address as Address,
        tokenId: BigInt(offer.identifierOrCriteria),
        priceWei: BigInt(price.value),
      });
    }
    return out;
  }

  async fulfillment(listing: Listing, fulfiller: Address): Promise<FulfillmentTx> {
    const res = await fetch(`${this.base}/api/v2/listings/fulfillment_data`, {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        listing: { hash: listing.orderHash, chain: this.chain, protocol_address: listing.protocolAddress },
        fulfiller: { address: fulfiller },
      }),
    });
    if (!res.ok) throw new Error(`OpenSea fulfillment_data -> ${res.status}`);
    const j = (await res.json()) as { fulfillment_data?: { transaction?: Record<string, any> } };
    const t = j.fulfillment_data?.transaction;
    if (!t) throw new Error('OpenSea fulfillment_data missing transaction');
    return { to: t.to as Address, value: BigInt(t.value ?? 0), function: t.function, input_data: t.input_data };
  }
}
