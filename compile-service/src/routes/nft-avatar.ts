import type { FastifyInstance } from 'fastify';
import { isAddress } from 'viem';

/// Wallet-NFT inventory is an indexed-data problem, not something an RPC node can
/// answer by itself. Alchemy's NFT API v3 supplies the cross-chain index. It's
/// the right pick over the previous provider because Alchemy is the only major
/// NFT API that indexes Robinhood Chain (chainId 4663) — the home of urufu gemu,
/// the primary identity NFT for this ecosystem. This route keeps the API key
/// server-side and returns one stable response shape to the profile UI.
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;

/// Mainnet EVM networks with meaningful NFT activity and native Alchemy NFT
/// indexing. Robinhood FIRST because urufu gemu (0x60cB7082...) is the primary
/// identity NFT for the whole ecosystem — scan order matters because we return
/// partial results as chains resolve, and keeping RH at index 0 gets that match
/// on screen first.
///
/// `providerNetwork` is Alchemy's subdomain slug (see
/// https://docs.alchemy.com/reference/nft-api-endpoints for the current list).
/// Chains Alchemy doesn't index for NFTs (Cronos, Ronin, Moonbeam) are omitted;
/// no point offering a scan we know will 4xx.
const NFT_CHAINS = [
  { id: 'robinhood', label: 'Robinhood', chainId: 4663, providerNetwork: 'robinhood-mainnet' },
  { id: 'ethereum', label: 'Ethereum', chainId: 1, providerNetwork: 'eth-mainnet' },
  { id: 'arbitrum', label: 'Arbitrum', chainId: 42161, providerNetwork: 'arb-mainnet' },
  { id: 'optimism', label: 'Optimism', chainId: 10, providerNetwork: 'opt-mainnet' },
  { id: 'polygon', label: 'Polygon', chainId: 137, providerNetwork: 'polygon-mainnet' },
  { id: 'bnb', label: 'BNB Chain', chainId: 56, providerNetwork: 'bnb-mainnet' },
  { id: 'avalanche', label: 'Avalanche', chainId: 43114, providerNetwork: 'avax-mainnet' },
  { id: 'gnosis', label: 'Gnosis', chainId: 100, providerNetwork: 'gnosis-mainnet' },
  { id: 'linea', label: 'Linea', chainId: 59144, providerNetwork: 'linea-mainnet' },
] as const;

type NftChain = (typeof NFT_CHAINS)[number];

/// Alchemy NFT API v3 response shape for `getNFTsForOwner`. Trimmed to only
/// the fields we actually read — full schema is at
/// https://docs.alchemy.com/reference/getnftsforowner-v3.
interface AlchemyNft {
  contract?: {
    address?: string | null;
    name?: string | null;
    symbol?: string | null;
    isSpam?: boolean | null;
    openSeaMetadata?: { safelistRequestStatus?: string | null } | null;
  } | null;
  tokenId?: string | null;
  name?: string | null;
  image?: {
    cachedUrl?: string | null;
    thumbnailUrl?: string | null;
    pngUrl?: string | null;
    originalUrl?: string | null;
  } | null;
  raw?: {
    metadata?: { name?: string | null; image?: string | null } | null;
  } | null;
}

interface AlchemyResponse {
  ownedNfts?: AlchemyNft[];
  pageKey?: string | null;
  totalCount?: number;
}

interface NftAvatar {
  chainId: number;
  chain: string;
  contractAddress: string;
  tokenId: string;
  collectionName: string | null;
  tokenName: string | null;
  imageUrl: string;
}

interface ChainResult {
  id: string;
  label: string;
  chainId: number;
  items: NftAvatar[];
  nextCursor: string | null;
  error?: string;
}

const cache = new Map<string, { expiresAt: number; value: ChainResult }>();

export async function registerNftAvatarRoutes(app: FastifyInstance): Promise<void> {
  /// An inventory scan fans out to several paid provider requests. The route is
  /// public because wallet addresses and NFT ownership are public, but the tight
  /// per-IP limit prevents it from becoming an unbounded API-key proxy.
  app.get<{ Params: { address: string }; Querystring: { chain?: string; cursor?: string; limit?: string } }>(
    '/wallet/:address/nfts',
    {
      config: {
        rateLimit: {
          max: 6,
          timeWindow: '1 minute',
        },
      },
    },
    async (req, reply) => {
      const address = req.params.address.toLowerCase();
      if (!isAddress(address)) return reply.code(400).send({ code: 'BAD_ADDRESS' });
      if (!process.env.ALCHEMY_API_KEY) {
        return reply.code(503).send({ code: 'NFT_SCANNER_NOT_CONFIGURED' });
      }

      const limit = parseLimit(req.query.limit);
      const requestedChain = req.query.chain ? NFT_CHAINS.find((chain) => chain.id === req.query.chain) : undefined;
      if (req.query.chain && !requestedChain) return reply.code(400).send({ code: 'BAD_CHAIN' });
      if (req.query.cursor && !requestedChain) {
        return reply.code(400).send({ code: 'CURSOR_REQUIRES_CHAIN' });
      }

      const chains = requestedChain
        ? [await scanChain(address, requestedChain, limit, req.query.cursor)]
        : await mapWithConcurrency(NFT_CHAINS, 4, (chain) => scanChain(address, chain, limit));

      return reply.send({ chains });
    },
  );
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number(raw ?? DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(parsed)));
}

async function scanChain(address: string, chain: NftChain, limit: number, cursor?: string): Promise<ChainResult> {
  appraiseCache();
  const key = `${address}:${chain.id}:${limit}:${cursor ?? ''}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    // Alchemy's NFT API v3 endpoint. `withMetadata=true` returns the parsed
    // metadata + resolved image URLs so we don't need a second fetch per NFT.
    // `excludeFilters[]=SPAM` filters spam collections server-side (their spam
    // classifier is stricter and cheaper than any post-hoc check we'd do).
    const url = new URL(
      `https://${chain.providerNetwork}.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getNFTsForOwner`,
    );
    url.searchParams.set('owner', address);
    url.searchParams.set('withMetadata', 'true');
    url.searchParams.set('pageSize', String(limit));
    url.searchParams.append('excludeFilters[]', 'SPAM');
    if (cursor) url.searchParams.set('pageKey', cursor);

    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`provider returned ${res.status}`);
    const data = (await res.json()) as AlchemyResponse;
    const value: ChainResult = {
      id: chain.id,
      label: chain.label,
      chainId: chain.chainId,
      items: (data.ownedNfts ?? []).flatMap((nft) => toNftAvatar(chain, nft)),
      nextCursor: data.pageKey ?? null,
    };
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  } catch (err) {
    return {
      id: chain.id,
      label: chain.label,
      chainId: chain.chainId,
      items: [],
      nextCursor: null,
      error: err instanceof Error ? err.message : 'scan failed',
    };
  }
}

function toNftAvatar(chain: NftChain, nft: AlchemyNft): NftAvatar[] {
  const contractAddress = nft.contract?.address;
  const tokenId = nft.tokenId;
  if (!contractAddress || !isAddress(contractAddress) || !tokenId) return [];
  // Belt-and-suspenders: `excludeFilters=SPAM` already filters at the API layer,
  // but the flag can still appear on borderline collections that slipped through.
  if (nft.contract?.isSpam === true) return [];

  // Prefer Alchemy's cached CDN URL (fast, resized, HTTPS) over raw metadata
  // URIs, and fall back through their thumbnail / png / original URL variants
  // before touching the raw metadata (which can be an unresolved ipfs:// URI).
  const imageUrl = firstRenderableUrl(
    nft.image?.cachedUrl,
    nft.image?.thumbnailUrl,
    nft.image?.pngUrl,
    nft.image?.originalUrl,
    nft.raw?.metadata?.image,
  );
  if (!imageUrl) return [];

  return [{
    chainId: chain.chainId,
    chain: chain.label,
    contractAddress: contractAddress.toLowerCase(),
    tokenId,
    collectionName: nft.contract?.name ?? nft.contract?.symbol ?? null,
    tokenName: nft.name ?? nft.raw?.metadata?.name ?? null,
    imageUrl,
  }];
}

/// Never proxy or copy asset bytes. We only turn decentralized URI schemes into
/// browser-fetchable gateways and retain normal HTTP(S) media URLs as-is.
function firstRenderableUrl(...candidates: Array<string | null | undefined>): string | null {
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
