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

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/// A fair FIFO semaphore. `run(fn)` acquires a slot, runs the callback, and
/// releases the slot even if the callback rejects. Queued callers wake up in
/// arrival order so long tails don't get starved.
export class Semaphore {
  readonly max: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isFinite(max) || max < 1) {
      throw new Error(`Semaphore: max must be >= 1, got ${max}`);
    }
    this.max = max;
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
      return () => this.release();
    }
    await new Promise<void>((resolveP) => this.queue.push(resolveP));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
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

/// Compute the default concurrency for Forge builds. Forge is single-threaded
/// per invocation and each invocation pins one CPU under `via_ir`; running
/// more than a handful in parallel on a Railway box just multiplies wall time.
/// `min(2, cpus - 1)` is safe on any host with 2+ cores; env override lets
/// operators bump it on a beefier deploy.
export function defaultCompileConcurrency(): number {
  const envRaw = process.env.COMPILE_MAX_CONCURRENCY;
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
  }
  const cores = cpus().length || 1;
  return Math.max(1, Math.min(2, cores - 1));
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
}

export interface BuildArtifact {
  abi: unknown;
  bytecode: { object: string };
}

export interface BuildError {
  code: 'COMPILE_FAILED' | 'ARTIFACT_MISSING';
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
      const build = await spawnForge(forgeBin, ['build', '--root', workDir]);
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

/// Wraps child_process.spawn for forge, buffering stdout+stderr. Kept
/// separate from server.ts's runForge so isolated-build has no dependency
/// on server internals (easier to unit-test in isolation).
async function spawnForge(
  forgeBin: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn(forgeBin, args, { windowsHide: true });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on('data', (b: Buffer) => outChunks.push(b));
    proc.stderr.on('data', (b: Buffer) => errChunks.push(b));
    proc.on('error', rejectP);
    proc.on('close', (code) =>
      resolveP({
        code: code ?? -1,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      }),
    );
  });
}
