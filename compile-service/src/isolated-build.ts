/// URU-A14 additional-defect page 10: public compile-service resource exhaustion.
///
/// The original /compile handler had three problems flagged by the auditor:
///
///   1. Persistent temporary source — each request wrote a .sol into
///      contracts/tmp/<hash>/ and never removed it. Disk grew unbounded.
///   2. Workspace-wide Forge build — `forge build` compiled the entire
///      contracts/src tree on every request, wasting CPU and giving concurrent
///      requests a shared cache directory that races on artifact writes.
///   3. Shared output paths — two concurrent requests that composed
///      contracts with the same short name would clobber each other's
///      out/<contractName>.sol/<contractName>.json before the first reader
///      got to it.
///
/// This module fixes all three:
///
///   * `withIsolatedWorkDir` creates a fresh directory under os.tmpdir(),
///     runs the caller's build function, and removes the directory in a
///     `finally` block regardless of success or failure.
///
///   * `runIsolatedForgeBuild` scaffolds a minimal Foundry project inside
///     that tempdir (its own foundry.toml + remappings.txt pointing at the
///     shared contracts/lib/), copies ONLY the composed .sol into src/,
///     and runs `forge build --root <tempdir>`. The build touches only the
///     one contract; the workspace src/ tree is not compiled.
///
///   * `Semaphore` caps the number of concurrent Forge invocations. Forge
///     is single-threaded per invocation and CPU-bound, so uncapped fan-out
///     from a public endpoint is trivial to abuse. Default `min(2, cpus-1)`,
///     overridable via COMPILE_MAX_CONCURRENCY.
///
/// URU-P1-M05 (round 4): the pre-existing Semaphore only bounded ACTIVE
/// work — a distributed client could still pile up an unbounded number of
/// queued Promise continuations (each holding its already-parsed request
/// body in memory) while waiting for a slot. The auditor also flagged
/// that a hung Forge child (import fetch hang, solc infinite loop) would
/// pin its slot indefinitely with nothing to reap it, and that an HTTP
/// client dropping the connection did not cancel its in-flight compile.
///
/// The revised module addresses all three:
///   * The Semaphore takes `(max, maxQueue, waitTimeoutMs)`; queued
///     callers reject with `COMPILE_BUSY` when the queue is full and
///     `COMPILE_QUEUE_TIMEOUT` after `waitTimeoutMs`.
///   * `runIsolatedForgeBuild` accepts a hard wall-clock `timeoutMs` and
///     an `AbortSignal`; either one kills the Forge child and surfaces
///     a `COMPILE_TIMEOUT` / `COMPILE_ABORTED` error.
///   * `releaseOnce()` makes the returned release callback idempotent so
///     a caller's double-release cannot corrupt the semaphore counter.

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/// A waiter parked in the semaphore's FIFO queue. The `timer` is the
/// wall-clock deadline for how long this caller is willing to wait; on
/// fire it evicts itself from the queue and rejects.
type QueueWaiter = {
  resolve: (release: () => void) => void;
  reject: (err: Error & { code: string }) => void;
  timer: NodeJS.Timeout;
};

/// Helper: `Error` decorated with a stable `code` string so the /compile
/// route can map the failure to an HTTP status without pattern-matching on
/// the message.
function capacityError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/// Optional overrides passed to the Semaphore constructor so distinct
/// pools (compile vs test) can surface distinct error codes.
///
/// Round-2 FINDING 2 (/test admission controls): the /test endpoint gets
/// its own Semaphore and needs its capacity/queue-timeout failures to
/// surface as TEST_BUSY / TEST_QUEUE_TIMEOUT rather than reusing the
/// COMPILE_* codes — the launcher client differentiates the two pools.
export interface SemaphoreCodes {
  busyCode?: string;
  timeoutCode?: string;
}

/// A fair FIFO semaphore with a bounded queue and bounded wait time.
///
/// Capping only the number of active Forge processes is insufficient: a
/// distributed client can otherwise accumulate an unbounded number of
/// Promise continuations and already-parsed request bodies in memory
/// while waiting. `maxQueue` bounds the parked-caller count;
/// `waitTimeoutMs` bounds each caller's wall-clock wait so a stuck queue
/// does not silently hold onto memory forever.
export class Semaphore {
  readonly max: number;
  readonly maxQueue: number;
  readonly waitTimeoutMs: number;
  readonly busyCode: string;
  readonly timeoutCode: string;
  private active = 0;
  private readonly queue: QueueWaiter[] = [];

  constructor(
    max: number,
    maxQueue = 16,
    waitTimeoutMs = 30_000,
    codes?: SemaphoreCodes,
  ) {
    if (!Number.isFinite(max) || max < 1) {
      throw new Error(`Semaphore: max must be >= 1, got ${max}`);
    }
    if (!Number.isFinite(maxQueue) || maxQueue < 0) {
      throw new Error(`Semaphore: maxQueue must be >= 0, got ${maxQueue}`);
    }
    if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 1) {
      throw new Error(`Semaphore: waitTimeoutMs must be >= 1, got ${waitTimeoutMs}`);
    }
    this.max = Math.floor(max);
    this.maxQueue = Math.floor(maxQueue);
    this.waitTimeoutMs = Math.floor(waitTimeoutMs);
    this.busyCode = codes?.busyCode ?? 'COMPILE_BUSY';
    this.timeoutCode = codes?.timeoutCode ?? 'COMPILE_QUEUE_TIMEOUT';
  }

  /// Number of callers currently holding a slot. Test-only.
  get inFlight(): number {
    return this.active;
  }

  /// Number of callers waiting for a slot. Test-only.
  get waiting(): number {
    return this.queue.length;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1;
      return this.releaseOnce();
    }
    if (this.queue.length >= this.maxQueue) {
      throw capacityError(
        this.busyCode,
        `queue full (${this.queue.length}/${this.maxQueue})`,
      );
    }

    return new Promise<() => void>((resolveP, rejectP) => {
      const waiter: QueueWaiter = {
        resolve: resolveP,
        reject: rejectP,
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) this.queue.splice(idx, 1);
          rejectP(
            capacityError(
              this.timeoutCode,
              `queue wait exceeded ${this.waitTimeoutMs}ms`,
            ),
          );
        }, this.waitTimeoutMs),
      };
      this.queue.push(waiter);
    });
  }

  /// Return a release-once closure. Callers that accidentally invoke the
  /// returned function twice (e.g. race between a manual release and a
  /// `finally` block) must not decrement the counter twice.
  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    if (this.active > 0) this.active -= 1;
    const next = this.queue.shift();
    if (!next) return;
    clearTimeout(next.timer);
    // Hand the slot directly to the next waiter — do not drop `active`
    // to zero and let another arrival slip in ahead of it.
    this.active += 1;
    next.resolve(this.releaseOnce());
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/// Parse a positive-integer env override; falls back on any non-numeric or
/// out-of-range value. Shared by the four `default*` helpers below so the
/// coercion rules stay consistent across concurrency, queue depth,
/// queue-wait, and forge-lifetime knobs.
function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

/// Compute the default concurrency for Forge builds. Forge is single-threaded
/// per invocation and each invocation pins one CPU under `via_ir`; running
/// more than a handful in parallel on a Railway box just multiplies wall time.
/// `min(2, cpus - 1)` is safe on any host with 2+ cores; env override lets
/// operators bump it on a beefier deploy.
export function defaultCompileConcurrency(): number {
  const cores = cpus().length || 1;
  return positiveEnvInt('COMPILE_MAX_CONCURRENCY', Math.max(1, Math.min(2, cores - 1)));
}

/// URU-P1-M05: maximum number of callers allowed to park on the compile
/// semaphore's queue. Rejects with `COMPILE_BUSY` beyond this limit so
/// a distributed client can't accumulate arbitrary parked Promise
/// continuations + request bodies in memory.
export function defaultCompileQueueLimit(): number {
  return positiveEnvInt('COMPILE_MAX_QUEUE', 16);
}

/// URU-P1-M05: per-caller wall-clock wait ceiling for the compile
/// semaphore. Queued callers reject with `COMPILE_QUEUE_TIMEOUT` after
/// this many ms so a stuck queue can't silently hold memory forever.
export function defaultCompileQueueWaitMs(): number {
  return positiveEnvInt('COMPILE_QUEUE_WAIT_MS', 30_000);
}

/// URU-P1-M05: hard wall-clock ceiling for a single Forge child process.
/// A hung compile (import fetch hang, solc pathological input) is killed
/// with SIGKILL after this many ms and surfaces as `COMPILE_TIMEOUT` so
/// the semaphore slot is reclaimed for the next request.
export function defaultCompileTimeoutMs(): number {
  return positiveEnvInt('COMPILE_TIMEOUT_MS', 120_000);
}

// -----------------------------------------------------------------------------
// Round-2 FINDING 2 (/test admission controls)
// -----------------------------------------------------------------------------
// Test builds are considerably more expensive than compile builds:
// `forge test` under the CI profile runs 10_000 fuzz iterations PER
// case and needs to build the full contracts/ tree first. Left
// unbounded, a public /test endpoint is a trivial DoS on the box —
// which is exactly what the earlier audit round flagged. The knobs
// below scale each admission-control lever DOWN from its /compile
// equivalent (concurrency 1, smaller queue, longer per-run wall-clock)
// so a single stuck /test cannot starve /compile or eat the process.

/// Concurrency cap for /test. Defaults to 1 — a single test run is
/// heavy enough that overlap on a Railway box costs more wall time
/// than it saves.
export function defaultTestConcurrency(): number {
  return positiveEnvInt('TEST_MAX_CONCURRENCY', 1);
}

/// Queue depth for /test. Deliberately shorter than /compile's 16 —
/// tests are slower to drain, so a longer queue would just deepen the
/// wait for callers that will retry anyway.
export function defaultTestQueueLimit(): number {
  return positiveEnvInt('TEST_MAX_QUEUE', 4);
}

/// Per-caller wall-clock wait ceiling before a queued /test caller is
/// evicted with TEST_QUEUE_TIMEOUT. Matches /compile's default (30s).
export function defaultTestQueueWaitMs(): number {
  return positiveEnvInt('TEST_QUEUE_WAIT_MS', 30_000);
}

/// Hard wall-clock ceiling for a single `forge test` invocation. A hung
/// or runaway fuzz run is SIGKILLed after this many ms and surfaces as
/// TEST_TIMEOUT so the semaphore slot is reclaimed for the next call.
/// Defaults higher than /compile because `forge test` also runs a
/// build step before executing cases.
export function defaultTestTimeoutMs(): number {
  return positiveEnvInt('TEST_TIMEOUT_MS', 180_000);
}

/// Combined stdout+stderr byte ceiling for a single `forge test`
/// invocation. Once exceeded, subsequent chunks are dropped and the
/// returned payload's `truncated` flag is set. 2 MiB is well above
/// what a normal test run emits but low enough that a runaway
/// `console.log` fuzz case can't OOM the process. Environment
/// override supports beefier deploys.
export function defaultTestMaxOutputBytes(): number {
  return positiveEnvInt('TEST_MAX_OUTPUT_BYTES', 2 * 1024 * 1024);
}

/// Run `runBuild` inside a fresh workDir under `baseDir` (default os.tmpdir()).
/// Guarantees cleanup on both success and failure. Cleanup failures are
/// swallowed so they don't mask the caller's error.
export async function withIsolatedWorkDir<T>(
  runBuild: (workDir: string) => Promise<T>,
  opts: { prefix?: string; baseDir?: string } = {},
): Promise<T> {
  const base = opts.baseDir ?? tmpdir();
  const prefix = opts.prefix ?? 'urufu-compile-';
  const workDir = await fsp.mkdtemp(join(base, prefix));
  try {
    return await runBuild(workDir);
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {
      // Cleanup failure MUST NOT mask the real error. Best-effort only.
    });
  }
}

// -----------------------------------------------------------------------------
// Foundry scaffolding
// -----------------------------------------------------------------------------

/// Build a minimal foundry.toml that points at the SHARED contracts/lib/
/// directory (via absolute path) so each isolated build reuses the checked-out
/// dependencies rather than downloading them. Compiler flags mirror
/// contracts/foundry.toml's `[profile.default]` because the composed artifact
/// must be bytecode-identical whether built in-repo or in isolation.
export function isolatedFoundryToml(libsDir: string): string {
  const libs = JSON.stringify(resolve(libsDir));
  return `[profile.default]
src = "src"
out = "out"
libs = [${libs}]
cache_path = "cache"

solc_version = "0.8.26"
evm_version = "cancun"
optimizer = true
optimizer_runs = 10_000
via_ir = true

[profile.clone]
optimizer_runs = 200
via_ir = true
`;
}

/// Remappings that mirror contracts/remappings.txt but with absolute lib
/// paths so they resolve from any working directory. Kept in sync manually
/// with contracts/remappings.txt; drift will cause an isolated build to
/// fail with UnresolvedImport, which is caught by the semaphore-tests we
/// ship for the endpoint.
export function isolatedRemappings(libsDir: string): string {
  const base = resolve(libsDir);
  return [
    `forge-std/=${base}/forge-std/src/`,
    `@openzeppelin/contracts/=${base}/openzeppelin-contracts/contracts/`,
    `@openzeppelin/contracts-upgradeable/=${base}/openzeppelin-contracts-upgradeable/contracts/`,
    `solady/=${base}/solady/src/`,
    `erc721a/=${base}/ERC721A/contracts/`,
    `v4-core/=${base}/v4-core/src/`,
    `v4-periphery/=${base}/v4-periphery/src/`,
    `@uniswap/v4-core/src/=${base}/v4-core/src/`,
    `@uniswap/v4-core/=${base}/v4-core/`,
    `@uniswap/v4-periphery/=${base}/v4-periphery/`,
    '',
  ].join('\n');
}

// -----------------------------------------------------------------------------
// Isolated forge build
// -----------------------------------------------------------------------------

export interface BuildRequest {
  source: string;
  contractName: string;
  /// Absolute path to contracts/lib.
  libsDir: string;
  /// Optional override for the tempdir base (defaults to os.tmpdir()).
  baseDir?: string;
  /// Optional override for the forge binary path (defaults to `forge`).
  forgeBin?: string;
  /// URU-P1-M05: hard wall-clock ceiling for the forge child process.
  /// Falls back on `defaultCompileTimeoutMs()`.
  timeoutMs?: number;
  /// URU-P1-M05: aborts the forge child when fired (e.g. HTTP client
  /// disconnected before the compile finished).
  signal?: AbortSignal;
}

export interface BuildArtifact {
  abi: unknown;
  /// Creation (constructor + runtime) bytecode. Deployed via factory
  /// clones as the `impl` payload, so callers may hash this for a
  /// creation-code identity — but the factory verifies against the
  /// RUNTIME hash (see below).
  bytecode: { object: string };
  /// URU-P1-B01: deployed runtime bytecode. `keccak256(address.code)` on
  /// a deployed impl equals `keccak256(this.object)`, which is the value
  /// `ERC20Factory.setExpectedCodeHash` must be pinned to. The prior
  /// response omitted this field and hashed creation bytecode, so
  /// pin-and-register could never succeed.
  deployedBytecode: { object: string };
}

export interface BuildError {
  code:
    | 'COMPILE_FAILED'
    | 'COMPILE_TIMEOUT'
    | 'COMPILE_ABORTED'
    | 'ARTIFACT_MISSING';
  message: string;
  stderr?: string;
}

/// Scaffold + run + read + cleanup. Any failure path removes the tempdir.
/// Callers should wrap this in the module's `Semaphore` to bound concurrency.
export async function runIsolatedForgeBuild(req: BuildRequest): Promise<BuildArtifact> {
  return withIsolatedWorkDir(
    async (workDir) => {
      // Scaffold: foundry.toml + remappings.txt + src/<contractName>.sol.
      // We intentionally do NOT copy contracts/src/* — the composed source is
      // self-contained (all its imports resolve via the shared lib/ dir),
      // so limiting the src tree to a single file caps the compile budget
      // to exactly what this request needs.
      await fsp.mkdir(join(workDir, 'src'), { recursive: true });
      await Promise.all([
        fsp.writeFile(join(workDir, 'src', `${req.contractName}.sol`), req.source),
        fsp.writeFile(join(workDir, 'foundry.toml'), isolatedFoundryToml(req.libsDir)),
        fsp.writeFile(join(workDir, 'remappings.txt'), isolatedRemappings(req.libsDir)),
      ]);

      const forgeBin = req.forgeBin ?? 'forge';
      const timeoutMs = req.timeoutMs ?? defaultCompileTimeoutMs();
      const build = await spawnForge(
        forgeBin,
        ['build', '--root', workDir],
        timeoutMs,
        req.signal,
      );
      if (build.timedOut) {
        const err: BuildError = {
          code: 'COMPILE_TIMEOUT',
          message: `forge build exceeded ${timeoutMs}ms`,
          stderr: build.stderr.slice(-4_000),
        };
        throw Object.assign(new Error(err.message), err);
      }
      if (build.aborted) {
        const err: BuildError = {
          code: 'COMPILE_ABORTED',
          message: 'forge build aborted because the client disconnected',
          stderr: build.stderr.slice(-4_000),
        };
        throw Object.assign(new Error(err.message), err);
      }
      if (build.code !== 0) {
        const err: BuildError = {
          code: 'COMPILE_FAILED',
          message: `forge build exited ${build.code}`,
          stderr: build.stderr.slice(-4_000),
        };
        throw Object.assign(new Error(err.message), err);
      }

      const artifactPath = join(
        workDir,
        'out',
        `${req.contractName}.sol`,
        `${req.contractName}.json`,
      );
      let raw: string;
      try {
        raw = await fsp.readFile(artifactPath, 'utf8');
      } catch (readErr) {
        const err: BuildError = {
          code: 'ARTIFACT_MISSING',
          message: (readErr as Error).message,
        };
        throw Object.assign(new Error(err.message), err);
      }
      return JSON.parse(raw) as BuildArtifact;
    },
    { baseDir: req.baseDir },
  );
}

/// Options passed to `spawnForge`. Only `forgeBin`, `args`, and
/// `timeoutMs` are load-bearing — the rest are used by callers with
/// specific needs (e.g. `/test` runs forge inside `contracts/` so it
/// passes `cwd`; the test runner also needs `FOUNDRY_PROFILE` merged
/// through, so it passes `env`; both paths cap output via
/// `maxOutputBytes` to bound memory pressure from chatty forge runs).
export interface SpawnForgeOptions {
  /// Working directory for the forge child. Default: undefined (inherit
  /// parent process cwd).
  cwd?: string;
  /// Full environment for the forge child. Callers that need
  /// `FOUNDRY_PROFILE=ci` or repointed `FOUNDRY_CACHE_PATH` etc pass a
  /// pre-merged env here. Default: undefined (inherit parent env).
  env?: NodeJS.ProcessEnv;
  /// Combined stdout+stderr byte ceiling. Once exceeded, subsequent
  /// chunks are dropped and the returned payload's `truncated` flag is
  /// set. A trailing marker is appended to the returned strings so a
  /// log reader can see where the cutoff happened. Default: unbounded
  /// (backwards-compatible with the pre-Round-2 /compile path, which
  /// already runs behind a queue + timeout).
  maxOutputBytes?: number;
}

/// Wraps child_process.spawn for forge, buffering stdout+stderr. Kept
/// separate from server.ts's runForge so isolated-build has no dependency
/// on server internals (easier to unit-test in isolation).
///
/// URU-P1-M05: `timeoutMs` bounds wall-clock lifetime; `signal` cancels
/// on HTTP client disconnect. Either one SIGKILLs the child and surfaces
/// via `timedOut` / `aborted` in the resolved payload so the caller can
/// return a distinct HTTP status (504 vs 503) without message-parsing.
///
/// Round-2 FINDING 2: `spawnOpts` now carries optional `cwd`, `env`, and
/// `maxOutputBytes`. `/test` needs cwd=contracts/, `env` for
/// FOUNDRY_PROFILE, and the output cap so a chatty test run can't OOM
/// the process. Kept as a trailing options bag so existing /compile
/// callers (positional) are unaffected.
///
/// Exported so the unit tests can drive it with a hanging fake `forgeBin`
/// (a Node one-liner) to prove SIGKILL fires on both timeout and abort.
export async function spawnForge(
  forgeBin: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  spawnOpts?: SpawnForgeOptions,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /// True when combined stdout+stderr exceeded `maxOutputBytes` and one
  /// or more chunks were dropped. Trailing truncation marker is appended
  /// to whichever stream tripped the limit.
  truncated: boolean;
}> {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn(forgeBin, args, {
      windowsHide: true,
      cwd: spawnOpts?.cwd,
      env: spawnOpts?.env,
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const maxBytes = spawnOpts?.maxOutputBytes;
    let totalBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    // Split the cap across streams by tracking a shared budget: once
    // combined stdout+stderr crosses `maxBytes`, extra chunks are
    // dropped and `truncated` is set. Preserves whatever was captured
    // BEFORE the cap so error messages remain useful.
    const pushCapped = (bucket: Buffer[], chunk: Buffer): void => {
      if (maxBytes === undefined) {
        bucket.push(chunk);
        return;
      }
      const remaining = maxBytes - totalBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length <= remaining) {
        bucket.push(chunk);
        totalBytes += chunk.length;
        return;
      }
      bucket.push(chunk.subarray(0, remaining));
      totalBytes += remaining;
      truncated = true;
    };

    const truncationMarker = `\n[truncated: combined output exceeded ${maxBytes ?? 0} bytes]\n`;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      let stdout = Buffer.concat(outChunks).toString('utf8');
      let stderr = Buffer.concat(errChunks).toString('utf8');
      if (truncated) {
        // Append the marker to whichever stream was non-empty; prefer
        // stderr so it's visible to error handlers even when stdout was
        // the noisy stream.
        if (stderr.length > 0) stderr += truncationMarker;
        else stdout += truncationMarker;
      }
      resolveP({
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
        aborted,
        truncated,
      });
    };
    const onAbort = () => {
      aborted = true;
      // SIGKILL rather than SIGTERM — forge under via_ir can ignore a
      // graceful signal for tens of seconds while solc finishes a pass.
      try { proc.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* already exited */ }
    }, timeoutMs);

    proc.stdout.on('data', (b: Buffer) => pushCapped(outChunks, b));
    proc.stderr.on('data', (b: Buffer) => pushCapped(errChunks, b));
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectP(err);
    });
    proc.on('close', finish);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}
