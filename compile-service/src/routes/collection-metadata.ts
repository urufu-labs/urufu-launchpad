import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPublicClient, getAddress, http, isAddress, type Address } from 'viem';

import { sql as _defaultSql } from '../db.ts';
import { verifyEnvelope, type AuthEnvelope } from '../auth.ts';
import type { SqlLike } from './social.ts';

/// Off-chain page details for NFT-lane and DN404-lane collections: cover
/// image, description, socials, the page look (banner, accent color, theme,
/// fonts, wallpaper) and the creator's own link buttons. Same storage + signed-write pattern as the
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

/// A jsonb value as the driver hands it back; parses a stringified object.
function parseJsonb(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const safeUrl = (max: number) => z.string().url().max(max).refine(_safeHttpUrl, { message: 'http(s) only' });

/// Ids only; the web app maps each to a font it loads itself, so a stored
/// value can never pull in an arbitrary font URL.
export const FONT_IDS = ['default', 'caslon', 'bodoni', 'anton', 'plex-mono', 'silkscreen', 'marker'] as const;
/// Which one-click theme the launcher started from ('custom' once edited).
/// Cosmetic: every value a theme sets is also stored explicitly.
export const THEME_IDS = ['custom', 'site', 'night', 'paper', 'pixel', 'poster', 'sketch', 'mono'] as const;
/// Page background. 'default' = site background, 'tint' = light wash of the
/// accent, 'banner' = blurred copy of the banner, 'color' / 'gradient' = the
/// launcher's colors, 'image' = the launcher's image (optionally blurred).
export const WALLPAPER_TYPES = ['default', 'tint', 'banner', 'color', 'gradient', 'image'] as const;
export const LINK_STYLES = ['classic', 'featured'] as const;
export const MAX_LINKS = 12;

const Wallpaper = z.object({
  type: z.enum(WALLPAPER_TYPES),
  color: z.string().regex(HEX).nullable().optional(),
  color2: z.string().regex(HEX).nullable().optional(),
  imageUrl: safeUrl(500).nullable().optional(),
  blur: z.number().int().min(0).max(40).optional(),
}).strict();

export const PageDesign = z.object({
  theme: z.enum(THEME_IDS).optional(),
  titleFont: z.enum(FONT_IDS).optional(),
  bodyFont: z.enum(FONT_IDS).optional(),
  wallpaper: Wallpaper.optional(),
}).strict();

export const PageLink = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,24}$/),
  title: z.string().trim().min(1).max(60),
  url: safeUrl(500),
  style: z.enum(LINK_STYLES),
  thumbnailUrl: safeUrl(500).nullable().optional(),
}).strict();

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
    /// Page look. Wide image above the header.
    bannerUrl: z.string().url().max(500).refine(_safeHttpUrl, { message: 'http(s) only' }).nullable().optional(),
    /// #RRGGBB only, so the value can go straight into a CSS variable.
    accentColor: z.string().regex(HEX).nullable().optional(),
    /// Theme, fonts, wallpaper. Every field is an enum, hex color, bounded
    /// number or http(s) URL, so nothing stored can inject CSS.
    design: PageDesign.nullable().optional(),
    /// The creator's own link buttons, in display order.
    links: z.array(PageLink).max(MAX_LINKS).nullable().optional(),
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
               description, website, twitter, telegram, discord,
               banner_url AS "bannerUrl", accent_color AS "accentColor",
               page_design AS "design", page_links AS "links",
               updated_at AS "updatedAt", owner
        FROM app.token_metadata
        WHERE chain_id = ${chainId} AND token_address = ${addr}
        LIMIT 1
      `;
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return reply.send(null);
      // Rows saved before the ::text::jsonb fix hold a jsonb string; db.ts
      // repairs them on boot, this covers anything in between.
      return reply.send({ ...row, design: parseJsonb(row.design), links: parseJsonb(row.links) });
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
      // Verify against the payload exactly as the client sent it. zod rebuilds
      // nested objects in schema key order, which would change the canonical
      // JSON of `design` / `links` and break the signature. The parsed copy
      // (validated, unknown keys rejected) is what gets stored.
      const rawPayload = (req.body as { payload: Record<string, unknown> }).payload;
      const auth = await verifyEnvelope('collection:save', rawPayload, envelope);
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

      // Sent as text and cast ::text::jsonb. A bare ${json}::jsonb makes
      // postgres.js see a jsonb param and JSON-encode the string a second
      // time, which stored a jsonb *string* (the 2026-10-24 Lambro bug).
      const design = payload.design ? JSON.stringify(payload.design) : null;
      const links = payload.links && payload.links.length > 0 ? JSON.stringify(payload.links) : null;
      await sql`
        INSERT INTO app.token_metadata (chain_id, token_address, image_url, description, website, twitter, telegram, discord, banner_url, accent_color, page_design, page_links, owner, updated_at)
        VALUES (${payload.chainId}, ${collection}, ${payload.imageUrl ?? null}, ${payload.description ?? null}, ${payload.website ?? null}, ${payload.twitter ?? null}, ${payload.telegram ?? null}, ${payload.discord ?? null}, ${payload.bannerUrl ?? null}, ${payload.accentColor?.toLowerCase() ?? null}, ${design}::text::jsonb, ${links}::text::jsonb, ${auth.address}, now())
        ON CONFLICT (chain_id, token_address) DO UPDATE SET
          image_url = EXCLUDED.image_url,
          description = EXCLUDED.description,
          website = EXCLUDED.website,
          twitter = EXCLUDED.twitter,
          telegram = EXCLUDED.telegram,
          discord = EXCLUDED.discord,
          banner_url = EXCLUDED.banner_url,
          accent_color = EXCLUDED.accent_color,
          page_design = EXCLUDED.page_design,
          page_links = EXCLUDED.page_links,
          owner = EXCLUDED.owner,
          updated_at = now()
      `;
      return reply.send({ ok: true });
    },
  );
}
