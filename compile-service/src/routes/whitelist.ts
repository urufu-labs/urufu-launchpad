import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAddress } from 'viem';

import {
  snapshotHolders,
  proofFor,
  snapshotFromIpfs,
  WlSnapshotTruncated,
  WlSnapshotBlockDrift,
  WlHolderCountExceedsCap,
  WlIpfsResponseTooLarge,
} from '../wl-snapshot.ts';
import { Semaphore } from '../isolated-build.ts';

const SnapshotBody = z.object({
  chainId: z.number().int().positive(),
  tokenAddress: z.string().refine((s) => isAddress(s), { message: 'not an EVM address' }),
  minBalance: z.string().optional(), // bigint-as-string; parsed below
  /// Opt-in switch. Default (unset / false) runs the snapshot in STRICT mode:
  /// if Blockscout has more holder pages than the module cap OR the RPC
  /// fallback can't scan from block 0, the route returns 422 with a distinct
  /// `SNAPSHOT_TRUNCATED` code so the caller sees the incompleteness. Set
  /// `true` only when a best-effort snapshot is genuinely acceptable — the
  /// response then carries `partial: true` so downstream code can flag it.
  allowPartial: z.boolean().optional(),
});

// -----------------------------------------------------------------------------
// FINDING 3 (HIGH): admission controls for the public WL endpoints.
// -----------------------------------------------------------------------------
//
// Both /wl/snapshot and /wl/proof are public and both can trigger expensive
// work — snapshot walks Blockscout (up to 100 pages) or replays 25M blocks of
// Transfer events, then builds a Merkle tree over up to 50k addresses; proof
// pulls a JSON blob from IPFS. Without admission controls a single hostile
// caller could saturate the process indefinitely.
//
// The knobs below mirror the pattern used by /compile in server.ts (see the
// `Semaphore` in `isolated-build.ts`): a small concurrency cap paired with a
// bounded FIFO queue and a per-caller wait ceiling, plus a hard wall-clock
// timeout on the operation itself. Values are conservative — WL snapshots
// are rare (one per launch) and small (few hundred holders typical), so
// serializing to 2 in-flight with 8 queued is plenty. Everything is
// env-overridable so operators can tune without a redeploy.

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

export function defaultWlConcurrency(): number {
  return envInt('WL_MAX_CONCURRENCY', 2);
}
export function defaultWlQueueLimit(): number {
  return envInt('WL_MAX_QUEUE', 8);
}
export function defaultWlQueueWaitMs(): number {
  return envInt('WL_QUEUE_WAIT_MS', 30_000);
}
/// FINDING 3 (HIGH): hard wall-clock ceiling on a single snapshot operation.
/// If the Blockscout walk + Merkle build + IPFS pin exceeds this, we abort
/// the AbortController wired to every downstream fetch and return a 504 so
/// the semaphore slot is reclaimed for the next request.
export function defaultWlOperationTimeoutMs(): number {
  return envInt('WL_OPERATION_TIMEOUT_MS', 120_000);
}

/// FINDING 3 (HIGH): body cap on POST /wl/snapshot. A legitimate body is
/// { chainId, tokenAddress, minBalance?, allowPartial? } — well under 1 KB.
/// 8 KB gives comfortable headroom while blocking a hostile client from
/// pinning process memory with megabyte-scale bodies before the handler
/// even runs.
export function defaultWlSnapshotBodyLimitBytes(): number {
  return envInt('WL_SNAPSHOT_BODY_LIMIT_BYTES', 8 * 1024);
}

/// Global for the process. `defaultWl*` helpers are called ONCE at import
/// time so tests that flip env vars mid-process need to import + inspect
/// this instance directly if they want to peek at counts. Route-level
/// rate limits are declared inline below in `registerWhitelistRoutes` so
/// they attach to the correct FastifyInstance.
export const wlSemaphore = new Semaphore(
  defaultWlConcurrency(),
  defaultWlQueueLimit(),
  defaultWlQueueWaitMs(),
);

const WL_OPERATION_TIMEOUT_MS = defaultWlOperationTimeoutMs();
const WL_SNAPSHOT_BODY_LIMIT_BYTES = defaultWlSnapshotBodyLimitBytes();

/// FINDING 3 (HIGH): per-route rate limits. Snapshot is expensive so we cap
/// at 2/min per IP; proof is cheaper (in-memory or a single IPFS GET) so
/// 10/min gives a well-behaved buyer plenty of headroom while still blocking
/// a rapid enumeration attack. Overridable via env for operators.
export function defaultWlSnapshotRateMax(): number {
  return envInt('WL_SNAPSHOT_RATE_MAX', 2);
}
export function defaultWlProofRateMax(): number {
  return envInt('WL_PROOF_RATE_MAX', 10);
}

/// FINDING 3 (HIGH): compose the request-level abort signal with the
/// wall-clock timeout so the snapshot builder cancels on EITHER firing.
/// Kept private — callers just get the resulting signal and the timeout
/// clear function so they can drop the timer when the operation finishes
/// naturally.
function _snapshotAbortController(
  requestSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; controller: AbortController; timedOut: () => boolean; done: () => void } {
  const controller = new AbortController();
  let timedOutFlag = false;
  const timer = setTimeout(() => {
    timedOutFlag = true;
    controller.abort(new Error(`wl snapshot exceeded ${timeoutMs}ms wall-clock`));
  }, timeoutMs);
  const onReqAbort = () => controller.abort(new Error('client disconnected'));
  if (requestSignal) {
    if (requestSignal.aborted) onReqAbort();
    else requestSignal.addEventListener('abort', onReqAbort, { once: true });
  }
  return {
    signal: controller.signal,
    controller,
    timedOut: () => timedOutFlag,
    done: () => {
      clearTimeout(timer);
      if (requestSignal) requestSignal.removeEventListener('abort', onReqAbort);
    },
  };
}

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
  app.post(
    '/wl/snapshot',
    {
      // FINDING 3 (HIGH): tighter body cap than the app-wide default — the
      // legitimate body is ~200 bytes. 8 KB blocks megabyte-scale payloads
      // from pinning memory while they sit in the semaphore queue.
      bodyLimit: WL_SNAPSHOT_BODY_LIMIT_BYTES,
      config: {
        // FINDING 3 (HIGH): per-IP snapshot rate cap. Snapshot walks a full
        // holder set + builds a Merkle tree — expensive enough that even
        // one well-formed request per launch should not be exceeded by an
        // honest client. 2/min gives room for a retry, blocks abuse.
        rateLimit: {
          max: defaultWlSnapshotRateMax(),
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
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

    // FINDING 3 (HIGH): admission control + wall-clock timeout + client-
    // disconnect propagation. Wrap the snapshot in `wlSemaphore.run` so we
    // serialize with the process-wide 2-in-flight cap; race it against a
    // dedicated AbortController that fires on EITHER a client disconnect
    // OR the WL_OPERATION_TIMEOUT_MS wall clock. The controller's signal
    // is threaded into `snapshotHolders` and every fetch it makes.
    const abort = _snapshotAbortController(
      // Only listen for `aborted` — the real client-disconnect signal from
      // node's http server (fires when the client half-closes the TCP
      // connection). Previously we ALSO listened for `close` with a
      // `writableEnded` guard, but on Railway the edge proxy closes the
      // backend connection at its own request-timeout well before we've
      // sent response headers, which triggered `close` as a false-positive
      // and aborted every real snapshot mid-flight.
      //
      // Losing `close` means: if a client bails after `aborted` never fires
      // (rare — most disconnects DO emit aborted), the snapshot runs to
      // completion instead of stopping early. That completed snapshot
      // populates the cache, so a retry from any client hits the cache
      // instantly. Net effect: a bit of wasted compute on client bail,
      // but no false-positive aborts on real requests. Trade is worth it.
      //
      // Wall-clock timeout (WL_OPERATION_TIMEOUT_MS) still bounds runaway
      // snapshots.
      (function reqSignal(): AbortSignal {
        const ac = new AbortController();
        const onAborted = () => ac.abort(new Error('client disconnected'));
        request.raw.once('aborted', onAborted);
        return ac.signal;
      })(),
      WL_OPERATION_TIMEOUT_MS,
    );

    try {
      const snap = await wlSemaphore.run(async () => {
        return snapshotHolders({
          chainId,
          tokenAddress,
          minBalance: minBal,
          // Default is strict mode — caller must explicitly opt into partial
          // data via `allowPartial: true` in the request body. This prevents
          // consumers from silently receiving an incomplete holder set.
          allowPartial: parsed.data.allowPartial === true,
          // FINDING 3: propagate the combined abort signal — Blockscout
          // pagination, RPC block reads, and the IPFS pin all abort when
          // the client disconnects or the wall-clock timer fires.
          signal: abort.signal,
        });
      });
      return reply.send({
        root: snap.root,
        // Preserved for backwards compatibility — same value as `snapshotStartBlock`.
        snapshotBlock: snap.snapshotBlock.toString(),
        // NEW: expose the bookend block reads so callers can verify freshness
        // for themselves (see WlSnapshotBlockDrift).
        snapshotStartBlock: snap.snapshotStartBlock.toString(),
        snapshotEndBlock: snap.snapshotEndBlock.toString(),
        holderCount: snap.holderCount,
        listId: snap.listId,
        listCid: snap.listCid,
        listGatewayUrl: snap.listGatewayUrl,
        // NEW: `partial: true` only when the caller passed `allowPartial: true`
        // AND the snapshot was actually incomplete. Downstream code should
        // gate on-chain WL launches on `partial === false`.
        partial: snap.partial,
        pagesFetched: snap.pagesFetched,
        fromRpcFallback: snap.fromRpcFallback,
        // Bounded — return up to 500 holders inline so tiny lists don't require a
        // separate fetch. Big lists still get a full response via the listId path.
        holdersPreview: snap.holders.slice(0, 500),
      });
    } catch (err) {
      // Distinct 422 codes for the two "you asked for a snapshot but the data
      // isn't trustworthy" cases so operators (and the frontend) can react
      // differently from a generic 5xx. Each error carries the actual page
      // count / drift so debugging doesn't need log-trawling.
      if (err instanceof WlSnapshotTruncated) {
        return reply.code(422).send({
          code: 'SNAPSHOT_TRUNCATED',
          message: err.message,
          source: err.source,
          pagesFetched: err.pagesFetched,
          maxPages: err.maxPages,
          fromBlock: err.fromBlock?.toString(),
          toBlock: err.toBlock?.toString(),
        });
      }
      if (err instanceof WlSnapshotBlockDrift) {
        return reply.code(422).send({
          code: 'SNAPSHOT_BLOCK_DRIFT',
          message: err.message,
          startBlock: err.startBlock.toString(),
          endBlock: err.endBlock.toString(),
          drift: err.drift.toString(),
          maxDrift: err.maxDrift.toString(),
        });
      }
      // FINDING 3 (HIGH): 413 Payload Too Large for "the source token has
      // more holders than we're willing to Merkle-build". Callers get the
      // observed count + configured cap so a launch operator can decide
      // whether to raise WL_MAX_HOLDER_COUNT or narrow the source.
      if (err instanceof WlHolderCountExceedsCap) {
        return reply.code(413).send({
          code: 'HOLDER_COUNT_EXCEEDS_CAP',
          message: err.message,
          holderCount: err.holderCount,
          maxHolderCount: err.maxHolderCount,
          source: err.source,
        });
      }
      // FINDING 3 (HIGH): back-pressure — same taxonomy as /compile.
      const code = (err as { code?: string }).code;
      if (code === 'COMPILE_BUSY' || code === 'COMPILE_QUEUE_TIMEOUT') {
        return reply
          .header('retry-after', '30')
          .code(503)
          .send({
            code: 'WL_BUSY',
            message: 'wl snapshot service busy, retry',
            queueDepth: wlSemaphore.waiting,
            inFlight: wlSemaphore.inFlight,
          });
      }
      // FINDING 3 (HIGH): wall-clock timeout on the operation itself.
      // Distinct 504 so the client can tell "gateway timed out" apart from
      // "snapshot logically failed". `abort.timedOut()` is the truth
      // source — the abort controller may have fired for OTHER reasons
      // (client disconnect) and we want to be precise.
      if (abort.timedOut()) {
        return reply.code(504).send({
          code: 'WL_OPERATION_TIMEOUT',
          message: `wl snapshot exceeded ${WL_OPERATION_TIMEOUT_MS}ms`,
        });
      }
      // AbortError from a client disconnect. Reply is likely unreachable
      // but Fastify still requires a value; return 499 (nginx convention
      // for "client closed request") to keep the log clean.
      if ((err as { name?: string }).name === 'AbortError' || code === 'ABORT_ERR') {
        return reply.code(499).send({ code: 'CLIENT_DISCONNECTED' });
      }
      const msg = err instanceof Error ? err.message : String(err);
      app.log.warn({ err: msg }, 'wl snapshot failed');
      return reply.code(400).send({ code: 'SNAPSHOT_FAILED', message: msg });
    } finally {
      // Always drop the timer + request-abort listener so a completed
      // request doesn't leak either.
      abort.done();
    }
  });

  app.get(
    '/wl/proof',
    {
      config: {
        // FINDING 3 (HIGH): per-IP proof rate cap. Cheaper than snapshot
        // but still worth bounding — proofs by CID hit IPFS.
        rateLimit: {
          max: defaultWlProofRateMax(),
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
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

    // FINDING 3 (HIGH): request-scoped abort so a client disconnect kills
    // the IPFS fetch. Composed with the WL_OPERATION_TIMEOUT_MS wall clock
    // so a stuck gateway can't pin the semaphore slot forever.
    const abort = _snapshotAbortController(
      (function reqSignal(): AbortSignal {
        const ac = new AbortController();
        const onAborted = () => ac.abort(new Error('client disconnected'));
        request.raw.once('aborted', onAborted);
        request.raw.once('close', () => {
          if (!reply.raw.writableEnded) onAborted();
        });
        return ac.signal;
      })(),
      WL_OPERATION_TIMEOUT_MS,
    );

    try {
      // Try in-memory cache first (cheap, no admission needed). Only when
      // we have to fall through to an IPFS fetch do we take a semaphore
      // slot — an evicted-cache scenario paired with a hostile gateway
      // is the only path that hits the network here.
      let proof = q.listId ? proofFor(q.listId, q.addr) : null;
      if (proof === null && q.listCid) {
        const snap = await wlSemaphore.run(async () => {
          return snapshotFromIpfs(q.listCid!, { signal: abort.signal });
        });
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
    } catch (err) {
      // FINDING 3 (HIGH): IPFS response exceeded the byte cap. 413 with the
      // observed byte counts so operators see the abuse shape.
      if (err instanceof WlIpfsResponseTooLarge) {
        return reply.code(413).send({
          code: 'IPFS_RESPONSE_TOO_LARGE',
          message: err.message,
          bytesRead: err.bytesRead,
          maxBytes: err.maxBytes,
        });
      }
      const code = (err as { code?: string }).code;
      if (code === 'COMPILE_BUSY' || code === 'COMPILE_QUEUE_TIMEOUT') {
        return reply
          .header('retry-after', '30')
          .code(503)
          .send({
            code: 'WL_BUSY',
            message: 'wl proof service busy, retry',
          });
      }
      if (abort.timedOut()) {
        return reply.code(504).send({
          code: 'WL_OPERATION_TIMEOUT',
          message: `wl proof exceeded ${WL_OPERATION_TIMEOUT_MS}ms`,
        });
      }
      if ((err as { name?: string }).name === 'AbortError' || code === 'ABORT_ERR') {
        return reply.code(499).send({ code: 'CLIENT_DISCONNECTED' });
      }
      const msg = err instanceof Error ? err.message : String(err);
      app.log.warn({ err: msg }, 'wl proof failed');
      return reply.code(400).send({ code: 'PROOF_FAILED', message: msg });
    } finally {
      abort.done();
    }
  });
}
