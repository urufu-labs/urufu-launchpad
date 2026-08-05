import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, keccak256 } from 'viem';

import { canonicalModuleString } from '../../shared/config-id.ts';

/// URU-A08: assert both v1 identity is stable AND that Pausable v2 produces a
/// fresh hash (proving V2 impls cannot collide with retired V1 clones on the
/// same factory).

function id(base: string, modules: string[], versions: Record<string, number>) {
  const canonical = canonicalModuleString(modules, (m) => versions[m]);
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }],
      [base, canonical],
    ),
  );
}

test('legacy v1 identity is stable (Pausable V1, bare)', () => {
  assert.equal(
    id('ERC20', ['Pausable'], { Pausable: 1 }),
    '0xa831bae1a66d3623be52065f464133bc90bd2eff45d4dc07d911b639ccdc803a',
  );
  assert.equal(
    id('ERC20', [], {}),
    '0xf7b8c67f3c497ace04f267a7b77845c97e685bd8ba1b0bec3d54a28e64a30acb',
  );
});

test('Pausable v2 gets a new identity distinct from V1', () => {
  assert.equal(
    id('ERC20', ['Pausable'], { Pausable: 2 }),
    '0xc9a87cbca9b96a91b5d8f29c4cacc6748e305cae57916c56e73ddafedb143e1f',
  );
});

test('duplicate module ids reject', () => {
  assert.throws(
    () => canonicalModuleString(['Permit', 'Permit'], () => 1),
    /DUPLICATE_MODULES/,
  );
});

test('unknown module id rejects', () => {
  assert.throws(
    () => canonicalModuleString(['NotAModule'], () => undefined),
    /UNKNOWN_MODULE/,
  );
});
