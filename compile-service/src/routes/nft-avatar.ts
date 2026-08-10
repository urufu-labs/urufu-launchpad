import type { FastifyInstance } from 'fastify';
import { isAddress } from 'viem';

/// Wallet-NFT inventory is an indexed-data problem, not something an RPC node can
/// answer by itself. Moralis supplies the cross-chain index while this route keeps
/// its API key server-side and gives the profile UI one stable response shape.
const MORALIS_API_URL = 'https://deep-index.moralis.io/api/v2.2';
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;

/// Mainnet EVM networks with meaningful NFT activity and supported by the wallet
/// NFT index. Keep this explicit rather than treating the currently-selected launch
/// chain as the inventory scope: a linked EVM address is portable across networks.
const NFT_CHAINS = [
  // Robinhood FIRST — urufu gemu NFT (0x60cB7082...) lives here and is the
  // primary identity NFT for the whole ecosystem. Anything else is nice-to-
  // have. Scan order matters because we return partial results as chains
  // resolve; keeping RH at index 0 gets the important match on screen first.
  { id: 'robinhood', label: 'Robinhood', chainId: 4663, providerChain: '0x1237' },
  { id: 'ethereum', label: 'Ethereum', chainId: 1, providerChain: '0x1' },
  { id: 'base', label: 'Base', chainId: 8453, providerChain: '0x2105' },
  { id: 'arbitrum', label: 'Arbitrum', chainId: 42161, providerChain: '0xa4b1' },
  { id: 'optimism', label: 'Optimism', chainId: 10, providerChain: '0xa' },
  { id: 'polygon', label: 'Polygon', chainId: 137, providerChain: '0x89' },
  { id: 'bnb', label: 'BNB Chain', chainId: 56, providerChain: '0x38' },
  { id: 'avalanche', label: 'Avalanche', chainId: 43114, providerChain: '0xa86a' },
  { id: 'gnosis', label: 'Gnosis', chainId: 100, providerChain: '0x64' },
  { id: 'linea', label: 'Linea', chainId: 59144, providerChain: '0xe708' },
  { id: 'cronos', label: 'Cronos', chainId: 25, providerChain: '0x19' },
  { id: 'ronin', label: 'Ronin', chainId: 2020, providerChain: '0x7e4' },
  { id: 'moonbeam', label: 'Moonbeam', chainId: 1284, providerChain: '0x504' },
] as const;

type NftChain = (typeof NFT_CHAINS)[number];

interface ProviderNft {
  token_address?: string;
  token_id?: string;
  name?: string | null;
  symbol?: string | null;
  amount?: string | null;
  possible_spam?: boolean | string;
  normalized_metadata?: { name?: string | null; image?: string | null } | null;
  metadata?: string | { name?: string | null; image?: string | null } | null;
  media?: {
    original_media_url?: string | null;
    gateway?: string | null;
    media_collection?: { high?: { url?: string | null }; low?: { url?: string | null } } | null;
  } | null;
}

interface ProviderResponse {
  result?: ProviderNft[];
  cursor?: string | null;
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
      if (!process.env.MORALIS_API_KEY) {
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
    const url = new URL(`${MORALIS_API_URL}/${address}/nft`);
    url.searchParams.set('chain', chain.providerChain);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('normalizeMetadata', 'true');
    url.searchParams.set('media_items', 'true');
    url.searchParams.set('exclude_spam', 'true');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url, {
      headers: { 'X-API-Key': process.env.MORALIS_API_KEY! },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`provider returned ${res.status}`);
    const data = (await res.json()) as ProviderResponse;
    const value: ChainResult = {
      id: chain.id,
      label: chain.label,
      chainId: chain.chainId,
      items: (data.result ?? []).flatMap((nft) => toNftAvatar(chain, nft)),
      nextCursor: data.cursor ?? null,
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

function toNftAvatar(chain: NftChain, nft: ProviderNft): NftAvatar[] {
  if ((nft.possible_spam === true || nft.possible_spam === 'true') || !nft.token_address || !isAddress(nft.token_address) || !nft.token_id) return [];
  const metadata = parseMetadata(nft.metadata);
  const imageUrl = firstRenderableUrl(
    nft.normalized_metadata?.image,
    metadata?.image,
    nft.media?.original_media_url,
    nft.media?.gateway,
    nft.media?.media_collection?.high?.url,
    nft.media?.media_collection?.low?.url,
  );
  if (!imageUrl) return [];

  return [{
    chainId: chain.chainId,
    chain: chain.label,
    contractAddress: nft.token_address.toLowerCase(),
    tokenId: nft.token_id,
    collectionName: nft.name ?? nft.symbol ?? null,
    tokenName: nft.normalized_metadata?.name ?? metadata?.name ?? null,
    imageUrl,
  }];
}

function parseMetadata(raw: ProviderNft['metadata']): { name?: string | null; image?: string | null } | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as { name?: string | null; image?: string | null } : null;
  } catch {
    return null;
  }
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
