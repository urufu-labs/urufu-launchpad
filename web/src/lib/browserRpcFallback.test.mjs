// The browser reads Robinhood Chain through a fallback of keyless public RPCs
// (lib/wagmi.ts ROBINHOOD_BROWSER_RPCS). Guards: the fallback stays wired, and
// no URL in it carries a provider key (these ship in the public JS bundle; see
// noKeyedRpcInBundle.test.mjs for the 2026-10-02 Alchemy leak).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'wagmi.ts'), 'utf8');

const list = src.match(/ROBINHOOD_BROWSER_RPCS = \[([\s\S]*?)\] as const/);

test('Robinhood browser RPC list exists with the official RPC first', () => {
  assert.ok(list, 'ROBINHOOD_BROWSER_RPCS not found');
  const urls = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(urls.length >= 2, 'need at least one fallback');
  assert.equal(urls[0], 'https://rpc.mainnet.chain.robinhood.com');
});

test('no browser RPC URL carries a provider key', () => {
  const urls = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const u of urls) {
    assert.ok(!/\/v[0-9]+\/|[?&](key|apikey|api_key)=|[0-9a-f]{24,}/i.test(u), `looks keyed: ${u}`);
    assert.ok(!/infura|alchemy|quicknode/i.test(u), `keyed provider in browser list: ${u}`);
  }
});

test('Robinhood transport uses the fallback list', () => {
  assert.match(src, /\[robinhoodChain\.id\]:\s*fallback\(ROBINHOOD_BROWSER_RPCS\.map\(/);
});
