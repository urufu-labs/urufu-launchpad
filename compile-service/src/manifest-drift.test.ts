// URU-A09 AC #4: CI no-drift check for the module matrix.
//
// Independently recomputes every canonical ConfigId (and every retired hash)
// using the same rule the shared library codifies, then asserts each hex
// value appears verbatim in the on-chain manifest source.
//
// KEEP the canonical + retired lists BELOW in sync with:
//   contracts/script/manifest/RhConfigManifest.sol
//   shared/config-id.ts::canonicalModuleString
//   shared/matrix.ts (single source of module versions)
// Any module version bump or new composed impl MUST update this file AND the
// manifest in the same PR; CI will fail otherwise.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, encodeAbiParameters, type Hex } from "viem";

// URU-A09 AC #1: import module versions from the shared source of truth
// instead of hand-maintaining a `versions: { … }` block inline. Adding a
// module in shared/matrix.json auto-flows into the canonical hash the moment
// its label appears in CANONICAL below — no second edit required.
import { moduleVersionFor } from "../../shared/matrix.ts";

// Deliberately-duplicated copy of `canonicalModuleString`. Detecting drift
// means we can't import from `shared/` — if the shared algorithm changes
// unilaterally, this local reference still forces the manifest to agree.
// (Module VERSIONS are safe to import — they're the input the manifest
// depends on, not the algorithm this test is guarding.)
function canonicalModuleString(
  moduleIds: readonly string[],
  versions: Record<string, number>,
): string {
  const unique = new Set(moduleIds);
  if (unique.size !== moduleIds.length) throw new Error("DUPLICATE_MODULES");
  const withVersions = moduleIds.map((id) => {
    const v = versions[id];
    if (v === undefined) throw new Error(`UNKNOWN_MODULE: ${id}`);
    return { id, version: v };
  });
  const versioned = withVersions.some((m) => m.version >= 2);
  return withVersions
    .map((m) => (versioned ? `${m.id}@${m.version}` : m.id))
    .sort((a, b) => a.localeCompare(b))
    .join(",");
}

function configHashFor(
  base: string,
  moduleIds: readonly string[],
  versions: Record<string, number>,
): Hex {
  const canonical = canonicalModuleString(moduleIds, versions);
  return keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "string" }], [base, canonical]),
  );
}

/// Turn a bare module-id list into the `versions` record the local copy of
/// `canonicalModuleString` expects — versions come straight from shared/.
function versionsFor(ids: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) {
    const v = moduleVersionFor(id);
    if (v === undefined) throw new Error(`UNKNOWN_MODULE in shared matrix: ${id}`);
    out[id] = v;
  }
  return out;
}

const CANONICAL = [
  { label: "Permit",         base: "ERC20", modules: ["Permit"] },
  { label: "Vesting",        base: "ERC20", modules: ["Vesting"] },
  { label: "Staking",        base: "ERC20", modules: ["Staking"] },
  { label: "Votes",          base: "ERC20", modules: ["Votes"] },
  { label: "bare",           base: "ERC20", modules: [] },
  { label: "AntiBot",        base: "ERC20", modules: ["AntiBot"] },
  { label: "AntiWhale",      base: "ERC20", modules: ["AntiWhale"] },
  { label: "FoT",            base: "ERC20", modules: ["FeeOnTransfer"] },
  { label: "Pausable@2",     base: "ERC20", modules: ["Pausable"] },
  { label: "Permit+Staking", base: "ERC20", modules: ["Permit", "Staking"] },
  // Round 6: 10 additional curve-compatible pair templates generated via
  // the splicer to close the customize-mode coverage gap. Every user-
  // selectable 2-module ERC20 combo (except Staking+Vesting, which is
  // marked incompatible in shared/matrix.json) now has a template on
  // disk + a graduation test. Note: AntiBot+Permit and Permit+Vesting
  // templates also exist on disk but are NOT manifest-registered on
  // fresh deploys yet — pre-existing gap tracked separately, do NOT add
  // them here until they land in the manifest.
  { label: "AntiBot+Staking",      base: "ERC20", modules: ["AntiBot", "Staking"] },
  { label: "AntiBot+Vesting",      base: "ERC20", modules: ["AntiBot", "Vesting"] },
  { label: "AntiBot+Votes",        base: "ERC20", modules: ["AntiBot", "Votes"] },
  { label: "AntiWhale+Permit",     base: "ERC20", modules: ["AntiWhale", "Permit"] },
  { label: "AntiWhale+Staking",    base: "ERC20", modules: ["AntiWhale", "Staking"] },
  { label: "AntiWhale+Vesting",    base: "ERC20", modules: ["AntiWhale", "Vesting"] },
  { label: "AntiWhale+Votes",      base: "ERC20", modules: ["AntiWhale", "Votes"] },
  { label: "Permit+Votes",         base: "ERC20", modules: ["Permit", "Votes"] },
  { label: "Staking+Votes",        base: "ERC20", modules: ["Staking", "Votes"] },
  { label: "Vesting+Votes",        base: "ERC20", modules: ["Vesting", "Votes"] },
];

const RETIRED = [
  { label: "Airdrop@1",         csv: "Airdrop" },
  { label: "Airdrop+Permit@1",  csv: "Airdrop,Permit" },
  { label: "Airdrop+Vesting@1", csv: "Airdrop,Vesting" },
  { label: "Pausable@1",        csv: "Pausable" },
];

const manifestPath = resolve(
  import.meta.dirname,
  "../../contracts/script/manifest/RhConfigManifest.sol",
);
const manifestSrc = readFileSync(manifestPath, "utf8").toLowerCase();

test("URU-A09: every canonical ConfigId appears verbatim in RhConfigManifest.sol", () => {
  const missing: string[] = [];
  for (const c of CANONICAL) {
    const hex = configHashFor(c.base, c.modules, versionsFor(c.modules)).toLowerCase();
    if (!manifestSrc.includes(hex)) {
      missing.push(`${c.label}: ${hex}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `Computed ConfigId(s) missing from manifest. Update RhConfigManifest.sol OR fix the module list above.\n${missing.join("\n")}`,
  );
});

test("URU-A09: every retired hash appears verbatim in RhConfigManifest.sol", () => {
  const missing: string[] = [];
  for (const r of RETIRED) {
    const hex = keccak256(
      encodeAbiParameters([{ type: "string" }, { type: "string" }], ["ERC20", r.csv]),
    ).toLowerCase();
    if (!manifestSrc.includes(hex)) {
      missing.push(`${r.label}: ${hex}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `Retired hash(es) missing from manifest.\n${missing.join("\n")}`,
  );
});

test("URU-A09: manifest hex hashes have exactly one canonical + retired source", () => {
  // Guard: make sure any hex hash present in the manifest is also produced by
  // one of the sources above. If a manifest entry appears with no computed
  // source, either the CANONICAL/RETIRED lists are stale or the manifest was
  // hand-edited with an unaudited hash.
  const hexPattern = /0x[a-f0-9]{64}/g;
  const allComputed = new Set<string>();
  for (const c of CANONICAL) {
    allComputed.add(configHashFor(c.base, c.modules, versionsFor(c.modules)).toLowerCase());
  }
  for (const r of RETIRED) {
    allComputed.add(
      keccak256(
        encodeAbiParameters([{ type: "string" }, { type: "string" }], ["ERC20", r.csv]),
      ).toLowerCase(),
    );
  }

  const manifestHashes = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = hexPattern.exec(manifestSrc)) !== null) {
    manifestHashes.add(match[0].toLowerCase());
  }

  const unknown: string[] = [];
  for (const h of manifestHashes) {
    if (!allComputed.has(h)) unknown.push(h);
  }
  assert.deepEqual(
    unknown,
    [],
    `Manifest contains hash(es) not produced by the canonical or retired sources above. Either add them here or remove them from the manifest:\n${unknown.join("\n")}`,
  );
});
