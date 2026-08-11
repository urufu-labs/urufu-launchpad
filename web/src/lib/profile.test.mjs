// Unit tests for the profile module's hide-holdings gate + the localStorage
// round-trip of the new `hideHoldings` field.
//
// Runs with `node --test web/src/lib/profile.test.mjs`. Uses
// `--experimental-strip-types` (matches the existing xAuth.test.mjs pattern)
// so it can import the .ts source directly.
//
// Covered:
//   1. shouldHideHoldingsFromView table — the truth table between `isOwn`
//      and `hideHoldings` that gates the profile page's rail render.
//   2. saveProfile + loadProfile round-trip preserves `hideHoldings: true`.
//   3. saveProfile drops `hideHoldings` when false so we don't bloat every
//      snapshot with an explicit `false` for a default value.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const profile = await import('./profile.ts');

// --- localStorage stub -------------------------------------------------
//
// profile.ts short-circuits when `window` is undefined; we install a minimal
// shim so `saveProfile` / `loadProfile` exercise the real serialization path.

const store = new Map();
const originalWindow = globalThis.window;

before(() => {
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      clear: () => { store.clear(); },
    },
  };
});

after(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

// ---------------------------------------------------------------- gate

describe('shouldHideHoldingsFromView', () => {
  test('own view with flag off — visible', () => {
    assert.equal(profile.shouldHideHoldingsFromView({ isOwn: true, hideHoldings: false }), false);
  });

  test('own view with flag on — still visible (owner always sees own data)', () => {
    assert.equal(profile.shouldHideHoldingsFromView({ isOwn: true, hideHoldings: true }), false);
  });

  test('stranger view with flag off — visible', () => {
    assert.equal(profile.shouldHideHoldingsFromView({ isOwn: false, hideHoldings: false }), false);
  });

  test('stranger view with flag on — hidden (the whole point)', () => {
    assert.equal(profile.shouldHideHoldingsFromView({ isOwn: false, hideHoldings: true }), true);
  });

  test('undefined hideHoldings treated as false (backward compat)', () => {
    assert.equal(profile.shouldHideHoldingsFromView({ isOwn: false, hideHoldings: undefined }), false);
    assert.equal(profile.shouldHideHoldingsFromView({ isOwn: true, hideHoldings: undefined }), false);
  });
});

// ---------------------------------------------------------------- round-trip

describe('saveProfile / loadProfile: hideHoldings round-trip', () => {
  test('true persists through localStorage', () => {
    store.clear();
    const addr = '0x1111111111111111111111111111111111111111';
    const res = profile.saveProfile({
      address: addr,
      username: 'me',
      hideHoldings: true,
      savedAt: 0,
    });
    assert.equal(res.ok, true);
    const loaded = profile.loadProfile(addr);
    assert.equal(loaded.hideHoldings, true);
  });

  test('false / undefined does not bloat the serialized snapshot', () => {
    store.clear();
    const addr = '0x2222222222222222222222222222222222222222';
    profile.saveProfile({
      address: addr,
      username: 'me',
      hideHoldings: false,
      savedAt: 0,
    });
    const raw = store.get(`uru-profile-${addr}`);
    assert.ok(raw, 'localStorage row exists');
    const parsed = JSON.parse(raw);
    // We drop the key entirely rather than persist an explicit false —
    // keeps the snapshot small + the field is optional on the type.
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'hideHoldings'), false);
    const loaded = profile.loadProfile(addr);
    // Consumer-facing shape: still resolves to a falsy value.
    assert.notEqual(loaded.hideHoldings, true);
  });

  test('toggling from true -> false erases the flag on re-save', () => {
    store.clear();
    const addr = '0x3333333333333333333333333333333333333333';
    profile.saveProfile({ address: addr, hideHoldings: true, savedAt: 0 });
    assert.equal(profile.loadProfile(addr).hideHoldings, true);
    profile.saveProfile({ address: addr, hideHoldings: false, savedAt: 0 });
    const after = profile.loadProfile(addr);
    assert.notEqual(after.hideHoldings, true);
  });
});
