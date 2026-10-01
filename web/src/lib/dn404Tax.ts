/// DN404 per-transfer tax helpers for the trade page.
///
/// A taxed DN404 base token (Dn404TaxTemplate / V2 clone) takes `taxBps` of
/// every non-exempt transfer. Exempt: the bonding curve, launch factory,
/// launcher, fee splitter, and (V2) graduators, hook hosts and the keeper.
/// NOT exempt: Uniswap's PoolManager. So:
///   - curve buys/sells are untaxed (curve is exempt);
///   - a pool SELL taxes the transfer into the PoolManager: only
///     `amountIn - tax` reaches the pool, so quote on that net amount;
///   - a pool BUY taxes the PoolManager -> buyer transfer: the pool pays the
///     full output, the buyer nets `out - tax`;
///   - wallet-to-wallet transfers are taxed.
/// Math mirrors Dn404TaxTemplate._transfer: tax = amount * taxBps / 10_000
/// (floor), net = amount - tax.

/// Token-side tax on a transfer of `amount`, exactly as the contract floors it.
export function taxOn(amount: bigint, taxBps: number): bigint {
  if (amount <= 0n || taxBps <= 0) return 0n;
  return (amount * BigInt(taxBps)) / 10_000n;
}

/// What actually arrives after one taxed transfer.
export function netAfterTax(amount: bigint, taxBps: number): bigint {
  return amount - taxOn(amount, taxBps);
}

/// Pool SELL: tokens that reach the pool (and get swapped) for `amountIn`.
export function taxedSellPoolInput(amountIn: bigint, taxBps: number): bigint {
  return netAfterTax(amountIn, taxBps);
}

/// Pool BUY: tokens the buyer actually receives when the pool pays `grossOut`.
export function taxedBuyNetOut(grossOut: bigint, taxBps: number): bigint {
  return netAfterTax(grossOut, taxBps);
}

/// Tax mode enum, mirrors Dn404TaxTemplate.TaxMode ordering.
export const TAX_MODE = {
  Off: 0,
  BurnDead: 1,
  BuybackURU: 2,
  BuyAllowedToken: 3,
  AddToLP: 4,
  HolderReflections: 5,
  MirrorFloorSupport: 6,
} as const;

/// "1%", "0.5%", "2.25%". Plain, no trailing zeros.
export function formatTaxPct(taxBps: number): string {
  const pct = taxBps / 100;
  return `${Number(pct.toFixed(2))}%`;
}

/// One plain-language sentence for the trade page: what the tax is and what it
/// does. `targetLabel` is the symbol for BuyAllowedToken (e.g. "URU"). Returns
/// null when there is no tax.
export function describeTax(taxMode: number, taxBps: number, targetLabel?: string): string | null {
  if (taxMode === TAX_MODE.Off || taxBps <= 0) return null;
  const pct = formatTaxPct(taxBps);
  switch (taxMode) {
    case TAX_MODE.BurnDead:
      return `${pct} of every transfer is burned.`;
    case TAX_MODE.BuybackURU:
      return `${pct} of every transfer is used to buy back and burn URU.`;
    case TAX_MODE.BuyAllowedToken:
      return `${pct} of every transfer is used to buy ${targetLabel || 'a listed token'} for the creator.`;
    case TAX_MODE.AddToLP:
      return `${pct} of every transfer is added to the trading pool's liquidity.`;
    case TAX_MODE.HolderReflections:
      return `${pct} of every transfer is shared with holders.`;
    case TAX_MODE.MirrorFloorSupport:
      return `${pct} of every transfer is used to buy and burn the cheapest NFTs listed for sale.`;
    default:
      return `${pct} of every transfer is taxed.`;
  }
}

/// Second line of the notice: where the tax applies.
export const TAX_SCOPE_NOTE =
  'Buys and sells on the bonding curve are not taxed. After graduation, pool trades and wallet transfers are.';
