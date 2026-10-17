'use client';

import { usePriceUnit, setPriceUnit } from '@/lib/priceUnit';

/// USD / ETH switch for every price and market cap on the site. Persists via
/// localStorage; every price widget subscribes to the same store.
export function PriceUnitToggle() {
  const unit = usePriceUnit();
  return (
    <div className="ui-seg" role="group" aria-label="Price unit">
      <button type="button" aria-pressed={unit === 'usd'} onClick={() => setPriceUnit('usd')} data-sfx="none">
        USD
      </button>
      <button type="button" aria-pressed={unit === 'eth'} onClick={() => setPriceUnit('eth')} data-sfx="none">
        ETH
      </button>
    </div>
  );
}
