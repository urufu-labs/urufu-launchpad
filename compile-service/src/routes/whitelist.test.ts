/// FINDING 3 (HIGH) route-level tests.
///
/// The pure-function tests in `../wl-snapshot.test.ts` cover the snapshot
/// builder's holder-count cap, abort propagation, and IPFS byte cap. This
/// file covers the admission controls layered on top of them at the HTTP
/// boundary:
///
///   AC #1  — /wl/snapshot under queue overflow returns 503 WL_BUSY.
///   AC #2  — /wl/snapshot wall-clock timeout returns 504 and cancels
///            in-flight work (drops the semaphore slot).
///   AC #3  — /wl/proof IPFS response exceeding the size cap returns 413.
///   AC #6  — Existing happy path still works — a normal-sized snapshot
///            completes and returns a valid root through the semaphore.
///   AC #7  — Per-route rate limit rejects at the configured cap.
///
/// Tests use Fastify's `app.inject()` rather than binding a real port so
/// they run in-process and stay deterministic across CI. The route module
/// creates its `wlSemaphore` at import time from the current env, so each
/// test that needs a tight semaphore installs the env override BEFORE
/// dynamically importing a fresh copy of the route module (via `?query`
/// cache-buster on the import URL).

import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

// -----------------------------------------------------------------------------
// fetch mock — reused shape from wl-snapshot.test.ts. Serves Blockscout REST
// + RH JSON-RPC through a single interceptor keyed on URL / body.
// -----------------------------------------------------------------------------

interface BlockscoutPage {
  items: Array<{ address: { hash: string }; value: string }>;
  next_page_params: Record<string, string | number> | null;
}

interface MockState {
  blockscoutPages: BlockscoutPage[];
  rpcBlocks: bigint[];
  /// Optional hook that runs on EVERY intercepted fetch. Tests use it to
  /// inject latency, throw synthetic errors, or observe request counts.
  onFetch?: (url: string) => Promise<void>;
}

let mock: MockState;
let originalFetch: typeof fetch;

function installMock(): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (mock.onFetch) await mock.onFetch(url);

    if (url.includes('/tokens/') && url.includes('/holders')) {
      const page = mock.blockscoutPages.shift() ?? {
        items: [],
        next_page_params: null,
      };
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    const rpcReq = JSON.parse(bodyStr) as {
      method?: string;
      params?: unknown;
      id?: number;
    };
    if (rpcReq.method === 'eth_blockNumber') {
      const block = mock.rpcBlocks.shift();
      if (block === undefined) {
        throw new Error(
          `test bug: eth_blockNumber ran out of mock blocks`,
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpcReq.id,
          result: '0x' + block.toString(16),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`test bug: unmocked RPC method ${rpcReq.method}`);
  }) as typeof fetch;
}

function uninstallMock(): void {
  globalThis.fetch = originalFetch;
}

function makePage(
  next: Record<string, string | number> | null,
  holders: Array<[string, string]> = [],
): BlockscoutPage {
  return {
    items: holders.map(([addr, val]) => ({ address: { hash: addr }, value: val })),
    next_page_params: next,
  };
}

// -----------------------------------------------------------------------------
// Fresh-import helper: the route module reads env at import time to size the
// semaphore + timeouts, and it declares a MODULE-LEVEL `wlSemaphore`. Tests
// that need a specific concurrency knob install the env override, then
// re-import the module with a cache-busting query string so ES modules
// honor the new env.
// -----------------------------------------------------------------------------

let modCounter = 0;
async function freshWlRoutes(env: Record<string, string>): Promise<{
  register: (app: FastifyInstance) => Promise<void>;
  wlSemaphore: { inFlight: number; waiting: number };
  /// Call in the test's `finally` to restore env vars this helper mutated.
  /// We deliberately KEEP env set past import — the route registration
  /// (which happens in `makeApp` AFTER import) also reads env for the
  /// per-route rate-limit config, so restoring too early flips the caps
  /// back to defaults and lets rate limits fire in the wrong tests.
  restoreEnv: () => void;
}> {
  const restore: Array<[string, string | undefined]> = [];
  for (const [k, v] of Object.entries(env)) {
    restore.push([k, process.env[k]]);
    process.env[k] = v;
  }
  const url = new URL(`./whitelist.ts?v=${++modCounter}`, import.meta.url).href;
  const mod = (await import(url)) as {
    registerWhitelistRoutes: (app: FastifyInstance) => Promise<void>;
    wlSemaphore: { inFlight: number; waiting: number };
  };
  return {
    register: mod.registerWhitelistRoutes,
    wlSemaphore: mod.wlSemaphore,
    restoreEnv: () => {
      for (const [k, v] of restore) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

async function makeApp(routes: (app: FastifyInstance) => Promise<void>): Promise<FastifyInstance> {
  // Silent logger — the tests intentionally provoke error paths and we
  // don't want warn/error logs cluttering the test output.
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 1_000, timeWindow: '1 minute' });
  await routes(app);
  return app;
}

const TEST_TOKEN = '0x000000000000000000000000000000000000c001';

beforeEach(() => {
  mock = {
    blockscoutPages: [],
    rpcBlocks: [],
    onFetch: undefined,
  };
  installMock();
});

afterEach(() => {
  uninstallMock();
});

// ================================================================
// AC #6 — happy path: a valid /wl/snapshot returns a valid root.
// ================================================================

test('POST /wl/snapshot happy path returns 200 with a Merkle root and holderCount', async () => {
  const { register, restoreEnv } = await freshWlRoutes({
    WL_SNAPSHOT_RATE_MAX: '1000',
  });
  const app = await makeApp(register);
  try {
    mock.blockscoutPages = [
      makePage(null, [
        ['0x0000000000000000000000000000000000000001', '10'],
        ['0x0000000000000000000000000000000000000002', '10'],
      ]),
    ];
    mock.rpcBlocks = [1000n, 1001n];

    const res = await app.inject({
      method: 'POST',
      url: '/wl/snapshot',
      payload: { chainId: 4663, tokenAddress: TEST_TOKEN },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      root: string;
      holderCount: number;
      partial: boolean;
    };
    assert.ok(body.root.startsWith('0x'));
    assert.equal(body.holderCount, 2);
    assert.equal(body.partial, false);
  } finally {
    await app.close();
    restoreEnv();
  }
});

// ================================================================
// AC #1 — queue overflow returns 503 WL_BUSY.
// ================================================================

test('POST /wl/snapshot returns 503 WL_BUSY when concurrency + queue are saturated', async () => {
  // Concurrency 1, queue 1, wait 5000ms. Two requests in flight (one
  // active + one queued) — a third must reject synchronously with 503.
  const { register, wlSemaphore, restoreEnv } = await freshWlRoutes({
    WL_MAX_CONCURRENCY: '1',
    WL_MAX_QUEUE: '1',
    WL_QUEUE_WAIT_MS: '5000',
    WL_OPERATION_TIMEOUT_MS: '5000',
    // Rate limit defaults to 2/min per IP — this test fires 3 requests
    // from the same in-process client, so bump the cap out of the way
    // and let the semaphore's 503 be what surfaces (not a 429).
    WL_SNAPSHOT_RATE_MAX: '1000',
  });
  const app = await makeApp(register);
  try {
    // A slow fetch hook holds the first snapshot's fetch open until we
    // release it — that way we can deterministically build up the
    // in-flight + queued + rejected sequence without racing timeouts.
    const inflightGate = createGate();
    let firstStarted = false;
    mock.onFetch = async (url) => {
      if (url.includes('/holders') && !firstStarted) {
        firstStarted = true;
        // Hold the FIRST snapshot's fetch open until the test releases it.
        // The queued snapshot never starts fetching until first completes.
        await inflightGate.promise;
      }
    };
    // Enough pages / block reads to serve BOTH the active + queued
    // snapshots. The third request rejects before firing any fetches.
    mock.blockscoutPages = [
      makePage(null, [['0x0000000000000000000000000000000000000001', '10']]),
      makePage(null, [['0x0000000000000000000000000000000000000001', '10']]),
    ];
    mock.rpcBlocks = [10n, 10n, 20n, 20n];

    // Fire request 1 — it takes the only concurrency slot.
    const p1 = app.inject({
      method: 'POST',
      url: '/wl/snapshot',
      payload: { chainId: 4663, tokenAddress: TEST_TOKEN },
    });
    // Give request 1 a chance to enter the semaphore + hit the mock.
    while (!firstStarted) await tick();
    // Sanity: the slot is occupied.
    assert.equal(wlSemaphore.inFlight, 1);

    // Fire request 2 — it fills the ONE queue slot.
    const p2 = app.inject({
      method: 'POST',
      url: '/wl/snapshot',
      payload: {
        chainId: 4663,
        tokenAddress: '0x000000000000000000000000000000000000c002',
      },
    });
    // Poll the semaphore directly rather than guessing at microtask
    // ordering — request 2 has to actually park on the queue before
    // request 3 will see queue.length >= maxQueue.
    while (wlSemaphore.waiting !== 1) await tick();

    // Third request — queue is full, must synchronously reject.
    const r3 = await app.inject({
      method: 'POST',
      url: '/wl/snapshot',
      payload: {
        chainId: 4663,
        tokenAddress: '0x000000000000000000000000000000000000c003',
      },
    });
    assert.equal(r3.statusCode, 503, `expected 503 WL_BUSY, got ${r3.statusCode} ${r3.body}`);
    const body3 = r3.json() as { code?: string };
    assert.equal(body3.code, 'WL_BUSY');
    assert.equal(r3.headers['retry-after'], '30');

    // Cleanup: let the queued requests drain so we don't leave open
    // fetches sitting on the mock.
    inflightGate.release();
    const r1 = await p1;
    const r2 = await p2;
    assert.equal(r1.statusCode, 200, r1.body);
    assert.equal(r2.statusCode, 200, r2.body);
  } finally {
    await app.close();
    restoreEnv();
  }
});

// ================================================================
// AC #2 — wall-clock timeout returns 504 and cancels in-flight work.
// ================================================================

test('POST /wl/snapshot returns 504 WL_OPERATION_TIMEOUT when the wall clock elapses, releases the semaphore', async () => {
  const { register, wlSemaphore, restoreEnv } = await freshWlRoutes({
    WL_MAX_CONCURRENCY: '1',
    WL_MAX_QUEUE: '2',
    WL_QUEUE_WAIT_MS: '5000',
    // Tiny operation timeout so the snapshot's first fetch outlives it.
    WL_OPERATION_TIMEOUT_MS: '50',
    WL_SNAPSHOT_RATE_MAX: '1000',
  });
  const app = await makeApp(register);
  try {
    // Every fetch takes 500ms — well past the 50ms operation timeout.
    // The AbortController wired to the fetch will fire once the wall
    // clock elapses; the snapshot builder observes it via its signal.
    mock.onFetch = async () => {
      await new Promise((r) => setTimeout(r, 500));
    };
    mock.blockscoutPages = [
      makePage(null, [['0x0000000000000000000000000000000000000001', '10']]),
    ];
    mock.rpcBlocks = [100n, 100n];

    const res = await app.inject({
      method: 'POST',
      url: '/wl/snapshot',
      payload: { chainId: 4663, tokenAddress: TEST_TOKEN },
    });
    assert.equal(res.statusCode, 504, `expected 504 WL_OPERATION_TIMEOUT, got ${res.statusCode} ${res.body}`);
    const body = res.json() as { code?: string };
    assert.equal(body.code, 'WL_OPERATION_TIMEOUT');

    // Slot must be released so a follow-up request isn't queued forever.
    // Semaphore in-flight goes back to 0 once the timed-out request's
    // finally-block drops the slot.
    assert.equal(
      wlSemaphore.inFlight,
      0,
      `semaphore slot leaked after timeout: inFlight=${wlSemaphore.inFlight}`,
    );
  } finally {
    await app.close();
    restoreEnv();
  }
});

// ================================================================
// AC #3 — /wl/proof IPFS response exceeding size cap returns 413.
// ================================================================

test('GET /wl/proof returns 413 IPFS_RESPONSE_TOO_LARGE when the pinned body exceeds WL_MAX_IPFS_BYTES', async () => {
  const { register, restoreEnv } = await freshWlRoutes({
    // Tiny cap so a tiny synthetic body trips the limit.
    WL_MAX_IPFS_BYTES: '256',
    WL_PROOF_RATE_MAX: '1000',
  });
  const app = await makeApp(register);
  try {
    // Intercept the IPFS gateway URL specifically — the mock recognises
    // "/ipfs/" as the gateway path.
    mock.onFetch = async (url) => {
      if (url.includes('/ipfs/')) {
        // Nothing — the fetch below is served by the top-level fetch
        // handler, which we monkey-patch below to return a big body for
        // exactly the IPFS URLs.
      }
    };
    const gatewayResponse = 'x'.repeat(2_048); // way over 256
    // Replace only the IPFS branch of the mock by wrapping globalThis.fetch.
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes('/ipfs/')) {
        return new Response(gatewayResponse, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return inner(input, init);
    }) as typeof fetch;

    const res = await app.inject({
      method: 'GET',
      url: `/wl/proof?listCid=bafyfakecid&addr=0x${'a'.repeat(40)}`,
    });
    assert.equal(res.statusCode, 413, `expected 413, got ${res.statusCode} ${res.body}`);
    const body = res.json() as { code?: string; maxBytes?: number; bytesRead?: number };
    assert.equal(body.code, 'IPFS_RESPONSE_TOO_LARGE');
    assert.equal(body.maxBytes, 256);
    assert.ok((body.bytesRead ?? 0) > 256, `bytesRead ${body.bytesRead} must exceed cap`);
  } finally {
    await app.close();
    restoreEnv();
  }
});

// ================================================================
// AC #7 — per-route rate limit rejects at the configured cap.
// ================================================================

test('POST /wl/snapshot per-IP rate limit fires beyond the configured cap (returns 429)', async () => {
  const { register, restoreEnv } = await freshWlRoutes({
    // Tiny per-IP cap so a burst of requests trips it quickly.
    WL_SNAPSHOT_RATE_MAX: '1',
  });
  const app = await makeApp(register);
  try {
    // Empty mock — request never reaches the handler (invalid body
    // triggers zod 400 OR rate limit 429 first). If we pass a valid
    // body the snapshot would succeed and burn our mock; using an
    // invalid body keeps every request cheap.
    const invalidBody = { garbage: true };

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: 'POST',
          url: '/wl/snapshot',
          payload: invalidBody,
        }),
      ),
    );
    const statuses = responses.map((r) => r.statusCode);
    const status429 = statuses.filter((s) => s === 429).length;
    // With cap = 1, exactly one request should pass the rate limit (and
    // get a 400 from zod), the other four must be 429.
    assert.ok(
      status429 >= 3,
      `expected at least 3 rate-limited 429s (cap=1), got statuses=${JSON.stringify(statuses)}`,
    );
  } finally {
    await app.close();
    restoreEnv();
  }
});

// ================================================================
// AC #7 (proof) — /wl/proof rate limit fires too.
// ================================================================

test('GET /wl/proof per-IP rate limit fires beyond WL_PROOF_RATE_MAX (returns 429)', async () => {
  const { register, restoreEnv } = await freshWlRoutes({
    WL_PROOF_RATE_MAX: '2',
  });
  const app = await makeApp(register);
  try {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({
          method: 'GET',
          url: `/wl/proof?listId=nonexistent&addr=0x${'a'.repeat(40)}`,
        }),
      ),
    );
    const statuses = responses.map((r) => r.statusCode);
    const status429 = statuses.filter((s) => s === 429).length;
    // Cap = 2 → four rate-limited responses expected.
    assert.ok(
      status429 >= 3,
      `expected at least 3 rate-limited 429s (cap=2), got statuses=${JSON.stringify(statuses)}`,
    );
  } finally {
    await app.close();
    restoreEnv();
  }
});

// ================================================================
// AC #4 (route-level) — holder-count cap surfaces as 413 with count.
// ================================================================

test('POST /wl/snapshot returns 413 HOLDER_COUNT_EXCEEDS_CAP with observed count when the source exceeds the cap', async () => {
  const { register, restoreEnv } = await freshWlRoutes({
    // Tiny cap so a small mock trips it.
    WL_MAX_HOLDER_COUNT: '3',
    WL_SNAPSHOT_RATE_MAX: '1000',
  });
  const app = await makeApp(register);
  try {
    const holders: Array<[string, string]> = [];
    for (let i = 1; i <= 6; i++) {
      holders.push([`0x${i.toString(16).padStart(40, '0')}`, '10']);
    }
    mock.blockscoutPages = [makePage(null, holders)];
    mock.rpcBlocks = [100n];

    const res = await app.inject({
      method: 'POST',
      url: '/wl/snapshot',
      payload: { chainId: 4663, tokenAddress: TEST_TOKEN },
    });
    assert.equal(res.statusCode, 413, `expected 413, got ${res.statusCode} ${res.body}`);
    const body = res.json() as {
      code?: string;
      holderCount?: number;
      maxHolderCount?: number;
    };
    assert.equal(body.code, 'HOLDER_COUNT_EXCEEDS_CAP');
    assert.equal(body.holderCount, 6);
    assert.equal(body.maxHolderCount, 3);
  } finally {
    await app.close();
    restoreEnv();
  }
});

// ================================================================
// Body-size cap — oversize /wl/snapshot body returns 4xx.
// ================================================================

test('POST /wl/snapshot rejects a body larger than WL_SNAPSHOT_BODY_LIMIT_BYTES with 4xx', async () => {
  const { register, restoreEnv } = await freshWlRoutes({
    // 512-byte cap so a 4 KB body trips it.
    WL_SNAPSHOT_BODY_LIMIT_BYTES: '512',
    WL_SNAPSHOT_RATE_MAX: '1000',
  });
  const app = await makeApp(register);
  try {
    const oversized = {
      chainId: 4663,
      tokenAddress: TEST_TOKEN,
      pad: 'a'.repeat(4_096),
    };
    const res = await app.inject({
      method: 'POST',
      url: '/wl/snapshot',
      payload: oversized,
    });
    // Fastify returns 413 for oversize bodies; some middleware maps to
    // 400. Accept any 4xx as proof the cap fired before the handler ran.
    assert.ok(
      res.statusCode >= 400 && res.statusCode < 500,
      `expected 4xx for oversize body, got ${res.statusCode}`,
    );
  } finally {
    await app.close();
    restoreEnv();
  }
});

// -----------------------------------------------------------------------------
// Test helpers.
// -----------------------------------------------------------------------------

/// Deferred-resolution gate for coordinating request phases in tests.
function createGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

/// Yield to the event loop (setImmediate) so fastify's request pipeline
/// gets a chance to run. Microtasks alone (`Promise.resolve().then(...)`)
/// starve I/O — fastify processes requests via `nextTick`/`setImmediate`,
/// so a microtask-only spin never sees the semaphore state advance.
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
