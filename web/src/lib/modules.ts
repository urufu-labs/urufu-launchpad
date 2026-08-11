import { encodeAbiParameters, keccak256, isAddress, parseEther } from 'viem';
import { canonicalModuleString } from '../../../shared/config-id';
import {
  MATRIX,
  moduleVersionFor,
  type SharedModuleSpec,
  type SharedParamSchema,
  type UiParamOverlay,
} from '../../../shared/matrix';

export type BaseType = 'ERC20' | 'ERC721A' | 'ERC1155';

/// Enum values matching Solidity's BaseType.
export const BASE_TYPE_TO_UINT: Record<BaseType, 0 | 1 | 2> = {
  ERC20: 0,
  ERC721A: 1,
  ERC1155: 2,
};

/// UI-facing param types.
///  - 'percent': user types a % (e.g. 5 for 5%), stored as %, encoded as bps (×100) into uint16.
///  - 'eth':     user types a decimal ETH string (e.g. "0.01"), stored as string, encoded via parseEther.
export type ModuleParamType = UiParamOverlay['type'];

export interface ModuleParamField {
  key: string;
  label: string;
  type: ModuleParamType;
  /// For 'integer' + 'percent' this is in the user-facing unit (blocks / %). Not bps.
  min?: number;
  max?: number;
  /// For 'percent' — how many decimal places the input allows (default 2 → 0.01% resolution).
  step?: number;
  defaultValue?: unknown;
  /// Short one-liner explaining what the value does in plain words.
  description?: string;
}

export type ModuleStatus = 'shipped' | 'planned';
export type ModuleCategory =
  | 'token'
  | 'nft'
  | 'allocation'
  | 'governance'
  | 'hook';

export interface ModuleSpec {
  id: string;
  label: string;
  category: ModuleCategory;
  status: ModuleStatus;
  version: number;
  bases: BaseType[];
  requires: string[];
  incompatibleWith: string[];
  flagged: string | null;
  /// True when the module exposes owner-callable functions that are only
  /// meaningful post-launch (pause/unpause, add-to-allowlist, exempt-from-caps).
  /// Bonding-curve launches auto-renounce ownership, so picking one of these
  /// modules under a curve mechanic would silently disable those functions.
  /// The create page uses this flag to grey the module out in that scenario.
  requiresOwner?: boolean;
  /// True when the module hooks into every ERC-20 transfer to burn or route a
  /// slice of the transfer amount (e.g. FeeOnTransfer). Bonding-curve trading
  /// itself goes through the ERC-20 transfer path — the curve calls
  /// `token.transfer(buyer, amount)` on every buy — so this class of module
  /// would corrupt the curve's math, drain reserves on every trade, and mess up
  /// graduation. The create page blocks these on curve mechanic (users can still
  /// use them on direct-launch, where transfers are user-driven).
  taxesTransfers?: boolean;
  description: string;
  /// Human-readable Solidity ABI signature for the module's initData slice, e.g. `(uint16)`.
  abiEncode: string;
  params: ModuleParamField[];
}

// ---------------------------------------------------------------
// Shared → web ModuleSpec projection (URU-A09 AC #1)
// ---------------------------------------------------------------
//
// The `MODULES` array below used to be a 500-line hand-maintained duplicate
// of `shared/matrix.json`. The auditor flagged this in the Consolidated
// system-level findings PDF (#6): two catalogs = drift. Now MODULES is a
// pure `.map()` over the shared source. The three fields the frontend needs
// on top of the compile-service view (`ui` overlay, `capabilities`, param
// `ui`) live in the SAME shared JSON so there is still exactly one place
// to edit. Drift is caught by `compile-service/src/matrix-drift.test.ts`.

const KNOWN_BASES = new Set<BaseType>(['ERC20', 'ERC721A', 'ERC1155']);

function toBase(name: string): BaseType {
  if (!KNOWN_BASES.has(name as BaseType)) {
    throw new Error(`unknown base '${name}' in shared matrix`);
  }
  return name as BaseType;
}

function paramFieldsFor(spec: SharedModuleSpec): ModuleParamField[] {
  const properties = spec.params?.properties ?? {};
  const required = spec.params?.required ?? [];
  // Preserve the required-order for positional abi encoding, then append any
  // extra (optional) properties in declaration order.
  const orderedKeys: string[] = [];
  for (const k of required) {
    if (k in properties) orderedKeys.push(k);
  }
  for (const k of Object.keys(properties)) {
    if (!orderedKeys.includes(k)) orderedKeys.push(k);
  }
  return orderedKeys.map((key) => paramField(key, properties[key]!));
}

function paramField(key: string, prop: SharedParamSchema): ModuleParamField {
  const ui = prop.ui;
  const fallbackType = fallbackParamType(prop.type);
  return {
    key,
    label: ui?.label ?? key,
    type: ui?.type ?? fallbackType,
    // UI-side min/max is in user units (percent / ETH), which may differ
    // from the JSON-schema bps/wei bounds. Prefer the overlay; fall back
    // to schema numbers so the input still bounds sensibly.
    min: ui?.min ?? prop.minimum,
    max: ui?.max ?? prop.maximum,
    step: ui?.step,
    defaultValue: ui?.default,
    description: ui?.hint ?? prop.description,
  };
}

function fallbackParamType(t: string | undefined): ModuleParamType {
  switch (t) {
    case 'integer': return 'integer';
    case 'boolean': return 'boolean';
    // string/array/undefined → free-text; percent/eth must always come
    // through the ui overlay, never from the JSON schema type.
    default: return 'string';
  }
}

function toModuleSpec(id: string, spec: SharedModuleSpec): ModuleSpec {
  const caps = spec.capabilities ?? {};
  return {
    id,
    label: spec.ui.label,
    category: spec.ui.category,
    status: spec.ui.status,
    version: spec.version,
    bases: spec.base.map(toBase),
    requires: [...spec.requires],
    incompatibleWith: [...spec.incompatibleWith],
    flagged: spec.flagged,
    requiresOwner: caps.requiresOwner || undefined,
    taxesTransfers: caps.taxesTransfers || undefined,
    description: spec.ui.description,
    abiEncode: spec.abiEncode,
    params: paramFieldsFor(spec),
  };
}

/// The full module catalog, derived at import time from `shared/matrix.json`.
/// Do NOT hand-maintain entries here — edit the shared JSON. Any drift
/// between this array and the shared file is a bug and fails the
/// `matrix-drift.test.ts` in compile-service.
export const MODULES: ModuleSpec[] = Object.keys(MATRIX.modules).map((id) =>
  toModuleSpec(id, MATRIX.modules[id]!),
);

export function modulesForBase(base: BaseType): ModuleSpec[] {
  return MODULES.filter((m) => m.bases.includes(base));
}

export function shippedModulesForBase(base: BaseType): ModuleSpec[] {
  return modulesForBase(base).filter((m) => m.status === 'shipped');
}

export function moduleById(id: string): ModuleSpec | undefined {
  return MODULES.find((m) => m.id === id);
}

/// Client-side config hash. Two paths:
///   1. Tuples with ONLY v1 modules (no reserve-backed): legacy formula
///      `keccak256(abi.encode(base, sortedModuleIds.join(',')))`.
///      Matches every impl Router deploy.s.sol registered — existing tokens
///      launched under these hashes keep working, existing impls stay pinned.
///   2. Tuples containing ANY v2+ module: version-tagged formula
///      `keccak256(abi.encode(base, sortedModuleIdsWithVersion.join(',')))`
///      where each id becomes `${id}@${version}`. The @-suffix produces a
///      different hash so V2 impls register cleanly without colliding with the
///      existing v1 impls on the same factory (`registerImpl` reverts on
///      duplicate). Backward-compatible by construction.
export function configHashFor(base: BaseType, moduleIds: readonly string[]): `0x${string}` {
  // URU-A08 + A09: identity + version lookup both come from `shared/`. The
  // web app no longer carries its own version numbers — `moduleVersionFor`
  // reads straight from `shared/matrix.json`.
  const modulesStr = canonicalModuleString(moduleIds, moduleVersionFor);
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }],
      [base, modulesStr],
    ),
  );
}

/// Cross-module compatibility check. Returns an array of error strings; empty array = OK.
export function checkCompatibility(selectedIds: readonly string[]): string[] {
  const errors: string[] = [];
  const selected = selectedIds.map((id) => moduleById(id)).filter((m): m is ModuleSpec => !!m);

  for (const mod of selected) {
    for (const req of mod.requires) {
      if (!selectedIds.includes(req)) {
        errors.push(`${mod.id} requires ${req}`);
      }
    }
    for (const incompat of mod.incompatibleWith) {
      if (selectedIds.includes(incompat)) {
        errors.push(`${mod.id} is incompatible with ${incompat}`);
      }
    }
  }
  return errors;
}

/// Basic client-side field validation.
export function validateParam(field: ModuleParamField, value: unknown): string | null {
  if (field.type === 'integer') {
    const n = Number(value);
    if (!Number.isInteger(n)) return `${field.label} must be a whole number`;
    if (field.min !== undefined && n < field.min) return `${field.label} min ${field.min}`;
    if (field.max !== undefined && n > field.max) return `${field.label} max ${field.max}`;
    return null;
  }
  if (field.type === 'percent') {
    const n = Number(value);
    if (!Number.isFinite(n)) return `${field.label} needs a number`;
    if (field.min !== undefined && n < field.min) return `${field.label} min ${field.min}%`;
    if (field.max !== undefined && n > field.max) return `${field.label} max ${field.max}%`;
    return null;
  }
  if (field.type === 'eth') {
    if (typeof value !== 'string' || value.trim().length === 0) return `${field.label} needs an amount`;
    try {
      parseEther(value);
      return null;
    } catch {
      return `${field.label} — bad amount`;
    }
  }
  if (field.type === 'address') {
    if (typeof value !== 'string' || !isAddress(value)) return `${field.label} — paste a valid address`;
    return null;
  }
  return null;
}

/// Convert a user-facing param value to its on-chain encoded form.
///   'percent' → bps  (× 100, rounded)
///   'eth'     → wei  (parseEther)
///   others    → as-is
export function encodeParamValue(field: ModuleParamField, raw: unknown): unknown {
  if (field.type === 'percent') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0n;
    return BigInt(Math.round(n * 100));
  }
  if (field.type === 'eth') {
    if (typeof raw !== 'string' || raw.trim().length === 0) return 0n;
    try { return parseEther(raw); } catch { return 0n; }
  }
  return raw;
}
