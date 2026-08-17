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

import {
  publishEpoch,
  vaultSummary,
  proofFor,
  epochsForHolder,
  fetchGemuHoldersFromBlockscout,
  fetchGemuHoldersFromChain,
  fetchGemuHoldersFromIndexer,
} from '../rewards.ts';
import { createPublicClient, http } from 'viem';

const CHAIN_PATH = z.enum(['robinhood']);
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

  // GET /rewards/:chain/_probe/blockscout — DIAGNOSTIC. Calls the Blockscout
  // holder fetcher directly and reports what it saw. Lets an operator confirm
  // whether the Railway container can actually reach Blockscout (some hosts
  // block outbound to public block explorers) instead of guessing from a
  // silently-fallen-back publish result. Public because it exposes only
  // counts, not addresses.
  app.get<{ Params: { chain: string } }>('/rewards/:chain/_probe/blockscout', async (req, reply) => {
    const parsed = CHAIN_PATH.safeParse(req.params.chain);
    if (!parsed.success) return reply.code(400).send({ code: 'BAD_CHAIN' });
    const { chainConfigFor } = await import('../rewards.ts');
    const cfg = chainConfigFor(parsed.data);
    if (!cfg) return reply.code(404).send({ code: 'CHAIN_NOT_CONFIGURED' });
    if (!cfg.blockscoutUrl) return reply.send({ ok: false, reason: 'no blockscoutUrl in cfg' });
    const t0 = Date.now();
    try {
      const holders = await fetchGemuHoldersFromBlockscout(cfg);
      const totalNfts = holders.reduce((s, h) => s + h.balance, 0n);
      return reply.send({
        ok: true,
        blockscoutUrl: cfg.blockscoutUrl,
        holderCount: holders.length,
        totalNfts: totalNfts.toString(),
        elapsedMs: Date.now() - t0,
      });
    } catch (err) {
      return reply.send({
        ok: false,
        blockscoutUrl: cfg.blockscoutUrl,
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - t0,
      });
    }
  });

  // GET /rewards/:chain/_probe/pending-tree — DIAGNOSTIC. Reads rewards_leaves
  // for the current on-chain pendingEpoch WITHOUT the rewards_epochs JOIN that
  // proofFor/epochsForHolder use, so we can verify a pending tree's coverage
  // BEFORE it activates. Returns leaf count, sum-of-amounts, and optional
  // ?contains=addr,addr,addr membership check.
  app.get<{ Params: { chain: string }; Querystring: { contains?: string } }>(
    '/rewards/:chain/_probe/pending-tree',
    async (req, reply) => {
      const parsed = CHAIN_PATH.safeParse(req.params.chain);
      if (!parsed.success) return reply.code(400).send({ code: 'BAD_CHAIN' });
      const { chainConfigFor } = await import('../rewards.ts');
      const { sql } = await import('../db.ts');
      const cfg = chainConfigFor(parsed.data);
      if (!cfg) return reply.code(404).send({ code: 'CHAIN_NOT_CONFIGURED' });
      if (!sql) return reply.code(503).send({ code: 'NO_DB' });

      // Read the pending epoch's expectedEpochId + merkleRoot from chain to
      // pin the DB query to exactly that pending tree.
      const { createPublicClient, http, parseAbi } = await import('viem');
      const pub = createPublicClient({ transport: http(cfg.rpcUrl) });
      const abi = parseAbi([
        'function pendingEpoch() view returns (uint256,bytes32,uint256,uint64)',
      ]);
      const pending = (await pub.readContract({
        address: cfg.vaultAddress,
        abi,
        functionName: 'pendingEpoch',
      })) as readonly [bigint, `0x${string}`, bigint, bigint];
      const [pExpectedId, pRoot, pTotal, pReadyAt] = pending;
      if (pReadyAt === 0n) {
        return reply.send({ ok: false, reason: 'no pending epoch on chain' });
      }

      const epochIdNum = Number(pExpectedId);
      const rows = await sql<Array<{ holder: string; amount: string }>>`
        SELECT holder, amount
        FROM app.rewards_leaves
        WHERE chain_id = ${cfg.chainId} AND epoch_id = ${epochIdNum}
      `;
      const set = new Set(rows.map((r) => r.holder.toLowerCase()));
      const totalAmountSum = rows.reduce((s, r) => s + BigInt(r.amount), 0n);

      const containsRaw = (req.query.contains ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const contains: Record<string, boolean> = {};
      for (const c of containsRaw) contains[c.toLowerCase()] = set.has(c.toLowerCase());

      return reply.send({
        ok: true,
        pending: {
          expectedEpochId: epochIdNum,
          merkleRoot: pRoot,
          totalAmount: pTotal.toString(),
          readyAt: Number(pReadyAt),
        },
        db: {
          leafCount: rows.length,
          totalAmountSum: totalAmountSum.toString(),
          matchesOnchainTotal: totalAmountSum === pTotal,
        },
        contains,
      });
    },
  );

  // GET /rewards/:chain/_probe/all-sources — DIAGNOSTIC. Runs each holder
  // source in parallel and reports what each returned. Used to diagnose why
  // the tree-building path is falling through to the wrong source (e.g.
  // on-chain walk times out silently → Blockscout wins by default). Public
  // because it exposes only counts, not addresses.
  app.get<{ Params: { chain: string }; Querystring: { source?: string } }>(
    '/rewards/:chain/_probe/all-sources',
    async (req, reply) => {
      const parsed = CHAIN_PATH.safeParse(req.params.chain);
      if (!parsed.success) return reply.code(400).send({ code: 'BAD_CHAIN' });
      const { chainConfigFor } = await import('../rewards.ts');
      const cfg = chainConfigFor(parsed.data);
      if (!cfg) return reply.code(404).send({ code: 'CHAIN_NOT_CONFIGURED' });
      const pub = createPublicClient({ transport: http(cfg.rpcUrl) });

      async function run<T>(fn: () => Promise<T[]>): Promise<{ ok: boolean; count?: number; error?: string; elapsedMs: number }> {
        const t0 = Date.now();
        try {
          const out = await fn();
          return { ok: true, count: out.length, elapsedMs: Date.now() - t0 };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - t0 };
        }
      }

      // Serial so we don't accidentally trigger rate limits.
      const chain = await run(() => fetchGemuHoldersFromChain(cfg, pub as unknown as Parameters<typeof fetchGemuHoldersFromChain>[1]));
      const indexer = await run(() => fetchGemuHoldersFromIndexer(cfg));
      const blockscout = cfg.blockscoutUrl
        ? await run(() => fetchGemuHoldersFromBlockscout(cfg))
        : { ok: false, error: 'no blockscoutUrl in cfg', elapsedMs: 0 };

      return reply.send({ chain, indexer, blockscout });
    },
  );

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
