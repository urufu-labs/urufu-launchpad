/// Pins the marketplace's Seaport event ABI and marker zone.
///
/// Same failure mode as dn404-abi.test.ts: Ponder filters getLogs by
/// topic0 = keccak256(signature), so a typo in a struct field silently drops
/// every fill with no error. The topic0s below were checked against live
/// Seaport 1.6 on Robinhood (2026-10-19, blocks ~92.94M-92.99M: 827
/// OrderFulfilled, 1142 OrderCancelled, 3 CounterIncremented logs matched).
///
/// The zone must equal shared/seaport.ts MARKET_ZONE or the indexer would
/// filter for a zone our orders never carry.
///
/// Reads ponder.config.ts as text (its module init is env-dependent).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAbi, toEventSelector, type AbiEvent } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = readFileSync(join(HERE, '..', 'ponder.config.ts'), 'utf8');
const SHARED = readFileSync(join(HERE, '..', '..', 'shared', 'seaport.ts'), 'utf8');

const ONCHAIN = {
  OrderFulfilled: '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31',
  OrderCancelled: '0x6bacc01dbe442496068f7d234edd811f1a5f833243e0aec824f86ab861f3c90d',
  CounterIncremented: '0x721c20121297512b72821b97f5326877ea8ecf4bb9948fea5bfcb6453074d37f',
} as const;

function seaportAbiFromConfig() {
  const block = CONFIG.match(/export const seaportAbi = parseAbi\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(block, 'seaportAbi parseAbi([...]) not found in ponder.config.ts');
  const strings = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  return parseAbi(strings as unknown as readonly string[]);
}

test('Seaport event topic0s match live Seaport 1.6 on Robinhood', () => {
  const abi = seaportAbiFromConfig();
  for (const [name, topic0] of Object.entries(ONCHAIN)) {
    const ev = abi.find((i) => i.type === 'event' && i.name === name) as AbiEvent | undefined;
    assert.ok(ev, `event ${name} missing from seaportAbi`);
    assert.equal(toEventSelector(ev), topic0, `${name} topic0 drifted`);
  }
});

test('fills and cancels are filtered by zone, which is indexed', () => {
  const abi = seaportAbiFromConfig();
  for (const name of ['OrderFulfilled', 'OrderCancelled']) {
    const ev = abi.find((i) => i.type === 'event' && i.name === name) as AbiEvent;
    const zone = ev.inputs.find((p) => p.name === 'zone');
    assert.ok(zone && 'indexed' in zone && zone.indexed, `${name}.zone must be indexed for the getLogs filter`);
  }
  assert.match(CONFIG, /event: 'OrderFulfilled' as const, args: \{ zone: MARKET_ZONE \}/);
  assert.match(CONFIG, /event: 'OrderCancelled' as const, args: \{ zone: MARKET_ZONE \}/);
});

test('indexer MARKET_ZONE equals shared/seaport.ts MARKET_ZONE', () => {
  const re = /export const MARKET_ZONE = '(0x[0-9a-f]{40})'/;
  const a = CONFIG.match(re)?.[1];
  const b = SHARED.match(re)?.[1];
  assert.ok(a && b, 'MARKET_ZONE not found');
  assert.equal(a, b);
});
