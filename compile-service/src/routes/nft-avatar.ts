import type { FastifyInstance } from 'fastify';
import { isAddress } from 'viem';

/// Wallet NFT inventory for profile-avatar selection and the profile holdings
/// widget, via OpenSea's account-NFTs API (OPENSEA_API_KEY, server-side only).
///
/// Was Alchemy's NFT API until 2026-10-02, when the Alchemy account was
/// suspended over an unpaid bill. OpenSea indexes Robinhood Chain (chain id
/// `robinhood`, verified) plus the other chains below, and the key is the
/// same one the DN404 keeper uses. Response shape is unchanged
/// (web/src/lib/nftAvatarApi.ts: { chains: [{ id, label, chainId, items,
/// nextCursor, error? }] }), so the web needs no change.
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 24;
/// OpenSea caps `limit` at 200 for this endpoint; keep the old 100 ceiling.
const MAX_PAGE_SIZE = 100;

/// Chains OpenSea recognizes (from its own "Recognized chains" list,
/// 2026-10-02). Robinhood FIRST: urufu gemu nft is the primary identity NFT.
/// Gnosis and Linea were dropped (OpenSea doesn't index them); Base added.
export const NFT_CHAINS = [
  { id: 'robinhood', label: 'Robinhood', chainId: 4663, openseaChain: 'robinhood' },
  { id: 'ethereum', label: 'Ethereum', chainId: 1, openseaChain: 'ethereum' },
  { id: 'base', label: 'Base', chainId: 8453, openseaChain: 'base' },
  { id: 'arbitrum', label: 'Arbitrum', chainId: 42161, openseaChain: 'arbitrum' },
  { id: 'optimism', label: 'Optimism', chainId: 10, openseaChain: 'optimism' },
  { id: 'polygon', label: 'Polygon', chainId: 137, openseaChain: 'polygon' },
  { id: 'bnb', label: 'BNB Chain', chainId: 56, openseaChain: 'bsc' },
  { id: 'avalanche', label: 'Avalanche', chainId: 43114, openseaChain: 'avalanche' },
] as const;

type NftChain = (typeof NFT_CHAINS)[number];

/// OpenSea v2 `GET /chain/{chain}/account/{address}/nfts` item (fields we read).
export interface OpenSeaNft {
  identifier?: string | null;
  collection?: string | null;
  contract?: string | null;
  name?: string | null;
  image_url?: string | null;
  display_image_url?: string | null;
  is_disabled?: boolean | null;
  is_nsfw?: boolean | null;
}

interface OpenSeaResponse {
  nfts?: OpenSeaNft[];
  next?: string | null;
}

export interface NftAvatar {
  chainId: number;
  chain: string;
  contractAddress: string;
  tokenId: string;
  collectionName: string | null;
  tokenName: string | null;
  imageUrl: string;
}

export interface ChainResult {
  id: string;
  label: string;
  chainId: number;
  items: NftAvatar[];
  nextCursor: string | null;
  error?: string;
}

const cache = new Map<string, { expiresAt: number; value: ChainResult }>();

export async function registerNftAvatarRoutes(app: FastifyInstance): Promise<void> {
  /// Public read route (wallet NFT ownership is public); the per-IP limit keeps
  /// it from becoming an unbounded OpenSea-key proxy.
  app.get<{ Params: { address: string }; Querystring: { chain?: string; cursor?: string; limit?: string } }>(
    '/wallet/:address/nfts',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const address = req.params.address.toLowerCase();
      if (!isAddress(address)) return reply.code(400).send({ code: 'BAD_ADDRESS' });
      if (!process.env.OPENSEA_API_KEY) {
        return reply.code(503).send({ code: 'NFT_SCANNER_NOT_CONFIGURED' });
      }

      const limit = parseLimit(req.query.limit);
      const requestedChain = req.query.chain ? NFT_CHAINS.find((chain) => chain.id === req.query.chain) : undefined;
      if (req.query.chain && !requestedChain) return reply.code(400).send({ code: 'BAD_CHAIN' });
      if (req.query.cursor && !requestedChain) {
        return reply.code(400).send({ code: 'CURSOR_REQUIRES_CHAIN' });
      }

      // Concurrency 2: OpenSea's per-key rate limit is modest; RH resolves first.
      const chains = requestedChain
        ? [await scanChain(app, address, requestedChain, limit, req.query.cursor)]
        : await mapWithConcurrency(NFT_CHAINS, 2, (chain) => scanChain(app, address, chain, limit));

      return reply.send({ chains });
    },
  );
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number(raw ?? DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(parsed)));
}

async function scanChain(
  app: FastifyInstance,
  address: string,
  chain: NftChain,
  limit: number,
  cursor?: string,
): Promise<ChainResult> {
  appraiseCache();
  const key = `${address}:${chain.id}:${limit}:${cursor ?? ''}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const url = new URL(`https://api.opensea.io/api/v2/chain/${chain.openseaChain}/account/${address}/nfts`);
    url.searchParams.set('limit', String(limit));
    if (cursor) url.searchParams.set('next', cursor);
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'x-api-key': process.env.OPENSEA_API_KEY ?? '' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`opensea returned ${res.status}`);
    const data = (await res.json()) as OpenSeaResponse;
    const value: ChainResult = {
      id: chain.id,
      label: chain.label,
      chainId: chain.chainId,
      items: (data.nfts ?? []).flatMap((nft) => toNftAvatar(chain, nft)),
      nextCursor: data.next ?? null,
    };
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  } catch (err) {
    // Never include the key or URL in logs / responses; message only.
    const message = err instanceof Error ? err.message : 'scan failed';
    app.log.warn({ chain: chain.id, err: message }, 'nft-avatar opensea scan failed');
    return { id: chain.id, label: chain.label, chainId: chain.chainId, items: [], nextCursor: null, error: message };
  }
}

/// Map one OpenSea NFT to the avatar shape. Exported for tests.
export function toNftAvatar(chain: { chainId: number; label: string }, nft: OpenSeaNft): NftAvatar[] {
  const contractAddress = nft.contract;
  const tokenId = nft.identifier;
  // strict:false: accept any-case hex; a bad checksum must not hide an NFT.
  if (!contractAddress || !isAddress(contractAddress, { strict: false }) || !tokenId) return [];
  if (nft.is_disabled === true || nft.is_nsfw === true) return [];
  const imageUrl = firstRenderableUrl(nft.display_image_url, nft.image_url);
  if (!imageUrl) return [];
  return [{
    chainId: chain.chainId,
    chain: chain.label,
    contractAddress: contractAddress.toLowerCase(),
    tokenId,
    // OpenSea returns the collection slug here, not a display name.
    collectionName: nft.collection ?? null,
    tokenName: nft.name ?? null,
    imageUrl,
  }];
}

/// Never proxy or copy asset bytes. Only turn decentralized URI schemes into
/// browser-fetchable gateways and keep normal HTTP(S) media URLs as-is.
export function firstRenderableUrl(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (!candidate || candidate.length > 2_048) continue;
    const trimmed = candidate.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^ipfs:\/\//i.test(trimmed)) return `https://ipfs.io/ipfs/${trimmed.replace(/^ipfs:\/\/?/i, '')}`;
    if (/^ar:\/\//i.test(trimmed)) return `https://arweave.net/${trimmed.replace(/^ar:\/\/?/i, '')}`;
  }
  return null;
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function appraiseCache(): void {
  if (cache.size < 200) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}
