/// DN404 tax quote math + plain-language copy.
///
/// Run:
///   node --experimental-strip-types --disable-warning=ExperimentalWarning \
///     --test src/lib/dn404Tax.test.mjs

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  TAX_MODE,
  describeTax,
  formatTaxPct,
  netAfterTax,
  taxOn,
  taxedBuyNetOut,
  taxedSellPoolInput,
} from './dn404Tax.ts';

const E18 = 10n ** 18n;

describe('taxOn / netAfterTax match Dn404TaxTemplate._transfer flooring', () => {
  it('1% of 1,000 tokens is 10', () => {
    assert.equal(taxOn(1_000n * E18, 100), 10n * E18);
    assert.equal(netAfterTax(1_000n * E18, 100), 990n * E18);
  });
  it('floors like Solidity integer division', () => {
    assert.equal(taxOn(199n, 100), 1n); // 199 * 100 / 10000 = 1.99 -> 1
    assert.equal(taxOn(99n, 100), 0n); // dust is untaxed, as on-chain (tax == 0 short-circuits)
  });
  it('zero bps or zero amount is untaxed', () => {
    assert.equal(taxOn(10n * E18, 0), 0n);
    assert.equal(taxOn(0n, 500), 0n);
  });
  it('5% cap case', () => {
    assert.equal(netAfterTax(100n * E18, 500), 95n * E18);
  });
});

describe('pool quotes', () => {
  it('sell: only amountIn minus tax reaches the pool', () => {
    assert.equal(taxedSellPoolInput(111_799n * E18, 100), 110_681_010_000_000_000_000_000n);
  });
  it('buy: buyer nets pool output minus tax', () => {
    assert.equal(taxedBuyNetOut(18_633n * E18, 250), 18_167_175_000_000_000_000_000n);
  });
});

describe('describeTax copy', () => {
  it('no tax -> null', () => {
    assert.equal(describeTax(TAX_MODE.Off, 100), null);
    assert.equal(describeTax(TAX_MODE.BurnDead, 0), null);
  });
  it('every mode has a plain sentence with the percent and no em dash', () => {
    for (const mode of [1, 2, 3, 4, 5, 6]) {
      const s = describeTax(mode, 100, 'URU');
      assert.ok(s && s.startsWith('1% of every transfer'), `mode ${mode}: ${s}`);
      assert.ok(!s.includes('—'), `mode ${mode} has an em dash`);
    }
  });
  it('buyback copy', () => {
    assert.equal(describeTax(TAX_MODE.BuybackURU, 100), '1% of every transfer is used to buy back and burn URU.');
  });
  it('allowed-token copy uses the target label', () => {
    assert.equal(describeTax(TAX_MODE.BuyAllowedToken, 250, 'URU'), '2.5% of every transfer is used to buy URU for the creator.');
  });
  it('formatTaxPct trims zeros', () => {
    assert.equal(formatTaxPct(100), '1%');
    assert.equal(formatTaxPct(50), '0.5%');
    assert.equal(formatTaxPct(225), '2.25%');
  });
});
