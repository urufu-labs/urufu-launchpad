// The swarm keeper may only send joinBatch / claimFromBatch when the vault would
// accept them (contracts/src/swarm/SwarmVault.sol). Its decision is a pure function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORGET_AFTER_S, swarmJoinConfig, swarmMove, type SwarmSnapshot } from './swarmJoin.ts';

const NOW = 1_800_000_000;
const base: SwarmSnapshot = {
  joined: false, batchClaimed: false, passed: true, unanimous: false,
  joinDeadline: NOW - 10, launchDeadline: NOW + 3600,
  batchExists: true, openTs: NOW - 5, closeTs: NOW + 55, settled: false,
};
const move = (over: Partial<SwarmSnapshot>, now = NOW) => swarmMove({ ...base, ...over }, now);

test('joins once the creator launched, the vote passed and the window is open', () => {
  assert.equal(move({}), 'join');
});

test('waits for the launch, and for a failed vote that may still pass', () => {
  assert.equal(move({ batchExists: false }), 'wait');
  assert.equal(move({ passed: false }), 'wait');
});

test('before the vote closes, joins only a unanimous pool', () => {
  assert.equal(move({ joinDeadline: NOW + 100 }), 'wait');
  assert.equal(move({ joinDeadline: NOW + 100, unanimous: true }), 'join');
});

test('gives up on a missed window, a late launch, or a launch that never came', () => {
  assert.equal(move({ closeTs: NOW }), 'done');
  assert.equal(move({ settled: true }), 'done');
  assert.equal(move({ openTs: NOW + 3600, launchDeadline: NOW + 3600 }), 'done');
  assert.equal(move({ batchExists: false, launchDeadline: NOW - FORGET_AFTER_S }), 'done');
});

test('after joining: waits for the window, then claims once, then stops', () => {
  assert.equal(move({ joined: true }), 'wait');
  assert.equal(move({ joined: true }, NOW + 60), 'claim');
  assert.equal(move({ joined: true, settled: true }), 'claim');
  assert.equal(move({ joined: true, batchClaimed: true }), 'done');
});

test('config needs rpc, key, a factory address and a start block', () => {
  const env = { ROBINHOOD_RPC_URL: 'http://localhost:1', KEEPER_PRIVATE_KEY: '11'.repeat(32), ROBINHOOD_SWARM_VAULT_FACTORY: '0x' + 'ab'.repeat(20), ROBINHOOD_SWARM_START_BLOCK: '100' };
  const cfg = swarmJoinConfig(env as NodeJS.ProcessEnv);
  assert.equal(cfg?.startBlock, 100n);
  assert.equal(cfg?.keeperKey, '0x' + '11'.repeat(32));
  assert.equal(swarmJoinConfig({ ...env, ROBINHOOD_SWARM_VAULT_FACTORY: 'nope' } as NodeJS.ProcessEnv), null);
  assert.equal(swarmJoinConfig({ ...env, ROBINHOOD_SWARM_START_BLOCK: '' } as NodeJS.ProcessEnv), null);
});
