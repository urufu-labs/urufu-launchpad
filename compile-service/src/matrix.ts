import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/// A single module's spec inside `shared/matrix.json`.
export interface ModuleSpec {
  version: number;
  base: string[];
  requires: string[];
  incompatibleWith: string[];
  flagged: string | null;
  fragmentPath: string;
  params: Record<string, unknown>;
  abiEncode: string; // canonical Solidity signature for the module's initData slice
}

export interface Matrix {
  version: string;
  bases: string[];
  mechanics: Record<string, string[]>;
  modules: Record<string, ModuleSpec>;
}

export function loadMatrix(matrixPath: string): Matrix {
  const raw = readFileSync(resolve(matrixPath), 'utf8');
  const parsed = JSON.parse(raw) as Matrix;
  return parsed;
}

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
  | { code: 'MODULE_INCOMPATIBLE'; module: string; withModule: string };

/// Validate a config against the matrix. Throws on the first problem (single-error contract for now;
/// upgrade to error-list when the frontend wants inline field-level feedback).
export function validateConfig(matrix: Matrix, config: CompileConfig): void {
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
    const missing = mod.requires.filter((r) => !config.modules.includes(r));
    if (missing.length > 0) {
      throw new Error(`MODULE_MISSING_REQUIRES: ${mid} needs ${missing.join(', ')}`);
    }
    for (const incompat of mod.incompatibleWith) {
      if (config.modules.includes(incompat)) {
        throw new Error(`MODULE_INCOMPATIBLE: ${mid} incompatible with ${incompat}`);
      }
    }
  }
}
