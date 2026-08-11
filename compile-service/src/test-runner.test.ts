/// Round-2 FINDING 2 tests: /test admission controls.
///
/// These exercise the pieces that make the /test HTTP path safe to
/// expose publicly:
///
///   * runForgeTests times out (SIGKILL + timedOut flag) when the
///     forge child exceeds `timeoutMs` — AC #2 building block.
///   * runForgeTests aborts (SIGKILL + aborted flag) when the
///     supplied AbortSignal fires — AC #3 building block.
///   * runForgeTests cleans up its isolated cache/output tempdir on
///     SUCCESS, on timeout, and on abort — AC #6 building block.
///   * runForgeTests caps combined output at `maxOutputBytes` and
///     reports `truncated: true` when a chatty forge run overshoots —
///     protects the process from OOM by a hostile test.
///   * runForgeTests ignores TEST_FORGE_ARGS_JSON when the value is
///     malformed (falls back to real forge args) — the injection
///     hatch is test-only and MUST NOT accidentally influence prod.
///   * The Semaphore's SemaphoreCodes overrides surface distinct
///     error codes for the /test pool — proves /test capacity errors
///     don't reuse the /compile codes.
///   * The default* helpers for the /test pool honor their env
///     overrides — matches the parallel /compile suite.
///
/// The forge child is stubbed with `process.execPath -e <script>` so
/// these tests need neither a real forge nor a real test binary on
/// PATH. Matches the existing `spawnForge` unit-test pattern.

import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  Semaphore,
  defaultTestConcurrency,
  defaultTestMaxOutputBytes,
  defaultTestQueueLimit,
  defaultTestQueueWaitMs,
  defaultTestTimeoutMs,
} from './isolated-build.ts';
import { runForgeTests } from './test-runner.ts';

const HANG_SCRIPT = 'setTimeout(() => {}, 60_000)';

async function countTestDirs(base: string): Promise<number> {
  const entries = await fsp.readdir(base).catch(() => [] as string[]);
  let n = 0;
  for (const e of entries) if (e.startsWith('urufu-test-')) n += 1;
  return n;
}

// -----------------------------------------------------------------------------
// runForgeTests: timeout / abort / cleanup / output cap / args-override guard
// -----------------------------------------------------------------------------

test('runForgeTests + TEST_FORGE_ARGS_JSON: wall-clock timeout SIGKILLs + tempdir cleaned', async () => {
  process.env.TEST_FORGE_ARGS_JSON = JSON.stringify(['-e', HANG_SCRIPT]);
  const before = await countTestDirs(tmpdir());
  try {
    const started = Date.now();
    const result = await runForgeTests({
      contractsDir: process.cwd(),
      matchPath: 'test/does-not-matter.t.sol',
      forgeBin: process.execPath,
      timeoutMs: 100,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true, 'timedOut flag must be set when wall-clock ceiling fires');
    assert.equal(result.aborted, false);
    assert.notEqual(result.exitCode, 0, 'SIGKILLed child exits non-zero');
    assert.ok(elapsed < 5_000, `timeout took too long (${elapsed}ms) — did SIGKILL land?`);
    // AC #6: cleanup on timeout.
    const after = await countTestDirs(tmpdir());
    assert.equal(after, before, 'tempdir must be cleaned up on timeout');
  } finally {
    delete process.env.TEST_FORGE_ARGS_JSON;
  }
});

test('runForgeTests + AbortSignal: aborts SIGKILL the child + tempdir cleaned', async () => {
  process.env.TEST_FORGE_ARGS_JSON = JSON.stringify(['-e', HANG_SCRIPT]);
  const before = await countTestDirs(tmpdir());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  try {
    const started = Date.now();
    const result = await runForgeTests({
      contractsDir: process.cwd(),
      matchPath: 'test/does-not-matter.t.sol',
      forgeBin: process.execPath,
      timeoutMs: 60_000, // huge — only the abort should end this
      signal: controller.signal,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.aborted, true, 'aborted flag must be set when signal fires mid-run');
    assert.equal(result.timedOut, false);
    assert.notEqual(result.exitCode, 0);
    assert.ok(elapsed < 5_000, `abort took too long (${elapsed}ms) — did SIGKILL land?`);
    // AC #6: cleanup on abort.
    const after = await countTestDirs(tmpdir());
    assert.equal(after, before, 'tempdir must be cleaned up on abort');
  } finally {
    delete process.env.TEST_FORGE_ARGS_JSON;
  }
});

test('runForgeTests caps combined stdout+stderr at maxOutputBytes and reports truncated=true', async () => {
  // Emit a 4 KiB blob repeatedly until the child exits normally.
  const chatty = "const blob = 'x'.repeat(4096); for (let i = 0; i < 500; i++) process.stdout.write(blob);";
  process.env.TEST_FORGE_ARGS_JSON = JSON.stringify(['-e', chatty]);
  try {
    const result = await runForgeTests({
      contractsDir: process.cwd(),
      matchPath: 'test/does-not-matter.t.sol',
      forgeBin: process.execPath,
      timeoutMs: 10_000,
      maxOutputBytes: 8 * 1024, // 8 KiB cap; the child writes ~2 MiB
    });
    assert.equal(result.truncated, true, 'must flag truncation when child exceeds the cap');
    // Cap is enforced BEFORE the truncation marker is appended, so the
    // captured stdout must be within a small constant slop of the cap.
    // (Give a generous ceiling to tolerate the trailing marker text.)
    assert.ok(
      result.stdout.length + result.stderr.length <= 8 * 1024 + 512,
      `combined output should be near the 8 KiB cap, got ${result.stdout.length + result.stderr.length}`,
    );
  } finally {
    delete process.env.TEST_FORGE_ARGS_JSON;
  }
});

test('runForgeTests ignores TEST_FORGE_ARGS_JSON when malformed', async () => {
  // Malformed JSON must fall back to real forge args — the injection
  // hatch is test-only and must fail closed. With a bogus forgeBin
  // and no real forge available, we can still assert the args override
  // is not silently used by pointing forgeBin at process.execPath and
  // asserting the runner spawns SOMETHING other than the hang script
  // (i.e. it uses the default args and errors out quickly).
  process.env.TEST_FORGE_ARGS_JSON = '{not valid json';
  try {
    const started = Date.now();
    const result = await runForgeTests({
      contractsDir: process.cwd(),
      matchPath: 'test/does-not-matter.t.sol',
      forgeBin: process.execPath,
      timeoutMs: 5_000,
    });
    const elapsed = Date.now() - started;
    // Node ran with the real forge args -> quickly failed (unknown
    // script `test`). Definitely not the 60s hang path.
    assert.ok(elapsed < 5_000, `malformed override must not hang (elapsed ${elapsed}ms)`);
    assert.equal(result.timedOut, false, 'malformed override should not trigger the hang path');
  } finally {
    delete process.env.TEST_FORGE_ARGS_JSON;
  }
});

test('runForgeTests: successful run cleans up the isolated work directory', async () => {
  // No override, no timeout — spawn a Node that exits with code 0
  // immediately. `runForgeTests` should return ok=false (forge test
  // not actually run) but the tempdir must be gone.
  process.env.TEST_FORGE_ARGS_JSON = JSON.stringify(['-e', 'process.exit(0)']);
  const before = await countTestDirs(tmpdir());
  try {
    const result = await runForgeTests({
      contractsDir: process.cwd(),
      matchPath: 'test/does-not-matter.t.sol',
      forgeBin: process.execPath,
      timeoutMs: 5_000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, false);
    const after = await countTestDirs(tmpdir());
    assert.equal(after, before, 'tempdir must be cleaned up on success');
  } finally {
    delete process.env.TEST_FORGE_ARGS_JSON;
  }
});

// -----------------------------------------------------------------------------
// SemaphoreCodes override — proves /test capacity failures are distinct
// -----------------------------------------------------------------------------

test('Semaphore honors the codes override so /test rejects with TEST_BUSY / TEST_QUEUE_TIMEOUT', async () => {
  const sem = new Semaphore(1, 1, 20, {
    busyCode: 'TEST_BUSY',
    timeoutCode: 'TEST_QUEUE_TIMEOUT',
  });
  let releaseFirst!: () => void;
  const first = sem.run(() => new Promise<void>((r) => { releaseFirst = r; }));
  while (sem.inFlight !== 1) await new Promise((r) => setTimeout(r, 1));

  const second = sem.run(async () => 2);
  while (sem.waiting !== 1) await new Promise((r) => setTimeout(r, 1));

  // Third caller: queue full -> TEST_BUSY (not COMPILE_BUSY).
  await assert.rejects(
    sem.run(async () => 3),
    (err: unknown) => (err as { code?: string }).code === 'TEST_BUSY',
  );

  // Second caller: queue wait exceeds 20ms -> TEST_QUEUE_TIMEOUT.
  await assert.rejects(second, (err: unknown) =>
    (err as { code?: string }).code === 'TEST_QUEUE_TIMEOUT',
  );

  releaseFirst();
  await first;
});

// -----------------------------------------------------------------------------
// default* helpers respect env overrides (matches parallel /compile suite)
// -----------------------------------------------------------------------------

test('defaultTestConcurrency defaults to 1 and honors TEST_MAX_CONCURRENCY', () => {
  const before = process.env.TEST_MAX_CONCURRENCY;
  try {
    delete process.env.TEST_MAX_CONCURRENCY;
    assert.equal(defaultTestConcurrency(), 1);
    process.env.TEST_MAX_CONCURRENCY = '3';
    assert.equal(defaultTestConcurrency(), 3);
    process.env.TEST_MAX_CONCURRENCY = 'garbage';
    assert.equal(defaultTestConcurrency(), 1);
  } finally {
    if (before === undefined) delete process.env.TEST_MAX_CONCURRENCY;
    else process.env.TEST_MAX_CONCURRENCY = before;
  }
});

test('defaultTestQueueLimit defaults to 4 and honors TEST_MAX_QUEUE', () => {
  const before = process.env.TEST_MAX_QUEUE;
  try {
    delete process.env.TEST_MAX_QUEUE;
    assert.equal(defaultTestQueueLimit(), 4);
    process.env.TEST_MAX_QUEUE = '2';
    assert.equal(defaultTestQueueLimit(), 2);
  } finally {
    if (before === undefined) delete process.env.TEST_MAX_QUEUE;
    else process.env.TEST_MAX_QUEUE = before;
  }
});

test('defaultTestQueueWaitMs defaults to 30000 and honors TEST_QUEUE_WAIT_MS', () => {
  const before = process.env.TEST_QUEUE_WAIT_MS;
  try {
    delete process.env.TEST_QUEUE_WAIT_MS;
    assert.equal(defaultTestQueueWaitMs(), 30_000);
    process.env.TEST_QUEUE_WAIT_MS = '5000';
    assert.equal(defaultTestQueueWaitMs(), 5_000);
  } finally {
    if (before === undefined) delete process.env.TEST_QUEUE_WAIT_MS;
    else process.env.TEST_QUEUE_WAIT_MS = before;
  }
});

test('defaultTestTimeoutMs defaults to 180000 and honors TEST_TIMEOUT_MS', () => {
  const before = process.env.TEST_TIMEOUT_MS;
  try {
    delete process.env.TEST_TIMEOUT_MS;
    assert.equal(defaultTestTimeoutMs(), 180_000);
    process.env.TEST_TIMEOUT_MS = '30000';
    assert.equal(defaultTestTimeoutMs(), 30_000);
  } finally {
    if (before === undefined) delete process.env.TEST_TIMEOUT_MS;
    else process.env.TEST_TIMEOUT_MS = before;
  }
});

test('defaultTestMaxOutputBytes defaults to 2 MiB and honors TEST_MAX_OUTPUT_BYTES', () => {
  const before = process.env.TEST_MAX_OUTPUT_BYTES;
  try {
    delete process.env.TEST_MAX_OUTPUT_BYTES;
    assert.equal(defaultTestMaxOutputBytes(), 2 * 1024 * 1024);
    process.env.TEST_MAX_OUTPUT_BYTES = '1048576';
    assert.equal(defaultTestMaxOutputBytes(), 1_048_576);
  } finally {
    if (before === undefined) delete process.env.TEST_MAX_OUTPUT_BYTES;
    else process.env.TEST_MAX_OUTPUT_BYTES = before;
  }
});

// -----------------------------------------------------------------------------
// Sanity: default runForgeTests still writes into `urufu-test-*` under tmpdir
// -----------------------------------------------------------------------------

test('runForgeTests uses the urufu-test- tempdir prefix (distinct from /compile)', async () => {
  process.env.TEST_FORGE_ARGS_JSON = JSON.stringify([
    '-e',
    'setTimeout(() => process.exit(0), 100)',
  ]);
  let peakTest = 0;
  let peakCompile = 0;
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const entries = await fsp.readdir(tmpdir()).catch(() => [] as string[]);
      let t = 0, c = 0;
      for (const e of entries) {
        if (e.startsWith('urufu-test-')) t += 1;
        if (e.startsWith('urufu-compile-')) c += 1;
      }
      peakTest = Math.max(peakTest, t);
      peakCompile = Math.max(peakCompile, c);
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  try {
    await runForgeTests({
      contractsDir: process.cwd(),
      matchPath: 'test/does-not-matter.t.sol',
      forgeBin: process.execPath,
      timeoutMs: 5_000,
    });
    // Give the poller one more tick.
    await new Promise((r) => setTimeout(r, 30));
    polling = false;
    await poller;
    assert.ok(peakTest >= 1, 'must observe at least one urufu-test-* tempdir during the run');
  } finally {
    polling = false;
    await poller;
    delete process.env.TEST_FORGE_ARGS_JSON;
  }
  void peakCompile; // reserved for future cross-pool separation checks
});
