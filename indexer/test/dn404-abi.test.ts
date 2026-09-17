/// Pins the Dn404Launched event signature to the real on-chain topic0.
///
/// Why this exists: on 2026-09-16 the first mainnet DN404 launch was never
/// indexed. The contract had gained `uint8 taxMode, uint16 taxBps` (slice
/// C3); the web ABI was updated but this indexer's copy was not. Ponder
/// filters eth_getLogs by topic0 = keccak256(signature), so the stale
/// 12-field string produced a topic0 that matched nothing — the log was
/// fetched, silently discarded, and no handler ever ran. No error anywhere.
///
/// Deliberately reads both ABI files as text rather than importing them:
/// ponder.config.ts has env-dependent module init (enabledChains, createConfig)
/// and web/abis.ts sits in a Next.js graph. Text + keccak has no side effects
/// and is exactly what Ponder does with the string at runtime anyway.
///
/// ONCHAIN_TOPIC0 is taken from the receipt of that first launch (tx
/// 0xad4818…, block 64796708, Dn404LaunchFactory 0x3026C7…). If the
/// contract's event ever changes, update BOTH ABIs and this constant from a
/// real receipt — never from a hand-typed signature.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak256, toHex } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEXER_CONFIG = join(HERE, '..', 'ponder.config.ts');
const WEB_ABIS = join(HERE, '..', '..', 'web', 'src', 'lib', 'abis.ts');

/// Real topic0 of Dn404Launched as emitted by the deployed factory.
const ONCHAIN_TOPIC0 = '0x68365ce95c6edf66a41eb43906537daf339f288d09b8f33eecfa542d4b240439';

const selectorOf = (types: string[]) => keccak256(toHex(`Dn404Launched(${types.join(',')})`));

/// Indexer copy: human-readable `parseAbi(['event Dn404Launched(...)'])` string.
function indexerTypes(): string[] {
  const src = readFileSync(INDEXER_CONFIG, 'utf8');
  const body = src.match(/event\s+Dn404Launched\s*\(([^)]*)\)/)?.[1];
  assert.ok(body, 'event Dn404Launched(...) string not found in ponder.config.ts');
  return body
    .split(',')
    .map((s) => s.trim().split(/\s+/).filter((w) => w !== 'indexed')[0])
    .filter((t): t is string => !!t);
}

/// Web copy: object-form `{ name: 'Dn404Launched', inputs: [{ type: ... }] }`.
function webTypes(): string[] {
  const src = readFileSync(WEB_ABIS, 'utf8');
  const body = src.match(/name:\s*['"]Dn404Launched['"][\s\S]*?inputs:\s*\[([\s\S]*?)\n\s*\]/)?.[1];
  assert.ok(body, 'Dn404Launched event not found in web/src/lib/abis.ts');
  return [...body.matchAll(/type:\s*['"]([^'"]+)['"]/g)].map((x) => x[1]).filter((t): t is string => !!t);
}

test('indexer Dn404Launched signature matches the on-chain topic0', () => {
  const t = indexerTypes();
  assert.equal(t.length, 14, `indexer ABI expected 14 fields, got ${t.length}: ${t.join(',')}`);
  assert.equal(selectorOf(t), ONCHAIN_TOPIC0, 'indexer ABI topic0 drifted from on-chain');
});

test('web Dn404Launched signature matches the on-chain topic0', () => {
  const t = webTypes();
  assert.equal(t.length, 14, `web ABI expected 14 fields, got ${t.length}: ${t.join(',')}`);
  assert.equal(selectorOf(t), ONCHAIN_TOPIC0, 'web ABI topic0 drifted from on-chain');
});

test('indexer and web copies agree with each other field-for-field', () => {
  assert.deepEqual(indexerTypes(), webTypes());
});
