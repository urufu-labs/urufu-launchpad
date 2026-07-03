import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

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
  ci?: boolean;
  /// Extra environment (e.g. RPC keys for fork tests). Merged over process.env.
  env?: Record<string, string>;
  /// Timeout in ms (default: 90s).
  timeoutMs?: number;
}

export interface TestRunResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  suites: TestSuite[];
}

/// Run `forge test` for a given match-path and return parsed results.
///
/// This shells out to the local `forge` binary. Caller must ensure `forge` is on PATH.
/// Prefers `--json` output for structured parsing; falls back to human-readable output if the
/// JSON parse fails (older forge versions used a different shape).
export async function runForgeTests(opts: TestRunOptions): Promise<TestRunResult> {
  const args = ['test', '--match-path', opts.matchPath, '--json'];
  const env = { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv;
  if (opts.ci) env['FOUNDRY_PROFILE'] = 'ci';

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const result = await new Promise<{ code: number }>((resolveP, rejectP) => {
    const proc = spawn('forge', args, {
      cwd: resolve(opts.contractsDir),
      env,
      windowsHide: true,
    });

    const timeout = setTimeout(
      () => {
        proc.kill('SIGKILL');
        rejectP(new Error(`forge test timeout after ${opts.timeoutMs ?? 90_000}ms`));
      },
      opts.timeoutMs ?? 90_000,
    );

    proc.stdout.on('data', (b: Buffer) => stdoutChunks.push(b));
    proc.stderr.on('data', (b: Buffer) => stderrChunks.push(b));
    proc.on('error', (e) => {
      clearTimeout(timeout);
      rejectP(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolveP({ code: code ?? -1 });
    });
  });

  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const stderr = Buffer.concat(stderrChunks).toString('utf8');

  const suites = parseForgeJson(stdout);
  return {
    ok: result.code === 0,
    exitCode: result.code,
    stdout,
    stderr,
    suites,
  };
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
