/// Per-collection holders scan for the /collection/[address] page. Alchemy's
/// NFT API v3 `getOwnersForContract` returns every current owner of a given
/// ERC-721 contract along with token counts. We proxy it here so the API key
/// stays server-side and the response gets cached — a viewer refreshing the
/// mint page shouldn't retrigger a full holders scan every time.

import type { FastifyInstance } from 'fastify';
import { isAddress } from 'viem';

const CACHE_TTL_MS = 60 * 1000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

/// Same chain catalog shape as nft-avatar.ts. Robinhood is the only
/// launchpad chain today; kept as an array so adding chains later is a
/// one-line append.
const NFT_CHAINS = [
  { id: 'robinhood', label: 'Robinhood', chainId: 4663, providerNetwork: 'robinhood-mainnet' },
] as const;
type NftChain = (typeof NFT_CHAINS)[number];

interface AlchemyOwnerEntry {
  ownerAddress?: string;
  tokenBalances?: Array<{ tokenId?: string; balance?: string | number }>;
}

interface AlchemyResponse {
  owners?: AlchemyOwnerEntry[];
  pageKey?: string | null;
}

interface HolderRow {
  address: string;
  balance: number;
  tokenIds: string[];
}

interface HoldersResult {
  chainId: number;
  chain: string;
  contractAddress: string;
  holders: HolderRow[];
  nextCursor: string | null;
  error?: string;
}

const cache = new Map<string, { expiresAt: number; value: HoldersResult }>();

export async function registerNftHoldersRoutes(app: FastifyInstance): Promise<void> {
  /// GET /nft/:chain/:contract/holders?cursor=…&limit=…
  ///   chain     — id from NFT_CHAINS (currently only 'robinhood')
  ///   contract  — ERC-721 contract address
  ///   limit     — optional page size (default 100, max 500)
  ///   cursor    — optional Alchemy pageKey for the next page
  app.get<{
    Params: { chain: string; contract: string };
    Querystring: { limit?: string; cursor?: string };
  }>(
    '/nft/:chain/:contract/holders',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const chain = NFT_CHAINS.find((c) => c.id === req.params.chain);
      if (!chain) return reply.code(400).send({ code: 'BAD_CHAIN' });
      const contract = req.params.contract.toLowerCase();
      if (!isAddress(contract)) return reply.code(400).send({ code: 'BAD_ADDRESS' });
      if (!process.env.ALCHEMY_API_KEY) {
        return reply.code(503).send({ code: 'NFT_SCANNER_NOT_CONFIGURED' });
      }
      const limit = parseLimit(req.query.limit);
      const cursor = req.query.cursor;

      const key = `${chain.id}:${contract}:${limit}:${cursor ?? ''}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return reply.send(cached.value);

      try {
        const url = new URL(
          `https://${chain.providerNetwork}.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getOwnersForContract`,
        );
        url.searchParams.set('contractAddress', contract);
        url.searchParams.set('withTokenBalances', 'true');
        url.searchParams.set('pageSize', String(limit));
        if (cursor) url.searchParams.set('pageKey', cursor);

        const res = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`provider returned ${res.status}`);
        const data = (await res.json()) as AlchemyResponse;

        const holders: HolderRow[] = (data.owners ?? []).map((row) => {
          const tokenBalances = row.tokenBalances ?? [];
          const balance = tokenBalances.reduce((total, tb) => total + Number(tb.balance ?? 0), 0);
          const tokenIds = tokenBalances.map((tb) => tb.tokenId ?? '').filter(Boolean);
          return {
            address: (row.ownerAddress ?? '').toLowerCase(),
            balance,
            tokenIds,
          };
        }).filter((h) => h.address && h.balance > 0);

        const value: HoldersResult = {
          chainId: chain.chainId,
          chain: chain.id,
          contractAddress: contract,
          holders,
          nextCursor: data.pageKey ?? null,
        };
        cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
        appraiseCache();
        return reply.send(value);
      } catch (err) {
        app.log.warn({ err, chain: chain.id, contract }, 'nft-holders scan failed');
        return reply.code(502).send({ code: 'SCAN_FAILED', chain: chain.id, contract });
      }
    },
  );
  // Silence unused NftChain type warning — kept exported-shape for future
  // chain-agnostic scans; today only robinhood is wired.
  void ({} as NftChain);
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number(raw ?? DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(parsed)));
}

function appraiseCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}
