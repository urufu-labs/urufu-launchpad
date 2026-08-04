import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import {
  MATRIX,
  type SharedMatrix,
  type SharedModuleSpec,
  type SharedParams,
  isCompilable,
} from '../../shared/matrix.ts';

/// A single module's spec inside `shared/matrix.json`.
///
/// URU-A09 AC #1: mirrors the shared shape so callers that were compiling
/// against the compile-service local type continue to compile unchanged. The
/// shared type is the authority; extending this here is a bug.
export interface ModuleSpec extends SharedModuleSpec {}

/// URU-A09 AC #1: was a compile-service-local Matrix type. Now re-exported
/// from `shared/matrix.ts` so the frontend and the server cannot drift.
/// Extra `ui` / `capabilities` fields flow through untouched.
export interface Matrix extends SharedMatrix {}

// ---------------------------------------------------------------
// Zod schema — layered on top of the shared JSON to catch drift.
// ---------------------------------------------------------------

// URU-A09: validate the shared JSON at process boot. The web app carries the
// same file through its bundler without a runtime dep on zod; here we get
// belt-and-braces validation because zod is already a compile-service dep.
const UiParamOverlaySchema = z.object({
  label: z.string(),
  type: z.enum(['integer', 'address', 'string', 'boolean', 'percent', 'eth']),
  default: z.unknown().optional(),
  hint: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
});

const ParamSchemaSchema = z.object({
  type: z.string().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  pattern: z.string().optional(),
  description: z.string().optional(),
  items: z.object({ type: z.string().optional() }).passthrough().optional(),
  ui: UiParamOverlaySchema.optional(),
}).passthrough();

const ParamsBlockSchema = z.object({
  $schema: z.string().optional(),
  type: z.string().optional(),
  required: z.array(z.string()).optional(),
  properties: z.record(z.string(), ParamSchemaSchema).optional(),
}).passthrough();

const UiModuleOverlaySchema = z.object({
  label: z.string(),
  category: z.enum(['token', 'nft', 'allocation', 'governance', 'hook']),
  status: z.enum(['shipped', 'planned']),
  description: z.string(),
});

const CapabilitiesSchema = z.object({
  requiresOwner: z.boolean().optional(),
  taxesTransfers: z.boolean().optional(),
}).passthrough();

const ModuleSpecSchema = z.object({
  version: z.number().int(),
  base: z.array(z.string()).min(1),
  requires: z.array(z.string()),
  incompatibleWith: z.array(z.string()),
  flagged: z.string().nullable(),
  fragmentPath: z.string().optional(),
  templateOverride: z.string().optional(),
  params: ParamsBlockSchema,
  abiEncode: z.string(),
  ui: UiModuleOverlaySchema,
  capabilities: CapabilitiesSchema.optional(),
}).passthrough();

const MatrixSchema = z.object({
  version: z.string(),
  bases: z.array(z.string()).min(1),
  mechanics: z.record(z.string(), z.array(z.string())),
  modules: z.record(z.string(), ModuleSpecSchema),
}).passthrough();

// Validate the shared matrix eagerly at module load. A schema mismatch fails
// the process boot instead of surfacing as a mid-request validation error.
const _validated = MatrixSchema.parse(MATRIX) as SharedMatrix;
void _validated;

/// Load the matrix from disk. Preserved for callers that need the historical
/// `loadMatrix(path)` shape (server.ts, tests). The path argument is honored
/// so a caller can point at a different file for smoke tests, but the default
/// shared JSON is already validated at import time (see MatrixSchema.parse
/// above) — this pass only checks the on-disk file matches the schema.
export function loadMatrix(matrixPath: string): Matrix {
  const raw = readFileSync(resolve(matrixPath), 'utf8');
  const parsed = JSON.parse(raw);
  return MatrixSchema.parse(parsed) as Matrix;
}

/// URU-A09 AC #1: the shared matrix as a compile-service-typed Matrix.
/// Prefer this over `loadMatrix(MATRIX_PATH)` in new code — same object, no
/// filesystem round-trip, no second validation pass.
export const SHARED_MATRIX: Matrix = MATRIX as Matrix;

export interface CompileConfig {
  base: string;
  mechanic?: string;
  modules: string[];
  params: Record<string, Record<string, unknown>>;
}

export type ValidationError =
  | { code: 'UNKNOWN_BASE'; base: string }
  | { code: 'UNKNOWN_MECHANIC'; base: string; mechanic: string }
  | { code: 'UNKNOWN_MODULE'; module: string }
  | { code: 'MODULE_WRONG_BASE'; module: string; base: string }
  | { code: 'MODULE_MISSING_REQUIRES'; module: string; missing: string[] }
  | { code: 'MODULE_INCOMPATIBLE'; module: string; withModule: string }
  | { code: 'MODULE_NOT_COMPILABLE'; module: string };

/// Validate a config against the matrix. Throws on the first problem (single-error contract for now;
/// upgrade to error-list when the frontend wants inline field-level feedback).
export function validateConfig(matrix: Matrix, config: CompileConfig): void {
  // URU-A09: catch duplicate module ids up-front. `canonicalModuleString`
  // also enforces this on the identity side; caught here first so the error
  // surfaces via the compile-service's normal validation pipeline.
  if (new Set(config.modules).size !== config.modules.length) {
    throw new Error('DUPLICATE_MODULES: each module id may appear once');
  }
  if (!matrix.bases.includes(config.base)) {
    throw new Error(`UNKNOWN_BASE: ${config.base}`);
  }
  if (config.mechanic) {
    const allowed = matrix.mechanics[config.base] ?? [];
    if (!allowed.includes(config.mechanic)) {
      throw new Error(`UNKNOWN_MECHANIC: ${config.mechanic} (base ${config.base} supports: ${allowed.join(', ')})`);
    }
  }
  for (const mid of config.modules) {
    const mod = matrix.modules[mid];
    if (!mod) throw new Error(`UNKNOWN_MODULE: ${mid}`);
    if (!mod.base.includes(config.base)) {
      throw new Error(`MODULE_WRONG_BASE: ${mid} does not support base ${config.base}`);
    }
    // URU-A09: reject modules that have no `.frag.sol` fragment (post-graduation
    // hooks like LPLocked/MultiHookHost, planned modules). Without this check
    // the composer would blow up mid-splice with a confusing 'ENOENT'.
    if (!isCompilable(mod)) {
      throw new Error(`MODULE_NOT_COMPILABLE: ${mid} has no fragmentPath (hook or planned module)`);
    }
    const missing = mod.requires.filter((r) => !config.modules.includes(r));
    if (missing.length > 0) {
      throw new Error(`MODULE_MISSING_REQUIRES: ${mid} needs ${missing.join(', ')}`);
    }
    for (const incompat of mod.incompatibleWith) {
      if (config.modules.includes(incompat)) {
        throw new Error(`MODULE_INCOMPATIBLE: ${mid} incompatible with ${incompat}`);
      }
    }
    // URU-A09: validate each module's params against the JSON Schema in the
    // matrix. Previously the server accepted `params` as arbitrary unknown
    // values and only the on-chain fragment would revert (mid-tx, wasting gas).
    validateModuleParams(mid, mod.params as unknown as Record<string, unknown>, config.params[mid] ?? {});
  }
}

interface JsonSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, {
    type?: string;
    minimum?: number;
    maximum?: number;
    pattern?: string;
  }>;
}

/// URU-A09: enforce JSON-schema parameter validation server-side. Catches
/// missing required fields, unknown extras, wrong types, and out-of-range
/// integers BEFORE the compile-service spawns Forge or the user pays gas.
///
/// Cross-field invariants that JSON-schema alone can't express (FoT
/// burnBps+treasuryBps==10000, 1155 array-length equality, Vesting
/// end>cliff) are checked explicitly at the bottom.
function validateModuleParams(
  moduleId: string,
  rawSchema: Record<string, unknown> | SharedParams,
  rawParams: Record<string, unknown>,
): void {
  const schema = rawSchema as JsonSchema;
  const properties = schema.properties ?? {};

  for (const key of schema.required ?? []) {
    if (!(key in rawParams)) {
      throw new Error(`MODULE_PARAM_REQUIRED: ${moduleId}.${key}`);
    }
  }
  for (const key of Object.keys(rawParams)) {
    if (!(key in properties)) {
      throw new Error(`MODULE_PARAM_UNKNOWN: ${moduleId}.${key}`);
    }
  }

  for (const [key, rule] of Object.entries(properties)) {
    if (!(key in rawParams)) continue;
    const value = rawParams[key];
    switch (rule.type) {
      case 'integer':
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
          throw new Error(`MODULE_PARAM_TYPE: ${moduleId}.${key} must be an integer`);
        }
        if (rule.minimum !== undefined && value < rule.minimum) {
          throw new Error(`MODULE_PARAM_MIN: ${moduleId}.${key}`);
        }
        if (rule.maximum !== undefined && value > rule.maximum) {
          throw new Error(`MODULE_PARAM_MAX: ${moduleId}.${key}`);
        }
        break;
      case 'string':
        if (typeof value !== 'string') {
          throw new Error(`MODULE_PARAM_TYPE: ${moduleId}.${key} must be a string`);
        }
        if (rule.pattern && !(new RegExp(rule.pattern).test(value))) {
          throw new Error(`MODULE_PARAM_PATTERN: ${moduleId}.${key}`);
        }
        break;
      case 'array':
        if (!Array.isArray(value)) {
          throw new Error(`MODULE_PARAM_TYPE: ${moduleId}.${key} must be an array`);
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new Error(`MODULE_PARAM_TYPE: ${moduleId}.${key} must be a boolean`);
        }
        break;
      default:
        break;
    }
  }

  // Cross-field invariants that JSON Schema in the current matrix does not express.
  if (moduleId === 'FeeOnTransfer') {
    const burn = Number(rawParams['burnBps']);
    const treasury = Number(rawParams['treasuryBps']);
    if (!Number.isFinite(burn) || !Number.isFinite(treasury) || burn + treasury !== 10_000) {
      throw new Error('MODULE_PARAM_INVARIANT: FeeOnTransfer burnBps + treasuryBps must equal 10000');
    }
    if (treasury > 0 && rawParams['treasury'] === '0x0000000000000000000000000000000000000000') {
      throw new Error('MODULE_PARAM_INVARIANT: FeeOnTransfer treasury cannot be zero');
    }
  }

  if (
    moduleId === 'SupplyPerToken1155'
    || moduleId === 'PayableMint1155'
    || moduleId === 'PayableMint1155Split'
  ) {
    const ids = rawParams['ids'];
    const values = moduleId === 'SupplyPerToken1155' ? rawParams['caps'] : rawParams['pricesWei'];
    if (!Array.isArray(ids) || !Array.isArray(values) || ids.length !== values.length) {
      throw new Error(`MODULE_PARAM_INVARIANT: ${moduleId} arrays must have equal length`);
    }
    if (new Set(ids.map(String)).size !== ids.length) {
      throw new Error(`MODULE_PARAM_INVARIANT: ${moduleId} ids must be unique`);
    }
  }

  if (moduleId === 'Vesting') {
    const cliff = Number(rawParams['cliffTimestamp']);
    const end = Number(rawParams['endTimestamp']);
    if (!Number.isSafeInteger(cliff) || !Number.isSafeInteger(end) || end <= cliff) {
      throw new Error('MODULE_PARAM_INVARIANT: Vesting endTimestamp must be after cliffTimestamp');
    }
  }
}
