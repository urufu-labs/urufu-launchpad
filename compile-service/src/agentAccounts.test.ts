/// Agent account detection (agentAccounts.ts): which wallets are agent Safes, the
/// mastercopy and owner/avatar checks, caching and the per-read check budget.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hex } from 'viem';

import { AgentAccountDetector, MAX_NEW_CHECKS, ROLES_V2_MASTERCOPY, isMinimalProxyOf, type AccountChain } from './agentAccounts.ts';

const SAFE = '0x00000000000000000000000000000000000000a1' as Address;
const ROLES = '0x00000000000000000000000000000000000000b1' as Address;
const OTHER_MOD = '0x00000000000000000000000000000000000000b2' as Address;
const EOA = '0x00000000000000000000000000000000000000c1' as Address;
const proxyOf = (t: Address) => `0x363d3d373d3d3d363d73${t.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3` as Hex;

/// A tiny chain: SAFE has ROLES (a Roles v2 clone owned by + acting on SAFE)
/// and OTHER_MOD (a clone of something else). Everything else has no code.
function chain(over: Partial<{ owner: Address; avatar: Address; modules: Address[]; failCode: boolean }> = {}) {
  const calls = { code: 0 };
  const c: AccountChain = {
    async code(a) {
      calls.code++;
      if (over.failCode) throw new Error('rpc down');
      if (a.toLowerCase() === SAFE) return '0x6080' as Hex;
      if (a.toLowerCase() === ROLES) return proxyOf(ROLES_V2_MASTERCOPY);
      if (a.toLowerCase() === OTHER_MOD) return proxyOf('0x00000000000000000000000000000000000000ee');
      return '0x';
    },
    async modules(a) {
      return a.toLowerCase() === SAFE ? (over.modules ?? [OTHER_MOD, ROLES]) : null;
    },
    async ownerAndAvatar() {
      return [over.owner ?? SAFE, over.avatar ?? SAFE];
    },
  };
  return { c, calls };
}

test('minimal proxy check matches only the exact EIP-1167 code', () => {
  assert.equal(isMinimalProxyOf(proxyOf(ROLES_V2_MASTERCOPY), ROLES_V2_MASTERCOPY), true);
  assert.equal(isMinimalProxyOf(proxyOf(EOA), ROLES_V2_MASTERCOPY), false);
  assert.equal(isMinimalProxyOf('0x', ROLES_V2_MASTERCOPY), false);
});

test('a Safe with its own Roles v2 module is an agent account; a plain wallet is not', async () => {
  const d = new AgentAccountDetector(chain().c);
  assert.deepEqual(await d.find([SAFE, EOA]), [{ address: SAFE, rolesModule: ROLES }]);
});

test('a Safe whose only module is some other Zodiac module is not tagged', async () => {
  const d = new AgentAccountDetector(chain({ modules: [OTHER_MOD] }).c);
  assert.deepEqual(await d.find([SAFE]), []);
});

test('a Roles module owned by or acting for someone else does not count', async () => {
  assert.deepEqual(await new AgentAccountDetector(chain({ owner: EOA }).c).find([SAFE]), []);
  assert.deepEqual(await new AgentAccountDetector(chain({ avatar: EOA }).c).find([SAFE]), []);
});

test('results are cached; contracts are re-checked after 10 minutes', async () => {
  let t = 1_000;
  const { c, calls } = chain();
  const d = new AgentAccountDetector(c, () => t);
  await d.find([SAFE, EOA]);
  const first = calls.code;
  await d.find([SAFE, EOA]);
  assert.equal(calls.code, first, 'second read is all cache');
  t += 10 * 60_000 + 1;
  await d.find([SAFE, EOA]);
  assert.ok(calls.code > first, 'Safe re-checked');
  const afterSafe = calls.code;
  await d.find([EOA]);
  assert.equal(calls.code, afterSafe, 'plain wallet still cached (a day)');
});

test('RPC failure means no tag now and a retry later, not a cached "no"', async () => {
  const flaky = chain({ failCode: true });
  const d = new AgentAccountDetector(flaky.c);
  assert.deepEqual(await d.find([SAFE]), []);
  await d.find([SAFE]);
  assert.equal(flaky.calls.code, 2, 'retried on the second read');
});

test('each read checks at most MAX_NEW_CHECKS new addresses', async () => {
  const { c, calls } = chain();
  const d = new AgentAccountDetector(c);
  const many = Array.from({ length: 60 }, (_, i) => `0x${(0x1000 + i).toString(16).padStart(40, '0')}`);
  await d.find(many);
  assert.equal(calls.code, MAX_NEW_CHECKS);
  await d.find(many);
  assert.equal(calls.code, MAX_NEW_CHECKS * 2, 'the next batch on the next read');
});
