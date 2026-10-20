import assert from 'node:assert/strict';
import test from 'node:test';

import { pickLauncher } from './routes/social.ts';

const A = '0xAbCdEf0000000000000000000000000000000001';

test('pickLauncher reads the token-lane row', () => {
  assert.equal(pickLauncher({ data: { launches: { launchedBy: A } } }, 'launches'), A.toLowerCase());
});

test('pickLauncher reads the Fair-lane row', () => {
  assert.equal(pickLauncher({ data: { fairLaunches: { launcher: A } } }, 'fairLaunches'), A.toLowerCase());
});

test('pickLauncher returns null for missing rows and GraphQL errors', () => {
  assert.equal(pickLauncher({ data: { launches: null } }, 'launches'), null);
  assert.equal(pickLauncher({ errors: [{ message: 'Cannot query field "fairLaunches"' }] }, 'fairLaunches'), null);
  assert.equal(pickLauncher(null, 'launches'), null);
});
