/**
 * URU-A09 AC #1: single source of truth for the module catalog.
 *
 * `shared/matrix.json` carries every field consumed by:
 *   • compile-service — validation + Solidity splicing (base/version/requires/
 *     incompatibleWith/fragmentPath/templateOverride/params/abiEncode)
 *   • web             — module picker + param form + config-hash preview
 *     (`ui` presentation overlay + `capabilities` bitmap booleans)
 *
 * This file:
 *   1. imports the JSON at compile time so both bundlers (Next.js + tsx) inline
 *      it — no runtime `fs` dep, no path drift between web + service builds.
 *   2. narrows the raw JSON shape to typed interfaces every consumer imports.
 *   3. exposes light helpers (moduleVersionFor, moduleIds, forEachModule) that
 *      remove any second reason to hand-maintain a parallel catalog.
 *
 * NO runtime deps (viem, zod, react, …). Zod schema-level validation is
 * layered ON TOP in `compile-service/src/matrix.ts` where zod is already a dep.
 *
 * Extending the catalog:
 *   Edit `shared/matrix.json` ONLY. The web frontend picks up the entry via
 *   `web/src/lib/modules.ts` (a pure `.map()`), the compile-service picks it up
 *   via `compile-service/src/matrix.ts` (re-exports these types + validates at
 *   boot), and the manifest-drift test asserts the module lands on the
 *   `RhConfigManifest` list before it can be launched on-chain.
 */

// Node's --experimental-strip-types loader requires the `with { type: 'json' }`
// import attribute for JSON files. TypeScript 5.3+ parses it, and both
// workspaces resolve TS 5.5+ (web: 5.9.3, compile-service: 5.5+). Next.js
// bundler + resolveJsonModule accept it too. Same JSON either way.
import MATRIX_JSON from './matrix.json' with { type: 'json' };

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

/// UI-facing param types.
///  - 'percent': user types a % (5 → stored 5), encoded as bps (×100) → uint16.
///  - 'eth':     user types a decimal ETH string ("0.01"), encoded via parseEther → uint256.
///  - 'integer'|'address'|'string'|'boolean': carry through unchanged.
export type UiParamType = 'integer' | 'address' | 'string' | 'boolean' | 'percent' | 'eth';

export interface UiParamOverlay {
  /// Human-friendly label rendered next to the input.
  label: string;
  /// UI-facing type — usually matches the JSON-schema type; overrides
  /// `integer` → `percent` (%↔bps) or `string` → `eth` (ETH↔wei) where the
  /// on-chain contract is bps or wei but the human wants %/ETH.
  type: UiParamType;
  /// Value pre-seeded into the input when the module is added to the cart.
  default?: unknown;
  /// Long-form hint text shown under the input.
  hint?: string;
  /// UI-facing bounds (for percent/eth types these are in percent/ETH units,
  /// NOT the underlying bps/wei bounds — those live on the JSON-schema side).
  min?: number;
  max?: number;
  /// For 'percent' — decimal-places precision the input accepts (default 2).
  step?: number;
}

/// A single JSON-schema `properties[name]` entry as it appears in matrix.json,
/// plus the optional UI overlay for the frontend form.
export interface SharedParamSchema {
  type?: string;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  description?: string;
  items?: { type?: string };
  ui?: UiParamOverlay;
}

/// The `params` object for a module — mirror of the shared JSON's top-level
/// param object (JSON Schema draft/2020-12 shape).
export interface SharedParams {
  $schema?: string;
  type?: string;
  required?: string[];
  properties?: Record<string, SharedParamSchema>;
}

/// Presentation overlay for a whole module.
export interface UiModuleOverlay {
  label: string;
  /// Category the shop groups the module under.
  category: 'token' | 'nft' | 'allocation' | 'governance' | 'hook';
  /// 'shipped' = selectable; 'planned' = greyed-out in the shop.
  status: 'shipped' | 'planned';
  /// Short one-liner rendered in the module card.
  description: string;
}

/// Router-flag-adjacent booleans a module can declare. When set, the web app
/// disables the module in combinations Router would reject on-chain (curve
/// launches for `requiresOwner`; both curve + FoT taxes for
/// `taxesTransfers`). These mirror `FLAG_REQUIRES_OWNER` /
/// `FLAG_BALANCE_MUTATING` on the Router bitmap.
export interface ModuleCapabilities {
  requiresOwner?: boolean;
  taxesTransfers?: boolean;
}

/// A module entry inside `shared/matrix.json`.
export interface SharedModuleSpec {
  version: number;
  base: string[];
  requires: string[];
  incompatibleWith: string[];
  flagged: string | null;
  /// Path (repo-relative) to the `.frag.sol` fragment the composer splices in.
  /// Absent for post-graduation hook modules (LPLocked, FeeRedirect, …) and
  /// planned modules (status = 'planned'). Modules without a `fragmentPath`
  /// cannot appear in a `/compile` request.
  fragmentPath?: string;
  /// Optional Solidity file that replaces the default base template
  /// (`ERC20Template.sol` etc.) when this module is selected. Currently only
  /// `Votes` sets it — it needs the OZ checkpoint state that fragments can't
  /// splice in cleanly.
  templateOverride?: string;
  params: SharedParams;
  /// Human-readable Solidity ABI signature for the module's initData slice.
  abiEncode: string;
  ui: UiModuleOverlay;
  capabilities?: ModuleCapabilities;
}

/// Full matrix shape — matches the top level of `shared/matrix.json`.
export interface SharedMatrix {
  version: string;
  bases: string[];
  mechanics: Record<string, string[]>;
  modules: Record<string, SharedModuleSpec>;
}

// ---------------------------------------------------------------
// Loaded matrix
// ---------------------------------------------------------------

/// Typed handle to the imported JSON — same object both bundlers see.
export const MATRIX: SharedMatrix = MATRIX_JSON as unknown as SharedMatrix;

/// Stable, alphabetical list of every declared module id.
export const MODULE_IDS: readonly string[] = Object.keys(MATRIX.modules).sort((a, b) => a.localeCompare(b));

/// Runtime lookup used by `canonicalModuleString`. Returns the module's
/// declared version, or `undefined` when the id is unknown (letting the
/// canonical-string layer raise its own `UNKNOWN_MODULE` error).
export function moduleVersionFor(id: string): number | undefined {
  return MATRIX.modules[id]?.version;
}

/// Convenience iterator — used by the drift test + any consumer that wants a
/// (id, spec) pair without hitting the raw object shape.
export function forEachModule<T>(fn: (id: string, spec: SharedModuleSpec) => T): T[] {
  const out: T[] = [];
  for (const id of MODULE_IDS) {
    const spec = MATRIX.modules[id];
    if (!spec) continue;
    out.push(fn(id, spec));
  }
  return out;
}

/// True iff the module can be composed via /compile (has a fragmentPath).
/// Hook modules + planned modules return false.
export function isCompilable(spec: SharedModuleSpec): boolean {
  return typeof spec.fragmentPath === 'string' && spec.fragmentPath.length > 0;
}
