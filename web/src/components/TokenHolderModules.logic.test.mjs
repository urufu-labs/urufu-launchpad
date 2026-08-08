// Unit tests for TokenHolderModules render decision matrix. Same pattern as
// web/src/lib/xAuth.test.mjs — node --test with .mjs so the TS extension
// doesn't need a compile step (we import the .ts source with strip-types).
//
// This is the "test without a live V9" answer: rather than mount the whole
// trade page in a real browser (which short-circuits at 'no curve for this
// token' for our rehearsal-stack addresses), we exercise every render branch
// of the panel's decision logic directly. Every combination of
// {modules-installed, wallet, owner-state} is asserted.
//
// Run:
//   node --experimental-strip-types --disable-warning=ExperimentalWarning \
//     --test web/src/components/TokenHolderModules.logic.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import { decideVisibleModules } from './TokenHolderModules.logic.ts';

const WALLET = '0xd0b109fe95956E57926726a785BDEF1937B2F533';
const OTHER = '0x000000000000000000000000000000000000BEEF';
const OWNER = '0x1111111111111111111111111111111111111111';
const ZERO = '0x0000000000000000000000000000000000000000';

/// Build a marker array of length 7 with all fields absent, then let callers
/// flip the ones they want. Mirrors the wagmi useReadContracts result shape.
function markers(overrides = {}) {
  const arr = Array.from({ length: 7 }, () => ({ ok: false }));
  for (const [i, m] of Object.entries(overrides)) arr[Number(i)] = m;
  return arr;
}

// ============================================================================
// Bare ERC20 case: no modules at all → panel renders nothing.
// ============================================================================

test('bare ERC20: all markers fail → nothing to render', () => {
  const d = decideVisibleModules({ markers: markers(), wallet: WALLET });
  assert.equal(d.anythingToRender, false);
  assert.equal(d.hasStaking, false);
  assert.equal(d.hasVesting, false);
  assert.equal(d.hasVotes, false);
  assert.equal(d.showAdminBanner, false);
});

// ============================================================================
// Staking-only launches.
// ============================================================================

test('Staking installed → hasStaking + render', () => {
  const d = decideVisibleModules({
    markers: markers({ 0: { ok: true, value: 6_430_041_152_263_374_485n } }),
    wallet: WALLET,
  });
  assert.equal(d.hasStaking, true);
  assert.equal(d.anythingToRender, true);
  assert.equal(d.showAdminBanner, false);
});

// ============================================================================
// Vesting: beneficiary vs non-beneficiary gate.
// ============================================================================

test('Vesting installed, wallet IS beneficiary → panel renders', () => {
  const d = decideVisibleModules({
    markers: markers({ 1: { ok: true, value: WALLET } }),
    wallet: WALLET,
  });
  assert.equal(d.hasVesting, true);
  assert.equal(d.vestingIsBeneficiary, true);
  assert.equal(d.anythingToRender, true);
});

test('Vesting installed, wallet is NOT beneficiary → panel silent', () => {
  const d = decideVisibleModules({
    markers: markers({ 1: { ok: true, value: OTHER } }),
    wallet: WALLET,
  });
  assert.equal(d.hasVesting, true);
  assert.equal(d.vestingIsBeneficiary, false);
  assert.equal(d.anythingToRender, false); // no other modules, non-bene
});

test('Vesting installed, beneficiary check is case-insensitive', () => {
  const d = decideVisibleModules({
    markers: markers({ 1: { ok: true, value: WALLET.toUpperCase() } }),
    wallet: WALLET.toLowerCase(),
  });
  assert.equal(d.vestingIsBeneficiary, true);
});

test('Vesting installed, wallet is null (not connected) → panel silent', () => {
  const d = decideVisibleModules({
    markers: markers({ 1: { ok: true, value: WALLET } }),
    wallet: null,
  });
  assert.equal(d.hasVesting, true);
  assert.equal(d.vestingIsBeneficiary, false);
  assert.equal(d.anythingToRender, false);
});

// ============================================================================
// Votes.
// ============================================================================

test('Votes installed → render regardless of wallet', () => {
  const withWallet = decideVisibleModules({
    markers: markers({ 2: { ok: true, value: 0n } }),
    wallet: WALLET,
  });
  const noWallet = decideVisibleModules({
    markers: markers({ 2: { ok: true, value: 0n } }),
    wallet: null,
  });
  assert.equal(withWallet.hasVotes, true);
  assert.equal(withWallet.anythingToRender, true);
  assert.equal(noWallet.hasVotes, true);
  assert.equal(noWallet.anythingToRender, true);
});

// ============================================================================
// Admin risk banner: owner-restrictable modules × owner state.
// ============================================================================

test('Pausable + owner set → admin banner shown', () => {
  const d = decideVisibleModules({
    markers: markers({
      3: { ok: true, value: false },
      6: { ok: true, value: OWNER },
    }),
    wallet: WALLET,
  });
  assert.equal(d.hasPausable, true);
  assert.equal(d.tokenOwner, OWNER);
  assert.equal(d.showAdminBanner, true);
  assert.equal(d.anythingToRender, true);
});

test('Pausable + owner renounced (address(0)) → NO admin banner', () => {
  const d = decideVisibleModules({
    markers: markers({
      3: { ok: true, value: false },
      6: { ok: true, value: ZERO },
    }),
    wallet: WALLET,
  });
  assert.equal(d.hasPausable, true);
  assert.equal(d.tokenOwner, ZERO);
  assert.equal(d.showAdminBanner, false);
  assert.equal(d.anythingToRender, false); // no other modules
});

test('AntiBot + owner set → admin banner shown', () => {
  const d = decideVisibleModules({
    markers: markers({
      4: { ok: true, value: false },
      6: { ok: true, value: OWNER },
    }),
    wallet: WALLET,
  });
  assert.equal(d.hasAntiBot, true);
  assert.equal(d.showAdminBanner, true);
});

test('AntiWhale + owner set → admin banner shown', () => {
  const d = decideVisibleModules({
    markers: markers({
      5: { ok: true, value: false },
      6: { ok: true, value: OWNER },
    }),
    wallet: WALLET,
  });
  assert.equal(d.hasAntiWhale, true);
  assert.equal(d.showAdminBanner, true);
});

test('All three admin modules + owner set → banner shown once, all flags true', () => {
  const d = decideVisibleModules({
    markers: markers({
      3: { ok: true, value: false },
      4: { ok: true, value: false },
      5: { ok: true, value: false },
      6: { ok: true, value: OWNER },
    }),
    wallet: WALLET,
  });
  assert.equal(d.hasPausable, true);
  assert.equal(d.hasAntiBot, true);
  assert.equal(d.hasAntiWhale, true);
  assert.equal(d.showAdminBanner, true);
});

test('owner() marker fails → treated as renounced → no admin banner', () => {
  const d = decideVisibleModules({
    markers: markers({ 3: { ok: true, value: false } }), // Pausable yes, owner() marker missing
    wallet: WALLET,
  });
  assert.equal(d.tokenOwner, null);
  assert.equal(d.showAdminBanner, false);
});

// ============================================================================
// Combined cases — matches what a real launch might look like.
// ============================================================================

test('curve launch with Staking + Votes (auto-renounced) → both sub-panels, no admin banner', () => {
  const d = decideVisibleModules({
    markers: markers({
      0: { ok: true, value: 1n },
      2: { ok: true, value: 0n },
      6: { ok: true, value: ZERO }, // curve renounces at launch
    }),
    wallet: WALLET,
  });
  assert.equal(d.hasStaking, true);
  assert.equal(d.hasVotes, true);
  assert.equal(d.showAdminBanner, false);
  assert.equal(d.anythingToRender, true);
});

test('direct launch with AntiBot (owner retained) → admin banner AND nothing else', () => {
  const d = decideVisibleModules({
    markers: markers({
      4: { ok: true, value: true }, // gated
      6: { ok: true, value: OWNER },
    }),
    wallet: WALLET,
  });
  assert.equal(d.hasAntiBot, true);
  assert.equal(d.showAdminBanner, true);
  assert.equal(d.hasStaking, false);
  assert.equal(d.hasVotes, false);
  assert.equal(d.anythingToRender, true);
});

test('direct launch with AntiBot + Vesting for a non-beneficiary viewer → only admin banner', () => {
  const d = decideVisibleModules({
    markers: markers({
      1: { ok: true, value: OTHER }, // vesting beneficiary is someone else
      4: { ok: true, value: true },
      6: { ok: true, value: OWNER },
    }),
    wallet: WALLET,
  });
  assert.equal(d.hasVesting, true);
  assert.equal(d.vestingIsBeneficiary, false);
  assert.equal(d.showAdminBanner, true);
  assert.equal(d.anythingToRender, true);
});

test('empty markers array (marker probe not yet fired) → nothing renders', () => {
  const d = decideVisibleModules({ markers: [], wallet: WALLET });
  assert.equal(d.hasStaking, false);
  assert.equal(d.anythingToRender, false);
});
