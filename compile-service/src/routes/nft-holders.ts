/// Per-collection holders for the /collection/[address] page.
///
/// Computed on-chain from the collection's transfer events via the shared
/// holder engine (src/holders-engine.ts) over Robinhood's PUBLIC RPC. No paid
/// API: the Alchemy NFT API this used to proxy was suspended (2026-10-02).
/// The engine caches each collection and only scans new blocks on repeat
/// calls, and this route keeps a short response cache on top so page refreshes
/// don't even hit the engine.
///
/// Response shape is unchanged (web/src/lib/nftHoldersApi.ts):
///   { chainId, chain, contractAddress, holders: [{address, balance, tokenIds}], nextCursor }
/// `nextCursor` is now an offset into the sorted holder list (opaque string).

import type { FastifyInstance } from 'fastify';
import { isAddress } from 'viem';
import { holdersFromState, scanHolders } from '../holders-engine.ts';
import { verifiedIndexerHolders } from '../holders-verify.ts';

const CACHE_TTL_MS = 60 * 1000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

/// Robinhood is the only launchpad chain. RPC is public unless overridden.
const NFT_CHAINS = [
  {
    id: 'robinhood',
    label: 'Robinhood',
    chainId: 4663,
    rpcUrl: () => process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  },
] as const;

interface HolderRowOut {
  address: string;
  balance: number;
  tokenIds: string[];
}

export interface HoldersResult {
  chainId: number;
  chain: string;
  contractAddress: string;
  holders: HolderRowOut[];
  nextCursor: string | null;
  error?: string;
}

const cache = new Map<string, { expiresAt: number; value: HoldersResult }>();

/// Block a launchpad collection was created at, from the indexer. Without it
/// the scan starts at block 0 and walks ~50M blocks on the public RPC, which
/// takes far longer than the web's 30s timeout, so a collection's holders
/// never showed. A collection can't have Transfer logs before its launch
/// block, so starting there loses nothing. Cached forever (it never changes);
/// undefined when the indexer is unset or doesn't know the address.
const launchBlockCache = new Map<string, bigint>();
async function collectionLaunchBlock(contract: string): Promise<bigint | undefined> {
  const hit = launchBlockCache.get(contract);
  if (hit !== undefined) return hit;
  const base = process.env.INDEXER_URL;
  if (!base) return undefined;
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query($a: String!) { nftCollectionss(where: { collectionAddress: $a }, limit: 1) { items { blockNumber } } }',
        variables: { a: contract },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const json = await res.json() as { data?: { nftCollectionss?: { items?: Array<{ blockNumber?: string }> } } };
    const raw = json.data?.nftCollectionss?.items?.[0]?.blockNumber;
    if (!raw || !/^\d+$/.test(raw)) return undefined;
    const block = BigInt(raw);
    launchBlockCache.set(contract, block);
    return block;
  } catch {
    return undefined;
  }
}

/// urufu gemu nft (ChibiCoreV2) on Robinhood.
const PREWARM_COLLECTIONS = ['0x60cb7082c8c14b4237c6a24c65e7c2e7abe2bd17'] as const;

/// Page an already-sorted holder list. Exported for tests.
export function pageHolders(
  rows: Array<{ address: string; balance: bigint; tokenIds: string[] }>,
  limit: number,
  cursor: string | undefined,
): { holders: HolderRowOut[]; nextCursor: string | null } {
  const offset = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  const slice = rows.slice(offset, offset + limit);
  const next = offset + limit < rows.length ? String(offset + limit) : null;
  return {
    holders: slice.map((r) => ({ address: r.address, balance: Number(r.balance), tokenIds: r.tokenIds })),
    nextCursor: next,
  };
}

export async function registerNftHoldersRoutes(app: FastifyInstance): Promise<void> {
  // Pre-warm urufu gemu nft (the ecosystem's identity collection): a cold
  // full-history scan takes ~2 min on the public RPC at its current 100k-block
  // log limit, longer than the web's 30s fetch timeout. Fire-and-forget; later
  // requests only scan new blocks.
  // Skipped under node:test (NODE_TEST_CONTEXT) so CI never starts a real scan.
  if (process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT && !process.env.NFT_HOLDERS_NO_PREWARM) {
    void scanHolders({ rpcUrl: NFT_CHAINS[0].rpcUrl(), address: PREWARM_COLLECTIONS[0] })
      .then(() => app.log.info('nft-holders: urufu gemu nft pre-warmed'))
      .catch((err) => app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'nft-holders: pre-warm failed'));
  }
  /// GET /nft/:chain/:contract/holders?cursor=…&limit=…
  app.get<{
    Params: { chain: string; contract: string };
    Querystring: { limit?: string; cursor?: string };
  }>(
    '/nft/:chain/:contract/holders',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const chain = NFT_CHAINS.find((c) => c.id === req.params.chain);
      if (!chain) return reply.code(400).send({ code: 'BAD_CHAIN' });
      const contract = req.params.contract.toLowerCase();
      if (!isAddress(contract)) return reply.code(400).send({ code: 'BAD_ADDRESS' });
      const limit = parseLimit(req.query.limit);
      const cursor = req.query.cursor;

      const key = `${chain.id}:${contract}:${limit}:${cursor ?? ''}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return reply.send(cached.value);

      try {
        // Verified indexer first (collections the indexer tracks, e.g. urufu
        // gemu nft): accepted only when every balance matches chain and the
        // total equals the minted count. Token ids aren't in the indexer's
        // holders table, so this path returns empty tokenIds; the web never
        // renders them (web/src/lib/nftHoldersApi.ts keeps the field for shape).
        let rows: Array<{ address: string; balance: bigint; tokenIds: string[] }> | null = null;
        if (process.env.INDEXER_URL) {
          try {
            const v = await verifiedIndexerHolders({ chainId: chain.chainId, token: contract, rpcUrl: chain.rpcUrl() });
            if (v.verification.ok) {
              rows = v.holders
                .map((h) => ({ address: h.address, balance: h.balance, tokenIds: [] as string[] }))
                .sort((a, b) => (a.balance === b.balance ? (a.address < b.address ? -1 : 1) : a.balance > b.balance ? -1 : 1));
            }
          } catch (err) {
            app.log.warn({ err: err instanceof Error ? err.message : String(err), contract }, 'nft-holders: indexer path failed, scanning');
          }
        }
        if (!rows) {
          const startBlock = await collectionLaunchBlock(contract);
          const state = await scanHolders({ rpcUrl: chain.rpcUrl(), address: contract, startBlock });
          rows = holdersFromState(state);
        }
        const value: HoldersResult = {
          chainId: chain.chainId,
          chain: chain.id,
          contractAddress: contract,
          ...pageHolders(rows, limit, cursor),
        };
        cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
        appraiseCache();
        return reply.send(value);
      } catch (err) {
        app.log.warn({ err: err instanceof Error ? err.message : String(err), chain: chain.id, contract }, 'nft-holders scan failed');
        return reply.code(502).send({ code: 'SCAN_FAILED', chain: chain.id, contract });
      }
    },
  );
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
