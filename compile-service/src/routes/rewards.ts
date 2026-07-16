/// Flywheel rewards HTTP surface. Two public GETs for the profile page claim UI,
/// one gated POST for the operator to trigger a snapshot + on-chain publish.
///
/// Auth model:
///   - GET /rewards/*                — public, safe reads (no PII, just proofs)
///   - POST /rewards/:chain/publish  — requires header `x-keeper-secret` matching
///                                     the env var `KEEPER_TRIGGER_SECRET`. Anyone
///                                     with the secret can trigger; the on-chain
///                                     tx still signs from the server-held
///                                     `KEEPER_PRIVATE_KEY` (which is the vault
///                                     owner today), so blast radius is bounded to
///                                     "publish an epoch," never "drain the vault."
///
/// The keeper trigger secret should be a long random string, rotated any time
/// the compile-service logs might have leaked (Railway ships them by default).

import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { isAddress, type Address } from 'viem';
import { z } from 'zod';

import { publishEpoch, vaultSummary, proofFor, epochsForHolder } from '../rewards.ts';

const CHAIN_PATH = z.enum(['base']);
const ADDRESS_PATH = z.string().refine(isAddress, { message: 'invalid address' });

export async function registerRewardsRoutes(app: FastifyInstance): Promise<void> {
  // GET /rewards/:chain/vault-summary — for the profile page's rewards section
  // header (current vault balance + how many epochs have been published).
  app.get<{ Params: { chain: string } }>('/rewards/:chain/vault-summary', async (req, reply) => {
    const parsed = CHAIN_PATH.safeParse(req.params.chain);
    if (!parsed.success) return reply.code(400).send({ code: 'BAD_CHAIN' });
    const summary = await vaultSummary(parsed.data);
    if (!summary) return reply.code(404).send({ code: 'CHAIN_NOT_CONFIGURED' });
    return reply.send(summary);
  });

  // GET /rewards/:chain/epochs/:address — list every epoch this address has an
  // allocation in. Frontend cross-checks `vault.isClaimed` on-chain per epoch.
  app.get<{ Params: { chain: string; address: string } }>(
    '/rewards/:chain/epochs/:address',
    async (req, reply) => {
      const chain = CHAIN_PATH.safeParse(req.params.chain);
      if (!chain.success) return reply.code(400).send({ code: 'BAD_CHAIN' });
      const addr = ADDRESS_PATH.safeParse(req.params.address);
      if (!addr.success) return reply.code(400).send({ code: 'BAD_ADDRESS' });
      const items = await epochsForHolder(chain.data, addr.data as Address);
      return reply.send({ items });
    },
  );

  // GET /rewards/:chain/:epochId/:address — proof for a specific (epoch, holder).
  // Used by the claim button; the on-chain claim call needs both `amount` and `proof`.
  app.get<{ Params: { chain: string; epochId: string; address: string } }>(
    '/rewards/:chain/:epochId/:address',
    async (req, reply) => {
      const chain = CHAIN_PATH.safeParse(req.params.chain);
      if (!chain.success) return reply.code(400).send({ code: 'BAD_CHAIN' });
      const addr = ADDRESS_PATH.safeParse(req.params.address);
      if (!addr.success) return reply.code(400).send({ code: 'BAD_ADDRESS' });
      const epochId = Number(req.params.epochId);
      if (!Number.isInteger(epochId) || epochId < 0) return reply.code(400).send({ code: 'BAD_EPOCH' });
      const found = await proofFor(chain.data, epochId, addr.data as Address);
      if (!found) return reply.code(404).send({ code: 'NOT_ELIGIBLE' });
      return reply.send({ epochId, ...found });
    },
  );

  // POST /rewards/:chain/publish — operator-triggered. Reads snapshot, builds
  // tree, broadcasts addEpoch, persists. Body: { totalAmount?: string } — omit
  // to distribute the entire current vault balance.
  const publishBody = z.object({
    totalAmount: z.string().regex(/^\d+$/, 'must be a wei-scale integer string').optional(),
  });
  app.post<{ Params: { chain: string }; Body: unknown }>('/rewards/:chain/publish', async (req, reply) => {
    const expected = process.env.KEEPER_TRIGGER_SECRET;
    if (!expected) return reply.code(503).send({ code: 'PUBLISH_DISABLED' });
    const got = req.headers['x-keeper-secret'];
    // Constant-time compare so an attacker with rate-limited-but-many attempts can't
    // side-channel the secret via response-time skew on partial-match. Length mismatch
    // is handled explicitly since timingSafeEqual requires equal-length buffers.
    if (typeof got !== 'string' || got.length !== expected.length) {
      return reply.code(401).send({ code: 'UNAUTHORIZED' });
    }
    const gotBuf = Buffer.from(got, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (!timingSafeEqual(gotBuf, expBuf)) {
      return reply.code(401).send({ code: 'UNAUTHORIZED' });
    }

    const chain = CHAIN_PATH.safeParse(req.params.chain);
    if (!chain.success) return reply.code(400).send({ code: 'BAD_CHAIN' });
    const body = publishBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ code: 'BAD_BODY', errors: body.error.flatten() });

    try {
      const result = await publishEpoch({
        chainSlug: chain.data,
        totalAmountOverride: body.data.totalAmount ? BigInt(body.data.totalAmount) : undefined,
      });
      return reply.send(result);
    } catch (err) {
      req.log.error({ err }, 'rewards publish failed');
      return reply.code(500).send({ code: 'PUBLISH_FAILED', message: (err as Error).message });
    }
  });
}
