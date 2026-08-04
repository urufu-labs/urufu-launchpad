// URU-A09 AC #4: CI no-drift check for the module matrix.
//
// Independently recomputes every canonical ConfigId (and every retired hash)
// using the same rule the shared library codifies, then asserts each hex
// value appears verbatim in the on-chain manifest source.
//
// KEEP the canonical + retired lists BELOW in sync with:
//   contracts/script/manifest/RhConfigManifest.sol
//   shared/config-id.ts::canonicalModuleString
//   web/src/lib/modules.ts::configHashFor
// Any module version bump or new composed impl MUST update this file AND the
// manifest in the same PR; CI will fail otherwise.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, encodeAbiParameters, type Hex } from "viem";

// Deliberately-duplicated copy of `canonicalModuleString`. Detecting drift
// means we can't import from `shared/` — if the shared algorithm changes
// unilaterally, this local reference still forces the manifest to agree.
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

const CANONICAL = [
  { label: "Permit",        base: "ERC20", modules: ["Permit"],         versions: { Permit: 1 } },
  { label: "Vesting",       base: "ERC20", modules: ["Vesting"],        versions: { Vesting: 1 } },
  { label: "Staking",       base: "ERC20", modules: ["Staking"],        versions: { Staking: 1 } },
  { label: "Votes",         base: "ERC20", modules: ["Votes"],          versions: { Votes: 1 } },
  { label: "bare",          base: "ERC20", modules: [],                 versions: {} },
  { label: "AntiBot",       base: "ERC20", modules: ["AntiBot"],        versions: { AntiBot: 1 } },
  { label: "AntiWhale",     base: "ERC20", modules: ["AntiWhale"],      versions: { AntiWhale: 1 } },
  { label: "FoT",           base: "ERC20", modules: ["FeeOnTransfer"],  versions: { FeeOnTransfer: 1 } },
  { label: "Pausable@2",    base: "ERC20", modules: ["Pausable"],       versions: { Pausable: 2 } },
  { label: "Permit+Staking", base: "ERC20", modules: ["Permit", "Staking"], versions: { Permit: 1, Staking: 1 } },
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
    const hex = configHashFor(c.base, c.modules, c.versions).toLowerCase();
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
    allComputed.add(configHashFor(c.base, c.modules, c.versions).toLowerCase());
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
