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
import { registerRewardsRoutes } from './routes/rewards.ts';
import { reconcilePendingPublications } from './rewards.ts';
import { startKeeper } from './keeper.ts';
import { registerWhitelistRoutes } from './routes/whitelist.ts';
import {
  Semaphore,
  defaultCompileConcurrency,
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
const compileSemaphore = new Semaphore(defaultCompileConcurrency());

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
  reply.header('access-control-allow-headers', 'content-type, x-vm-deep-test');
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

// Whitelisted-curve snapshot endpoints — POST /wl/snapshot + GET /wl/proof. No
// Postgres dep (in-memory cache), no external API keys — works out of the box
// against RH's public RPC. Chain support is intentionally narrow (RH only) for v1.
await registerWhitelistRoutes(app);
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
  let artifact: { abi: unknown; bytecode: { object: string } };
  try {
    artifact = await compileSemaphore.run(async () => {
      if (USE_ISOLATED_BUILD) {
        return runIsolatedForgeBuild({
          source: composed.source,
          contractName: composed.contractName,
          libsDir: CONTRACTS_LIB_DIR,
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
  }

  // URU-A08: artifact identity separate from config identity.
  const artifactHash = keccak256(artifact.bytecode.object as Hex);
  return reply.send({
    configHash,
    artifactHash,
    contractName: composed.contractName,
    moduleIds: composed.moduleIds,
    bytecode: artifact.bytecode.object,
    abi: artifact.abi,
    warnings: [],
  });
});

app.post('/test', async (request, reply) => {
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

  const result = await runForgeTests({
    contractsDir: CONTRACTS_DIR,
    matchPath,
    ci: request.headers['x-vm-deep-test'] === '1',
  });

  if (!result.ok && result.suites.length === 0) {
    return reply.code(500).send({
      code: 'TEST_HARNESS_FAILED',
      stderr: result.stderr.slice(-4_000),
    });
  }

  return reply.send({
    ok: result.ok,
    suites: result.suites,
  });
});

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
): Promise<{ abi: unknown; bytecode: { object: string } }> {
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
