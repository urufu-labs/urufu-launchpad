/// Live implementations of the marketplace deps (market.ts): Robinhood RPC
/// reads through Multicall3, and the collection allowlist from the indexer.

import { createPublicClient, http, type Hex, type PublicClient } from 'viem';

import { scanHolders } from './holders-engine.ts';

import {
  MARKET_CHAIN_ID,
  SEAPORT_ABI,
  SEAPORT_ADDRESS,
  SEAPORT_ORDER_TYPES,
  ZERO_ADDRESS,
  seaportDomain,
  type OrderComponents,
  type Royalty,
} from '../../shared/seaport.ts';
import type {
  CollectionInfo,
  Lane,
  OwnedScanner,
  ListingChainState,
  ListingRef,
  MarketChain,
  MarketCollections,
} from './market.ts';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

const ERC721_READ_ABI = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getApproved', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'address' }] },
  {
    type: 'function', name: 'isApprovedForAll', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'operator', type: 'address' }], outputs: [{ type: 'bool' }],
  },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'string' }] },
  {
    type: 'function', name: 'royaltyInfo', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'salePrice', type: 'uint256' }],
    outputs: [{ name: 'receiver', type: 'address' }, { name: 'royaltyAmount', type: 'uint256' }],
  },
] as const;

export function marketRpcUrl(): string {
  return process.env.ROBINHOOD_RPC_URL?.split(',')[0]?.trim() || 'https://rpc.mainnet.chain.robinhood.com';
}

let _client: PublicClient | null = null;
export function marketClient(): PublicClient {
  if (!_client) _client = createPublicClient({ transport: http(marketRpcUrl(), { timeout: 15_000 }) });
  return _client;
}

/// Max calls per multicall. Each listing costs 5.
const MULTICALL_CHUNK = 500;

export function viemMarketChain(client: PublicClient = marketClient()): MarketChain {
  return {
    async readStates(refs: ListingRef[]): Promise<ListingChainState[]> {
      if (refs.length === 0) return [];
      const calls = refs.flatMap((r) => [
        { address: r.collection, abi: ERC721_READ_ABI, functionName: 'ownerOf', args: [r.tokenId] },
        { address: r.collection, abi: ERC721_READ_ABI, functionName: 'isApprovedForAll', args: [r.seller, SEAPORT_ADDRESS] },
        { address: r.collection, abi: ERC721_READ_ABI, functionName: 'getApproved', args: [r.tokenId] },
        { address: SEAPORT_ADDRESS, abi: SEAPORT_ABI, functionName: 'getOrderStatus', args: [r.orderHash] },
        { address: SEAPORT_ADDRESS, abi: SEAPORT_ABI, functionName: 'getCounter', args: [r.seller] },
      ] as const);
      const results: Array<{ status: 'success' | 'failure'; result?: unknown }> = [];
      for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) {
        const chunk = await client.multicall({
          contracts: calls.slice(i, i + MULTICALL_CHUNK) as never,
          allowFailure: true,
          multicallAddress: MULTICALL3,
        });
        results.push(...(chunk as typeof results));
      }
      return refs.map((_, k) => {
        const [own, all, one, status, counter] = results.slice(k * 5, k * 5 + 5);
        // Seaport reads never fail for a real order hash / address; if they
        // did, the state is unknown. Throw so callers treat it as a failed
        // read (StateCache hides the listing, submit returns 502).
        if (status?.status !== 'success' || counter?.status !== 'success') {
          throw new Error('seaport read failed');
        }
        const [, isCancelled, totalFilled, totalSize] = status.result as [boolean, boolean, bigint, bigint];
        const owner = own?.status === 'success' ? ((own.result as string).toLowerCase() as Hex) : null;
        const approvedAll = all?.status === 'success' && all.result === true;
        const approvedOne = one?.status === 'success' && (one.result as string).toLowerCase() === SEAPORT_ADDRESS.toLowerCase();
        return {
          owner: owner && owner !== ZERO_ADDRESS ? owner : null,
          approved: approvedAll || approvedOne,
          counter: counter.result as bigint,
          cancelled: isCancelled,
          filled: totalSize > 0n && totalFilled >= totalSize,
        };
      });
    },

    async readRoyalty(collection: Hex, tokenId: bigint, salePrice: bigint): Promise<Royalty | null> {
      // Call royaltyInfo directly instead of trusting supportsInterface:
      // some implementations answer one and not the other. A revert means
      // no royalty.
      try {
        const [receiver, amount] = await client.readContract({
          address: collection,
          abi: ERC721_READ_ABI,
          functionName: 'royaltyInfo',
          args: [tokenId, salePrice],
        });
        if (amount === 0n || receiver.toLowerCase() === ZERO_ADDRESS) return null;
        return { receiver: receiver.toLowerCase() as Hex, amount };
      } catch {
        return null;
      }
    },

    async verifyContractSignature(seller: Hex, order: OrderComponents, signature: Hex): Promise<boolean> {
      return client.verifyTypedData({
        address: seller,
        domain: seaportDomain(MARKET_CHAIN_ID),
        types: SEAPORT_ORDER_TYPES,
        primaryType: 'OrderComponents',
        message: order as unknown as Record<string, unknown>,
        signature,
      });
    },
  };
}

/// tokenURI for a batch of ids (null where the call failed).
export async function readTokenUris(collection: Hex, ids: bigint[], client: PublicClient = marketClient()): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  for (let i = 0; i < ids.length; i += MULTICALL_CHUNK) {
    const chunk = await client.multicall({
      contracts: ids.slice(i, i + MULTICALL_CHUNK).map((id) => ({
        address: collection, abi: ERC721_READ_ABI, functionName: 'tokenURI', args: [id],
      })) as never,
      allowFailure: true,
      multicallAddress: MULTICALL3,
    });
    for (const r of chunk as Array<{ status: string; result?: unknown }>) {
      out.push(r.status === 'success' && typeof r.result === 'string' ? r.result : null);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collection allowlist: only collections the indexer recorded from our NFT
// and DN404 launch factories. The indexer writes nft_collections rows only
// from those factories' launch events, so a lookup hit means "launched on
// urufu".
// ---------------------------------------------------------------------------

interface IndexerCollectionRow {
  chainId: number;
  collectionAddress: string;
  lane: string;
  name: string;
  ticker: string;
  pairedToken: string;
  unitWei: string;
  maxSupply: string;
  blockNumber: string;
}

const ROW_FIELDS = 'chainId collectionAddress lane name ticker pairedToken unitWei maxSupply blockNumber';

function rowToInfo(row: IndexerCollectionRow): CollectionInfo {
  const num = (v: string | undefined) => (/^\d+$/.test(v ?? '') ? BigInt(v!) : 0n);
  return {
    collection: row.collectionAddress.toLowerCase() as Hex,
    lane: (row.lane === 'dn404' ? 'dn404' : 'nft') as Lane,
    name: row.name,
    ticker: row.ticker,
    pairedToken: (row.pairedToken || ZERO_ADDRESS).toLowerCase() as Hex,
    unitWei: num(row.unitWei),
    maxSupply: num(row.maxSupply),
    launchBlock: num(row.blockNumber),
  };
}

export function indexerMarketCollections(
  indexerUrl: string | undefined = process.env.INDEXER_URL,
  fetchImpl: typeof fetch = fetch,
): MarketCollections {
  const hits = new Map<string, CollectionInfo>();
  const misses = new Map<string, number>(); // address -> expiry ms
  let listCache: { at: number; rows: CollectionInfo[] } | null = null;
  const gql = async <T,>(query: string, variables: Record<string, unknown>): Promise<T> => {
    if (!indexerUrl) throw Object.assign(new Error('INDEXER_URL unset'), { code: 'INDEXER_UNAVAILABLE' });
    try {
      const res = await fetchImpl(`${indexerUrl.replace(/\/$/, '')}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`indexer ${res.status}`);
      const json = (await res.json()) as { data?: T };
      if (!json.data) throw new Error('indexer: no data');
      return json.data;
    } catch (err) {
      throw Object.assign(new Error('indexer unavailable'), { code: 'INDEXER_UNAVAILABLE', cause: err });
    }
  };
  return {
    async list(): Promise<CollectionInfo[]> {
      if (listCache && Date.now() - listCache.at < 60_000) return listCache.rows;
      const data = await gql<{ nftCollectionss: { items: IndexerCollectionRow[] } }>(
        `query { nftCollectionss(where: { chainId: ${MARKET_CHAIN_ID} }, orderBy: "blockTimestamp", orderDirection: "desc", limit: 1000) { items { ${ROW_FIELDS} } } }`,
        {},
      );
      const rows = data.nftCollectionss.items.map(rowToInfo);
      for (const r of rows) hits.set(r.collection, r);
      listCache = { at: Date.now(), rows };
      return rows;
    },
    async lookup(collection: Hex): Promise<CollectionInfo | null> {
      const key = collection.toLowerCase();
      const hit = hits.get(key);
      if (hit) return hit;
      const miss = misses.get(key);
      if (miss && miss > Date.now()) return null;
      if (!indexerUrl) return null;
      // Indexer down: throws INDEXER_UNAVAILABLE (caller returns 503), not cached.
      const data = await gql<{ nftCollectionss: { items: IndexerCollectionRow[] } }>(
        `query($a: String!) { nftCollectionss(where: { collectionAddress: $a, chainId: ${MARKET_CHAIN_ID} }, limit: 1) { items { ${ROW_FIELDS} } } }`,
        { a: key },
      );
      const row = data.nftCollectionss.items[0];
      if (!row || row.chainId !== MARKET_CHAIN_ID || row.collectionAddress.toLowerCase() !== key) {
        misses.set(key, Date.now() + 60_000);
        if (misses.size > 10_000) misses.clear();
        return null;
      }
      const info = rowToInfo(row);
      hits.set(key, info);
      return info;
    },
  };
}

/// Owned-token scanner over each collection's Transfer logs (holders-engine,
/// incremental + cached per collection), confirmed with a live ownerOf.
/// Neither template exposes tokensOfOwner, so logs are the only source.
export function holdersOwnedScanner(client: PublicClient = marketClient()): OwnedScanner {
  return async (wallet, collections) => {
    const w = wallet.toLowerCase();
    const candidates: Array<{ collection: Hex; tokenId: bigint }> = [];
    for (const c of collections) {
      try {
        const state = await scanHolders({ rpcUrl: marketRpcUrl(), address: c.collection, startBlock: c.launchBlock || undefined });
        for (const [id, owner] of state.owners) {
          if (owner.toLowerCase() === w) candidates.push({ collection: c.collection, tokenId: BigInt(id) });
        }
      } catch {
        // One slow collection shouldn't hide the rest.
      }
      if (candidates.length >= 500) break;
    }
    if (candidates.length === 0) return [];
    const res = await client.multicall({
      contracts: candidates.map((t) => ({ address: t.collection, abi: ERC721_READ_ABI, functionName: 'ownerOf', args: [t.tokenId] })) as never,
      allowFailure: true,
      multicallAddress: MULTICALL3,
    });
    return candidates.filter((_, i) => {
      const r = (res as Array<{ status: string; result?: unknown }>)[i];
      return r?.status === 'success' && String(r.result).toLowerCase() === w;
    });
  };
}
