import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPublicClient, getAddress, http, isAddress, type Address } from 'viem';

import { sql as _defaultSql } from '../db.ts';
import { verifyEnvelope, type AuthEnvelope } from '../auth.ts';
import type { SqlLike } from './social.ts';

/// Off-chain page details for NFT-lane and DN404-lane collections: cover
/// image, description, socials. Same storage + signed-write pattern as the
/// ERC-20 `/token/:chainId/:address/metadata` route in social.ts, keyed on the
/// collection address (the ERC-721; for DN404 that is the mirror, which is the
/// address the /collection page lives at). Rows share `app.token_metadata`:
/// collection and token addresses never collide, so one table serves both.
///
///   - GET  /collection/:chainId/:address/metadata   public read
///   - POST /collection/:chainId/:address/metadata   launcher-only signed write
///
/// Write gate: the signer must be BOTH the indexer's `nftCollections.launchedBy`
/// AND the current on-chain `owner()` (NFT lane: the collection; DN404 lane:
/// the base ERC-20, whose owner is the one that can call setBaseURI /
/// setContractURI). Requiring both means a launcher who handed the contract to
/// someone else can no longer edit the page, and nobody can front-run a
/// not-yet-indexed launch.

/// Robinhood Chain. The indexer + RPC below only cover this chain.
const SUPPORTED_CHAIN_ID = 4663;

const INDEXER_URL = process.env.INDEXER_URL ?? process.env.NEXT_PUBLIC_INDEXER_URL ?? 'http://localhost:42069';

const ownerAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

export interface CollectionRecord {
  /// Lower-cased launcher wallet.
  launchedBy: string;
  lane: string;
  /// DN404 base ERC-20 (lower-cased) when lane === 'dn404'.
  pairedToken: string | null;
}

/// Indexer lookup. Ponder ids for nftCollections use the checksummed
/// address (`4663-0xAbC…`); a lower-cased id returns null.
async function defaultLookupCollection(chainId: number, collection: Address): Promise<CollectionRecord | null> {
  const id = `${chainId}-${getAddress(collection)}`;
  const query = `query CollectionLauncher($id: String!) { nftCollections(id: $id) { launchedBy lane pairedToken } }`;
  try {
    const res = await fetch(`${INDEXER_URL.replace(/\/$/, '')}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { id } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { nftCollections?: { launchedBy?: string; lane?: string; pairedToken?: string | null } | null };
    };
    const row = json.data?.nftCollections;
    if (!row || typeof row.launchedBy !== 'string') return null;
    return {
      launchedBy: row.launchedBy.toLowerCase(),
      lane: row.lane ?? 'nft',
      pairedToken: typeof row.pairedToken === 'string' ? row.pairedToken.toLowerCase() : null,
    };
  } catch {
    return null;
  }
}

/// On-chain owner() of `target`, lower-cased. null on RPC failure.
async function defaultLookupOwner(target: Address): Promise<string | null> {
  const rpcUrl = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
  try {
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: 5_000 }) });
    const owner = await client.readContract({ address: target, abi: ownerAbi, functionName: 'owner' });
    return owner.toLowerCase();
  } catch {
    return null;
  }
}

/// http/https only. zod's .url() also accepts javascript: and data:, which
/// the page renders as <a href> / CSS url(), so refuse them at write time.
function _safeHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

export const CollectionMetadataSaveBody = z.object({
  address: z.string(),
  signature: z.string(),
  timestamp: z.number(),
  payload: z.object({
    chainId: z.number().int().positive(),
    collectionAddress: z.string().refine(isAddress, { message: 'not an address' }),
    imageUrl: z.string().url().max(500).refine(_safeHttpUrl, { message: 'http(s) only' }).nullable().optional(),
    description: z.string().max(1000).nullable().optional(),
    website: z.string().url().max(300).refine(_safeHttpUrl, { message: 'http(s) only' }).nullable().optional(),
    twitter: z.string().max(80).nullable().optional(),
    telegram: z.string().max(80).nullable().optional(),
    discord: z.string().max(80).nullable().optional(),
  }),
});

export async function registerCollectionMetadataRoutes(
  app: FastifyInstance,
  opts?: {
    sqlOverride?: SqlLike;
    /// Test seams. Production uses the indexer GraphQL + Robinhood RPC.
    lookupCollection?: (chainId: number, collection: Address) => Promise<CollectionRecord | null>;
    lookupOwner?: (target: Address) => Promise<string | null>;
  },
): Promise<void> {
  const sql = (opts?.sqlOverride ?? _defaultSql) as SqlLike | null;
  const lookupCollection = opts?.lookupCollection ?? defaultLookupCollection;
  const lookupOwner = opts?.lookupOwner ?? defaultLookupOwner;

  app.get<{ Params: { chainId: string; address: string } }>(
    '/collection/:chainId/:address/metadata',
    async (req, reply) => {
      if (!sql) return reply.code(503).send({ code: 'DB_NOT_CONFIGURED' });
      const chainId = Number(req.params.chainId);
      const addr = req.params.address.toLowerCase();
      if (!Number.isInteger(chainId) || !isAddress(addr)) {
        return reply.code(400).send({ code: 'BAD_PARAMS' });
      }
      const rows = await sql`
        SELECT chain_id AS "chainId", token_address AS "collectionAddress", image_url AS "imageUrl",
               description, website, twitter, telegram, discord, updated_at AS "updatedAt", owner
        FROM app.token_metadata
        WHERE chain_id = ${chainId} AND token_address = ${addr}
        LIMIT 1
      `;
      return reply.send(rows[0] ?? null);
    },
  );

  app.post<{ Params: { chainId: string; address: string } }>(
    '/collection/:chainId/:address/metadata',
    async (req, reply) => {
      if (!sql) return reply.code(503).send({ code: 'DB_NOT_CONFIGURED' });
      const parsed = CollectionMetadataSaveBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: 'BAD_BODY', errors: parsed.error.flatten() });
      const { address, signature, timestamp, payload } = parsed.data;
      // The URL must name the same collection the signature covers, or a
      // signature for collection X could be posted against collection Y's URL.
      if (Number(req.params.chainId) !== payload.chainId
        || req.params.address.toLowerCase() !== payload.collectionAddress.toLowerCase()) {
        return reply.code(400).send({ code: 'URL_PAYLOAD_MISMATCH' });
      }
      if (payload.chainId !== SUPPORTED_CHAIN_ID) {
        return reply.code(400).send({ code: 'UNSUPPORTED_CHAIN' });
      }
      const envelope: AuthEnvelope = { address, signature: signature as `0x${string}`, timestamp };
      const auth = await verifyEnvelope('collection:save', payload, envelope);
      if (!auth.ok) return reply.code(401).send({ code: 'UNAUTHORIZED', reason: auth.reason });

      const collection = payload.collectionAddress.toLowerCase() as Address;
      const record = await lookupCollection(payload.chainId, collection);
      if (record === null) {
        return reply.code(409).send({ code: 'INDEXER_PENDING', message: 'collection not indexed yet, retry in a few seconds' });
      }
      if (record.launchedBy !== auth.address) {
        return reply.code(403).send({ code: 'NOT_LAUNCHER', launcher: record.launchedBy, signer: auth.address });
      }
      // DN404: the base ERC-20 holds ownership (and the URI setters). Its
      // mirror only caches the owner at link time, so read the base.
      const ownerTarget = (record.lane === 'dn404' && record.pairedToken && isAddress(record.pairedToken)
        ? record.pairedToken
        : collection) as Address;
      const onChainOwner = await lookupOwner(ownerTarget);
      if (onChainOwner === null) {
        return reply.code(503).send({ code: 'OWNER_LOOKUP_FAILED' });
      }
      if (onChainOwner !== auth.address) {
        return reply.code(403).send({ code: 'NOT_OWNER', owner: onChainOwner, signer: auth.address });
      }

      await sql`
        INSERT INTO app.token_metadata (chain_id, token_address, image_url, description, website, twitter, telegram, discord, owner, updated_at)
        VALUES (${payload.chainId}, ${collection}, ${payload.imageUrl ?? null}, ${payload.description ?? null}, ${payload.website ?? null}, ${payload.twitter ?? null}, ${payload.telegram ?? null}, ${payload.discord ?? null}, ${auth.address}, now())
        ON CONFLICT (chain_id, token_address) DO UPDATE SET
          image_url = EXCLUDED.image_url,
          description = EXCLUDED.description,
          website = EXCLUDED.website,
          twitter = EXCLUDED.twitter,
          telegram = EXCLUDED.telegram,
          discord = EXCLUDED.discord,
          owner = EXCLUDED.owner,
          updated_at = now()
      `;
      return reply.send({ ok: true });
    },
  );
}
