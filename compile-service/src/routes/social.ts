import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAddress } from 'viem';

import { sql, hasDb } from '../db.ts';
import { verifyEnvelope, type AuthEnvelope } from '../auth.ts';

/// Reject any URL scheme other than http/https before we accept + persist a
/// user-supplied metadata URL. zod's `.url()` accepts `javascript:`, `data:`,
/// `vbscript:`, etc. Any frontend that renders these as `<a href>` opens a
/// stored-XSS vector on every viewer of the token's metadata.
function _safeHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

/// Indexer GraphQL endpoint. Compile-service used to read `public.launches`
/// directly from a shared Postgres, but the two services drifted onto
/// separate Postgres instances during the Railway migration — the SQL query
/// throws `relation "public.launches" does not exist` and the endpoint 500s
/// before the launcher check runs. Reading through the indexer's public
/// GraphQL keeps the two services independent + works regardless of the
/// underlying DB topology.
const INDEXER_URL = process.env.INDEXER_URL ?? process.env.NEXT_PUBLIC_INDEXER_URL ?? 'http://localhost:42069';

/// Look up the launcher wallet for `(chainId, tokenAddress)` from the
/// indexer's GraphQL. Returns:
///   - launcher lower-cased address string on success
///   - null if the indexer has no row for this token yet (fresh launch,
///     not-yet-indexed) OR indexer is unreachable — either case is treated
///     as `INDEXER_PENDING` upstream and blocks the write.
async function launcherForToken(chainId: number, tokenAddress: string): Promise<string | null> {
  const id = `${chainId}-${tokenAddress.toLowerCase()}`;
  const query = `query LauncherByToken($id: String!) { launches(id: $id) { launchedBy } }`;
  try {
    const res = await fetch(`${INDEXER_URL.replace(/\/$/, '')}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { id } }),
      // 5s cap — the indexer's realtime layer should answer well under this;
      // a stall here would otherwise hang the write endpoint indefinitely.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { launches?: { launchedBy?: string } | null } };
    const raw = json.data?.launches?.launchedBy;
    return typeof raw === 'string' ? raw.toLowerCase() : null;
  } catch {
    return null;
  }
}

/// Registers the three social/UGC route groups on the compile service:
///   - GET/POST /token/:chainId/:address/metadata   (image, socials, description)
///   - GET/POST /profile/:address                    (bio, avatar, socials)
///   - GET/POST /token/:chainId/:address/chat        (per-token comment strip)
///
/// All writes are wallet-signed; reads are public.
export async function registerSocialRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- metadata

  app.get<{ Params: { chainId: string; address: string } }>(
    '/token/:chainId/:address/metadata',
    async (req, reply) => {
      if (!hasDb()) return reply.code(503).send({ code: 'DB_NOT_CONFIGURED' });
      const chainId = Number(req.params.chainId);
      const addr = req.params.address.toLowerCase();
      if (!Number.isFinite(chainId) || !isAddress(addr)) {
        return reply.code(400).send({ code: 'BAD_PARAMS' });
      }
      const rows = await sql!`
        SELECT chain_id AS "chainId", token_address AS "tokenAddress", image_url AS "imageUrl",
               description, website, twitter, telegram, discord, tiktok,
               wl_list_cid AS "wlListCid", updated_at AS "updatedAt", owner
        FROM app.token_metadata
        WHERE chain_id = ${chainId} AND token_address = ${addr}
        LIMIT 1
      `;
      return reply.send(rows[0] ?? null);
    },
  );

  const MetadataSaveBody = z.object({
    address: z.string(),
    signature: z.string(),
    timestamp: z.number(),
    payload: z.object({
      chainId: z.number().int().positive(),
      // Enforce 20-byte hex — prior z.string() accepted any garbage which polluted
      // token_metadata rows with junk keys AND let a valid signature for token X
      // be redirected to token Y's row by just re-writing payload.tokenAddress.
      tokenAddress: z.string().refine(isAddress, { message: 'not an address' }),
      // http/https only — zod .url() accepts javascript: and data: which the
      // frontend renders as <a href>, opening a stored-XSS click vector.
      imageUrl: z.string().url().refine(_safeHttpUrl, { message: 'http(s) only' }).nullable().optional(),
      description: z.string().max(500).nullable().optional(),
      website: z.string().url().refine(_safeHttpUrl, { message: 'http(s) only' }).nullable().optional(),
      twitter: z.string().max(80).nullable().optional(),
      telegram: z.string().max(80).nullable().optional(),
      discord: z.string().max(80).nullable().optional(),
      tiktok: z.string().max(80).nullable().optional(),
      /// IPFS CID for the pinned whitelist holder list, when the token launched
      /// with a community whitelist. Trade page uses this to fetch the list +
      /// build proofs for WL-eligible buyers. Bounded length to prevent junk
      /// (Pinata CIDs are ~46-62 chars).
      wlListCid: z.string().max(100).nullable().optional(),
    }),
  });

  app.post<{ Params: { chainId: string; address: string } }>('/token/:chainId/:address/metadata', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ code: 'DB_NOT_CONFIGURED' });
    const parsed = MetadataSaveBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'BAD_BODY', errors: parsed.error.flatten() });
    const { address, signature, timestamp, payload } = parsed.data;
    // Belt-and-suspenders: the URL params must agree with the body payload. Without
    // this a wallet could sign a valid envelope for token X but POST it against
    // token Y's URL — routing tools that key on the URL (rate-limits, audit logs)
    // would attribute the write to the wrong resource.
    if (Number(req.params.chainId) !== payload.chainId
      || req.params.address.toLowerCase() !== payload.tokenAddress.toLowerCase()) {
      return reply.code(400).send({ code: 'URL_PAYLOAD_MISMATCH' });
    }
    const envelope: AuthEnvelope = { address, signature: signature as `0x${string}`, timestamp };
    const auth = await verifyEnvelope('metadata:save', payload, envelope);
    if (!auth.ok) return reply.code(401).send({ code: 'UNAUTHORIZED', reason: auth.reason });

    const tokenAddr = payload.tokenAddress.toLowerCase();
    // Ownership: only the launcher of the token can update its metadata. We
    // ask the indexer over its public GraphQL endpoint (compile-service and
    // indexer live on separate Postgres instances post-Railway migration, so
    // the old direct-SQL lookup against `public.launches` throws 42P01 and
    // 500s the endpoint for both attackers AND legitimate launchers). Behavior
    // on missing row is identical: reject with INDEXER_PENDING so an attacker
    // can't front-run a not-yet-indexed launch to plant defacement metadata.
    const launcher = await launcherForToken(payload.chainId, tokenAddr);
    if (launcher === null) {
      return reply.code(409).send({ code: 'INDEXER_PENDING', message: 'launch not indexed yet — retry in a few seconds' });
    }
    if (launcher !== auth.address) {
      return reply.code(403).send({ code: 'NOT_LAUNCHER', launcher, signer: auth.address });
    }

    await sql!`
      INSERT INTO app.token_metadata (chain_id, token_address, image_url, description, website, twitter, telegram, discord, tiktok, wl_list_cid, owner, updated_at)
      VALUES (${payload.chainId}, ${tokenAddr}, ${payload.imageUrl ?? null}, ${payload.description ?? null}, ${payload.website ?? null}, ${payload.twitter ?? null}, ${payload.telegram ?? null}, ${payload.discord ?? null}, ${payload.tiktok ?? null}, ${payload.wlListCid ?? null}, ${auth.address}, now())
      ON CONFLICT (chain_id, token_address) DO UPDATE SET
        image_url = EXCLUDED.image_url,
        description = EXCLUDED.description,
        website = EXCLUDED.website,
        twitter = EXCLUDED.twitter,
        telegram = EXCLUDED.telegram,
        discord = EXCLUDED.discord,
        tiktok = EXCLUDED.tiktok,
        wl_list_cid = EXCLUDED.wl_list_cid,
        owner = EXCLUDED.owner,
        updated_at = now()
    `;
    return reply.send({ ok: true });
  });

  /// Batch metadata read — the home page + discover need image URIs for ~40 tokens per
  /// render. This endpoint takes a list and returns whatever exists in one query so we
  /// don't spam GETs.
  app.post<{ Body: { chainId: number; tokens: string[] } }>('/token-metadata/batch', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ code: 'DB_NOT_CONFIGURED' });
    const body = req.body;
    if (!body || typeof body.chainId !== 'number' || !Array.isArray(body.tokens)) {
      return reply.code(400).send({ code: 'BAD_BODY' });
    }
    const tokens = body.tokens
      .filter((t): t is string => typeof t === 'string' && isAddress(t))
      .map((t) => t.toLowerCase())
      .slice(0, 200);
    if (tokens.length === 0) return reply.send({ items: [] });
    const rows = await sql!`
      SELECT chain_id AS "chainId", token_address AS "tokenAddress", image_url AS "imageUrl",
             description, website, twitter, telegram, discord, tiktok,
             wl_list_cid AS "wlListCid", updated_at AS "updatedAt"
      FROM app.token_metadata
      WHERE chain_id = ${body.chainId} AND token_address IN ${sql!(tokens)}
    `;
    return reply.send({ items: rows });
  });

  // ---------------------------------------------------------------- profile

  app.get<{ Params: { address: string } }>('/profile/:address', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ code: 'DB_NOT_CONFIGURED' });
    const addr = req.params.address.toLowerCase();
    if (!isAddress(addr)) return reply.code(400).send({ code: 'BAD_ADDRESS' });
    const rows = await sql!`
      SELECT address, username, avatar_url AS "avatarUrl",
             avatar_nft_chain_id AS "avatarNftChainId",
             avatar_nft_chain AS "avatarNftChain",
             avatar_nft_contract_address AS "avatarNftContractAddress",
             avatar_nft_token_id AS "avatarNftTokenId",
             avatar_nft_collection_name AS "avatarNftCollectionName",
             avatar_nft_token_name AS "avatarNftTokenName",
             bio, twitter, telegram, discord, website, updated_at AS "updatedAt"
      FROM app.user_profile
      WHERE address = ${addr}
      LIMIT 1
    `;
    return reply.send(rows[0] ?? null);
  });

  const ProfileSaveBody = z.object({
    address: z.string(),
    signature: z.string(),
    timestamp: z.number(),
    payload: z.object({
      username: z.string().max(24).nullable().optional(),
      avatarUrl: z.string().url().refine(_safeHttpUrl, { message: 'http(s) only' }).nullable().optional(),
      avatarNft: z.object({
        chainId: z.number().int().positive(),
        chain: z.string().min(1).max(40),
        contractAddress: z.string().refine(isAddress, { message: 'invalid contract address' }),
        tokenId: z.string().min(1).max(100),
        collectionName: z.string().max(120).nullable(),
        tokenName: z.string().max(120).nullable(),
      }).nullable().optional(),
      bio: z.string().max(200).nullable().optional(),
      twitter: z.string().max(80).nullable().optional(),
      telegram: z.string().max(80).nullable().optional(),
      discord: z.string().max(80).nullable().optional(),
      website: z.string().url().refine(_safeHttpUrl, { message: 'http(s) only' }).nullable().optional(),
    }),
  });

  app.post('/profile/:address', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ code: 'DB_NOT_CONFIGURED' });
    const paramAddr = (req.params as { address: string }).address.toLowerCase();
    if (!isAddress(paramAddr)) return reply.code(400).send({ code: 'BAD_ADDRESS' });
    const parsed = ProfileSaveBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'BAD_BODY', errors: parsed.error.flatten() });
    const { address, signature, timestamp, payload } = parsed.data;
    const envelope: AuthEnvelope = { address, signature: signature as `0x${string}`, timestamp };
    const auth = await verifyEnvelope('profile:save', payload, envelope);
    if (!auth.ok) return reply.code(401).send({ code: 'UNAUTHORIZED', reason: auth.reason });
    if (auth.address !== paramAddr) return reply.code(403).send({ code: 'PATH_MISMATCH' });

    await sql!`
      INSERT INTO app.user_profile (
        address, username, avatar_url,
        avatar_nft_chain_id, avatar_nft_chain, avatar_nft_contract_address,
        avatar_nft_token_id, avatar_nft_collection_name, avatar_nft_token_name,
        bio, twitter, telegram, discord, website, updated_at
      ) VALUES (
        ${auth.address}, ${payload.username ?? null}, ${payload.avatarUrl ?? null},
        ${payload.avatarNft?.chainId ?? null}, ${payload.avatarNft?.chain ?? null}, ${payload.avatarNft?.contractAddress?.toLowerCase() ?? null},
        ${payload.avatarNft?.tokenId ?? null}, ${payload.avatarNft?.collectionName ?? null}, ${payload.avatarNft?.tokenName ?? null},
        ${payload.bio ?? null}, ${payload.twitter ?? null}, ${payload.telegram ?? null}, ${payload.discord ?? null}, ${payload.website ?? null}, now()
      )
      ON CONFLICT (address) DO UPDATE SET
        username = EXCLUDED.username,
        avatar_url = EXCLUDED.avatar_url,
        avatar_nft_chain_id = EXCLUDED.avatar_nft_chain_id,
        avatar_nft_chain = EXCLUDED.avatar_nft_chain,
        avatar_nft_contract_address = EXCLUDED.avatar_nft_contract_address,
        avatar_nft_token_id = EXCLUDED.avatar_nft_token_id,
        avatar_nft_collection_name = EXCLUDED.avatar_nft_collection_name,
        avatar_nft_token_name = EXCLUDED.avatar_nft_token_name,
        bio = EXCLUDED.bio,
        twitter = EXCLUDED.twitter,
        telegram = EXCLUDED.telegram,
        discord = EXCLUDED.discord,
        website = EXCLUDED.website,
        updated_at = now()
    `;
    return reply.send({ ok: true });
  });

  // ---------------------------------------------------------------- chat

  app.get<{ Params: { chainId: string; address: string }; Querystring: { limit?: string } }>(
    '/token/:chainId/:address/chat',
    async (req, reply) => {
      if (!hasDb()) return reply.code(503).send({ code: 'DB_NOT_CONFIGURED' });
      const chainId = Number(req.params.chainId);
      const addr = req.params.address.toLowerCase();
      if (!Number.isFinite(chainId) || !isAddress(addr)) return reply.code(400).send({ code: 'BAD_PARAMS' });
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 100)));
      const rows = await sql!`
        SELECT id::text AS id, sender_address AS "senderAddress", text, extract(epoch from created_at)::bigint AS "ts"
        FROM app.token_chat
        WHERE chain_id = ${chainId} AND token_address = ${addr}
        ORDER BY id DESC
        LIMIT ${limit}
      `;
      // Return oldest-first so the UI can append newest at the bottom naturally.
      return reply.send({ items: rows.reverse() });
    },
  );

  const ChatPostBody = z.object({
    address: z.string(),
    signature: z.string(),
    timestamp: z.number(),
    payload: z.object({
      chainId: z.number().int().positive(),
      tokenAddress: z.string(),
      text: z.string().min(1).max(400),
    }),
  });

  app.post('/token/:chainId/:address/chat', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ code: 'DB_NOT_CONFIGURED' });
    const parsed = ChatPostBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'BAD_BODY', errors: parsed.error.flatten() });
    const { address, signature, timestamp, payload } = parsed.data;
    const envelope: AuthEnvelope = { address, signature: signature as `0x${string}`, timestamp };
    const auth = await verifyEnvelope('chat:post', payload, envelope);
    if (!auth.ok) return reply.code(401).send({ code: 'UNAUTHORIZED', reason: auth.reason });
    const tokenAddr = payload.tokenAddress.toLowerCase();
    if (!isAddress(tokenAddr)) return reply.code(400).send({ code: 'BAD_TOKEN' });

    await sql!`
      INSERT INTO app.token_chat (chain_id, token_address, sender_address, text)
      VALUES (${payload.chainId}, ${tokenAddr}, ${auth.address}, ${payload.text})
    `;
    return reply.send({ ok: true });
  });

  // ---------------------------------------------------------------- follows
  //
  // Simple social graph. Writes are signed (follow / unfollow); reads are public
  // and paginated by client-side .slice() (limit built into query). Enriches
  // the response with the followee/follower's profile so the modal can render
  // avatars without a second fetch per address.

  const FollowActionBody = z.object({
    address: z.string(),
    signature: z.string(),
    timestamp: z.number(),
    payload: z.object({
      /// The target being followed / unfollowed (lowercased address).
      target: z.string(),
    }),
  });

  /// POST /follows/:target — signer follows target. Idempotent (ON CONFLICT DO NOTHING).
  app.post('/follows/:target', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ code: 'DB_NOT_CONFIGURED' });
    const paramTarget = (req.params as { target: string }).target.toLowerCase();
    if (!isAddress(paramTarget)) return reply.code(400).send({ code: 'BAD_TARGET' });
    const parsed = FollowActionBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'BAD_BODY', errors: parsed.error.flatten() });
    const { address, signature, timestamp, payload } = parsed.data;
    const envelope: AuthEnvelope = { address, signature: signature as `0x${string}`, timestamp };
    const auth = await verifyEnvelope('follow:add', payload, envelope);
    if (!auth.ok) return reply.code(401).send({ code: 'UNAUTHORIZED', reason: auth.reason });
    // Payload target must match URL target so signature can't be replayed against a different followee.
    if (payload.target.toLowerCase() !== paramTarget) return reply.code(400).send({ code: 'TARGET_MISMATCH' });
    // Can't follow yourself — silently succeed rather than 400 so accidental self-follow doesn't UX-break.
    if (auth.address === paramTarget) return reply.send({ ok: true, selfIgnored: true });

    await sql!`
      INSERT INTO app.follows (follower, followee)
      VALUES (${auth.address}, ${paramTarget})
      ON CONFLICT (follower, followee) DO NOTHING
    `;
    return reply.send({ ok: true });
  });

  /// DELETE /follows/:target — signer unfollows target. Also uses POST body for
  /// consistency (browsers strip DELETE bodies more aggressively; fastify handles
  /// both fine but signed POST is the simpler client path).
  app.post('/follows/:target/unfollow', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ code: 'DB_NOT_CONFIGURED' });
    const paramTarget = (req.params as { target: string }).target.toLowerCase();
    if (!isAddress(paramTarget)) return reply.code(400).send({ code: 'BAD_TARGET' });
    const parsed = FollowActionBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'BAD_BODY', errors: parsed.error.flatten() });
    const { address, signature, timestamp, payload } = parsed.data;
    const envelope: AuthEnvelope = { address, signature: signature as `0x${string}`, timestamp };
    const auth = await verifyEnvelope('follow:remove', payload, envelope);
    if (!auth.ok) return reply.code(401).send({ code: 'UNAUTHORIZED', reason: auth.reason });
    if (payload.target.toLowerCase() !== paramTarget) return reply.code(400).send({ code: 'TARGET_MISMATCH' });

    await sql!`DELETE FROM app.follows WHERE follower = ${auth.address} AND followee = ${paramTarget}`;
    return reply.send({ ok: true });
  });

  /// GET /followers/:address — public list of everyone who follows this address.
  /// Enriches with each follower's profile so the modal renders avatars without
  /// a per-row fetch. Ordered by most recent follow first, capped at 200.
  app.get<{ Params: { address: string } }>('/followers/:address', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ code: 'DB_NOT_CONFIGURED' });
    const addr = req.params.address.toLowerCase();
    if (!isAddress(addr)) return reply.code(400).send({ code: 'BAD_ADDRESS' });
    const rows = await sql!<
      { address: string; username: string | null; avatar_url: string | null; followed_at: Date }[]
    >`
      SELECT f.follower AS address,
             p.username,
             p.avatar_url,
             f.followed_at
      FROM app.follows f
      LEFT JOIN app.user_profile p ON p.address = f.follower
      WHERE f.followee = ${addr}
      ORDER BY f.followed_at DESC
      LIMIT 200
    `;
    return reply.send({
      count: rows.length,
      items: rows.map((r) => ({
        address: r.address,
        username: r.username,
        avatarUrl: r.avatar_url,
        followedAt: r.followed_at.toISOString(),
      })),
    });
  });

  /// GET /following/:address — public list of everyone this address follows.
  /// Same shape as /followers for a uniform frontend renderer.
  app.get<{ Params: { address: string } }>('/following/:address', async (req, reply) => {
    if (!hasDb()) return reply.code(503).send({ code: 'DB_NOT_CONFIGURED' });
    const addr = req.params.address.toLowerCase();
    if (!isAddress(addr)) return reply.code(400).send({ code: 'BAD_ADDRESS' });
    const rows = await sql!<
      { address: string; username: string | null; avatar_url: string | null; followed_at: Date }[]
    >`
      SELECT f.followee AS address,
             p.username,
             p.avatar_url,
             f.followed_at
      FROM app.follows f
      LEFT JOIN app.user_profile p ON p.address = f.followee
      WHERE f.follower = ${addr}
      ORDER BY f.followed_at DESC
      LIMIT 200
    `;
    return reply.send({
      count: rows.length,
      items: rows.map((r) => ({
        address: r.address,
        username: r.username,
        avatarUrl: r.avatar_url,
        followedAt: r.followed_at.toISOString(),
      })),
    });
  });
}
