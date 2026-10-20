// node --experimental-strip-types --disable-warning=ExperimentalWarning --test src/lib/devFunded.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ethRecipients, tokenRecipients, matchFunded, findDevFundedWallets, FUNDING_LOOKBACK_SECS } from './devFunded.ts';

const CREATOR = '0x00000000000000000000000000000000000000Cc';
const TOKEN = '0x00000000000000000000000000000000000000aA';
const ALT1 = '0x0000000000000000000000000000000000000A01';
const ALT2 = '0x0000000000000000000000000000000000000A02';
const HONEST = '0x0000000000000000000000000000000000000B01';
const LAUNCH = 1_800_000_000;
const iso = (s) => new Date(s * 1000).toISOString();

test('ethRecipients keeps value > 0 inside the window only', () => {
  const r = ethRecipients(
    [
      { to: { hash: ALT1 }, value: '1000', timestamp: iso(LAUNCH - 60) },
      { to: { hash: ALT2 }, value: '0', timestamp: iso(LAUNCH - 60) },
      { to: { hash: HONEST }, value: '5', timestamp: iso(LAUNCH - FUNDING_LOOKBACK_SECS - 1) },
    ],
    LAUNCH - FUNDING_LOOKBACK_SECS,
  );
  assert.deepEqual([...r], [ALT1.toLowerCase()]);
});

test('tokenRecipients filters by token address', () => {
  const r = tokenRecipients(
    [
      { to: { hash: ALT1 }, token: { address_hash: TOKEN }, timestamp: iso(LAUNCH + 100) },
      { to: { hash: ALT2 }, token: { address_hash: '0x0000000000000000000000000000000000000999' }, timestamp: iso(LAUNCH) },
    ],
    TOKEN,
    0,
  );
  assert.deepEqual([...r], [ALT1.toLowerCase()]);
});

test('matchFunded skips the creator, ignored contracts and duplicates', () => {
  const out = matchFunded([ALT1, ALT1, CREATOR, HONEST, ALT2], [new Set([ALT1.toLowerCase(), CREATOR.toLowerCase()]), new Set([ALT2.toLowerCase()])], CREATOR, [ALT2]);
  assert.deepEqual(out, [ALT1.toLowerCase()]);
});

test('findDevFundedWallets pages and returns null when Blockscout is unreachable', async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    if (url.includes('/transactions')) {
      if (!url.includes('page=2')) {
        return { ok: true, json: async () => ({ items: [{ to: { hash: ALT1 }, value: '1', timestamp: iso(LAUNCH - 10) }], next_page_params: { page: 2 } }) };
      }
      return { ok: true, json: async () => ({ items: [{ to: { hash: ALT2 }, value: '1', timestamp: iso(LAUNCH - 20) }], next_page_params: null }) };
    }
    return { ok: true, json: async () => ({ items: [], next_page_params: null }) };
  };
  const out = await findDevFundedWallets({ creator: CREATOR, token: TOKEN, launchTs: LAUNCH, candidates: [HONEST, ALT2, ALT1], fetchImpl: fake });
  assert.deepEqual(out, [ALT2.toLowerCase(), ALT1.toLowerCase()]);
  assert.ok(calls.some((u) => u.includes('page=2')), 'did not follow next_page_params');

  const down = await findDevFundedWallets({ creator: CREATOR, token: TOKEN, launchTs: LAUNCH, candidates: [ALT1], fetchImpl: async () => { throw new Error('cf'); } });
  assert.equal(down, null);
});
