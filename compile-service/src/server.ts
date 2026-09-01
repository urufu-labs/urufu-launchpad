import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { canonicalModuleString } from '../../shared/config-id.ts';

import { CompileRequestSchema } from './types.ts';
import { loadMatrix } from './matrix.ts';
import { compose } from './compile.ts';
import { runForgeTests } from './test-runner.ts';
import { migrate, hasDb } from './db.ts';
import { registerSocialRoutes } from './routes/social.ts';
import { registerPinRoutes } from './routes/pin.ts';
import { registerNftAvatarRoutes } from './routes/nft-avatar.ts';
import { registerNftHoldersRoutes } from './routes/nft-holders.ts';
import { registerRewardsRoutes } from './routes/rewards.ts';
import { reconcilePendingPublications } from './rewards.ts';
import { startKeeper } from './keeper.ts';
import { registerWhitelistRoutes } from './routes/whitelist.ts';
import { registerNftDiscountAttestRoutes } from './routes/nft-discount-attest.ts';
import {
  Semaphore,
  defaultCompileConcurrency,
  defaultCompileQueueLimit,
  defaultCompileQueueWaitMs,
  defaultCompileTimeoutMs,
  defaultTestConcurrency,
  defaultTestMaxOutputBytes,
  defaultTestQueueLimit,
  defaultTestQueueWaitMs,
  defaultTestTimeoutMs,
  runIsolatedForgeBuild,
} from './isolated-build.ts';

// Compile service entrypoint. See docs/SPEC-compile-service.md.
// Endpoints:
//   POST /compile — validate config, splice, forge build, return artifacts.
//   POST /test    — merge test fragments, forge test, return per-test results.
//   GET  /health  — liveness.

// URL.pathname on Windows returns "/C:/..." with a leading slash which then
// makes path.resolve produce "C:\C:\..." (double-drive) on subsequent calls.
// `fileURLToPath` strips the leading slash + normalises separators. Matches
// the pattern already in composeSmoke.ts + db.ts.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MATRIX_PATH = resolve(REPO_ROOT, 'shared/matrix.json');
const CONTRACTS_DIR = resolve(REPO_ROOT, 'contracts');
const CONTRACTS_LIB_DIR = resolve(CONTRACTS_DIR, 'lib');

// URU-A14 page 10 additional-defect: bound concurrent Forge invocations.
// Forge is single-threaded per invocation and CPU-bound; unbounded fan-out
// from a public endpoint is a trivial resource-exhaustion vector. Default
// concurrency is min(2, cpus-1); operators can bump via COMPILE_MAX_CONCURRENCY.
//
// URU-P1-M05 (round 4): additionally bound the queue depth + per-caller
// wait so a distributed client cannot accumulate parked continuations +
// request bodies in memory while waiting for a slot, and bound Forge's
// wall-clock lifetime so a hung child can't pin its slot indefinitely.
const compileSemaphore = new Semaphore(
  defaultCompileConcurrency(),
  defaultCompileQueueLimit(),
  defaultCompileQueueWaitMs(),
);
const COMPILE_TIMEOUT_MS = defaultCompileTimeoutMs();
// URU-P1-M05: a well-formed /compile body is a few KB (base + module ids +
// small params map). Cap request bodies before JSON parsing so a hostile
// caller cannot make the process buffer megabytes on a rate-limited route.
const COMPILE_BODY_LIMIT_BYTES = Math.max(
  1,
  Number.parseInt(process.env.COMPILE_BODY_LIMIT_BYTES ?? '', 10) || 256 * 1024,
);

// Round-2 FINDING 2: /test admission controls. The previous /test
// handler bypassed EVERY guardrail on /compile — no semaphore, no
// wall-clock timeout, no output cap, no abort propagation, no
// per-route rate limit, no body-size cap — AND took its `ci` flag
// from an unauthenticated `x-vm-deep-test` header, so a public
// attacker could crank fuzz runs to 10_000 per case at will. The
// dedicated pool below lives alongside `compileSemaphore` (never
// shares slots) with lower concurrency + a shorter queue because
// each test run is heavier than a compile.
const testSemaphore = new Semaphore(
  defaultTestConcurrency(),
  defaultTestQueueLimit(),
  defaultTestQueueWaitMs(),
  { busyCode: 'TEST_BUSY', timeoutCode: 'TEST_QUEUE_TIMEOUT' },
);
const TEST_TIMEOUT_MS = defaultTestTimeoutMs();
const TEST_MAX_OUTPUT_BYTES = defaultTestMaxOutputBytes();
// Test bodies use the same schema as /compile so the same cap is
// appropriate. Kept as a distinct env knob so operators can tune
// them independently without one gate accidentally opening the other.
const TEST_BODY_LIMIT_BYTES = Math.max(
  1,
  Number.parseInt(process.env.TEST_BODY_LIMIT_BYTES ?? '', 10) || 256 * 1024,
);
// Round-2 FINDING 2 AC #4: `ci` (== FOUNDRY_PROFILE=ci, 10_000 fuzz
// runs per test) is now an OPERATOR gate, not a caller gate. Off by
// default; only turned on when ALLOW_DEEP_TESTS is set. Setting the
// old `x-vm-deep-test` header on a request no longer changes anything
// — the header is not read and has been removed from the CORS
// allow-list below.
const ALLOW_DEEP_TESTS = process.env.ALLOW_DEEP_TESTS === '1';

// URU-A14 page 10 additional-defect: run each request in an isolated tempdir
// (created + cleaned up per-request) instead of a shared contracts/tmp path.
// The workspace-wide dev path is preserved for local iteration but the public
// production surface must always take the isolated route.
const USE_ISOLATED_BUILD =
  process.env.NODE_ENV === 'production' || process.env.COMPILE_ISOLATED === '1';

// Default template for the ERC-20 base. Extend as other bases land.
const TEMPLATES: Record<string, string> = {
  ERC20: resolve(REPO_ROOT, 'contracts/src/templates/ERC20Template.sol'),
};

const app = Fastify({ logger: true });

await app.register(rateLimit, {
  max: 30,
  timeWindow: '1 minute',
});

// Permissive CORS — the frontend on Vercel needs to POST from a different origin.
// Rate limiting above bounds abuse; no cookies/credentials pass so a wide-open CORS
// posture is safe here.
app.addHook('onRequest', async (req, reply) => {
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
  // Round-2 FINDING 2 AC #4: `x-vm-deep-test` used to opt a request
  // into FOUNDRY_PROFILE=ci (10_000 fuzz runs). That path was a public
  // DoS vector and has been removed from the /test handler; drop the
  // header from the CORS allow-list too so no client believes it's a
  // supported knob.
  reply.header('access-control-allow-headers', 'content-type');
});
app.options('/*', async (_req, reply) => reply.code(204).send());

// Social / UGC routes (metadata, profile, chat) — backed by the Railway Postgres addon.
// Skipped silently when DATABASE_URL isn't set (local dev without a Postgres running).
if (hasDb()) {
  await migrate();
  // URU-A06: on boot, walk the rewards_publications journal and reconcile
  // anything left in `pending` / `broadcast` state (typically a tx that
  // confirmed while the process was down). Runs before route registration so
  // a fresh HTTP publish doesn't race the sweep.
  //
  // Round-2 audit FINDING 1 AC #1: reconcile no longer throws when it finds a
  // legitimately-pending on-chain proposal (any stage of the timelock
  // window) — it logs the state and returns, so boot proceeds. It still
  // throws for the "different root already landed at our epoch id"
  // conflict case; those legitimately require a human, and halting boot is
  // the loudest signal.
  try {
    await reconcilePendingPublications();
    app.log.info('rewards reconciliation complete');
  } catch (err) {
    app.log.error({ err }, 'rewards reconciliation failed — halting boot');
    throw err;
  }
  await registerSocialRoutes(app);
  app.log.info('social routes registered');
} else {
  app.log.warn('DATABASE_URL not set — /token/*/metadata + /profile/* + /token/*/chat disabled');
}

// Pinata proxy — server-side so the JWT stays out of the client bundle. Skipped when
// PINATA_JWT isn't set; the client falls back to the local-only metadata path.
await registerPinRoutes(app);

// Cross-chain NFT inventory for profile-avatar selection. This deliberately lives
// outside the social/Postgres gate: inventory is public read data and only needs the
// provider key, while the final profile choice remains signature-gated below.
await registerNftAvatarRoutes(app);

// Per-collection holders scan for the /collection/[address] page. Same
// public-read-data posture as nft-avatar; reuses ALCHEMY_API_KEY.
await registerNftHoldersRoutes(app);

// Whitelisted-curve snapshot endpoints — POST /wl/snapshot + GET /wl/proof. No
// Postgres dep (in-memory cache), no external API keys — works out of the box
// against RH's public RPC. Chain support is intentionally narrow (RH only) for v1.
await registerWhitelistRoutes(app);
await registerNftDiscountAttestRoutes(app);
app.log.info('wl snapshot routes registered');

// Flywheel rewards — public GETs for the claim UI, gated POST for publishing.
// Read-only endpoints work even without KEEPER_PRIVATE_KEY set (they only query
// on-chain + local Postgres); publishing 503s unless the trigger secret is set.
if (hasDb()) {
  await registerRewardsRoutes(app);
  app.log.info('rewards routes registered');
} else {
  app.log.warn('DATABASE_URL not set — /rewards/* disabled (Postgres required for tree storage)');
}

// Keeper background jobs (flywheel: sweep MHH → FeeSplitter every 60m,
// publish NFT holder epoch every 24h). Opt-in via KEEPER_ENABLED=true;
// otherwise no-op so local dev + PR previews don't touch prod state.
const keeperStatus = startKeeper();
if (keeperStatus.started.length > 0) {
  app.log.info({ started: keeperStatus.started, skipped: keeperStatus.skipped }, 'keeper loops started');
} else {
  app.log.info({ skipped: keeperStatus.skipped }, 'keeper not running');
}

app.post(
  '/compile',
  {
    // URU-P1-M05: bound the request body BEFORE JSON parsing so distributed
    // callers cannot consume memory while they sit in the compile queue.
    // 256 KB is enormous headroom for a config request.
    bodyLimit: COMPILE_BODY_LIMIT_BYTES,
    config: {
      // URU-A14 page 10 additional-defect: tighter per-IP rate limit than the
      // app-wide 30/min because /compile actually spawns Forge. Per-IP cap of
      // 5/min gives well-behaved launchers plenty of headroom (typical launch
      // flow does 1-2 compiles) while blocking a single client from
      // saturating the semaphore.
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  },
  async (request, reply) => {
  const parsed = CompileRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ code: 'INVALID_BODY', errors: parsed.error.flatten() });
  }
  const cfg = parsed.data;
  const defaultTemplate = TEMPLATES[cfg.base];
  if (!defaultTemplate) {
    return reply.code(400).send({ code: 'UNKNOWN_BASE', base: cfg.base });
  }

  // Input hardening (auditor Tier 4):
  //   - dedupe module list: a request with duplicated module IDs would splice
  //     each one N times, producing garbage bytecode with duplicated storage
  //     slots + duplicated event handlers.
  //   - canonicalize alphabetical order: on-chain module data is required to
  //     be alphabetical-by-id because each module's slice is decoded at a
  //     specific offset derived from that ordering. A launcher-supplied
  //     out-of-order list decodes every module's initData at the wrong slice
  //     boundary. Sort here BEFORE splicing so a well-formed frontend and a
  //     malformed direct caller both end up with the same canonical output.
  const dedupedModules = Array.from(new Set(cfg.modules));
  if (dedupedModules.length !== cfg.modules.length) {
    return reply.code(400).send({
      code: 'DUPLICATE_MODULES',
      message: 'modules list contains duplicates; each module id must appear at most once',
    });
  }
  const canonicalModules = [...dedupedModules].sort((a, b) => a.localeCompare(b));
  cfg.modules = canonicalModules;

  let composed;
  try {
    const matrix = loadMatrix(MATRIX_PATH);
    // Honor `templateOverride` on any selected module. Currently only Votes
    // declares one (needs ERC20VotesTemplate.sol for OZ checkpoint state
    // that can't be spliced in via fragments). Without this the /compile
    // path emits a "vote-enabled" event but the token has no delegate() /
    // getVotes() / checkpoint history — silent divergence from the
    // registered ERC20WithVotesGen impl.
    //
    // Enforce exclusivity: only ONE module in the set may declare an
    // override. If two conflict (Votes + hypothetical future module), we
    // reject explicitly rather than silently pick one.
    let templatePath = defaultTemplate;
    let overridingModule: string | null = null;
    for (const mid of cfg.modules) {
      const spec = matrix.modules[mid];
      if (!spec?.templateOverride) continue;
      if (overridingModule !== null) {
        return reply.code(400).send({
          code: 'TEMPLATE_OVERRIDE_CONFLICT',
          message: `${overridingModule} and ${mid} both declare templateOverride`,
        });
      }
      overridingModule = mid;
      templatePath = resolve(REPO_ROOT, spec.templateOverride);
    }

    // If an override took effect, the template file declares a DIFFERENT
    // base contract than `${cfg.base}Template` (e.g. ERC20VotesTemplate).
    // Derive that name from the override filename so compose()'s rename
    // step finds the right anchor.
    const baseContractName = overridingModule !== null ? basename(templatePath, '.sol') : undefined;

    composed = compose({
      matrix,
      config: { base: cfg.base, modules: cfg.modules, params: cfg.params as Record<string, Record<string, unknown>> },
      templatePath,
      contractName: composedName(cfg.base, cfg.modules),
      baseContractName,
      repoRoot: REPO_ROOT,
    });
  } catch (err) {
    return reply.code(400).send({ code: taxonomize(err), message: (err as Error).message });
  }

  // URU-A08: canonical ConfigId hash matches the on-chain formula exactly.
  // Old wider hash (base + modules + params + chain, JSON-serialized) is
  // replaced with `keccak256(abi.encode(base, canonicalModuleString(...)))`.
  const matrixForId = loadMatrix(MATRIX_PATH);
  const configHash = computeConfigHash(cfg, matrixForId);

  // URU-A14 page 10 additional-defect: bound concurrent Forge invocations to
  // avoid public-endpoint CPU exhaustion. Isolated builds also run inside a
  // fresh tempdir each so shared-output-path collisions cannot happen.
  //
  // URU-P1-M05: propagate an AbortSignal to the forge child so a client that
  // drops the connection mid-compile releases its semaphore slot immediately
  // rather than waiting for the wall-clock timeout to fire.
  let artifact: {
    abi: unknown;
    bytecode: { object: string };
    deployedBytecode: { object: string };
  };
  const abortController = new AbortController();
  const onAborted = () => abortController.abort();
  request.raw.once('aborted', onAborted);
  try {
    artifact = await compileSemaphore.run(async () => {
      if (USE_ISOLATED_BUILD) {
        return runIsolatedForgeBuild({
          source: composed.source,
          contractName: composed.contractName,
          libsDir: CONTRACTS_LIB_DIR,
          timeoutMs: COMPILE_TIMEOUT_MS,
          signal: abortController.signal,
        });
      }
      // Legacy path: workspace-wide build against contracts/. Kept for local
      // dev only (fast iteration when the whole src/ tree is already cached).
      // Still writes source through the isolated `tmp/<hash>/` scratch dir
      // and cleans it up in a finally.
      return runLegacyWorkspaceBuild(composed.contractName, composed.source, configHash);
    });
  } catch (err) {
    const e = err as { code?: string; message: string; stderr?: string };
    // URU-P1-M05: back-pressure. Queue full -> 503 + Retry-After; queue
    // wait blew past its ceiling -> also 503 so the client can retry once
    // load abates.
    if (e.code === 'COMPILE_BUSY' || e.code === 'COMPILE_QUEUE_TIMEOUT') {
      return reply
        .header('retry-after', '30')
        .code(503)
        .send({ code: e.code, configHash, message: e.message });
    }
    // URU-P1-M05: forge child exceeded its wall-clock ceiling. 504 signals
    // "gateway upstream timed out" so the client can distinguish this from
    // "compile itself failed cleanly".
    if (e.code === 'COMPILE_TIMEOUT') {
      return reply.code(504).send({
        code: e.code,
        configHash,
        message: e.message,
        stderr: e.stderr ?? '',
      });
    }
    // URU-P1-M05: client disconnected mid-compile. Reply is likely
    // unreachable but Fastify still requires a value; 503 keeps parity
    // with the busy/queue-timeout paths.
    if (e.code === 'COMPILE_ABORTED') {
      return reply.code(503).send({ code: e.code, configHash, message: e.message });
    }
    if (e.code === 'COMPILE_FAILED') {
      return reply.code(500).send({
        code: 'COMPILE_FAILED',
        configHash,
        stderr: e.stderr ?? '',
      });
    }
    if (e.code === 'ARTIFACT_MISSING') {
      return reply
        .code(500)
        .send({ code: 'ARTIFACT_MISSING', configHash, message: e.message });
    }
    request.log.error({ err }, 'compile handler unexpected failure');
    return reply.code(500).send({ code: 'INTERNAL', configHash, message: e.message });
  } finally {
    request.raw.off('aborted', onAborted);
  }

  // URU-P1-B01: factory pins `keccak256(impl.code)`, which is the deployed
  // RUNTIME bytecode — not the creation-bytecode buffer the launcher hands
  // to the deployer. The prior response hashed creation code and therefore
  // could never satisfy `ERC20Factory.registerImpl` (the pin/actual would
  // never match). We now compute both and expose `artifactHash` as a
  // backwards-compat alias for the runtime hash so existing manifest
  // consumers continue to work while the launcher migrates to the more
  // explicit `runtimeCodeHash` field.
  const creationCodeHash = keccak256(artifact.bytecode.object as Hex);
  const runtimeCodeHash = keccak256(artifact.deployedBytecode.object as Hex);
  return reply.send({
    configHash,
    // Backward-compatible alias: `artifactHash` now means runtime identity.
    artifactHash: runtimeCodeHash,
    creationCodeHash,
    runtimeCodeHash,
    contractName: composed.contractName,
    moduleIds: composed.moduleIds,
    bytecode: artifact.bytecode.object,
    runtimeBytecode: artifact.deployedBytecode.object,
    abi: artifact.abi,
    warnings: [],
  });
});

app.post(
  '/test',
  {
    // Round-2 FINDING 2 AC #5: bound the request body BEFORE JSON
    // parsing so a caller sitting in the /test queue can't consume
    // memory with a megabyte-scale body. Same 256 KiB default as
    // /compile — the request shape is identical (config object).
    bodyLimit: TEST_BODY_LIMIT_BYTES,
    config: {
      // Round-2 FINDING 2: /test spawns a heavier Forge child than
      // /compile (build + test + fuzz), so its per-IP rate limit is
      // TIGHTER — 3/min instead of /compile's 5/min. Combined with
      // the app-wide 30/min ceiling, a well-behaved launcher (which
      // typically runs a single test after each compile) still has
      // plenty of headroom while a single abusive client cannot
      // saturate the test semaphore.
      rateLimit: {
        max: 3,
        timeWindow: '1 minute',
      },
    },
  },
  async (request, reply) => {
    const parsed = CompileRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'INVALID_BODY', errors: parsed.error.flatten() });
    }
    const cfg = parsed.data;
    const composedContractName = composedName(cfg.base, cfg.modules);

    // Look for a hand-written test at `test/composed/<contractName>.t.sol`. Full test-fragment
    // merging (SPEC-compile-service §Merged test suite) is a follow-up — for now the frontend
    // wires a per-composition test file manually.
    const matchPath = `test/composed/${composedContractName}.t.sol`;

    // Round-2 FINDING 2: propagate an AbortSignal so a dropped HTTP
    // connection kills the Forge child immediately instead of pinning
    // the test semaphore slot until the wall-clock timeout fires.
    const abortController = new AbortController();
    const onAborted = () => abortController.abort();
    request.raw.once('aborted', onAborted);

    try {
      const result = await testSemaphore.run(() =>
        runForgeTests({
          contractsDir: CONTRACTS_DIR,
          matchPath,
          // Round-2 FINDING 2 AC #4: `ci` (10k fuzz per case) is an
          // OPERATOR gate — never a header. The old header path is
          // gone; setting it does nothing and it is no longer in the
          // CORS allow-list.
          ci: ALLOW_DEEP_TESTS,
          timeoutMs: TEST_TIMEOUT_MS,
          signal: abortController.signal,
          maxOutputBytes: TEST_MAX_OUTPUT_BYTES,
        }),
      );

      // Round-2 FINDING 2 AC #2: wall-clock timeout returns 504 so the
      // launcher client can distinguish "test itself failed cleanly"
      // (200 with ok=false + suites) from "the server killed the run
      // for taking too long".
      if (result.timedOut) {
        return reply.code(504).send({
          code: 'TEST_TIMEOUT',
          message: `forge test exceeded ${TEST_TIMEOUT_MS}ms`,
          stderr: result.stderr.slice(-4_000),
        });
      }
      // Round-2 FINDING 2 AC #3: client dropped mid-run. Reply is
      // probably unreachable but Fastify still requires we return
      // something; use Nginx's 499 (client closed request) so any
      // log-based dashboard classifies it correctly.
      if (result.aborted) {
        return reply.code(499).send({
          code: 'TEST_ABORTED',
          message: 'forge test aborted because the client disconnected',
        });
      }
      if (!result.ok && result.suites.length === 0) {
        return reply.code(500).send({
          code: 'TEST_HARNESS_FAILED',
          stderr: result.stderr.slice(-4_000),
        });
      }

      return reply.send({
        ok: result.ok,
        suites: result.suites,
        // Surface the truncation flag so a launcher UI can render a
        // "output truncated at 2 MiB" banner instead of silently
        // dropping the tail.
        truncated: result.truncated,
      });
    } catch (err) {
      const e = err as { code?: string; message: string };
      // Round-2 FINDING 2 AC #1: back-pressure. Queue full or wait
      // timeout -> 503 + Retry-After.
      if (e.code === 'TEST_BUSY' || e.code === 'TEST_QUEUE_TIMEOUT') {
        return reply
          .header('retry-after', '30')
          .code(503)
          .send({ code: e.code, message: e.message });
      }
      request.log.error({ err }, 'test handler unexpected failure');
      return reply.code(500).send({ code: 'INTERNAL', message: e.message });
    } finally {
      request.raw.off('aborted', onAborted);
    }
  },
);

app.get('/health', async () => ({ status: 'ok' }));

const port = Number(process.env.PORT ?? 3_001);
try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// =========================================================
// Helpers
// =========================================================

function composedName(base: string, modules: string[]): string {
  if (modules.length === 0) return `${base}Bare`;
  const sorted = [...modules].sort((a, b) => a.localeCompare(b));
  return `${base}With${sorted.join('And')}Gen`;
}

function computeConfigHash(cfg: {
  base: string;
  modules: string[];
}, matrix: ReturnType<typeof loadMatrix>): Hex {
  // URU-A08: matches on-chain formula exactly. Instance params + chain are
  // NOT part of identity — those are init data / deployment scope. Uses the
  // shared `canonicalModuleString` so a formula divergence between web +
  // compile-service is a compile-time import error, not a live-hash mismatch.
  const modules = canonicalModuleString(
    cfg.modules,
    (id) => matrix.modules[id]?.version,
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }],
      [cfg.base, modules],
    ),
  );
}

function taxonomize(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith('UNKNOWN_BASE:')) return 'UNKNOWN_BASE';
  if (msg.startsWith('UNKNOWN_MECHANIC:')) return 'UNKNOWN_MECHANIC';
  if (msg.startsWith('UNKNOWN_MODULE:')) return 'UNKNOWN_MODULE';
  if (msg.startsWith('MODULE_WRONG_BASE:')) return 'MODULE_WRONG_BASE';
  if (msg.startsWith('MODULE_MISSING_REQUIRES:')) return 'MODULE_MISSING_REQUIRES';
  if (msg.startsWith('MODULE_INCOMPATIBLE:')) return 'MODULE_INCOMPATIBLE';
  return 'INTERNAL';
}

async function runForge(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn('forge', args, { cwd, windowsHide: true });
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

/// Legacy dev-mode build path: writes into contracts/tmp/<hash>/ and invokes
/// forge against the whole contracts/ workspace. Retained per the audit
/// finding as an opt-in dev shortcut (fast iteration when the local cache is
/// hot), but the scratch dir is now removed in a `finally` block so a
/// long-lived dev session no longer bleeds disk. Production requests go
/// through `runIsolatedForgeBuild` instead — the isolated path is enforced
/// whenever NODE_ENV === 'production' or COMPILE_ISOLATED === '1'.
async function runLegacyWorkspaceBuild(
  contractName: string,
  source: string,
  configHash: string,
): Promise<{
  abi: unknown;
  bytecode: { object: string };
  deployedBytecode: { object: string };
}> {
  const outDir = resolve(CONTRACTS_DIR, 'tmp', configHash);
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${contractName}.sol`), source);

    const build = await runForge(['build', '--sizes'], CONTRACTS_DIR);
    if (build.code !== 0) {
      const err = new Error(`forge build exited ${build.code}`) as Error & {
        code: string;
        stderr: string;
      };
      err.code = 'COMPILE_FAILED';
      err.stderr = build.stderr.slice(-4_000);
      throw err;
    }

    const artifactPath = resolve(
      CONTRACTS_DIR,
      'out',
      `${contractName}.sol`,
      `${contractName}.json`,
    );
    try {
      return JSON.parse(readFileSync(artifactPath, 'utf8'));
    } catch (readErr) {
      const err = new Error((readErr as Error).message) as Error & { code: string };
      err.code = 'ARTIFACT_MISSING';
      throw err;
    }
  } finally {
    // URU-A14 page 10 additional-defect: cleanup on BOTH success and failure.
    // Best-effort — cleanup failures MUST NOT mask an earlier real error.
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}
