// KEEPER_RPC_URL falls back to Robinhood's public RPC, so losing the env var
// (as happened when the Alchemy key was pulled) can't stop the keeper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { RH_PUBLIC_RPC } from '../src/constants.ts';

const KEY = '0x' + '11'.repeat(32);

test('Robinhood without KEEPER_RPC_URL uses the public RPC', () => {
  const cfg = loadConfig({ KEEPER_PRIVATE_KEY: KEY } as NodeJS.ProcessEnv);
  assert.equal(cfg.rpcUrl, RH_PUBLIC_RPC);
});

test('an explicit KEEPER_RPC_URL still wins', () => {
  const cfg = loadConfig({ KEEPER_PRIVATE_KEY: KEY, KEEPER_RPC_URL: 'https://example.invalid/rpc' } as NodeJS.ProcessEnv);
  assert.equal(cfg.rpcUrl, 'https://example.invalid/rpc');
});

test('another chain must set KEEPER_RPC_URL', () => {
  assert.throws(() => loadConfig({ KEEPER_PRIVATE_KEY: KEY, KEEPER_CHAIN_ID: '8453' } as NodeJS.ProcessEnv));
});
