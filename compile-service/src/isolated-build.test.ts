/// URU-A14 additional-defect page 10 tests: the auditor flagged three
/// distinct concerns on the public compile service. Each concern gets its
/// own explicit test below so a future regression is caught by name.
///
///   1. Persistent temporary source        -> "failed build still cleans up..."
///   2. Workspace-wide Forge build         -> "isolated scaffolding writes only..."
///   3. Shared output paths (concurrency)  -> "two concurrent builds get..."
///                                            + "semaphore caps in-flight..."
///
/// Uses a mocked `runBuild(workDir)` so we don't have to spawn Forge in CI.
/// The mock exercises the exact wrapping (mkdtemp + finally + cleanup) that
/// the production path uses.

import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  Semaphore,
  defaultCompileConcurrency,
  defaultCompileQueueLimit,
  defaultCompileQueueWaitMs,
  defaultCompileTimeoutMs,
  isolatedFoundryToml,
  isolatedRemappings,
  spawnForge,
  withIsolatedWorkDir,
} from './isolated-build.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// withIsolatedWorkDir
// -----------------------------------------------------------------------------

test('withIsolatedWorkDir creates a fresh directory under os.tmpdir', async () => {
  let captured = '';
  await withIsolatedWorkDir(async (workDir) => {
    captured = workDir;
    assert.ok(workDir.startsWith(tmpdir()), 'workDir should sit under os.tmpdir()');
    assert.equal(await pathExists(workDir), true);
  });
  // Sanity: after the callback returns the dir is gone.
  assert.equal(await pathExists(captured), false);
});

test('two concurrent isolated builds get distinct workDirs', async () => {
  const seen: string[] = [];
  const build = () =>
    withIsolatedWorkDir(async (workDir) => {
      seen.push(workDir);
      // Write something so we would catch a collision (two runs writing the
      // same output path would clobber each other's file).
      await fsp.writeFile(join(workDir, 'marker.txt'), workDir);
      await sleep(20); // hold the dir open while the other run is scaffolding.
      const readBack = await fsp.readFile(join(workDir, 'marker.txt'), 'utf8');
      assert.equal(readBack, workDir, 'marker file must not be clobbered by peer');
      return workDir;
    });

  const [a, b] = await Promise.all([build(), build()]);
  assert.notEqual(a, b, 'each request must get its own workDir');
  assert.equal(seen.length, 2);
  // Both cleaned up.
  assert.equal(await pathExists(a), false);
  assert.equal(await pathExists(b), false);
});

test('failed build still cleans up the tempdir', async () => {
  let captured = '';
  await assert.rejects(
    withIsolatedWorkDir(async (workDir) => {
      captured = workDir;
      // Simulate a build failure mid-flight, after some files exist.
      await fsp.writeFile(join(workDir, 'partial.txt'), 'boom');
      throw new Error('COMPILE_FAILED: fake boom');
    }),
    /COMPILE_FAILED: fake boom/,
  );
  assert.ok(captured, 'callback should have received a workDir');
  assert.equal(
    await pathExists(captured),
    false,
    'workDir must be removed even after the callback throws',
  );
});

test('cleanup failure does not mask the callback error', async () => {
  // If the callback throws AND cleanup happens to fail (e.g. dir already gone
  // because the callback deleted it itself), the callback error must still
  // propagate — cleanup is best-effort.
  let captured = '';
  await assert.rejects(
    withIsolatedWorkDir(async (workDir) => {
      captured = workDir;
      // Remove the dir out from under the finally-cleanup.
      await fsp.rm(workDir, { recursive: true, force: true });
      throw new Error('CALLBACK_ERROR: original');
    }),
    /CALLBACK_ERROR: original/,
  );
  assert.equal(await pathExists(captured), false);
});

// -----------------------------------------------------------------------------
// Foundry scaffolding
// -----------------------------------------------------------------------------

test('isolated scaffolding writes only the composed source, not the workspace', async () => {
  // The auditor concern was that the shared /compile handler invoked
  // `forge build` in contracts/ which compiled the whole src/ tree. Prove
  // the isolated scaffolding contains ONLY the composed .sol file — no
  // stray test/, script/, or repo-src copy.
  await withIsolatedWorkDir(async (workDir) => {
    const src = join(workDir, 'src');
    await fsp.mkdir(src, { recursive: true });
    await fsp.writeFile(join(src, 'Composed.sol'), '// composed');
    await fsp.writeFile(join(workDir, 'foundry.toml'), isolatedFoundryToml('/x/lib'));
    await fsp.writeFile(join(workDir, 'remappings.txt'), isolatedRemappings('/x/lib'));

    const roots = (await fsp.readdir(workDir)).sort();
    assert.deepEqual(
      roots,
      ['foundry.toml', 'remappings.txt', 'src'],
      'isolated workDir must contain ONLY the scaffolded files',
    );
    const inSrc = await fsp.readdir(src);
    assert.deepEqual(inSrc, ['Composed.sol'], 'src/ must contain only the composed file');
  });
});

test('isolatedFoundryToml points libs at the shared repo lib dir', () => {
  const toml = isolatedFoundryToml('/repo/contracts/lib');
  // Absolute path is JSON-encoded so backslashes on Windows are handled.
  assert.match(toml, /libs = \["[^"]*repo[^"]*contracts[^"]*lib"\]/);
  assert.match(toml, /solc_version = "0\.8\.26"/);
  assert.match(toml, /via_ir = true/);
});

test('isolatedRemappings covers every remapping in the repo remappings.txt', () => {
  const remaps = isolatedRemappings('/repo/contracts/lib');
  // Each of these must resolve so composed sources import cleanly.
  for (const marker of [
    'forge-std/=',
    '@openzeppelin/contracts/=',
    '@openzeppelin/contracts-upgradeable/=',
    'solady/=',
    'erc721a/=',
    'v4-core/=',
    'v4-periphery/=',
    '@uniswap/v4-core/=',
    '@uniswap/v4-periphery/=',
  ]) {
    assert.match(remaps, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

// -----------------------------------------------------------------------------
// Semaphore
// -----------------------------------------------------------------------------

test('semaphore caps in-flight to max, extra callers queue in order', async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const completions: number[] = [];

  const task = (id: number) =>
    sem.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(25);
      active -= 1;
      completions.push(id);
    });

  await Promise.all([task(1), task(2), task(3), task(4)]);
  assert.equal(peak, 2, `peak concurrency was ${peak}, expected 2`);
  assert.equal(sem.inFlight, 0);
  assert.equal(sem.waiting, 0);
  assert.equal(completions.length, 4);
});

test('semaphore serializes past N (spawning N+2 requests overlaps at most N)', async () => {
  const N = 2;
  const sem = new Semaphore(N);
  let active = 0;
  let peak = 0;

  const spawn = (delayMs: number) =>
    sem.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(delayMs);
      active -= 1;
    });

  // N+2 = 4 concurrent requests, each takes 30ms of "compile work".
  await Promise.all([spawn(30), spawn(30), spawn(30), spawn(30)]);
  assert.ok(peak <= N, `overlap ${peak} must not exceed cap ${N}`);
});

test('semaphore releases slot even when the callback rejects', async () => {
  const sem = new Semaphore(1);
  await assert.rejects(
    sem.run(async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  // If the finally didn't run, this second call would deadlock instead of
  // completing. Use a short timeout to prove it made it through.
  const second = sem.run(async () => 42);
  const winner = await Promise.race([
    second,
    sleep(200).then(() => 'timeout' as const),
  ]);
  assert.equal(winner, 42, 'semaphore must release even after a rejected callback');
});

test('semaphore rejects invalid bounds', () => {
  assert.throws(() => new Semaphore(0), /max must be >= 1/);
  assert.throws(() => new Semaphore(-1), /max must be >= 1/);
  assert.throws(() => new Semaphore(Number.NaN), /max must be >= 1/);
  // URU-P1-M05: the extra queue-depth + wait-timeout knobs get the same
  // guardrails as `max` so a mis-configured deploy fails at boot rather
  // than silently accepting an unbounded queue or a zero-timeout queue.
  assert.throws(() => new Semaphore(1, -1), /maxQueue must be >= 0/);
  assert.throws(() => new Semaphore(1, Number.NaN), /maxQueue must be >= 0/);
  assert.throws(() => new Semaphore(1, 1, 0), /waitTimeoutMs must be >= 1/);
  assert.throws(() => new Semaphore(1, 1, Number.NaN), /waitTimeoutMs must be >= 1/);
});

test('defaultCompileConcurrency respects COMPILE_MAX_CONCURRENCY env override', () => {
  const before = process.env.COMPILE_MAX_CONCURRENCY;
  try {
    process.env.COMPILE_MAX_CONCURRENCY = '7';
    assert.equal(defaultCompileConcurrency(), 7);
    process.env.COMPILE_MAX_CONCURRENCY = '1';
    assert.equal(defaultCompileConcurrency(), 1);
    process.env.COMPILE_MAX_CONCURRENCY = 'garbage';
    // Falls back to cpu-derived default when the override is non-numeric.
    const auto = defaultCompileConcurrency();
    assert.ok(auto >= 1);
  } finally {
    if (before === undefined) delete process.env.COMPILE_MAX_CONCURRENCY;
    else process.env.COMPILE_MAX_CONCURRENCY = before;
  }
});

// -----------------------------------------------------------------------------
// URU-P1-M05: bounded queue + queue-wait timeout + forge-lifetime bounds.
// -----------------------------------------------------------------------------
// Each concern gets a dedicated test so a regression is caught by name.
//
//   * bounded queue        -> "semaphore rejects when the bounded wait queue..."
//   * bounded queue wait   -> "semaphore times out queued callers..."
//   * release idempotency  -> "semaphore release callback is idempotent..."
//   * forge wall-clock     -> "spawnForge kills the child on wall-clock..."
//   * forge abort signal   -> "spawnForge kills the child when the abort..."

test('semaphore rejects when the bounded wait queue is full', async () => {
  const sem = new Semaphore(1, 1, 1_000);
  let releaseFirst!: () => void;
  const first = sem.run(
    () => new Promise<void>((resolveP) => {
      releaseFirst = resolveP;
    }),
  );
  while (sem.inFlight !== 1) await sleep(1);

  // Fills the single queue slot.
  const second = sem.run(async () => 2);
  while (sem.waiting !== 1) await sleep(1);

  // Third caller must reject synchronously with COMPILE_BUSY — the queue
  // is at capacity so we refuse rather than growing memory.
  await assert.rejects(
    sem.run(async () => 3),
    (err: unknown) => (err as { code?: string }).code === 'COMPILE_BUSY',
  );

  releaseFirst();
  await first;
  assert.equal(await second, 2);
  assert.equal(sem.inFlight, 0);
  assert.equal(sem.waiting, 0);
});

test('semaphore times out queued callers exceeding waitTimeoutMs', async () => {
  const sem = new Semaphore(1, 1, 20);
  let releaseFirst!: () => void;
  const first = sem.run(
    () => new Promise<void>((resolveP) => {
      releaseFirst = resolveP;
    }),
  );
  while (sem.inFlight !== 1) await sleep(1);

  // Queued caller reaches the wait ceiling and self-evicts with a
  // COMPILE_QUEUE_TIMEOUT — its request body is dropped instead of
  // sitting in memory forever.
  await assert.rejects(
    sem.run(async () => 2),
    (err: unknown) => (err as { code?: string }).code === 'COMPILE_QUEUE_TIMEOUT',
  );
  // After the timed-out caller self-evicted, the queue is empty and the
  // first caller still holds the slot.
  assert.equal(sem.waiting, 0);
  assert.equal(sem.inFlight, 1);

  releaseFirst();
  await first;
  assert.equal(sem.inFlight, 0);
});

test('semaphore release callback is idempotent (double-release is a no-op)', async () => {
  const sem = new Semaphore(2);
  const release1 = await sem.acquire();
  const release2 = await sem.acquire();
  assert.equal(sem.inFlight, 2);

  // Two calls to the SAME release must decrement exactly once. If not,
  // active would go negative and the next acquire could over-admit.
  release1();
  release1();
  release1();
  assert.equal(sem.inFlight, 1);

  release2();
  assert.equal(sem.inFlight, 0);

  // Prove the counter is not corrupted: fresh acquires still work.
  const release3 = await sem.acquire();
  assert.equal(sem.inFlight, 1);
  release3();
  assert.equal(sem.inFlight, 0);
});

test('defaultCompileQueueLimit respects COMPILE_MAX_QUEUE env override', () => {
  const before = process.env.COMPILE_MAX_QUEUE;
  try {
    process.env.COMPILE_MAX_QUEUE = '4';
    assert.equal(defaultCompileQueueLimit(), 4);
    delete process.env.COMPILE_MAX_QUEUE;
    assert.equal(defaultCompileQueueLimit(), 16);
    process.env.COMPILE_MAX_QUEUE = 'garbage';
    assert.equal(defaultCompileQueueLimit(), 16);
  } finally {
    if (before === undefined) delete process.env.COMPILE_MAX_QUEUE;
    else process.env.COMPILE_MAX_QUEUE = before;
  }
});

test('defaultCompileQueueWaitMs respects COMPILE_QUEUE_WAIT_MS env override', () => {
  const before = process.env.COMPILE_QUEUE_WAIT_MS;
  try {
    process.env.COMPILE_QUEUE_WAIT_MS = '5000';
    assert.equal(defaultCompileQueueWaitMs(), 5_000);
    delete process.env.COMPILE_QUEUE_WAIT_MS;
    assert.equal(defaultCompileQueueWaitMs(), 30_000);
  } finally {
    if (before === undefined) delete process.env.COMPILE_QUEUE_WAIT_MS;
    else process.env.COMPILE_QUEUE_WAIT_MS = before;
  }
});

test('defaultCompileTimeoutMs respects COMPILE_TIMEOUT_MS env override', () => {
  const before = process.env.COMPILE_TIMEOUT_MS;
  try {
    process.env.COMPILE_TIMEOUT_MS = '45000';
    assert.equal(defaultCompileTimeoutMs(), 45_000);
    delete process.env.COMPILE_TIMEOUT_MS;
    assert.equal(defaultCompileTimeoutMs(), 120_000);
  } finally {
    if (before === undefined) delete process.env.COMPILE_TIMEOUT_MS;
    else process.env.COMPILE_TIMEOUT_MS = before;
  }
});

// URU-P1-M05: the forge wall-clock + abort tests use `process.execPath`
// (node) as a stand-in for the forge binary. The one-liner `-e` argument
// installs a `setTimeout` that never fires, so the child is a
// deterministic hang. spawnForge must SIGKILL it and surface the correct
// { timedOut, aborted } flags. Cross-platform: no shell dependency and no
// need for a real forge on PATH.

const HANG_SCRIPT = 'setTimeout(() => {}, 60_000)';

test('spawnForge kills the child on wall-clock timeout and reports timedOut', async () => {
  const started = Date.now();
  const result = await spawnForge(
    process.execPath,
    ['-e', HANG_SCRIPT],
    50,
  );
  const elapsed = Date.now() - started;
  // Killed via wall-clock timeout, not natural exit.
  assert.equal(result.timedOut, true, 'timedOut flag must be set on wall-clock kill');
  assert.equal(result.aborted, false, 'aborted flag must be false on timeout kill');
  assert.notEqual(result.code, 0, 'exit code must not be 0 after SIGKILL');
  // Sanity: we actually killed early, we did NOT wait 60s.
  assert.ok(elapsed < 5_000, `timeout kill took too long (${elapsed} ms)`);
});

test('spawnForge kills the child when the abort signal fires and reports aborted', async () => {
  const controller = new AbortController();
  const started = Date.now();
  // Fire the abort after the child has definitely spawned.
  setTimeout(() => controller.abort(), 30);
  const result = await spawnForge(
    process.execPath,
    ['-e', HANG_SCRIPT],
    60_000, // huge wall-clock ceiling; only the abort should trigger.
    controller.signal,
  );
  const elapsed = Date.now() - started;
  assert.equal(result.aborted, true, 'aborted flag must be set on signal kill');
  assert.equal(result.timedOut, false, 'timedOut flag must be false on abort kill');
  assert.notEqual(result.code, 0, 'exit code must not be 0 after SIGKILL');
  assert.ok(elapsed < 5_000, `abort kill took too long (${elapsed} ms)`);
});

test('spawnForge honors an already-aborted signal (never spawns a long-lived child)', async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const result = await spawnForge(
    process.execPath,
    ['-e', HANG_SCRIPT],
    60_000,
    controller.signal,
  );
  const elapsed = Date.now() - started;
  assert.equal(result.aborted, true);
  assert.ok(elapsed < 2_000, `pre-aborted spawn took too long (${elapsed} ms)`);
});
