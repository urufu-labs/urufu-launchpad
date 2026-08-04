/// URU-A14 additional-defect page 10: adversarial end-to-end smoke test.
///
/// The unit tests in `isolated-build.test.ts` mock the forge invocation, so
/// they cannot prove the full production chain works together:
///
///     HTTP request  ->  fastify route  ->  compileSemaphore.run(...)
///                  ->  runIsolatedForgeBuild(...)  ->  mkdtemp(urufu-compile-*)
///                  ->  spawn(forge, ..., {root: workDir})
///                  ->  read artifact  ->  keccak256(bytecode)  ->  JSON reply
///                  ->  finally: rm(workDir)
///
/// This file starts the ACTUAL Fastify server as a subprocess (so we don't
/// have to refactor server.ts's top-level `await app.listen()`), forces the
/// isolated production path on with NODE_ENV=production +
/// COMPILE_MAX_CONCURRENCY=2, and drives it with real fetch calls.
///
/// Adversarial checks (things that would catch a broken integration but the
/// mocked unit tests would happily miss):
///
///   1. keccak256(bytecode) matches artifactHash on a REAL forge build,
///      proving the wire format the launcher trusts is what actually landed.
///   2. Firing 4 concurrent /compile requests never opens more than
///      COMPILE_MAX_CONCURRENCY (=2) tempdirs at once. Measured by polling
///      os.tmpdir() for `urufu-compile-*` entries every 25 ms during the
///      requests. This is a stronger check than a monkey-patched counter
///      because it observes the actual on-disk artifact of a concurrent
///      request. If the semaphore is misconfigured or bypassed, peak > 2.
///   3. After all 4 succeed, `urufu-compile-*` count returns to baseline
///      (no leaked tempdirs on success).
///   4. A malformed /compile request returns 4xx AND leaves the tempdir
///      count at baseline (no leaked tempdir on validation failure).
///   5. Firing 10 quick /compile requests from the same IP triggers Fastify
///      rate-limit (max 5/min per route in server.ts) — assert at least
///      one 429. Uses a FRESH server so the earlier suite's requests
///      haven't already burned the rate limit window.
///
/// Real forge is slow (10-30s per compile). This test intentionally accepts
/// the wall time — the whole point is to run the same binary a launcher
/// hits in production. The rate-limit test uses invalid bodies so it never
/// actually spawns forge; it exercises only the onRequest rate-limit hook.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry as foundryChain } from 'viem/chains';

// -----------------------------------------------------------------------------
// Repo layout + helpers
// -----------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolve(__dirname, '..');
const SERVER_TS = resolve(SERVICE_ROOT, 'src/server.ts');
const TEMP_PREFIX = 'urufu-compile-';

// Real forge binary must be on PATH to exercise the end-to-end HTTP -> tempdir
// -> real-compile path. Local dev boxes have it via foundryup; CI can't run
// this specific test unless the workflow also installs foundry. The
// isolated-build unit tests already prove the tempdir + semaphore mechanics
// under a stubbed forge — losing the end-to-end run on CI leaves the
// mechanics still covered, so we skip cleanly when forge is absent.
async function isForgeOnPath(): Promise<boolean> {
  const which = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolvePromise) => {
    const child = spawn(which, ['forge'], { stdio: 'ignore' });
    child.on('exit', (code) => resolvePromise(code === 0));
    child.on('error', () => resolvePromise(false));
  });
}
const HAVE_FORGE = await isForgeOnPath();

/// Anvil ships alongside forge under foundryup, so HAVE_ANVIL usually
/// tracks HAVE_FORGE — but a hand-installed forge may lack it, so we
/// check both independently. Anvil drives the on-chain URU-P1-B01
/// acceptance check (deploy the impl, verify `keccak256(getCode(addr))`
/// equals the compile-service's `runtimeCodeHash`).
async function isAnvilOnPath(): Promise<boolean> {
  const which = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolvePromise) => {
    const child = spawn(which, ['anvil'], { stdio: 'ignore' });
    child.on('exit', (code) => resolvePromise(code === 0));
    child.on('error', () => resolvePromise(false));
  });
}
const HAVE_ANVIL = await isAnvilOnPath();

/// Count `urufu-compile-*` entries currently under os.tmpdir(). The isolated
/// build path is the ONLY thing in the repo that uses this prefix, so a
/// count above baseline while requests are in flight = active work; a count
/// above baseline AFTER requests complete = a leaked tempdir.
async function countTempDirs(): Promise<number> {
  const entries = await fsp.readdir(tmpdir()).catch(() => [] as string[]);
  let n = 0;
  for (const e of entries) if (e.startsWith(TEMP_PREFIX)) n += 1;
  return n;
}

/// Build the parent test's env, but with every db/keeper/pinata key deleted
/// so the subprocess boots without needing Postgres/network access. We
/// DELETE rather than set to '' because db.ts uses `??` which treats '' as
/// truthy and would try to open a bogus Postgres connection.
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  delete out.DATABASE_URL;
  delete out.DATABASE_PRIVATE_URL;
  delete out.PINATA_JWT;
  delete out.KEEPER_ENABLED;
  return { ...out, ...extra };
}

interface Server {
  child: ChildProcess;
  url: string;
  close(): Promise<void>;
}

/// Spawn `src/server.ts` on a random port and wait until it logs the bound
/// address. Rewrites `0.0.0.0` -> `127.0.0.1` so the returned URL is
/// actually reachable client-side (0.0.0.0 is a bind address, not a
/// destination).
async function startServer(extraEnv: Record<string, string>): Promise<Server> {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', SERVER_TS],
    {
      cwd: SERVICE_ROOT,
      env: cleanEnv({
        PORT: '0',
        NODE_ENV: 'production',
        ...extraEnv,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  let stdoutBuf = '';

  const url = await new Promise<string>((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      rejectP(new Error(
        `server startup timeout after 20s.\nstderr:\n${stderrChunks.join('')}\nstdout:\n${stdoutChunks.join('')}`,
      ));
    }, 20_000);

    const finish = (u: string) => { clearTimeout(timer); resolveP(u); };
    const fail = (e: Error) => { clearTimeout(timer); rejectP(e); };

    child.stdout!.on('data', (buf: Buffer) => {
      const s = buf.toString('utf8');
      stdoutChunks.push(s);
      stdoutBuf += s;
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        let msg = '';
        try {
          const obj = JSON.parse(line);
          if (typeof obj?.msg === 'string') msg = obj.msg;
        } catch {
          msg = line;
        }
        const m = msg.match(/Server listening at (\S+)/);
        if (m && m[1]) return finish(m[1]);
      }
    });

    child.stderr!.on('data', (buf: Buffer) => stderrChunks.push(buf.toString('utf8')));
    child.on('exit', (code, sig) => fail(new Error(
      `server exited before ready (code=${code}, sig=${sig}).\nstderr:\n${stderrChunks.join('')}\nstdout:\n${stdoutChunks.join('')}`,
    )));
    child.on('error', (e) => fail(e));
  });

  const reachable = url.replace('0.0.0.0', '127.0.0.1');

  return {
    child,
    url: reachable,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
      await new Promise<void>((r) => child.once('exit', () => r()));
    },
  };
}

/// A valid /compile body — Permit is a no-param ERC20 module with a fragment
/// file, so the composed source builds against solady only (no extra libs).
function validCompileBody() {
  return {
    base: 'ERC20',
    mechanic: 'no-sale',
    chain: 'mainnet',
    modules: ['Permit'],
    params: { Permit: {} },
  };
}

async function postCompile(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/compile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// -----------------------------------------------------------------------------
// Suite A: real HTTP -> semaphore -> real forge -> cleanup
// -----------------------------------------------------------------------------
//
// One server, COMPILE_MAX_CONCURRENCY=2. Fires 4 concurrent real-forge
// requests, verifies:
//   - all 4 return 200 with a valid { artifactHash, bytecode, ... } shape
//   - keccak256(bytecode) === artifactHash on at least one response
//   - peak observed `urufu-compile-*` dirs <= 2 during the run
//   - tempdir count returns to baseline after all resolve
// Then a 5th request with a malformed body -> 400, tempdir count unchanged.
//
// Wall time budget: ~2 min. Real forge is ~15-30s per compile; 4 requests at
// cap 2 = 2 waves = ~30-60s. Timeout is generous.
//
// Test-plan requires "at least ONE end-to-end real forge compile" and the
// concurrency check on real integration; both are covered by this suite.

describe('smoke: real HTTP + semaphore + isolated forge build + cleanup', () => {
  let server: Server;
  let baselineTempCount = 0;

  before(async () => {
    baselineTempCount = await countTempDirs();
    server = await startServer({ COMPILE_MAX_CONCURRENCY: '2' });
  });

  after(async () => {
    if (server) await server.close();
  });

  it('4 concurrent real compiles: all 200, peak tempdirs <= cap, baseline restored', { skip: !HAVE_FORGE ? 'forge not on PATH (CI without foundry-toolchain; run locally to exercise real forge)' : false }, async (t) => {
    t.diagnostic(`baseline urufu-compile-* count = ${baselineTempCount}`);

    // Poll tempdir count every 25 ms while requests are in flight. Peak
    // reflects the maximum number of isolated builds that ever existed
    // on disk simultaneously — which upper-bounds concurrent forge invocations
    // and therefore concurrent semaphore holders.
    let peakDelta = 0;
    let polling = true;
    const pollDone = (async () => {
      while (polling) {
        const now = await countTempDirs();
        const delta = now - baselineTempCount;
        if (delta > peakDelta) peakDelta = delta;
        await delay(25);
      }
    })();

    const started = Date.now();
    const responses = await Promise.all([
      postCompile(server.url, validCompileBody()),
      postCompile(server.url, validCompileBody()),
      postCompile(server.url, validCompileBody()),
      postCompile(server.url, validCompileBody()),
    ]);
    const elapsedMs = Date.now() - started;
    t.diagnostic(`4 concurrent compiles wall time = ${elapsedMs} ms`);

    // Stop the poller before assertions so a failing assert doesn't leak it.
    polling = false;
    await pollDone;

    // Cache each response body once (fetch Response bodies can only be
    // consumed a single time; a subsequent .clone().text() would throw
    // "Body has already been consumed").
    const bodies: Array<{
      artifactHash?: string;
      creationCodeHash?: string;
      runtimeCodeHash?: string;
      bytecode?: string;
      runtimeBytecode?: string;
      configHash?: string;
      contractName?: string;
      abi?: unknown;
      moduleIds?: string[];
    }> = [];
    for (const [i, r] of responses.entries()) {
      const bodyText = await r.text();
      assert.equal(
        r.status, 200,
        `request ${i} expected 200, got ${r.status}: ${bodyText}`,
      );
      const j = JSON.parse(bodyText) as (typeof bodies)[number];
      bodies.push(j);
      assert.ok(j.artifactHash?.startsWith('0x'), `request ${i} missing artifactHash`);
      assert.ok(j.bytecode?.startsWith('0x'), `request ${i} missing bytecode`);
      assert.ok(j.configHash?.startsWith('0x'), `request ${i} missing configHash`);
      assert.equal(j.contractName, 'ERC20WithPermitGen', `request ${i} contractName drift`);
      assert.ok(Array.isArray(j.abi), `request ${i} abi not an array`);

      // URU-P1-B01 (round 4): the response MUST carry both hashes and the
      // deployed runtime buffer so a launcher can pin the factory correctly.
      assert.ok(
        j.runtimeBytecode?.startsWith('0x'),
        `request ${i} missing runtimeBytecode (URU-P1-B01: factory pin requires runtime code)`,
      );
      assert.ok(
        j.creationCodeHash?.startsWith('0x'),
        `request ${i} missing creationCodeHash`,
      );
      assert.ok(
        j.runtimeCodeHash?.startsWith('0x'),
        `request ${i} missing runtimeCodeHash`,
      );

      // Load-bearing wire invariants:
      //   * keccak256(bytecode)         == creationCodeHash
      //   * keccak256(runtimeBytecode)  == runtimeCodeHash
      //   * artifactHash                == runtimeCodeHash  (legacy alias)
      // If any of these drift the launcher's pin-and-register will fail
      // silently on-chain instead of loudly here.
      const computedCreation = keccak256(j.bytecode as Hex);
      const computedRuntime = keccak256(j.runtimeBytecode as Hex);
      assert.equal(
        computedCreation, j.creationCodeHash,
        `request ${i}: keccak256(bytecode) != creationCodeHash`,
      );
      assert.equal(
        computedRuntime, j.runtimeCodeHash,
        `request ${i}: keccak256(runtimeBytecode) != runtimeCodeHash`,
      );
      assert.equal(
        j.artifactHash, j.runtimeCodeHash,
        `request ${i}: artifactHash must alias runtimeCodeHash (URU-P1-B01)`,
      );
      // Belt-and-suspenders: creation vs runtime MUST differ. If they
      // matched, either the compiler emitted an odd artifact or the
      // server accidentally pointed both fields at the same buffer.
      assert.notEqual(
        j.creationCodeHash, j.runtimeCodeHash,
        `request ${i}: creationCodeHash and runtimeCodeHash must differ`,
      );
    }

    // All requests returned identical composed source, so all should have
    // the same artifactHash + configHash. Divergence would mean cross-request
    // state contamination (e.g., one request's params bleeding into another).
    const j0 = bodies[0]!;
    for (let i = 1; i < bodies.length; i++) {
      const ji = bodies[i]!;
      assert.equal(ji.artifactHash, j0.artifactHash, `request ${i} artifactHash diverged from request 0`);
      assert.equal(ji.configHash, j0.configHash, `request ${i} configHash diverged from request 0`);
    }

    // The concurrency assertion. With COMPILE_MAX_CONCURRENCY=2, peak
    // simultaneous tempdirs MUST be <= 2. If it hit 3 or 4, the semaphore
    // is bypassed and the audit fix is broken.
    t.diagnostic(`peak simultaneous urufu-compile-* dirs = ${peakDelta}`);
    assert.ok(
      peakDelta >= 1,
      `did not observe any urufu-compile-* dirs during 4 concurrent requests (peak=${peakDelta}). Something is wrong with the isolated-build path or the poller lost the race.`,
    );
    assert.ok(
      peakDelta <= 2,
      `peak simultaneous tempdirs was ${peakDelta}, exceeds COMPILE_MAX_CONCURRENCY=2 — semaphore is not capping concurrency`,
    );

    // Cleanup assertion — every tempdir must be gone after the requests
    // resolve. Give the finally-cleanup a short grace period in case rm
    // is still draining (fsp.rm awaits internally but Windows FS metadata
    // can lag briefly).
    for (let i = 0; i < 20; i++) {
      const now = await countTempDirs();
      if (now === baselineTempCount) break;
      await delay(50);
    }
    const finalCount = await countTempDirs();
    assert.equal(
      finalCount, baselineTempCount,
      `expected tempdir count back at baseline ${baselineTempCount}, got ${finalCount} — leaked tempdirs`,
    );
  });

  it('malformed request returns 4xx and leaves tempdir count at baseline', async () => {
    // Passes zod (all fields present + typed correctly) but fails compose()
    // with UNKNOWN_MODULE, so the handler returns 400 via taxonomize().
    // No forge is spawned, so no tempdir should be created for this request.
    // This test catches a regression where the handler starts to create the
    // tempdir BEFORE compose() runs (the fix keeps it strictly inside the
    // semaphore.run callback so a validation failure never enters that block).
    const beforeCount = await countTempDirs();
    const resp = await postCompile(server.url, {
      base: 'ERC20',
      mechanic: 'no-sale',
      chain: 'mainnet',
      modules: ['NotARealModule'],
      params: {},
    });
    assert.ok(resp.status >= 400 && resp.status < 500,
      `expected 4xx for unknown module, got ${resp.status}`);
    const j = await resp.json() as { code?: string };
    // Either UNKNOWN_MODULE from taxonomize() or INVALID_BODY from zod
    // (both acceptable — the point is that a broken input never spawns
    // forge and never leaks a tempdir).
    assert.ok(
      j.code === 'UNKNOWN_MODULE' || j.code === 'INVALID_BODY',
      `expected UNKNOWN_MODULE or INVALID_BODY, got code=${j.code}`,
    );

    const afterCount = await countTempDirs();
    assert.equal(
      afterCount, beforeCount,
      `expected tempdir count unchanged after 4xx (was ${beforeCount}, now ${afterCount}) — validation failure leaked a tempdir`,
    );
  });
});

// -----------------------------------------------------------------------------
// Suite B: rate limit fires
// -----------------------------------------------------------------------------
//
// Fresh server so the rate-limit window is untouched. Fires 10 quick
// /compile requests with an INVALID body — that way onRequest rate limit
// counts them but the handler never spawns forge, so the test finishes in
// a second even if rate-limit somehow forwarded them to compose(). Asserts
// at least one 429 lands.
//
// server.ts hardcodes `{ config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }`
// on the /compile route, so requests 6-10 MUST return 429.

describe('smoke: per-route rate limit on POST /compile', () => {
  let server: Server;

  before(async () => {
    server = await startServer({ COMPILE_MAX_CONCURRENCY: '2' });
  });

  after(async () => {
    if (server) await server.close();
  });

  it('firing 10 rapid POSTs from one IP produces at least one 429', async () => {
    // Invalid body -> would be 400 if it reached the handler. But rate limit
    // fires at onRequest, before body parse, so requests over the cap get
    // 429 regardless of body content. This deliberately keeps every request
    // cheap so the assertion doesn't wait 5 real forge builds.
    const invalidBody = { garbage: true };

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => postCompile(server.url, invalidBody)),
    );
    const statuses = responses.map((r) => r.status);
    const status429s = statuses.filter((s) => s === 429).length;
    const status400s = statuses.filter((s) => s === 400).length;

    // Consume every body so undici doesn't complain about unclosed streams.
    await Promise.all(responses.map((r) => r.text().catch(() => '')));

    assert.ok(
      status429s >= 1,
      `expected at least one 429 from rate limit, got statuses=${JSON.stringify(statuses)} (429=${status429s}, 400=${status400s})`,
    );
    // Sanity: the per-route cap is 5, so at most 5 requests get past the
    // rate limit and reach the handler. If we saw ALL 10 return 400, the
    // rate limit isn't attached.
    assert.ok(
      status400s <= 5,
      `expected at most 5 requests past the rate limit (max=5), got ${status400s} 400s — rate limit did not fire`,
    );
  });
});

// -----------------------------------------------------------------------------
// Suite C: URU-P1-M05 back-pressure body-size cap on POST /compile
// -----------------------------------------------------------------------------
//
// A well-formed compile body is a few KB. An abuser can otherwise POST a
// megabyte-scale body and pin the process's memory while the request
// waits in the semaphore queue. server.ts now sets `bodyLimit` on the
// /compile route via COMPILE_BODY_LIMIT_BYTES; this suite proves the
// cap actually fires by POSTing a body larger than the configured
// ceiling and asserting a 4xx (Fastify returns 413 for oversize
// bodies).

describe('smoke: /compile HTTP body-size cap', () => {
  let server: Server;

  before(async () => {
    // Tighten the cap so we can prove the guard without shipping a
    // gigabyte payload. 1_024 bytes is well below any legitimate config
    // request.
    server = await startServer({
      COMPILE_MAX_CONCURRENCY: '2',
      COMPILE_BODY_LIMIT_BYTES: '1024',
    });
  });

  after(async () => {
    if (server) await server.close();
  });

  it('POST with body larger than COMPILE_BODY_LIMIT_BYTES returns 4xx', async () => {
    // 4 KB body >> 1 KB cap. Padding lives inside a JSON field so the
    // parser has to buffer the entire body before it can even reject
    // (which is exactly the memory-pressure vector we're bounding).
    const oversized = {
      base: 'ERC20',
      mechanic: 'no-sale',
      chain: 'mainnet',
      modules: ['Permit'],
      params: { Permit: { pad: 'a'.repeat(4_096) } },
    };
    const resp = await postCompile(server.url, oversized);
    // Fastify returns 413 for oversize bodies. Some middleware may map
    // it to 400; accept anything in 4xx as proof the cap fired before
    // the handler ran.
    assert.ok(
      resp.status >= 400 && resp.status < 500,
      `expected 4xx for oversize body, got ${resp.status}`,
    );
    await resp.text().catch(() => '');
  });
});

// -----------------------------------------------------------------------------
// Suite D: URU-P1-B01 acceptance — on-chain runtime code equals runtimeCodeHash
// -----------------------------------------------------------------------------
//
// The URU-P1-B01 blocker was that the compile service returned
// `keccak256(creation bytecode)` while `ERC20Factory.registerImpl` (and
// friends) verify `keccak256(impl.code)` — which is the DEPLOYED
// runtime bytecode. Any launcher trusting `artifactHash` for the
// factory pin therefore could never pin-and-register successfully.
//
// The Foundry test suite (`test/audit/FactoryCodeHashPin.t.sol`) already
// proves the factory's pin-and-register works when given the runtime
// codehash. What that suite CANNOT prove is that the value the compile
// service returns IS the runtime codehash of a real deployed impl. This
// suite closes that gap:
//
//   1. Spawn anvil.
//   2. Compile via the real /compile HTTP flow, extract the creation
//      bytecode + returned `runtimeCodeHash`.
//   3. Deploy the creation bytecode on anvil (constructor takes no args —
//      the template initializes lazily via `initialize(bytes)`).
//   4. Fetch `getCode(deployedAddr)` from anvil.
//   5. Assert `keccak256(getCode) == runtimeCodeHash`.
//
// If (5) holds, then the launcher's chain of trust —
//   compile-service.runtimeCodeHash
//   -> factory.setExpectedCodeHash(configHash, that)
//   -> factory.registerImpl(configHash, deployedImpl)
// — is guaranteed to succeed on-chain, because the factory computes
// exactly `keccak256(deployedImpl.code)` and it will match the pin.
//
// Skipped cleanly when forge OR anvil is missing — the mechanics are
// still covered by the Foundry unit tests + the JS hash-equivalence
// assertions in Suite A.

async function startAnvil(): Promise<{ url: string; close: () => Promise<void> }> {
  // Do NOT pass --silent / --quiet: those suppress ALL stdout including
  // the "Listening on 127.0.0.1:PORT" line our helper waits for, which
  // would hang the test until the parent times it out. The verbose
  // banner is fine — we're piping stdout, so it doesn't reach the test
  // runner's output.
  const child = spawn('anvil', ['--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let buf = '';
  const url = await new Promise<string>((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error(
      `anvil startup timeout after 15s.\nstdout:\n${stdoutChunks.join('')}\nstderr:\n${stderrChunks.join('')}`,
    )), 15_000);
    child.stdout!.on('data', (b: Buffer) => {
      const s = b.toString('utf8');
      stdoutChunks.push(s);
      buf += s;
      // Anvil logs "Listening on 127.0.0.1:PORT" on ready.
      const m = buf.match(/Listening on\s+([0-9.]+):(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolveP(`http://${m[1]}:${m[2]}`);
      }
    });
    child.stderr!.on('data', (b: Buffer) => stderrChunks.push(b.toString('utf8')));
    child.on('exit', (code) => {
      clearTimeout(timer);
      rejectP(new Error(`anvil exited before ready (code=${code})`));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      rejectP(e);
    });
  });
  return {
    url,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
      await new Promise<void>((r) => child.once('exit', () => r()));
    },
  };
}

describe('smoke: URU-P1-B01 on-chain runtime code matches runtimeCodeHash', () => {
  let server: Server;
  let anvil: { url: string; close: () => Promise<void> };

  before(async () => {
    if (!HAVE_FORGE || !HAVE_ANVIL) return;
    server = await startServer({ COMPILE_MAX_CONCURRENCY: '2' });
    anvil = await startAnvil();
  });

  after(async () => {
    if (anvil) await anvil.close();
    if (server) await server.close();
  });

  it(
    'deploy(bytecode) -> keccak256(getCode(deployedAddr)) equals runtimeCodeHash',
    {
      skip: !HAVE_FORGE
        ? 'forge not on PATH (needed to compile the impl)'
        : !HAVE_ANVIL
          ? 'anvil not on PATH (needed to deploy and read on-chain code)'
          : false,
    },
    async (t) => {
      // 1. Real compile.
      const resp = await postCompile(server.url, validCompileBody());
      const bodyText = await resp.text();
      assert.equal(resp.status, 200, `compile failed: ${bodyText}`);
      const j = JSON.parse(bodyText) as {
        bytecode: string;
        runtimeBytecode: string;
        runtimeCodeHash: string;
        artifactHash: string;
      };

      // 2. Wire viem to anvil. anvil's first prefunded account has a
      // well-known private key.
      const account = privateKeyToAccount(
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      );
      const publicClient = createPublicClient({
        chain: foundryChain,
        transport: http(anvil.url),
      });
      const walletClient = createWalletClient({
        account,
        chain: foundryChain,
        transport: http(anvil.url),
      });

      // 3. Deploy the creation bytecode. ERC20Template has no constructor
      // args — it uses `initialize(bytes)` on the clone, not the impl.
      const txHash = await walletClient.sendTransaction({
        data: j.bytecode as Hex,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      assert.equal(receipt.status, 'success', 'impl deploy tx must succeed');
      assert.ok(receipt.contractAddress, 'deploy tx must produce a contract address');
      const deployedAddr = receipt.contractAddress;

      // 4. Read the on-chain runtime code.
      const onchainCode = await publicClient.getCode({ address: deployedAddr });
      assert.ok(onchainCode, 'anvil returned no code at deployed address');
      const onchainHash = keccak256(onchainCode);

      t.diagnostic(`deployedAddr = ${deployedAddr}`);
      t.diagnostic(`onchain codehash = ${onchainHash}`);
      t.diagnostic(`compile runtimeCodeHash = ${j.runtimeCodeHash}`);

      // 5. The load-bearing acceptance check. If this passes, a launcher
      // calling `factory.setExpectedCodeHash(configHash, j.runtimeCodeHash)`
      // then `factory.registerImpl(configHash, deployedAddr)` MUST succeed —
      // the factory's own check is exactly `keccak256(impl.code) == pin`.
      assert.equal(
        onchainHash, j.runtimeCodeHash,
        'URU-P1-B01: keccak256(getCode(deployedAddr)) must equal runtimeCodeHash — otherwise factory pin/register cannot succeed',
      );
      assert.equal(
        onchainHash, j.artifactHash,
        'URU-P1-B01: artifactHash alias must equal on-chain codehash',
      );
    },
  );
});
