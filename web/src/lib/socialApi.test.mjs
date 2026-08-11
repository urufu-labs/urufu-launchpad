// Tests for the compile-service HTTP client (web/src/lib/socialApi.ts).
//
// Focus: `searchProfiles` — it's the entry point the UserSearchModal uses
// and the one that has to be well-behaved under user typing (abort in-flight
// requests when a new query comes in) and backend back-pressure (surface
// rate-limit + network failures distinctly so the UI can react with the
// right toast copy).
//
// Runs with `node --test web/src/lib/socialApi.test.mjs` from the repo root,
// matching the existing xAuth.test.mjs pattern.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

// Same trick as xAuth.test.mjs: import the .ts source directly via
// --experimental-strip-types so assertions bind to the exact module that
// Next imports at runtime, not a compiled shim.
const socialApi = await import('./socialApi.ts');

// ------------------------------------------------------------
// fetch mock — records calls, returns whatever the current test staged.
// Restored between tests so a mock that misbehaves in one test doesn't
// poison the next.
// ------------------------------------------------------------

let originalFetch;
let calls;
let nextResponse;
let onFetch; // optional per-test hook (e.g. inject latency, throw errors)

before(() => {
  originalFetch = globalThis.fetch;
});
after(() => {
  globalThis.fetch = originalFetch;
});

function installFetch() {
  calls = [];
  nextResponse = null;
  onFetch = null;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (onFetch) await onFetch({ url: String(url), init });
    if (typeof nextResponse === 'function') {
      return nextResponse({ url: String(url), init });
    }
    return nextResponse ?? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

// ------------------------------------------------------------
// Search happy path + shape.
// ------------------------------------------------------------

describe('socialApi: searchProfiles', () => {
  test('returns { ok: true, results } on 200', async () => {
    installFetch();
    nextResponse = new Response(
      JSON.stringify({
        results: [
          {
            address: '0xaa',
            username: 'vitalik',
            avatarUrl: null,
            xVerifiedHandle: 'vitalik',
            xAvatarUrl: 'https://pbs.twimg.com/x.jpg',
            twitter: null,
            updatedAt: '2026-08-01T00:00:00Z',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const out = await socialApi.searchProfiles('vitalik');
    assert.equal(out.ok, true);
    if (!out.ok) return; // narrow for TS
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].xVerifiedHandle, 'vitalik');
    // The URL must include q= AND go against the configured base URL.
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/profile\/search\?q=vitalik/);
  });

  test('encodes query params correctly (spaces, ampersands, unicode)', async () => {
    installFetch();
    nextResponse = new Response('{"results":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    await socialApi.searchProfiles('hello & world 好');
    // URLSearchParams url-encodes: spaces become `+`, & becomes %26, unicode
    // becomes the utf-8 percent-escaped bytes.
    const url = calls[0].url;
    assert.match(url, /q=hello\+%26\+world\+%E5%A5%BD/);
  });

  test('passes limit param through when provided', async () => {
    installFetch();
    nextResponse = new Response('{"results":[]}', { status: 200 });
    await socialApi.searchProfiles('v', { limit: 5 });
    assert.match(calls[0].url, /limit=5/);
  });

  // ------------------------------------------------------------
  // Rate-limit surface — the modal renders a different toast for 429
  // than for a generic network error, so the code MUST distinguish them.
  // ------------------------------------------------------------

  test('surfaces 429 as { ok: false, error: "rate-limited" }', async () => {
    installFetch();
    nextResponse = new Response('rate limited', { status: 429 });
    const out = await socialApi.searchProfiles('vitalik');
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.error, 'rate-limited');
  });

  test('surfaces 500 as { ok: false, error: "server" }', async () => {
    installFetch();
    nextResponse = new Response('oops', { status: 500 });
    const out = await socialApi.searchProfiles('vitalik');
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.error, 'server');
  });

  test('surfaces fetch throw as { ok: false, error: "network" }', async () => {
    installFetch();
    nextResponse = () => {
      throw new TypeError('failed to fetch');
    };
    const out = await socialApi.searchProfiles('vitalik');
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.error, 'network');
  });

  // ------------------------------------------------------------
  // Abort behavior — the modal wires an AbortController per keystroke;
  // aborting an in-flight request must resolve to a distinct code
  // (NOT `network`) so the caller doesn't wipe the just-arrived results
  // for a query the user is still typing.
  // ------------------------------------------------------------

  test('aborted requests resolve to { ok: false, error: "aborted" }', async () => {
    installFetch();
    const controller = new AbortController();
    // Hold the fetch open until we've had a chance to abort.
    onFetch = ({ init }) => {
      return new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
        // Never resolves on its own — the abort is the only exit.
        setTimeout(() => resolve(), 10_000).unref?.();
      });
    };
    nextResponse = new Response('{}', { status: 200 });

    const pending = socialApi.searchProfiles('vitalik', { signal: controller.signal });
    // Give the fetch a tick to install the abort listener before we fire.
    await new Promise((r) => setImmediate(r));
    controller.abort();

    const out = await pending;
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(
      out.error,
      'aborted',
      `expected aborted, got ${JSON.stringify(out)} — modal will treat this as a live network error and stomp the good response`,
    );
  });

  // ------------------------------------------------------------
  // Concurrent races — if two searches fire and the FIRST completes
  // AFTER the second, the caller wiring abort correctly should see
  // exactly one non-aborted result. Documents the pattern the modal
  // depends on.
  // ------------------------------------------------------------

  test('a caller that aborts before firing the next request sees the new response only', async () => {
    installFetch();
    // Serve the first fetch slowly + the second fast. The caller aborts
    // the first before firing the second, so only the second resolves
    // with rows.
    let counter = 0;
    onFetch = ({ init }) =>
      new Promise((resolve, reject) => {
        counter += 1;
        const myTurn = counter;
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
        // First request never resolves on its own; second resolves after
        // one tick with a body that identifies the run.
        if (myTurn === 2) {
          setImmediate(() => resolve(undefined));
        } else {
          setTimeout(() => resolve(undefined), 10_000).unref?.();
        }
      });
    let responseCounter = 0;
    nextResponse = () => {
      responseCounter += 1;
      return new Response(
        JSON.stringify({ results: [{ address: `0x${'a'.repeat(40)}`, run: responseCounter }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const first = new AbortController();
    const second = new AbortController();
    const p1 = socialApi.searchProfiles('vitalik', { signal: first.signal });
    // The caller-side pattern: cancel the in-flight one BEFORE starting
    // the next.
    first.abort();
    const p2 = socialApi.searchProfiles('vitalikk', { signal: second.signal });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.ok, false, 'first (cancelled) request should not resolve as ok');
    assert.equal(r2.ok, true, 'second request should complete cleanly');
  });
});
