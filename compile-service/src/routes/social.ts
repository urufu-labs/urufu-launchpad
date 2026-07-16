import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAddress } from 'viem';

import { sql, hasDb } from '../db.ts';
import { verifyEnvelope, type AuthEnvelope } from '../auth.ts';

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
               description, website, twitter, telegram, discord, tiktok, updated_at AS "updatedAt", owner
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
      imageUrl: z.string().url().nullable().optional(),
      description: z.string().max(500).nullable().optional(),
      website: z.string().url().nullable().optional(),
      twitter: z.string().max(80).nullable().optional(),
      telegram: z.string().max(80).nullable().optional(),
      discord: z.string().max(80).nullable().optional(),
      tiktok: z.string().max(80).nullable().optional(),
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
    // Ownership: only the launcher of the token can update its metadata. We check
    // Ponder's `launches` table (same Postgres, public schema). If the launcher isn't
    // recorded (indexer still catching up), we allow the write from any wallet — the
    // metadata still requires a valid signature so it's not fully open.
    const launcherRows = await sql!`
      SELECT launched_by FROM public.launches
      WHERE chain_id = ${payload.chainId} AND token_address = ${tokenAddr}
      LIMIT 1
    `;
    const launcherRow = launcherRows[0];
    if (!launcherRow) {
      // Prior behavior: allow any signed wallet to write metadata when the indexer
      // hadn't caught up yet. That opened a defacement window on every fresh launch —
      // an attacker who saw a launch in mempool could plant a phishing image + socials
      // before the indexer added the launches row. Now the endpoint waits for the
      // indexer to confirm the launcher; the launcher retries a few seconds later. This
      // trades a small usability blip on fresh launches for eliminating the exploit
      // class entirely.
      return reply.code(409).send({ code: 'INDEXER_PENDING', message: 'launch not indexed yet — retry in a few seconds' });
    }
    const launcher = String(launcherRow.launched_by).toLowerCase();
    if (launcher !== auth.address) {
      return reply.code(403).send({ code: 'NOT_LAUNCHER', launcher, signer: auth.address });
    }

    await sql!`
      INSERT INTO app.token_metadata (chain_id, token_address, image_url, description, website, twitter, telegram, discord, tiktok, owner, updated_at)
      VALUES (${payload.chainId}, ${tokenAddr}, ${payload.imageUrl ?? null}, ${payload.description ?? null}, ${payload.website ?? null}, ${payload.twitter ?? null}, ${payload.telegram ?? null}, ${payload.discord ?? null}, ${payload.tiktok ?? null}, ${auth.address}, now())
      ON CONFLICT (chain_id, token_address) DO UPDATE SET
        image_url = EXCLUDED.image_url,
        description = EXCLUDED.description,
        website = EXCLUDED.website,
        twitter = EXCLUDED.twitter,
        telegram = EXCLUDED.telegram,
        discord = EXCLUDED.discord,
        tiktok = EXCLUDED.tiktok,
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
             description, website, twitter, telegram, discord, tiktok, updated_at AS "updatedAt"
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
      SELECT address, username, avatar_url AS "avatarUrl", bio, twitter, telegram, discord, website, updated_at AS "updatedAt"
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
      avatarUrl: z.string().url().nullable().optional(),
      bio: z.string().max(200).nullable().optional(),
      twitter: z.string().max(80).nullable().optional(),
      telegram: z.string().max(80).nullable().optional(),
      discord: z.string().max(80).nullable().optional(),
      website: z.string().url().nullable().optional(),
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
      INSERT INTO app.user_profile (address, username, avatar_url, bio, twitter, telegram, discord, website, updated_at)
      VALUES (${auth.address}, ${payload.username ?? null}, ${payload.avatarUrl ?? null}, ${payload.bio ?? null}, ${payload.twitter ?? null}, ${payload.telegram ?? null}, ${payload.discord ?? null}, ${payload.website ?? null}, now())
      ON CONFLICT (address) DO UPDATE SET
        username = EXCLUDED.username,
        avatar_url = EXCLUDED.avatar_url,
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
}
