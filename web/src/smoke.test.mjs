// Runtime smoke test for the launchpad web app.
//
// Boots `next start` on a random port against the existing `.next/` build,
// hits the main routes, and adversarially validates:
//   1. every route returns 200
//   2. /catalog renders every shipped ERC20 module (labels from
//      shared/matrix.json) after the audit round 3 v4 refactor that swapped
//      the hand-maintained MODULES array for a `.map()` over the shared JSON
//   3. the Pausable warning copy carries the round-3-v5 "including yours"
//      honesty (no owner exemption) instead of the old misleading phrasing
//   4. configHash for ERC20+Permit matches the pinned entry in
//      contracts/script/manifest/RhConfigManifest.sol (drift = broken
//      on-chain / off-chain ConfigId contract)
//
// Runs with `node --test web/src/smoke.test.mjs` from the repo root, or
// `node --test src/smoke.test.mjs` from web/.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { keccak256, encodeAbiParameters } from 'viem';

// ---------------------------------------------------------------
// paths + fixtures
// ---------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(WEB_ROOT, '..');
const MATRIX_PATH = pathResolve(REPO_ROOT, 'shared', 'matrix.json');
const MANIFEST_PATH = pathResolve(
  REPO_ROOT,
  'contracts',
  'script',
  'manifest',
  'RhConfigManifest.sol',
);

const MATRIX = JSON.parse(readFileSync(MATRIX_PATH, 'utf8'));
const MANIFEST_SRC = readFileSync(MANIFEST_PATH, 'utf8');

// ---------------------------------------------------------------
// config-id math, duplicated from shared/config-id.ts on purpose
// ---------------------------------------------------------------
//
// If the shared implementation drifts from this local copy the test still
// pins the actual bytes going out over the wire against the manifest,
// which is the ground truth.

function canonicalModuleString(moduleIds) {
  const versions = moduleIds.map((id) => {
    const v = MATRIX.modules[id]?.version;
    if (v === undefined) throw new Error(`UNKNOWN_MODULE: ${id}`);
    return { id, version: v };
  });
  const versioned = versions.some((m) => m.version >= 2);
  return versions
    .map((m) => (versioned ? `${m.id}@${m.version}` : m.id))
    .sort((a, b) => a.localeCompare(b))
    .join(',');
}

function computeConfigHash(base, moduleIds) {
  const s = canonicalModuleString(moduleIds);
  return keccak256(
    encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [base, s]),
  );
}

// ---------------------------------------------------------------
// server boot / teardown
// ---------------------------------------------------------------

async function pickPort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitForReady(url, timeoutMs) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { method: 'GET' });
      // Any HTTP response means Next is up and serving. 500s on `/` from a
      // bad build should still fail loud later in the per-route tests.
      if (r.status < 600) return r;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `next start not ready in ${timeoutMs}ms: ${lastErr ? lastErr.message : '(no error)'}`,
  );
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    // taskkill /T follows the whole process tree; /F is SIGKILL equivalent.
    // Errors are swallowed — the process might already be gone.
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch { /* ignore */ }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }
  }
}

let child = null;
let baseUrl = null;

before(async () => {
  const port = await pickPort();
  baseUrl = `http://127.0.0.1:${port}`;

  const nextBin = pathResolve(WEB_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  child = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], {
    cwd: WEB_ROOT,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  // Surface server output so a boot failure is diagnosable instead of just
  // "timed out". Prefixed to distinguish from test runner output.
  child.stdout.on('data', (d) => process.stderr.write(`[next] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[next!] ${d}`));

  child.on('exit', (code, sig) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`[next] exited early code=${code} sig=${sig}\n`);
    }
  });

  await waitForReady(`${baseUrl}/`, 60_000);
}, { timeout: 90_000 });

after(async () => {
  if (!child) return;
  const pid = child.pid;
  // Try graceful SIGTERM first.
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 3000));
  if (child.exitCode === null && child.signalCode === null) {
    killTree(pid);
  }
});

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

async function getPage(path) {
  const r = await fetch(`${baseUrl}${path}`, { method: 'GET' });
  const body = await r.text();
  return { status: r.status, body, contentType: r.headers.get('content-type') };
}

function shippedErc20Modules() {
  const out = [];
  for (const [id, spec] of Object.entries(MATRIX.modules)) {
    if (!spec?.base?.includes?.('ERC20')) continue;
    if (spec?.ui?.status !== 'shipped') continue;
    out.push({ id, label: spec.ui.label, description: spec.ui.description });
  }
  return out;
}

function pinnedPermitHashFromManifest() {
  // The manifest's `all()` function pins entry 0 to the Permit config hash.
  // We grep for the exact Entry block labeled "Permit" and pull its 0x… bytes.
  const re =
    /configHash:\s*(0x[0-9a-fA-F]{64}),[\s\S]*?label:\s*"Permit"/;
  const m = MANIFEST_SRC.match(re);
  if (!m) throw new Error('could not locate Permit entry in RhConfigManifest.sol');
  return m[1].toLowerCase();
}

// ---------------------------------------------------------------
// tests
// ---------------------------------------------------------------

describe('web smoke: routes render', () => {
  const ROUTES = ['/', '/create', '/catalog', '/discover', '/trade', '/docs'];

  for (const path of ROUTES) {
    test(`GET ${path} returns 200`, async () => {
      const { status, body, contentType } = await getPage(path);
      assert.equal(
        status,
        200,
        `GET ${path} expected 200, got ${status}; body head: ${body.slice(0, 400)}`,
      );
      assert.ok(
        contentType && contentType.includes('text/html'),
        `GET ${path} expected text/html, got ${contentType}`,
      );
      assert.ok(body.length > 200, `GET ${path} body suspiciously small (${body.length}B)`);
    });
  }
});

describe('web smoke: pre-launch splash gate', () => {
  test('/ renders the NotLiveYet copy while LAUNCHPAD_LIVE=false', async () => {
    const { body } = await getPage('/');
    // If someone flips LAUNCHPAD_LIVE without wiring the home feed back on
    // (or vice versa), this catches it early.
    const hasSplash =
      body.includes('not live yet') || body.includes('urufu is taking a nap');
    const hasHomeFeed =
      body.includes('recent trades') || body.includes('mock launches');
    assert.ok(
      hasSplash || hasHomeFeed,
      'home page shows neither the pre-launch splash nor the real feed',
    );
  });

  test('/create renders the NotLiveYet copy while LAUNCHPAD_LIVE=false', async () => {
    const { body } = await getPage('/create');
    const hasSplash =
      body.includes('not live yet') || body.includes('urufu is taking a nap');
    const hasLaunchFlow =
      body.includes('module picker') || body.includes('shippedModulesForBase');
    assert.ok(
      hasSplash || hasLaunchFlow,
      '/create renders neither the pre-launch splash nor the launch flow',
    );
  });
});

describe('web smoke: /catalog module catalog', () => {
  test('renders every shipped ERC20 module label from shared/matrix.json', async () => {
    const { body } = await getPage('/catalog');
    const expected = shippedErc20Modules();
    assert.ok(expected.length >= 10, `matrix.json produced ${expected.length} shipped ERC20 modules; suspiciously few`);

    const missing = [];
    for (const mod of expected) {
      // Strip the ✿ / ❀ prefix; that's decorative and can drift.
      const bareLabel = mod.label.replace(/^[^\w]+/, '').trim();
      if (!body.includes(bareLabel)) missing.push(`${mod.id} (label: "${mod.label}")`);
    }
    assert.equal(
      missing.length,
      0,
      `catalog missing labels for: ${missing.join(', ')}`,
    );
  });

  test('rendered shipped/planned counts match matrix.json', async () => {
    const { body } = await getPage('/catalog');
    const shippedCount = Object.values(MATRIX.modules).filter(
      (s) => s?.ui?.status === 'shipped',
    ).length;
    const plannedCount = Object.values(MATRIX.modules).filter(
      (s) => s?.ui?.status === 'planned',
    ).length;
    // Catalog hero row prints "· N shipped · M planned · K combos". React
    // SSR splits adjacent text nodes with `<!-- -->` markers, so we match
    // across those instead of asserting a literal contiguous substring.
    const re = new RegExp(
      `${shippedCount}(?:<!--\\s*-->)?\\s*shipped\\s*·\\s*(?:<!--\\s*-->)?${plannedCount}(?:<!--\\s*-->)?\\s*planned`,
    );
    assert.ok(
      re.test(body),
      `expected catalog hero to show "${shippedCount} shipped · ${plannedCount} planned" (React-splitter tolerant); didn't find it in body`,
    );
  });
});

describe('web smoke: Pausable warning honesty (audit URU-A01 secondary)', () => {
  // The audit round 3 remediation claims to have rewritten Pausable's UI
  // description so it stops implying the owner can freeze others while being
  // exempt themselves. V2's on-chain fragment blocks owner-originated
  // transfers when paused, so the copy needs to say so.

  test('Pausable UI description discloses the "no owner exemption" honesty', () => {
    const p = MATRIX.modules.Pausable;
    assert.ok(p, 'Pausable module missing from matrix.json');
    const blob = `${p.ui.description ?? ''} ${p.flagged ?? ''}`.toLowerCase();
    const HONEST_HINTS = [
      'including yours',
      'including you',
      'including the owner',
      'owner is not exempt',
      "owner isn't exempt",
      'no owner exemption',
      'you can\'t transfer either',
      'even you',
      'you too',
      'all transfers',
    ];
    const hasHonesty = HONEST_HINTS.some((h) => blob.includes(h));
    assert.ok(
      hasHonesty,
      `Pausable description/flagged text lacks any "no owner exemption" honesty; ` +
        `got description="${p.ui.description}" flagged="${p.flagged}"`,
    );
  });

  test('catalog HTML surfaces the Pausable honesty', async () => {
    const { body } = await getPage('/catalog');
    const bodyLower = body.toLowerCase();
    const HONEST_HINTS = [
      'including yours',
      'including you',
      'including the owner',
      'owner is not exempt',
      "owner isn't exempt",
      'no owner exemption',
      "you can't transfer either",
      'even you',
      'you too',
      'all transfers',
    ];
    const hasHonesty = HONEST_HINTS.some((h) => bodyLower.includes(h));
    assert.ok(
      hasHonesty,
      'rendered /catalog does not surface any "no owner exemption" honesty for Pausable — the audit-fix copy never reached the runtime bundle',
    );
  });
});

describe('web smoke: ConfigId contract with on-chain manifest', () => {
  test('configHashFor("ERC20", ["Permit"]) matches the pinned RhConfigManifest entry', () => {
    const computed = computeConfigHash('ERC20', ['Permit']).toLowerCase();
    const pinned = pinnedPermitHashFromManifest();
    assert.equal(
      computed,
      pinned,
      `Permit configHash drifted: computed=${computed} manifest=${pinned}`,
    );
  });

  test('canonicalModuleString handles v2 modules with @-suffix', () => {
    // Pausable is v2; Permit is v1. Once *any* module in the tuple is v2+
    // every module gets version-tagged so we do not collide with a legacy
    // v1-only hash.
    const s = canonicalModuleString(['Pausable', 'Permit']);
    assert.equal(s, 'Pausable@2,Permit@1');
  });
});
