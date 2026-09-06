/**
 * Unit coverage for the pure sweep-decision logic. Every branch of
 * decideSweep gets a scenario — the branch that flips a launch from
 * "held" to "swept" is the load-bearing decision the keeper makes, so
 * every reason string is tested explicitly.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Address } from 'viem';

import { decideSweep, type LaunchSnapshot } from '../src/sweeper.ts';
import type { KeeperConfig, LaunchWatch } from '../src/config.ts';
import { TaxMode } from '../src/config.ts';

const KEEPER_ADDR = '0xAaAaAaAaaaAaaAaaAaAaAaaaAaAaAaAaAaAaAaAa' as Address;
const OTHER_ADDR = '0xBbBBbbbbbbbbBBbBbBbBbbbBbBbBBbbBbbbbBBbb' as Address;
const BASE_ADDR = '0xCcCcccCccccCCCCCCCCccCccCCcCcCCcCCcccccC' as Address;

function makeWatch(overrides: Partial<LaunchWatch> = {}): LaunchWatch {
  return {
    base: BASE_ADDR,
    threshold: 1_000n,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<LaunchSnapshot> = {}): LaunchSnapshot {
  return {
    base: BASE_ADDR,
    taxMode: TaxMode.BuybackURU,
    taxTarget: '0x0000000000000000000000000000000000000000',
    uruToken: '0x9fbe210007dDd8389f98d0253018e65CC48b9D24' as Address,
    keeper: KEEPER_ADDR,
    accumulatedTax: 2_000n,
    ...overrides,
  };
}

function makeCfg(overrides: Partial<KeeperConfig> = {}): KeeperConfig {
  return {
    rpcUrl: 'http://localhost:8545',
    chainId: 4663,
    keeperPrivateKey: '0x0',
    v4SwapRouter: '0x0000000000000000000000000000000000000001' as Address,
    uruToken: '0x0000000000000000000000000000000000000002' as Address,
    uruBuybackSink: '0x0000000000000000000000000000000000000003' as Address,
    advancedDestinationTreasury: '0x0000000000000000000000000000000000000004' as Address,
    launches: [],
    pollIntervalMs: 30_000,
    maxSweepPerPoll: 10n ** 25n,
    ...overrides,
  };
}

describe('decideSweep', () => {
  it('sweeps when over threshold on an accumulator mode', () => {
    const d = decideSweep(makeWatch(), makeSnapshot(), KEEPER_ADDR, makeCfg());
    assert.equal(d.shouldSweep, true);
    assert.match(d.reason, /over threshold/);
  });

  it('skips when on-chain keeper mismatches wallet', () => {
    const d = decideSweep(
      makeWatch(),
      makeSnapshot({ keeper: OTHER_ADDR }),
      KEEPER_ADDR,
      makeCfg(),
    );
    assert.equal(d.shouldSweep, false);
    assert.match(d.reason, /keeper mismatch/);
  });

  it('is case-insensitive on the keeper mismatch check', () => {
    // Same address, opposite case — must still match.
    const d = decideSweep(
      makeWatch(),
      makeSnapshot({ keeper: KEEPER_ADDR.toLowerCase() as Address }),
      KEEPER_ADDR,
      makeCfg(),
    );
    assert.equal(d.shouldSweep, true);
  });

  it('skips taxMode=Off', () => {
    const d = decideSweep(
      makeWatch(),
      makeSnapshot({ taxMode: TaxMode.Off }),
      KEEPER_ADDR,
      makeCfg(),
    );
    assert.equal(d.shouldSweep, false);
    assert.match(d.reason, /taxMode=Off/);
  });

  it('skips taxMode=BurnDead (burned in-place)', () => {
    const d = decideSweep(
      makeWatch(),
      makeSnapshot({ taxMode: TaxMode.BurnDead, accumulatedTax: 10_000n }),
      KEEPER_ADDR,
      makeCfg(),
    );
    assert.equal(d.shouldSweep, false);
    assert.match(d.reason, /BurnDead/);
  });

  it('skips when accumulatedTax is 0', () => {
    const d = decideSweep(
      makeWatch(),
      makeSnapshot({ accumulatedTax: 0n }),
      KEEPER_ADDR,
      makeCfg(),
    );
    assert.equal(d.shouldSweep, false);
    assert.match(d.reason, /accumulatedTax=0/);
  });

  it('skips when accumulatedTax under threshold', () => {
    const d = decideSweep(
      makeWatch({ threshold: 5_000n }),
      makeSnapshot({ accumulatedTax: 1_000n }),
      KEEPER_ADDR,
      makeCfg(),
    );
    assert.equal(d.shouldSweep, false);
    assert.match(d.reason, /< threshold=5000/);
  });

  it('sweeps at exactly the threshold', () => {
    const d = decideSweep(
      makeWatch({ threshold: 1_000n }),
      makeSnapshot({ accumulatedTax: 1_000n }),
      KEEPER_ADDR,
      makeCfg(),
    );
    assert.equal(d.shouldSweep, true);
  });

  it('refuses sweep over the anti-MEV ceiling', () => {
    const d = decideSweep(
      makeWatch({ threshold: 1n }),
      makeSnapshot({ accumulatedTax: 10n ** 26n }), // 100M — well over 10M default ceiling
      KEEPER_ADDR,
      makeCfg({ maxSweepPerPoll: 10n ** 25n }),
    );
    assert.equal(d.shouldSweep, false);
    assert.match(d.reason, /alert ops/);
  });

  it('sweeps all accumulator modes (BuybackURU, BuyAllowedToken, AddToLP, HolderReflections, MirrorFloorSupport)', () => {
    for (const mode of [
      TaxMode.BuybackURU,
      TaxMode.BuyAllowedToken,
      TaxMode.AddToLP,
      TaxMode.HolderReflections,
      TaxMode.MirrorFloorSupport,
    ]) {
      const d = decideSweep(makeWatch(), makeSnapshot({ taxMode: mode }), KEEPER_ADDR, makeCfg());
      assert.equal(d.shouldSweep, true, `mode ${mode} should sweep`);
    }
  });
});
