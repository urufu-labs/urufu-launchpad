// Home "Live trades" rail: v4 swaps with a null tokenAddress are filled from the
// poolId -> token map (graduations rows + legacy V10 pools) instead of dropped.
// Run: pnpm --filter web test:agent
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { encodeAbiParameters, keccak256 } from 'viem';

import { buildPoolTokenMap, fillSwapTokens } from './v4SwapTokens.ts';
import { legacyV10Pools, V10_MULTI_HOOK_HOST } from './legacyGraduations.ts';

const LUV = '0x985ec2c71ffebf4822b6c877bb87229923813c63';

test('legacy V10 pool ids are the ETH/token 3000/60 keys at V10 MHH', () => {
  const luv = legacyV10Pools().find((p) => p.tokenAddress === LUV);
  const expected = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    ['0x0000000000000000000000000000000000000000', LUV, 3000, 60, V10_MULTI_HOOK_HOST],
  ));
  assert.equal(luv.poolId, expected);
});

test('null-token rows are filled from graduations and legacy pools, unknown pools dropped', () => {
  const legacy = legacyV10Pools();
  const map = buildPoolTokenMap([{ poolId: '0xAA', tokenAddress: '0xToken1' }, { poolId: null, tokenAddress: '0xNoPool' }], legacy);
  const rows = [
    { id: '1', poolId: '0xaa', tokenAddress: null },
    { id: '2', poolId: legacy.find((p) => p.tokenAddress === LUV).poolId, tokenAddress: null },
    { id: '3', poolId: '0xbb', tokenAddress: '0xkept' },
    { id: '4', poolId: '0xcc', tokenAddress: null },
  ];
  const out = fillSwapTokens(rows, map);
  assert.deepEqual(out.map((r) => [r.id, r.tokenAddress]), [['1', '0xtoken1'], ['2', LUV], ['3', '0xkept']]);
});

test('indexer graduation rows win over the static legacy list for the same pool', () => {
  const map = buildPoolTokenMap([{ poolId: '0x01', tokenAddress: '0xFromIndexer' }], [{ poolId: '0x01', tokenAddress: '0xFromLegacy' }]);
  assert.equal(map.get('0x01'), '0xfromindexer');
});

test('every legacy pool is in the poolId_in list the rail queries', () => {
  const map = buildPoolTokenMap([], legacyV10Pools());
  for (const p of legacyV10Pools()) assert.ok(map.has(p.poolId));
});
