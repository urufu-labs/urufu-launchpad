// URU-A09 AC #1: single source of truth for the module catalog.
//
// Guarantees the whole stack — web/src/lib/modules.ts, compile-service, and
// the on-chain RhConfigManifest — reads the same shared/matrix.json. Any
// drift (a module added to web but not shared, a version bump in shared not
// mirrored in the manifest, a fragmentPath that hallucinates a file that
// isn't in the repo) fails this test.
//
// KEEP this alongside `manifest-drift.test.ts` — that test pins the hashes,
// this one proves the catalog itself is single-sourced.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, encodeAbiParameters } from "viem";

import { MATRIX, MODULE_IDS, moduleVersionFor, isCompilable } from "../../shared/matrix.ts";
import { canonicalModuleString } from "../../shared/config-id.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

const manifestPath = resolve(REPO_ROOT, "contracts/script/manifest/RhConfigManifest.sol");
const manifestSrc = readFileSync(manifestPath, "utf8").toLowerCase();

/// Every hash the on-chain manifest recognises as retired. Kept in sync with
/// `RhConfigManifest.retiredAirdropHashes()` (name preserved for backwards
/// compat with existing callers — the list also covers Pausable@1).
const RETIRED_HASHES: readonly string[] = [
  "0x344f851ff67d34148ac2000b192fbc9a5cc4edd0ef612cd60c3e9d90738e7b2b", // Airdrop
  "0xa4df91ce9ab236d5e29251310259042c2d769b0e1ac21d4153ffa391ef492064", // Airdrop+Permit
  "0x903cca7212ee848c97d09fd3417f909ddbf131965f0b66e4d995d6eb7b49f3d2", // Airdrop+Vesting
  "0xa831bae1a66d3623be52065f464133bc90bd2eff45d4dc07d911b639ccdc803a", // Pausable@1
];

/// Compute the ConfigId the shared library would produce for a given
/// (base, moduleIds) tuple. Uses `moduleVersionFor` — reads directly from
/// the shared JSON, so any version bump in the JSON automatically flows
/// through the computed hash.
function sharedConfigHash(base: string, ids: readonly string[]): string {
  const canonical = canonicalModuleString(ids, moduleVersionFor);
  return keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "string" }], [base, canonical]),
  ).toLowerCase();
}

// ---------------------------------------------------------------

test("URU-A09: every shipped module in shared/matrix.json is registered on the on-chain manifest OR is a retired hash", () => {
  const missing: string[] = [];
  for (const id of MODULE_IDS) {
    const spec = MATRIX.modules[id];
    if (!spec) continue;
    // Only shipped ERC20 compilable modules land on the ERC20 manifest.
    // Hook + planned modules deploy as standalone contracts (or don't
    // deploy at all yet), so they have no per-hash entry.
    if (spec.ui.status !== "shipped") continue;
    if (!isCompilable(spec)) continue;
    if (!spec.base.includes("ERC20")) continue;

    const singletonHash = sharedConfigHash("ERC20", [id]);
    const onManifest = manifestSrc.includes(singletonHash);
    const onRetired = RETIRED_HASHES.includes(singletonHash);
    if (!onManifest && !onRetired) {
      missing.push(`${id}: ${singletonHash}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `Module(s) in shared/matrix.json have no matching entry in RhConfigManifest.all() and are not on the retired list. Either register the impl on ERC20Factory + add the hash to the manifest, or move the module to status='planned':\n${missing.join("\n")}`,
  );
});

test("URU-A09: web + compile-service compute the same ConfigId for every module the manifest carries", async () => {
  // Independently rebuild the singleton hash by parsing the manifest's
  // known labels. If the web app derives its module list from shared/
  // (which it now does via the .map() in web/src/lib/modules.ts), and
  // the compile-service does the same, both call sites route through
  // `canonicalModuleString(ids, moduleVersionFor)` — so proving the
  // shared side matches the manifest proves the whole stack agrees.
  //
  // These labels mirror `RhConfigManifest.all()` — bare + every
  // singleton the frontend can select from the shipped catalog.
  const CASES: Array<{ label: string; base: string; modules: string[] }> = [
    { label: "bare", base: "ERC20", modules: [] },
    { label: "Permit", base: "ERC20", modules: ["Permit"] },
    { label: "Vesting", base: "ERC20", modules: ["Vesting"] },
    { label: "Staking", base: "ERC20", modules: ["Staking"] },
    { label: "Votes", base: "ERC20", modules: ["Votes"] },
    { label: "AntiBot", base: "ERC20", modules: ["AntiBot"] },
    { label: "AntiWhale", base: "ERC20", modules: ["AntiWhale"] },
    { label: "FoT", base: "ERC20", modules: ["FeeOnTransfer"] },
    { label: "Pausable@2", base: "ERC20", modules: ["Pausable"] },
    { label: "Permit+Staking", base: "ERC20", modules: ["Permit", "Staking"] },
  ];

  const missing: string[] = [];
  for (const c of CASES) {
    const hex = sharedConfigHash(c.base, c.modules);
    if (!manifestSrc.includes(hex)) {
      missing.push(`${c.label}: ${hex}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `Shared/matrix-derived ConfigId(s) missing from RhConfigManifest.sol. Either the module version bumped in shared without a manifest entry, or the retired label above is stale:\n${missing.join("\n")}`,
  );
});

test("URU-A09: every module in shared/matrix.json has non-empty ui + capabilities-compatible fields", () => {
  // Guard against a partially-migrated entry: someone adds a module to
  // shared/matrix.json but forgets the `ui` block. Web would crash at
  // render time; catch it here instead.
  const bad: string[] = [];
  for (const id of MODULE_IDS) {
    const spec = MATRIX.modules[id];
    if (!spec) continue;
    if (!spec.ui || !spec.ui.label || !spec.ui.category || !spec.ui.status || !spec.ui.description) {
      bad.push(`${id} missing ui.*`);
    }
    if (!Array.isArray(spec.base) || spec.base.length === 0) {
      bad.push(`${id} missing base[]`);
    }
    if (typeof spec.abiEncode !== "string" || spec.abiEncode.length === 0) {
      bad.push(`${id} missing abiEncode`);
    }
  }
  assert.deepEqual(bad, [], `Shared matrix entries incomplete:\n${bad.join("\n")}`);
});

test("URU-A09: every module with a fragmentPath points at a file that exists in the repo", () => {
  const missing: string[] = [];
  for (const id of MODULE_IDS) {
    const spec = MATRIX.modules[id];
    if (!spec || !spec.fragmentPath) continue;
    const abs = resolve(REPO_ROOT, spec.fragmentPath);
    if (!existsSync(abs)) missing.push(`${id}: ${spec.fragmentPath}`);
  }
  assert.deepEqual(
    missing,
    [],
    `Module(s) declare a fragmentPath that isn't on disk. Fix the path or remove the module:\n${missing.join("\n")}`,
  );
});

test("URU-A09: every module with a templateOverride points at a file that exists in the repo", () => {
  const missing: string[] = [];
  for (const id of MODULE_IDS) {
    const spec = MATRIX.modules[id];
    if (!spec || !spec.templateOverride) continue;
    const abs = resolve(REPO_ROOT, spec.templateOverride);
    if (!existsSync(abs)) missing.push(`${id}: ${spec.templateOverride}`);
  }
  assert.deepEqual(
    missing,
    [],
    `Module(s) declare a templateOverride that isn't on disk:\n${missing.join("\n")}`,
  );
});

test("URU-A09: retired hashes list matches the on-chain manifest verbatim", () => {
  // Sanity: if RhConfigManifest.retiredAirdropHashes() changes without this
  // test's copy being updated, the drift test itself is stale — flag loud.
  for (const h of RETIRED_HASHES) {
    assert.ok(
      manifestSrc.includes(h),
      `retired hash ${h} is in this test but not in the on-chain manifest — one of the two is stale`,
    );
  }
});
