'use client';

import { encodeAbiParameters, isAddress, zeroAddress, type Hex } from 'viem';

import {
  MODULES,
  checkCompatibility,
  encodeParamValue,
  modulesForBase,
  validateParam,
  type BaseType,
  type ModuleSpec,
} from '@/lib/modules';

interface ModulePickerProps {
  base: BaseType;
  selectedIds: string[];
  onSelectedChange: (ids: string[]) => void;
  paramValues: Record<string, Record<string, unknown>>;
  onParamsChange: (values: Record<string, Record<string, unknown>>) => void;
}

/// Renders module toggles + params inputs for the current base. Emits `selectedIds` (alphabetical
/// preserved by internal sort) and per-module `paramValues` back to the parent shop page.
export function ModulePicker(props: ModulePickerProps) {
  const { base, selectedIds, onSelectedChange, paramValues, onParamsChange } = props;
  const available = modulesForBase(base);
  const compatErrors = checkCompatibility(selectedIds);

  if (available.length === 0) {
    return (
      <div className="rounded-md border border-neutral-800 p-4 text-sm text-neutral-500">
        No modules available for {base} yet.
      </div>
    );
  }

  function toggle(mod: ModuleSpec) {
    const next = selectedIds.includes(mod.id)
      ? selectedIds.filter((id) => id !== mod.id)
      : [...selectedIds, mod.id].sort((a, b) => a.localeCompare(b));
    onSelectedChange(next);

    // Seed default params when adding a module.
    if (!selectedIds.includes(mod.id) && !paramValues[mod.id]) {
      const seeded: Record<string, unknown> = {};
      for (const p of mod.params) {
        if (p.defaultValue !== undefined) seeded[p.key] = p.defaultValue;
      }
      onParamsChange({ ...paramValues, [mod.id]: seeded });
    }
  }

  function setParam(modId: string, paramKey: string, value: unknown) {
    onParamsChange({
      ...paramValues,
      [modId]: { ...(paramValues[modId] ?? {}), [paramKey]: value },
    });
  }

  return (
    <div className="space-y-4">
      {compatErrors.length > 0 && (
        <div className="rounded-md border border-red-800 bg-red-950/40 p-3 text-xs text-red-200">
          <div className="font-medium">Composition errors</div>
          <ul className="mt-1 list-disc pl-4">
            {compatErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {available.map((mod) => {
        const selected = selectedIds.includes(mod.id);
        const params = paramValues[mod.id] ?? {};
        const isPlanned = mod.status === 'planned';

        return (
          <div
            key={mod.id}
            className={`rounded-md border p-4 ${
              selected ? 'border-white bg-neutral-900' : 'border-neutral-800 bg-transparent'
            } ${isPlanned ? 'opacity-60' : ''}`}
          >
            <label className={`flex items-start gap-3 ${isPlanned ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={selected}
                disabled={isPlanned}
                onChange={() => !isPlanned && toggle(mod)}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{mod.label}</span>
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-neutral-400">
                    {mod.category}
                  </span>
                  {isPlanned ? (
                    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-neutral-500">
                      planned
                    </span>
                  ) : (
                    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-mono text-neutral-400">
                      v{mod.version}
                    </span>
                  )}
                  {mod.flagged && (
                    <span className="rounded bg-amber-950 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-amber-300">
                      flagged
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-neutral-400">{mod.description}</p>
                {mod.requires.length > 0 && (
                  <div className="mt-1 text-[11px] text-neutral-500">
                    requires: {mod.requires.join(', ')}
                  </div>
                )}
                {mod.incompatibleWith.length > 0 && (
                  <div className="mt-1 text-[11px] text-neutral-500">
                    incompatible with: {mod.incompatibleWith.join(', ')}
                  </div>
                )}
              </div>
            </label>

            {selected && mod.params.length > 0 && (
              <div className="mt-3 space-y-3 pl-7">
                {mod.params.map((field) => {
                  const value = params[field.key];
                  const err = value !== undefined ? validateParam(field, value) : null;
                  const inputType = field.type === 'integer' ? 'number' : 'text';
                  return (
                    <label key={field.key} className="block">
                      <span className="text-[11px] uppercase tracking-widest text-neutral-500">
                        {field.label}
                        {field.min !== undefined && field.max !== undefined && (
                          <span className="ml-1 text-neutral-600">
                            [{field.min}–{field.max}]
                          </span>
                        )}
                      </span>
                      <input
                        type={inputType}
                        value={(value as string | number | undefined) ?? ''}
                        onChange={(e) =>
                          setParam(
                            mod.id,
                            field.key,
                            inputType === 'number' ? Number(e.target.value) : e.target.value,
                          )
                        }
                        className={`mt-1 w-full rounded border bg-neutral-950 px-2 py-1 text-xs font-mono focus:outline-none ${
                          err ? 'border-red-700 focus:border-red-500' : 'border-neutral-700 focus:border-white'
                        }`}
                      />
                      {field.description && (
                        <div className="mt-1 text-[11px] text-neutral-500">{field.description}</div>
                      )}
                      {err && <div className="mt-1 text-[11px] text-red-400">{err}</div>}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/// Encode a module's params into the abi.encode(...) bytes matching its `abiEncode` signature.
/// Called by the shop when assembling the `bytes[]` moduleData array. Returns '0x' for modules
/// with no params.
export function encodeModuleSlice(mod: ModuleSpec, params: Record<string, unknown>): Hex {
  if (mod.params.length === 0) return '0x';
  const parsed = parseTupleSignature(mod.abiEncode);
  // Cart preview re-encodes on every keystroke, including before the user has typed anything
  // into required fields. Fall back to safe zero-values (zeroAddress, 0n, "") so viem doesn't
  // throw InvalidAddressError on an empty string — the launch button remains blocked by the
  // param-validation layer until the user actually fills the field.
  const args = mod.params.map((p) => {
    const raw = params[p.key];
    if (p.type === 'address') {
      if (typeof raw === 'string' && isAddress(raw)) return raw;
      return zeroAddress;
    }
    if (p.type === 'integer') {
      const n = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
      return BigInt(Number.isFinite(n) ? n : 0);
    }
    if (p.type === 'percent' || p.type === 'eth') {
      // Convert %/ETH → bps/wei. Falls back to 0 for empty inputs so the cart preview
      // doesn't crash before the user finishes typing.
      return encodeParamValue(p, raw);
    }
    if (p.type === 'string') {
      return typeof raw === 'string' ? raw : '';
    }
    return Boolean(raw);
  }) as readonly unknown[];
  return encodeAbiParameters(parsed, args);
}

/// Parse a Solidity-style tuple signature like `(uint16,uint16,uint16,address)` into viem
/// AbiParameter shape.
function parseTupleSignature(sig: string): readonly { type: string }[] {
  const inner = sig.trim().replace(/^\(/, '').replace(/\)$/, '');
  if (inner.length === 0) return [];
  return inner.split(',').map((t) => ({ type: t.trim() }));
}
