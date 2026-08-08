// GH-15 tests for loyaltyStateForChainId — the per-chain env-config resolver
// used by the launch-card route handler.
//
// Runs standalone via `node --experimental-strip-types --test`. No Ponder
// build, no db, no network. Each test snapshots + mutates process.env for
// the three RH chain env vars the resolver reads, then restores.

import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

const KEYS = [
  'ROBINHOOD_LOYALTY_ORACLE_ADDRESS',
  'ROBINHOOD_URU_ADDRESS',
  'ROBINHOOD_GEMU_NFT_ADDRESS',
] as const;
const RH_CHAIN_ID = 4663;
const ZERO = '0x0000000000000000000000000000000000000000';
const ORACLE = '0xDcAd73EB96Bd0573b6ed0Ac3FFA32b1A7e0C0b52';
const URU = '0x9fbe210007dDd8389f98d0253018e65CC48b9D24';
const GEMU = '0x60cB7082c8C14B4237C6a24c65E7C2E7abe2Bd17';

const originals: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
for (const k of KEYS) originals[k] = process.env[k];

function set(k: (typeof KEYS)[number], v: string | undefined) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

afterEach(() => {
  for (const k of KEYS) set(k, originals[k]);
});

// Import once at top-level so the resolver's dotenv side-effect runs; then
// mutate process.env per-test because the reader is a live lookup, not cached.
const { loyaltyStateForChainId } = await import('../chains.ts');

test('unknown chainId → both false (no slug match)', () => {
  const state = loyaltyStateForChainId(999999);
  assert.deepEqual(state, { advertised: false, live: false });
});

test('LOYALTY_ORACLE unset → advertised:false, live:false', () => {
  set('ROBINHOOD_LOYALTY_ORACLE_ADDRESS', undefined);
  set('ROBINHOOD_URU_ADDRESS', URU);
  set('ROBINHOOD_GEMU_NFT_ADDRESS', GEMU);
  const state = loyaltyStateForChainId(RH_CHAIN_ID);
  assert.deepEqual(state, { advertised: false, live: false });
});

test('LOYALTY_ORACLE = 0x0 → advertised:false, live:false (treated as unset)', () => {
  set('ROBINHOOD_LOYALTY_ORACLE_ADDRESS', ZERO);
  set('ROBINHOOD_URU_ADDRESS', URU);
  set('ROBINHOOD_GEMU_NFT_ADDRESS', GEMU);
  const state = loyaltyStateForChainId(RH_CHAIN_ID);
  assert.deepEqual(state, { advertised: false, live: false });
});

test('LOYALTY_ORACLE set, URU + GEMU missing → advertised:true, live:false', () => {
  set('ROBINHOOD_LOYALTY_ORACLE_ADDRESS', ORACLE);
  set('ROBINHOOD_URU_ADDRESS', undefined);
  set('ROBINHOOD_GEMU_NFT_ADDRESS', undefined);
  const state = loyaltyStateForChainId(RH_CHAIN_ID);
  assert.deepEqual(state, { advertised: true, live: false });
});

test('LOYALTY_ORACLE set, only URU present → advertised:true, live:false', () => {
  set('ROBINHOOD_LOYALTY_ORACLE_ADDRESS', ORACLE);
  set('ROBINHOOD_URU_ADDRESS', URU);
  set('ROBINHOOD_GEMU_NFT_ADDRESS', undefined);
  const state = loyaltyStateForChainId(RH_CHAIN_ID);
  assert.deepEqual(state, { advertised: true, live: false });
});

test('LOYALTY_ORACLE set, only GEMU present → advertised:true, live:false', () => {
  set('ROBINHOOD_LOYALTY_ORACLE_ADDRESS', ORACLE);
  set('ROBINHOOD_URU_ADDRESS', undefined);
  set('ROBINHOOD_GEMU_NFT_ADDRESS', GEMU);
  const state = loyaltyStateForChainId(RH_CHAIN_ID);
  assert.deepEqual(state, { advertised: true, live: false });
});

test('LOYALTY_ORACLE + URU + GEMU all set → advertised:true, live:true', () => {
  set('ROBINHOOD_LOYALTY_ORACLE_ADDRESS', ORACLE);
  set('ROBINHOOD_URU_ADDRESS', URU);
  set('ROBINHOOD_GEMU_NFT_ADDRESS', GEMU);
  const state = loyaltyStateForChainId(RH_CHAIN_ID);
  assert.deepEqual(state, { advertised: true, live: true });
});

test('URU set to 0x0 → treated as unset → live:false', () => {
  set('ROBINHOOD_LOYALTY_ORACLE_ADDRESS', ORACLE);
  set('ROBINHOOD_URU_ADDRESS', ZERO);
  set('ROBINHOOD_GEMU_NFT_ADDRESS', GEMU);
  const state = loyaltyStateForChainId(RH_CHAIN_ID);
  assert.deepEqual(state, { advertised: true, live: false });
});
