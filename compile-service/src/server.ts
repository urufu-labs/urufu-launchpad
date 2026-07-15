import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';

import { CompileRequestSchema } from './types.ts';
import { loadMatrix } from './matrix.ts';
import { compose } from './compile.ts';
import { runForgeTests } from './test-runner.ts';
import { migrate, hasDb } from './db.ts';
import { registerSocialRoutes } from './routes/social.ts';
import { registerPinRoutes } from './routes/pin.ts';
import { registerRewardsRoutes } from './routes/rewards.ts';

// Compile service entrypoint. See docs/SPEC-compile-service.md.
// Endpoints:
//   POST /compile — validate config, splice, forge build, return artifacts.
//   POST /test    — merge test fragments, forge test, return per-test results.
//   GET  /health  — liveness.

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
const MATRIX_PATH = resolve(REPO_ROOT, 'shared/matrix.json');
const CONTRACTS_DIR = resolve(REPO_ROOT, 'contracts');

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
  await registerSocialRoutes(app);
  app.log.info('social routes registered');
} else {
  app.log.warn('DATABASE_URL not set — /token/*/metadata + /profile/* + /token/*/chat disabled');
}

// Pinata proxy — server-side so the JWT stays out of the client bundle. Skipped when
// PINATA_JWT isn't set; the client falls back to the local-only metadata path.
await registerPinRoutes(app);

// Flywheel rewards — public GETs for the claim UI, gated POST for publishing.
// Read-only endpoints work even without KEEPER_PRIVATE_KEY set (they only query
// on-chain + local Postgres); publishing 503s unless the trigger secret is set.
if (hasDb()) {
  await registerRewardsRoutes(app);
  app.log.info('rewards routes registered');
} else {
  app.log.warn('DATABASE_URL not set — /rewards/* disabled (Postgres required for tree storage)');
}

app.post('/compile', async (request, reply) => {
  const parsed = CompileRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ code: 'INVALID_BODY', errors: parsed.error.flatten() });
  }
  const cfg = parsed.data;
  const templatePath = TEMPLATES[cfg.base];
  if (!templatePath) {
    return reply.code(400).send({ code: 'UNKNOWN_BASE', base: cfg.base });
  }

  let composed;
  try {
    const matrix = loadMatrix(MATRIX_PATH);
    composed = compose({
      matrix,
      config: { base: cfg.base, modules: cfg.modules, params: cfg.params as Record<string, Record<string, unknown>> },
      templatePath,
      contractName: composedName(cfg.base, cfg.modules),
      repoRoot: REPO_ROOT,
    });
  } catch (err) {
    return reply.code(400).send({ code: taxonomize(err), message: (err as Error).message });
  }

  const configHash = computeConfigHash(cfg);

  // Write spliced .sol to a tmp workspace under contracts/tmp/<hash>/ so it can be compiled
  // with forge alongside the existing src/ tree.
  const outDir = resolve(CONTRACTS_DIR, 'tmp', configHash);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${composed.contractName}.sol`);
  writeFileSync(outPath, composed.source);

  // Invoke forge build on the whole workspace.
  const build = await runForge(['build', '--sizes'], CONTRACTS_DIR);
  if (build.code !== 0) {
    return reply.code(500).send({
      code: 'COMPILE_FAILED',
      configHash,
      stderr: build.stderr.slice(-4_000), // last 4KB
    });
  }

  // Read the compiled artifact.
  const artifactPath = resolve(
    CONTRACTS_DIR,
    'out',
    `${composed.contractName}.sol`,
    `${composed.contractName}.json`,
  );
  let artifact: { abi: unknown; bytecode: { object: string } };
  try {
    artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch (err) {
    return reply
      .code(500)
      .send({ code: 'ARTIFACT_MISSING', configHash, message: (err as Error).message });
  }

  return reply.send({
    configHash,
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
  params: unknown;
  chain?: string;
}): string {
  const canonical = JSON.stringify({
    base: cfg.base,
    modules: [...cfg.modules].sort(),
    params: cfg.params,
    chain: cfg.chain ?? null,
  });
  const bytes = keccak_256(new TextEncoder().encode(canonical));
  return '0x' + Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
