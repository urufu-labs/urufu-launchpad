/// Pins the pair-currency (URU-paired) DN404 curve sources to real chain data.
///
/// Same failure mode as dn404-abi.test.ts: Ponder filters eth_getLogs by
/// topic0 = keccak(signature), so a wrong field anywhere drops every event
/// silently. Every ONCHAIN constant below was copied from a real receipt on
/// Robinhood mainnet (chain 4663), never typed from the Solidity:
///   - Dn404CurveCreated, Dn404CurveInitialized: REH404 launch tx 0x142338db…
///   - Dn404Trade, Dn404Graduated: REH404 graduating buy tx 0x9a4163fc…
///   - REH404_POOL_ID: the pool Dn404Graduator initialized in that buy
///
/// Reads ponder.config.ts as text (env-dependent init, see dn404-abi.test.ts).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak256, toHex } from 'viem';
import { computePairPoolId } from '../poolId.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = readFileSync(join(HERE, '..', 'ponder.config.ts'), 'utf8');

const ONCHAIN: Record<string, string> = {
  Dn404CurveCreated: '0xc4a81aede303aface6013bf04866c7bda4c2b8e9500b4d799a82c5ef816e4a64',
  Dn404CurveInitialized: '0x50ecd7220aacfd8f31c52a7664d404ac03065995e434946d2af0255e9bace4a5',
  Dn404Trade: '0xd4e366dd03c32bd5d0e56f580662967922553b384c4eb3c3023b44610e85b497',
  Dn404Graduated: '0x9d049ce682e92ccfd953f1c4b253d6ce95913ee7532a61c3561c6e706e0b387b',
};

function topic0FromConfig(name: string): string {
  const body = CONFIG.match(new RegExp(`event\\s+${name}\\s*\\(([^)]*)\\)`))?.[1];
  assert.ok(body !== undefined, `event ${name}(...) not found in ponder.config.ts`);
  const types = body
    .split(',')
    .map((s) => s.trim().split(/\s+/).filter((w) => w !== 'indexed')[0])
    .filter((t): t is string => !!t);
  return keccak256(toHex(`${name}(${types.join(',')})`));
}

for (const [name, expected] of Object.entries(ONCHAIN)) {
  test(`indexer ${name} signature matches the on-chain topic0`, () => {
    assert.equal(topic0FromConfig(name), expected, `${name} topic0 drifted from on-chain`);
  });
}

test('Dn404BondingCurve source is registered off the DN404 curve factory', () => {
  assert.match(CONFIG, /Dn404BondingCurve:\s*\{\s*abi:\s*dn404BondingCurveAbi,\s*network:\s*dn404BondingCurveNet\(\)\s*\}/);
  assert.match(CONFIG, /readAddress\(slug,\s*'DN404_CURVE_FACTORY'\)/);
});

const REH404 = '0x46377623F4Dd0470f5eA6F6120146F0801a26514' as const;
const URU = '0x9fbe210007dDd8389f98d0253018e65CC48b9D24' as const;
const DN404_HOST = '0x6d8701058E4eecA3bF80D14bD6C13A89575460C4' as const;
const REH404_POOL_ID = '0xe866d28f412e92d9310fce42f927fa5fc85d16777511ac8f52068ce62bb080c7';

test('computePairPoolId reproduces the live REH404/URU pool id', () => {
  assert.equal(computePairPoolId(REH404, URU, DN404_HOST), REH404_POOL_ID);
});

test('computePairPoolId is order-independent (sorts like the graduator)', () => {
  assert.equal(computePairPoolId(URU, REH404, DN404_HOST), REH404_POOL_ID);
});
