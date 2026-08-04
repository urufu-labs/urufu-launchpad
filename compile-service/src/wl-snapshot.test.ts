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
  WlSnapshotTruncated,
  WlSnapshotBlockDrift,
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
