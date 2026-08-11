import { join, resolve } from 'node:path';

import {
  defaultTestMaxOutputBytes,
  defaultTestTimeoutMs,
  spawnForge,
  withIsolatedWorkDir,
} from './isolated-build.ts';

export interface TestCase {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  gasUsed?: number;
  reason?: string; // failure message
}

export interface TestSuite {
  path: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs?: number;
  cases: TestCase[];
}

export interface TestRunOptions {
  /// Path to the repo's `contracts/` directory (where `forge` runs).
  contractsDir: string;
  /// Glob passed to forge --match-path (e.g. "test/composed/ERC20WithAntiBotGen.t.sol").
  matchPath: string;
  /// If true, use the CI profile (heavier fuzz + invariant budgets).
  ///
  /// Round-2 FINDING 2: the /test HTTP handler previously derived this
  /// from a caller-supplied header (`x-vm-deep-test`), letting a public
  /// attacker crank fuzz runs from 1k to 10k per test — a trivial DoS.
  /// The handler now defaults `ci` to false and only sets it true when
  /// the operator opts in via `ALLOW_DEEP_TESTS=1`. This flag stays on
  /// the runner API so internal callers (CLI, cron) can still request
  /// the heavy profile explicitly.
  ci?: boolean;
  /// Extra environment (e.g. RPC keys for fork tests). Merged over process.env.
  env?: Record<string, string>;
  /// Hard wall-clock ceiling for the `forge test` invocation. On expiry
  /// the child is SIGKILLed and the returned payload has `timedOut=true`.
  /// Defaults to `defaultTestTimeoutMs()` (180s).
  timeoutMs?: number;
  /// Aborts the `forge test` invocation when fired (e.g. HTTP client
  /// disconnected mid-run). SIGKILL sent to the child; returned payload
  /// has `aborted=true`. Callers that don't propagate a signal get the
  /// default behavior (only the wall-clock timeout can end the run).
  signal?: AbortSignal;
  /// Override the forge binary path — used by unit tests to inject a
  /// hanging Node one-liner for deterministic timeout/abort assertions
  /// without needing a real Forge on PATH.
  forgeBin?: string;
  /// Combined stdout+stderr byte ceiling. Defaults to
  /// `defaultTestMaxOutputBytes()` (2 MiB). Overshoots are dropped and
  /// the returned payload's `truncated` flag is set.
  maxOutputBytes?: number;
  /// Override the temp-directory base — same escape hatch as
  /// `runIsolatedForgeBuild`. Only useful for tests.
  baseDir?: string;
}

export interface TestRunResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  suites: TestSuite[];
  /// True when the wall-clock timeout SIGKILLed the child.
  timedOut: boolean;
  /// True when the supplied `signal` aborted the child.
  aborted: boolean;
  /// True when combined output exceeded `maxOutputBytes`.
  truncated: boolean;
}

/// Run `forge test` for a given match-path and return parsed results.
///
/// This shells out to the local `forge` binary. Caller must ensure `forge` is on PATH.
/// Prefers `--json` output for structured parsing; falls back to human-readable output if the
/// JSON parse fails (older forge versions used a different shape).
///
/// Round-2 FINDING 2 admission-control surface:
///   * A caller-supplied `AbortSignal` SIGKILLs the child mid-run so a
///     dropped HTTP connection immediately releases the /test
///     semaphore slot instead of hanging on to it for the full test
///     wall-clock ceiling.
///   * `timeoutMs` bounds the child's lifetime; on expiry the child is
///     SIGKILLed and `timedOut` is set on the returned payload so the
///     HTTP handler can return 504.
///   * Every invocation runs against a fresh isolated cache/output
///     directory (`FOUNDRY_CACHE_PATH` + `FOUNDRY_OUT` redirected into
///     an `mkdtemp`'d dir). The dir is removed in `finally` on success
///     AND on any failure (timeout, abort, spawn error) so a long-lived
///     service never leaks disk. Contract sources still resolve out of
///     the shared `contractsDir` (they're read-only for the test run).
///   * Combined stdout+stderr is capped at `maxOutputBytes` (default
///     2 MiB) so a chatty test run can't OOM the process.
export async function runForgeTests(opts: TestRunOptions): Promise<TestRunResult> {
  const contractsDir = resolve(opts.contractsDir);
  const forgeBin = opts.forgeBin ?? process.env.TEST_FORGE_BIN ?? 'forge';
  const timeoutMs = opts.timeoutMs ?? defaultTestTimeoutMs();
  const maxOutputBytes = opts.maxOutputBytes ?? defaultTestMaxOutputBytes();

  return withIsolatedWorkDir(
    async (workDir) => {
      // Redirect forge's write-heavy paths into the per-invocation
      // tempdir so concurrent (or back-to-back) runs never race on the
      // shared `contracts/cache/` and `contracts/out/`. Source lookup
      // still comes out of `contractsDir` (read-only for the test).
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...(opts.env ?? {}),
        FOUNDRY_CACHE_PATH: join(workDir, 'cache'),
        FOUNDRY_OUT: join(workDir, 'out'),
      };
      if (opts.ci) env.FOUNDRY_PROFILE = 'ci';

      // Test-only injection hatch: when TEST_FORGE_ARGS_JSON is set to
      // a JSON string-array, it REPLACES the normal forge args. The
      // smoke suite pairs this with TEST_FORGE_BIN=<node> and args
      // like `["-e", "setTimeout(()=>{},60_000)"]` to spawn a
      // guaranteed-hanging child so the timeout/abort/capacity ACs
      // don't have to rely on a real slow test run. Ignored (falls
      // back to the real forge args) unless both variables are set,
      // and the value must parse as a JSON string array.
      const args = parseArgsOverride(process.env.TEST_FORGE_ARGS_JSON) ??
        ['test', '--match-path', opts.matchPath, '--json'];
      const spawned = await spawnForge(
        forgeBin,
        args,
        timeoutMs,
        opts.signal,
        {
          cwd: contractsDir,
          env,
          maxOutputBytes,
        },
      );

      const suites = parseForgeJson(spawned.stdout);
      return {
        // `forge test` returns non-zero when any test case fails. The
        // /test HTTP layer still surfaces those as `ok: false` with
        // parsed per-case results — only a truly broken harness (empty
        // suites + non-zero exit) becomes a 500.
        ok: spawned.code === 0,
        exitCode: spawned.code,
        stdout: spawned.stdout,
        stderr: spawned.stderr,
        suites,
        timedOut: spawned.timedOut,
        aborted: spawned.aborted,
        truncated: spawned.truncated,
      };
    },
    { prefix: 'urufu-test-', baseDir: opts.baseDir },
  );
}

/// Parse the TEST_FORGE_ARGS_JSON test-injection env variable. Returns
/// undefined for any malformed / missing value so the runner falls back
/// to real forge args unconditionally in production (nothing sets this
/// variable there).
function parseArgsOverride(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed as string[];
    }
  } catch {
    // Malformed JSON — fall back to real forge args below.
  }
  return undefined;
}

/// Parse the JSON emitted by `forge test --json`. Structure varies by forge version so this
/// tries a couple of common shapes. Returns [] on failure — callers should check `ok` too.
export function parseForgeJson(raw: string): TestSuite[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const suites: TestSuite[] = [];
  // Common shape: { "<path>": { "test_results": { "<testName>": { status, decoded_logs, kind, ... } }, ... } }
  if (typeof parsed === 'object' && parsed !== null) {
    for (const [path, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof val !== 'object' || val === null) continue;
      const testResults = (val as { test_results?: Record<string, unknown> }).test_results;
      if (!testResults) continue;

      const cases: TestCase[] = [];
      let passed = 0;
      let failed = 0;
      let skipped = 0;

      for (const [testName, tr] of Object.entries(testResults)) {
        if (typeof tr !== 'object' || tr === null) continue;
        const status = (tr as { status?: string }).status?.toLowerCase() ?? 'unknown';
        const gasUsed =
          typeof (tr as { kind?: { Standard?: number } }).kind?.Standard === 'number'
            ? (tr as { kind: { Standard: number } }).kind.Standard
            : undefined;

        let normalized: TestCase['status'];
        if (status === 'success') {
          normalized = 'passed';
          passed++;
        } else if (status === 'skipped') {
          normalized = 'skipped';
          skipped++;
        } else {
          normalized = 'failed';
          failed++;
        }

        cases.push({
          name: testName,
          status: normalized,
          gasUsed,
          reason: (tr as { reason?: string }).reason,
        });
      }

      suites.push({ path, passed, failed, skipped, cases });
    }
  }
  return suites;
}
