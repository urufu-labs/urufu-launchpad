'use client';

import { motion } from 'framer-motion';

import type { ModuleSpec } from '@/lib/modules';
import { validateParam } from '@/lib/modules';

interface Props {
  mod: ModuleSpec;
  params: Record<string, unknown>;
  onParamsChange: (values: Record<string, unknown>) => void;
  onRemove: () => void;
  index: number;
}

export function CartItem({ mod, params, onParamsChange, onRemove, index }: Props) {
  function setField(key: string, value: unknown) {
    onParamsChange({ ...params, [key]: value });
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -16, rotate: -3 }}
      animate={{ opacity: 1, y: 0, rotate: index % 2 === 0 ? 0.6 : -0.4 }}
      exit={{ opacity: 0, x: 60, rotate: 8 }}
      transition={{ type: 'spring', stiffness: 500, damping: 32 }}
      className="kawaii-polaroid relative"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-lg" aria-hidden>
            {mod.category === 'token' ? '🪙' : mod.category === 'nft' ? '🎨' : mod.category === 'allocation' ? '📦' : mod.category === 'governance' ? '🏛️' : '🪝'}
          </span>
          <div>
            <div className="font-bold text-sm">{mod.label}</div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--zone-ink-soft)]">
              slot {index}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="text-[var(--zone-ink-soft)] hover:text-[var(--rose-700)] text-lg leading-none"
          aria-label={`Remove ${mod.label}`}
        >
          ✕
        </button>
      </div>

      {mod.params.length > 0 && (
        <div className="mt-3 space-y-2">
          {mod.params.map((field) => {
            const value = params[field.key];
            const err = value !== undefined ? validateParam(field, value) : null;
            const inputType = field.type === 'integer' ? 'number' : 'text';
            return (
              <label key={field.key} className="block">
                <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--zone-ink-soft)]">
                  {field.label}
                  {field.min !== undefined && field.max !== undefined && (
                    <span className="ml-1 text-[var(--zone-ink-soft)]">
                      [{field.min}–{field.max}]
                    </span>
                  )}
                </span>
                <input
                  type={inputType}
                  value={(value as string | number | undefined) ?? ''}
                  onChange={(e) =>
                    setField(field.key, inputType === 'number' ? Number(e.target.value) : e.target.value)
                  }
                  className="kawaii-input mt-1"
                  style={err ? { boxShadow: '2px 2px 0 var(--rose-700)' } : undefined}
                />
                {err && (
                  <div className="mt-1 text-[10px] text-[var(--rose-700)] font-mono">{err}</div>
                )}
              </label>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}
