/// Coverage for the audit finding "Silent partial whitelist snapshots".
///
/// The launchpad snapshot service (`snapshotHolders`) used to silently return
/// whatever holder set it happened to fetch, even when Blockscout paginated
/// past the module cap or the RPC fallback couldn't scan back to genesis. Two
/// distinct failure modes rode along with the "happy" success shape:
///
///   1. TRUNCATION — Blockscout indexes 12k holders, we fetch the first 10k,
///      and the returned Merkle root reflects only the 10k slice. A launch
///      curve initialized from that root would silently exclude the other 2k
///      holders from the WL, permanently.
///
///   2. TIP DRIFT — the reported `snapshotBlock` is read once at the start,
///      but Blockscout's per-page reads happen later and may already reflect
///      a newer tip. Downstream consumers can't verify freshness because the
///      reported block is decoupled from what Blockscout actually served.
///
/// This test file locks in the fix:
///   - Truncation now REJECTS with `WlSnapshotTruncated` by default; callers
///     must explicitly opt into partial data via `{ allowPartial: true }`.
///   - The result now carries both `snapshotStartBlock` and `snapshotEndBlock`,
///     and rejects with `WlSnapshotBlockDrift` when the tip moved too far
///     between the two reads.
///
/// Tests drive the code end-to-end by mocking global `fetch` — viem's HTTP
/// transport and Blockscout both use `globalThis.fetch` under the hood, so a
/// single interceptor can serve JSON-RPC + REST responses side by side. This
/// mirrors the `rewards.test.ts` pattern of fake-dep injection: no docker,
/// no real RPC / explorer, just deterministic responses.

import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import type { Address } from 'viem';

import {
  snapshotHolders,
  snapshotFromIpfs,
  WlSnapshotTruncated,
  WlSnapshotBlockDrift,
  WlHolderCountExceedsCap,
  WlIpfsResponseTooLarge,
} from './wl-snapshot.ts';

// -----------------------------------------------------------
// fetch mock
// -----------------------------------------------------------

interface BlockscoutPage {
  items: Array<{ address: { hash: string }; value: string }>;
  next_page_params: Record<string, string | number> | null;
}

interface MockState {
  blockscoutPages: BlockscoutPage[];
  rpcBlocks: bigint[];
  blockscoutCalls: number;
  rpcCalls: Array<{ method: string; params: unknown }>;
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

    // Blockscout GET `/api/v2/tokens/{addr}/holders[?…]`
    if (url.includes('/tokens/') && url.includes('/holders')) {
      mock.blockscoutCalls += 1;
      const page = mock.blockscoutPages.shift() ?? {
        items: [],
        next_page_params: null,
      };
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Assume everything else is a JSON-RPC POST to the RH RPC.
    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    const rpcReq = JSON.parse(bodyStr) as {
      method?: string;
      params?: unknown;
      id?: number;
    };
    mock.rpcCalls.push({ method: rpcReq.method ?? '', params: rpcReq.params });
    if (rpcReq.method === 'eth_blockNumber') {
      const block = mock.rpcBlocks.shift();
      if (block === undefined) {
        throw new Error(
          `test bug: eth_blockNumber called ${mock.rpcCalls.filter((c) => c.method === 'eth_blockNumber').length} times but mock ran out of rpcBlocks`,
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

// Distinct token per test avoids the module-level snapshot cache leaking
// results across tests (cache key includes tokenAddress).
function testToken(marker: string): Address {
  // Pad marker into a 20-byte address so each test gets a unique cache slot.
  const padded = marker.padStart(40, '0');
  return `0x${padded}` as Address;
}

beforeEach(() => {
  mock = {
    blockscoutPages: [],
    rpcBlocks: [],
    blockscoutCalls: 0,
    rpcCalls: [],
  };
  installMock();
});

afterEach(() => {
  uninstallMock();
});

// ================================================================
// Audit page 10 AC #1: strict mode rejects silent truncation
// ================================================================

test('snapshotHolders rejects with WlSnapshotTruncated when blockscout has more pages than the cap and allowPartial is unset', async () => {
  const token = testToken('dead01');
  // 3 pages fetched, all still advertising `next_page_params`, and we set
  // `maxBlockscoutPages: 3` so we exit the loop at the cap with more holders
  // still available upstream. This is the exact silent-truncation shape the
  // audit flagged.
  mock.blockscoutPages = [
    makePage({ page: 2 }, [['0x0000000000000000000000000000000000000001', '10']]),
    makePage({ page: 3 }, [['0x0000000000000000000000000000000000000002', '10']]),
    makePage({ page: 4 }, [['0x0000000000000000000000000000000000000003', '10']]),
  ];
  // Only the startBlock read happens before the truncation check throws; the
  // endBlock read is skipped. If the mock ever runs out of rpcBlocks the
  // fallthrough in installMock() throws with a clear message so a wiring
  // regression fails loudly rather than silently.
  mock.rpcBlocks = [1000n];

  await assert.rejects(
    () =>
      snapshotHolders({
        chainId: 4663,
        tokenAddress: token,
        maxBlockscoutPages: 3,
      }),
    (err: unknown) => {
      assert.ok(err instanceof WlSnapshotTruncated, `expected WlSnapshotTruncated, got ${err}`);
      assert.equal(err.source, 'blockscout');
      assert.equal(err.pagesFetched, 3);
      assert.equal(err.maxPages, 3);
      // The error message must carry enough context for on-call debugging
      // (spec: "Every reject case must include the actual page count").
      assert.match(err.message, /3-page cap/);
      assert.match(err.message, /allowPartial/);
      return true;
    },
  );
  // Blockscout was polled exactly `maxBlockscoutPages` times.
  assert.equal(mock.blockscoutCalls, 3);
});

// ================================================================
// Audit page 10 AC #2: allowPartial:true returns partial:true instead
// ================================================================

test('snapshotHolders returns partial true when allowPartial is set and blockscout truncated', async () => {
  const token = testToken('beef02');
  mock.blockscoutPages = [
    makePage({ page: 2 }, [['0x0000000000000000000000000000000000000001', '10']]),
    makePage({ page: 3 }, [['0x0000000000000000000000000000000000000002', '10']]),
    makePage({ page: 4 }, [['0x0000000000000000000000000000000000000003', '10']]),
  ];
  // Both bookend reads happen this time because the throw is skipped.
  mock.rpcBlocks = [2000n, 2000n];

  const snap = await snapshotHolders({
    chainId: 4663,
    tokenAddress: token,
    maxBlockscoutPages: 3,
    allowPartial: true,
  });

  assert.equal(snap.partial, true);
  assert.equal(snap.pagesFetched, 3);
  assert.equal(snap.holderCount, 3);
  assert.equal(snap.snapshotBlock, 2000n);
  assert.equal(snap.snapshotStartBlock, 2000n);
  assert.equal(snap.snapshotEndBlock, 2000n);
  assert.equal(snap.fromRpcFallback, false);
});

// ================================================================
// Audit page 10 AC #3: complete blockscout set returns partial:false
// ================================================================

test('snapshotHolders returns partial false when blockscout paginates to completion within the cap', async () => {
  const token = testToken('cafe03');
  // Two pages, second has no next_page_params — the natural "done" signal.
  // hadMorePages should be false, so `partial` MUST be false regardless of
  // whether allowPartial was set (which it isn't here).
  mock.blockscoutPages = [
    makePage({ page: 2 }, [['0x0000000000000000000000000000000000000001', '10']]),
    makePage(null, [['0x0000000000000000000000000000000000000002', '10']]),
  ];
  mock.rpcBlocks = [3000n, 3001n]; // one-block drift, well inside the default

  const snap = await snapshotHolders({
    chainId: 4663,
    tokenAddress: token,
    maxBlockscoutPages: 10,
  });

  assert.equal(snap.partial, false);
  assert.equal(snap.pagesFetched, 2);
  assert.equal(snap.holderCount, 2);
  assert.equal(snap.snapshotBlock, 3000n);
  assert.equal(snap.snapshotStartBlock, 3000n);
  assert.equal(snap.snapshotEndBlock, 3001n);
  assert.equal(snap.fromRpcFallback, false);
  assert.equal(mock.blockscoutCalls, 2);
});

// ================================================================
// Audit page 10 AC #4: chain-tip drift rejects with a distinct error
// ================================================================

test('snapshotHolders rejects with WlSnapshotBlockDrift when startBlock and endBlock differ by more than maxBlockDrift', async () => {
  const token = testToken('drift04');
  // Clean, complete holder set — no truncation signal in play. The rejection
  // must come purely from the block-drift check.
  mock.blockscoutPages = [
    makePage(null, [
      ['0x0000000000000000000000000000000000000001', '10'],
      ['0x0000000000000000000000000000000000000002', '10'],
    ]),
  ];
  // start=4000, end=4006, drift=6, maxBlockDrift=5 → reject.
  mock.rpcBlocks = [4000n, 4006n];

  await assert.rejects(
    () =>
      snapshotHolders({
        chainId: 4663,
        tokenAddress: token,
        maxBlockDrift: 5n,
      }),
    (err: unknown) => {
      assert.ok(err instanceof WlSnapshotBlockDrift, `expected WlSnapshotBlockDrift, got ${err}`);
      assert.equal(err.startBlock, 4000n);
      assert.equal(err.endBlock, 4006n);
      assert.equal(err.drift, 6n);
      assert.equal(err.maxDrift, 5n);
      // Message must include both block values + drift for operator triage.
      assert.match(err.message, /4000/);
      assert.match(err.message, /4006/);
      assert.match(err.message, /drift 6/);
      return true;
    },
  );
});

// ================================================================
// Bonus regression: same drift, within budget, must NOT reject
// ================================================================

test('snapshotHolders accepts a small drift within maxBlockDrift and returns both bookend block numbers', async () => {
  const token = testToken('drift05');
  mock.blockscoutPages = [
    makePage(null, [['0x0000000000000000000000000000000000000001', '10']]),
  ];
  // start=5000, end=5005, drift=5, maxBlockDrift=5 → exactly at the boundary,
  // must be accepted (check is strict `>`, not `>=`).
  mock.rpcBlocks = [5000n, 5005n];

  const snap = await snapshotHolders({
    chainId: 4663,
    tokenAddress: token,
    maxBlockDrift: 5n,
  });

  assert.equal(snap.snapshotStartBlock, 5000n);
  assert.equal(snap.snapshotEndBlock, 5005n);
  assert.equal(snap.partial, false);
});

// ================================================================
// FINDING 3 (HIGH) AC #4: holder count above the cap raises
// WlHolderCountExceedsCap with the observed count in the message.
// ================================================================

test('snapshotHolders rejects with WlHolderCountExceedsCap when the eligible set exceeds maxHolderCount, carrying the observed count', async () => {
  const token = testToken('cap06');
  // Six eligible holders in a single page; cap is 5. The error must fire
  // BEFORE the Merkle build (otherwise the point of the cap is defeated).
  const holders: Array<[string, string]> = [];
  for (let i = 1; i <= 6; i++) {
    holders.push([`0x${i.toString(16).padStart(40, '0')}`, '10']);
  }
  mock.blockscoutPages = [makePage(null, holders)];
  // Only the startBlock read fires before we throw the cap error.
  mock.rpcBlocks = [6000n];

  await assert.rejects(
    () =>
      snapshotHolders({
        chainId: 4663,
        tokenAddress: token,
        maxHolderCount: 5,
      }),
    (err: unknown) => {
      assert.ok(
        err instanceof WlHolderCountExceedsCap,
        `expected WlHolderCountExceedsCap, got ${err}`,
      );
      // Observed count must be in the message — audit requirement is
      // explicit ("with the observed count in the error message").
      assert.equal(err.holderCount, 6);
      assert.equal(err.maxHolderCount, 5);
      assert.equal(err.source, 'blockscout');
      assert.match(err.message, /holder count 6/);
      assert.match(err.message, /cap 5/);
      // Message must NOT truncate silently — audit requires an actionable hint.
      assert.match(err.message, /WL_MAX_HOLDER_COUNT/);
      return true;
    },
  );
});

test('fetchHoldersViaBlockscout aborts pagination mid-walk once the running count exceeds the cap, saving RPC/Blockscout budget', async () => {
  const token = testToken('cap07');
  // Two pages, three holders each. Cap is 4 — the walker should hard-stop
  // on the second page WITHOUT fetching a hypothetical third page. If we
  // stripped the early-abort, `blockscoutCalls` would go higher.
  mock.blockscoutPages = [
    makePage({ page: 2 }, [
      ['0x0000000000000000000000000000000000000001', '10'],
      ['0x0000000000000000000000000000000000000002', '10'],
      ['0x0000000000000000000000000000000000000003', '10'],
    ]),
    makePage({ page: 3 }, [
      ['0x0000000000000000000000000000000000000004', '10'],
      ['0x0000000000000000000000000000000000000005', '10'],
      ['0x0000000000000000000000000000000000000006', '10'],
    ]),
    // Deliberately unreachable — a passing test proves the walker stopped
    // before touching this page.
    makePage(null, [['0x0000000000000000000000000000000000000007', '10']]),
  ];
  mock.rpcBlocks = [7000n];

  await assert.rejects(
    () =>
      snapshotHolders({
        chainId: 4663,
        tokenAddress: token,
        maxHolderCount: 4,
      }),
    (err: unknown) => err instanceof WlHolderCountExceedsCap,
  );
  // Two pages walked, third never touched — saves us from paying for a
  // full holder-set fetch we're about to reject anyway.
  assert.equal(mock.blockscoutCalls, 2);
});

// ================================================================
// FINDING 3 (HIGH) AC #5: propagate AbortSignal into snapshot builder,
// client-abort mid-snapshot kills the fetch chain.
// ================================================================

test('snapshotHolders honors a pre-aborted signal without firing any downstream fetches', async () => {
  const token = testToken('abort08');
  // No pages / no blocks queued — if the code accidentally starts fetching,
  // the mock will throw its own "unmocked / ran out" error and the test
  // will fail loudly with a distinct message.
  const controller = new AbortController();
  controller.abort(new Error('client bailed'));

  await assert.rejects(
    () =>
      snapshotHolders({
        chainId: 4663,
        tokenAddress: token,
        signal: controller.signal,
      }),
    (err: unknown) => {
      // We don't care whether it's the caller's own reason or an AbortError
      // wrapper — the point is that we short-circuit before making a fetch.
      assert.ok(err instanceof Error);
      return true;
    },
  );
  assert.equal(mock.blockscoutCalls, 0, 'must not fetch blockscout after early-abort');
  assert.equal(
    mock.rpcCalls.length,
    0,
    'must not fire any RPC after early-abort',
  );
});

test('snapshotHolders abort mid-pagination stops fetching more pages', async () => {
  const token = testToken('abort09');
  mock.blockscoutPages = [
    makePage({ page: 2 }, [['0x0000000000000000000000000000000000000001', '10']]),
    // If the code kept walking, it would hit this page and blockscoutCalls
    // would become 2 — the test fails.
    makePage({ page: 3 }, [['0x0000000000000000000000000000000000000002', '10']]),
  ];
  mock.rpcBlocks = [9000n];

  const controller = new AbortController();
  // Signal the abort AFTER the first blockscout page returns but BEFORE
  // the loop reads the next one. Hook the mock to fire the abort right
  // when it dispatches its first blockscout response.
  const origFetch = globalThis.fetch;
  let firstBlockscoutSeen = false;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const res = await origFetch(input, init);
    if (url.includes('/holders') && !firstBlockscoutSeen) {
      firstBlockscoutSeen = true;
      // Defer to a microtask so the caller sees the successful response
      // before the abort fires between pages.
      queueMicrotask(() => controller.abort(new Error('client bailed mid-walk')));
    }
    return res;
  }) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        snapshotHolders({
          chainId: 4663,
          tokenAddress: token,
          signal: controller.signal,
        }),
    );
  } finally {
    globalThis.fetch = origFetch;
  }
  // Only the first blockscout page was fetched — the second must NOT be.
  assert.equal(
    mock.blockscoutCalls,
    1,
    `expected pagination to stop after abort; blockscoutCalls=${mock.blockscoutCalls}`,
  );
});

// ================================================================
// FINDING 3 (HIGH) AC #3: /wl/proof IPFS response exceeding the cap
// terminates the fetch and rejects with WlIpfsResponseTooLarge.
// ================================================================

test('snapshotFromIpfs throws WlIpfsResponseTooLarge when the gateway body exceeds maxBytes', async () => {
  const origFetch = globalThis.fetch;
  // Build a payload that BYTE-EXCEEDS our tiny cap. JSON size is a proxy
  // for real gateway abuse (a hostile gateway could send junk padding).
  const bigString = 'x'.repeat(2_000);
  const bodyText = JSON.stringify({
    root: '0x' + '0'.repeat(64),
    snapshotBlock: '1000',
    holders: [`0x${'a'.repeat(40)}`],
    junk: bigString,
  });
  globalThis.fetch = (async () => {
    return new Response(bodyText, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        // Cap is deliberately smaller than bodyText.length so the streamed
        // read trips the ceiling.
        snapshotFromIpfs('bafyfakecid', { maxBytes: 512 }),
      (err: unknown) => {
        assert.ok(
          err instanceof WlIpfsResponseTooLarge,
          `expected WlIpfsResponseTooLarge, got ${err}`,
        );
        assert.ok(err.bytesRead > 512, `bytesRead ${err.bytesRead} must be > cap 512`);
        assert.equal(err.maxBytes, 512);
        assert.match(err.message, /exceeded 512-byte cap/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('snapshotFromIpfs accepts a body inside the cap and returns a valid snapshot', async () => {
  const origFetch = globalThis.fetch;
  // Build a tiny, integrity-valid payload — the root must match the Merkle
  // root of the pinned holder list or snapshotFromIpfs returns null (see
  // the pin-integrity check in the source).
  //
  // Easiest path: use one holder and let the code do the Merkle math for
  // us in a scratch call. We embed the address, compute the root inline.
  const addr = '0x000000000000000000000000000000000000dead';
  // Import _leaf isn't exported, so recompute via a known-good tiny root
  // using the module's own helpers. Instead we invoke snapshotHolders
  // once with an inline mock to obtain a valid { root, holders } pair.
  const singleHolderRoot = (async () => {
    // Set up a fresh single-page mock ONLY for this bootstrap call.
    mock.blockscoutPages = [
      makePage(null, [[addr, '10']]),
    ];
    mock.rpcBlocks = [1n, 1n];
    const snap = await snapshotHolders({
      chainId: 4663,
      tokenAddress: testToken('ipfsok10'),
    });
    return { root: snap.root, holders: snap.holders };
  });
  const ready = await singleHolderRoot();

  const bodyText = JSON.stringify({
    root: ready.root,
    snapshotBlock: '1',
    holders: ready.holders,
  });
  globalThis.fetch = (async () => {
    return new Response(bodyText, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    // Cap comfortably above bodyText size — happy path must succeed.
    const snap = await snapshotFromIpfs('bafyfakecid2', {
      maxBytes: 10 * 1024,
    });
    assert.ok(snap, 'expected snapshotFromIpfs to return a valid snapshot');
    assert.equal(snap.holderCount, 1);
    assert.equal(snap.holders[0], addr);
    assert.equal(snap.root, ready.root);
  } finally {
    globalThis.fetch = origFetch;
  }
});
