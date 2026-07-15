'use client';

import { usePriceUnit, setPriceUnit } from '@/lib/priceUnit';

/// Small header chip that flips the global $ / Ξ price display. Persists via
/// localStorage; every price + market-cap widget subscribes to the same store.
/// Sized to match ThemeToggle + AudioToggle so the header trio reads as one row.
export function PriceUnitToggle() {
  const unit = usePriceUnit();
  const next = unit === 'usd' ? 'eth' : 'usd';
  const label = unit === 'usd' ? '$' : 'Ξ';
  return (
    <button
      type="button"
      onClick={() => setPriceUnit(next)}
      aria-label={`Switch to ${next === 'usd' ? 'USD' : 'ETH'} display`}
      title={`switch to ${next === 'usd' ? 'USD' : 'ETH'} display`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        padding: 0,
        background: unit === 'usd' ? 'var(--mint)' : 'var(--cream)',
        color: 'var(--anchor)',
        border: '1.5px solid var(--anchor)',
        boxShadow: '2px 2px 0 var(--anchor)',
        fontFamily: 'var(--font-pixel), monospace',
        fontSize: 14,
        fontWeight: 700,
        lineHeight: 1,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}
