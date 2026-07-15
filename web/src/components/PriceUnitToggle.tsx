'use client';

import { usePriceUnit, setPriceUnit } from '@/lib/priceUnit';

/// Small header chip that flips the global $ / Ξ price display. Persists via
/// localStorage; every price + market-cap widget subscribes to the same store.
export function PriceUnitToggle() {
  const unit = usePriceUnit();
  const next = unit === 'usd' ? 'eth' : 'usd';
  const label = unit === 'usd' ? '$' : 'Ξ';
  return (
    <button
      type="button"
      onClick={() => setPriceUnit(next)}
      title={`switch to ${next.toUpperCase()} display`}
      style={{
        fontFamily: 'var(--font-pixel), monospace',
        fontSize: 11,
        fontWeight: 700,
        padding: '2px 6px',
        border: '1.5px solid var(--anchor)',
        boxShadow: '1px 1px 0 var(--anchor)',
        background: 'var(--cream)',
        color: 'var(--anchor)',
        cursor: 'pointer',
        minWidth: 28,
      }}
    >
      {label}
    </button>
  );
}
