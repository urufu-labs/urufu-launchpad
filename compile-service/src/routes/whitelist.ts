import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAddress } from 'viem';

import { snapshotHolders, proofFor, snapshotFromIpfs } from '../wl-snapshot.ts';

const SnapshotBody = z.object({
  chainId: z.number().int().positive(),
  tokenAddress: z.string().refine((s) => isAddress(s), { message: 'not an EVM address' }),
  minBalance: z.string().optional(), // bigint-as-string; parsed below
});

/// Register WL snapshot endpoints. Called by server.ts alongside the other route
/// modules. Two endpoints:
///
///   POST /wl/snapshot  — accepts { chainId, tokenAddress, minBalance? }, returns
///                        { root, snapshotBlock, holderCount, listId, holders }.
///                        The `root` goes into the WL launch tx; `listId` gets
///                        handed back to /wl/proof at buy time.
///
///   GET  /wl/proof     — accepts ?listId&addr, returns { proof } or 404 if the
///                        list has been evicted from the in-memory cache OR the
///                        address isn't in the list.
export async function registerWhitelistRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post('/wl/snapshot', async (request, reply) => {
    const parsed = SnapshotBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'INVALID_BODY', errors: parsed.error.flatten() });
    }
    const { chainId, tokenAddress, minBalance } = parsed.data;
    let minBal: bigint | undefined;
    if (minBalance !== undefined) {
      try {
        minBal = BigInt(minBalance);
        if (minBal < 0n) throw new Error('negative');
      } catch {
        return reply.code(400).send({ code: 'INVALID_MIN_BALANCE', message: 'minBalance must be a non-negative integer string' });
      }
    }

    try {
      const snap = await snapshotHolders({ chainId, tokenAddress, minBalance: minBal });
      return reply.send({
        root: snap.root,
        snapshotBlock: snap.snapshotBlock.toString(),
        holderCount: snap.holderCount,
        listId: snap.listId,
        listCid: snap.listCid,
        listGatewayUrl: snap.listGatewayUrl,
        // Bounded — return up to 500 holders inline so tiny lists don't require a
        // separate fetch. Big lists still get a full response via the listId path.
        holdersPreview: snap.holders.slice(0, 500),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.warn({ err: msg }, 'wl snapshot failed');
      return reply.code(400).send({ code: 'SNAPSHOT_FAILED', message: msg });
    }
  });

  app.get('/wl/proof', async (request, reply) => {
    const q = request.query as { listId?: string; addr?: string; listCid?: string };
    if (!q.addr) {
      return reply.code(400).send({ code: 'MISSING_PARAMS', message: 'addr required' });
    }
    if (!isAddress(q.addr)) {
      return reply.code(400).send({ code: 'INVALID_ADDR' });
    }
    if (!q.listId && !q.listCid) {
      return reply.code(400).send({ code: 'MISSING_PARAMS', message: 'listId or listCid required' });
    }

    // Try in-memory cache first. If missing, fall back to IPFS via listCid — the
    // durable path that survives process restarts.
    let proof = q.listId ? proofFor(q.listId, q.addr) : null;
    if (proof === null && q.listCid) {
      const snap = await snapshotFromIpfs(q.listCid);
      if (snap) {
        proof = proofFor(snap.listId, q.addr) ?? proofFor(q.listCid, q.addr);
      }
    }
    if (proof === null) {
      // Two failure modes conflated: list not found OR address ineligible. The
      // frontend can distinguish by re-snapshotting and checking `holderCount`
      // + membership; on-endpoint distinguishing would need holding the list
      // separately from the proof.
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'list unavailable or address not on it' });
    }
    return reply.send({ proof });
  });
}
